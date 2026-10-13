-- =====================================================================
-- Nexus Layer 6 — Enterprise Security + Agent Firewall (UP)
-- =====================================================================
-- Requires Layers 1–5. Idempotent: safe to re-run.
-- Rollback: 20260928_layer6_security.down.sql
--
--   workspace_security_policies   one server-side policy document per workspace (versioned)
--   workspace_api_keys            hashed workspace API keys (plaintext never stored)
--   oauth_states                  server-side, single-use, hashed OAuth state
--   security_rate_limits          fixed-window counters (multi-instance safe)
--   agent_executions  + lease_expires_at, workflow_context   (multi-instance execution ownership)
--   agent_execution_approvals + binding_hash, policy_version (approval binding)
--   workflow_jobs     + lease_fence  (+ *_v2 job RPCs using it: stale-worker fencing)
--   user_integrations.github_token   → no NEW plaintext writes (trigger), if the legacy table exists
-- =====================================================================

-- gen_random_uuid() is built into PostgreSQL 13+. pgcrypto is only created
-- where the server offers it (Supabase does); no placeholder extension is
-- ever required (Layer 9).
do $pgc$
begin
  if exists (select 1 from pg_available_extensions where name = 'pgcrypto') then
    create extension if not exists pgcrypto;
  end if;
end $pgc$;

do $$
begin
  if to_regclass('public.workspaces') is null or to_regclass('public.agent_executions') is null
     or to_regclass('public.workflow_jobs') is null or to_regclass('public.integrations') is null then
    raise exception 'Layer 6 requires Layers 1-5.';
  end if;
end $$;

-- ---------------------------------------------------------------------
-- 1. Workspace security policy (absent row = built-in secure default)
-- ---------------------------------------------------------------------
create table if not exists public.workspace_security_policies (
  workspace_id uuid primary key references public.workspaces(id) on delete cascade,
  version      integer not null default 1 check (version >= 1),
  policy       jsonb not null,
  updated_by   text not null,
  updated_at   timestamptz not null default now(),
  check (pg_column_size(policy) <= 65536)
);

-- ---------------------------------------------------------------------
-- 2. Workspace API keys — only a SHA-256 hash of the key is stored
-- ---------------------------------------------------------------------
create table if not exists public.workspace_api_keys (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references public.workspaces(id) on delete cascade,
  name          text not null check (char_length(btrim(name)) between 1 and 80),
  prefix        text not null unique check (prefix ~ '^nxk_[a-z0-9]{12}$'),
  key_hash      text not null unique check (key_hash ~ '^[0-9a-f]{64}$'),
  scopes        text[] not null check (array_length(scopes, 1) between 1 and 10),
  workflow_ids  uuid[],
  created_by    text not null,
  created_at    timestamptz not null default now(),
  expires_at    timestamptz,
  last_used_at  timestamptz,
  revoked_at    timestamptz,
  revoked_by    text,
  rotated_from  uuid,
  unique (id, workspace_id)
);
create index if not exists workspace_api_keys_ws_idx on public.workspace_api_keys (workspace_id, created_at desc);

-- ---------------------------------------------------------------------
-- 3. OAuth state — random, hashed, short-lived, single-use, bound to
--    user + workspace + provider
-- ---------------------------------------------------------------------
create table if not exists public.oauth_states (
  id           uuid primary key default gen_random_uuid(),
  state_hash   text not null unique check (state_hash ~ '^[0-9a-f]{64}$'),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id      text not null,
  provider     text not null check (provider ~ '^[a-z][a-z0-9_]{1,31}$'),
  purpose      text not null check (purpose in ('workspace_connect', 'user_connect')),
  expires_at   timestamptz not null,
  consumed_at  timestamptz,
  created_at   timestamptz not null default now()
);
create index if not exists oauth_states_expiry_idx on public.oauth_states (expires_at);

-- Atomic single use: consumes by hash (whatever the provider/user) and
-- returns the row only if it was unconsumed and unexpired (DB clock).
create or replace function public.consume_oauth_state(p_state_hash text)
returns setof public.oauth_states
language sql
as $$
  update public.oauth_states
     set consumed_at = now()
   where state_hash = p_state_hash and consumed_at is null and expires_at > now()
  returning *;
$$;

-- ---------------------------------------------------------------------
-- 4. Rate limits (fixed windows; atomic upsert → safe across instances)
-- ---------------------------------------------------------------------
create table if not exists public.security_rate_limits (
  bucket       text not null check (char_length(bucket) between 1 and 200),
  window_start timestamptz not null,
  hits         integer not null default 0,
  primary key (bucket, window_start)
);

create or replace function public.security_rate_limit_hit(p_bucket text, p_window_seconds integer, p_limit integer)
returns boolean
language plpgsql
as $$
declare n integer; w timestamptz;
begin
  if p_window_seconds is null or p_window_seconds not between 1 and 86400 or p_limit is null or p_limit < 1 then
    raise exception 'invalid rate limit';
  end if;
  w := to_timestamp(floor(extract(epoch from now()) / p_window_seconds) * p_window_seconds);
  insert into public.security_rate_limits (bucket, window_start, hits) values (p_bucket, w, 1)
  on conflict (bucket, window_start) do update set hits = security_rate_limits.hits + 1
  returning hits into n;
  if random() < 0.01 then
    delete from public.security_rate_limits where window_start < now() - interval '2 days';
  end if;
  return n <= p_limit;
end $$;

-- ---------------------------------------------------------------------
-- 5. Multi-instance execution ownership + approval binding (Layer 3)
-- ---------------------------------------------------------------------
alter table public.agent_executions add column if not exists lease_expires_at timestamptz;
alter table public.agent_executions add column if not exists workflow_context jsonb;
alter table public.agent_execution_approvals add column if not exists binding_hash text
  check (binding_hash is null or binding_hash ~ '^[0-9a-f]{64}$');
alter table public.agent_execution_approvals add column if not exists policy_version integer;

-- ---------------------------------------------------------------------
-- 6. Durable-job fencing (Layer 4): every claim gets a new fence token;
--    heartbeat / release only succeed for the CURRENT owner + fence.
-- ---------------------------------------------------------------------
alter table public.workflow_jobs add column if not exists lease_fence bigint not null default 0;

create or replace function public.claim_workflow_job_v2(p_worker text, p_lease_seconds integer)
returns setof public.workflow_jobs
language plpgsql
as $$
begin
  if p_worker is null or char_length(p_worker) not between 1 and 200 then raise exception 'invalid worker id'; end if;
  if p_lease_seconds is null or p_lease_seconds not between 1 and 3600 then raise exception 'invalid lease'; end if;
  return query
  with candidate as (
    select j.id from public.workflow_jobs j
     where (j.status = 'queued' and j.run_at <= now())
        or (j.status = 'running' and j.lease_expires_at < now())
     order by j.run_at, j.created_at
     for update skip locked
     limit 1
  )
  update public.workflow_jobs j
     set recoveries       = j.recoveries + case when j.status = 'running' then 1 else 0 end,
         status           = 'running',
         lease_owner      = p_worker,
         lease_fence      = j.lease_fence + 1,
         lease_expires_at = now() + make_interval(secs => p_lease_seconds),
         heartbeat_at     = now(),
         attempts         = j.attempts + 1,
         updated_at       = now()
    from candidate
   where j.id = candidate.id
  returning j.*;
end $$;

create or replace function public.heartbeat_workflow_job_v2(p_job uuid, p_worker text, p_fence bigint, p_lease_seconds integer)
returns boolean
language plpgsql
as $$
declare n integer;
begin
  if p_lease_seconds is null or p_lease_seconds not between 1 and 3600 then raise exception 'invalid lease'; end if;
  update public.workflow_jobs
     set lease_expires_at = now() + make_interval(secs => p_lease_seconds), heartbeat_at = now(), updated_at = now()
   where id = p_job and lease_owner = p_worker and lease_fence = p_fence and status = 'running';
  get diagnostics n = row_count;
  return n = 1;
end $$;

create or replace function public.release_workflow_job_v2(p_job uuid, p_worker text, p_fence bigint, p_status text,
                                                          p_delay_seconds integer, p_error text)
returns boolean
language plpgsql
as $$
declare n integer;
begin
  if p_status not in ('queued','paused','completed','failed','cancelled') then raise exception 'invalid job status'; end if;
  update public.workflow_jobs
     set status = p_status,
         run_at = case when p_status = 'queued'
                       then now() + make_interval(secs => greatest(coalesce(p_delay_seconds, 0), 0)) else run_at end,
         lease_owner = null, lease_expires_at = null,
         last_error = case when p_error is null then last_error else left(p_error, 1000) end,
         updated_at = now()
   where id = p_job and lease_owner = p_worker and lease_fence = p_fence and status = 'running';
  get diagnostics n = row_count;
  return n = 1;
end $$;

-- ---------------------------------------------------------------------
-- 7. Legacy per-user GitHub OAuth: plaintext tokens can no longer be
--    written. Existing rows are migrated (encrypted) and cleared by
--    scripts/migrate-legacy-github-tokens.js (needs the app's key).
-- ---------------------------------------------------------------------
create or replace function public.user_integrations_no_plaintext_token() returns trigger
language plpgsql as $$
begin
  if new.github_token is not null then
    raise exception 'plaintext GitHub tokens are no longer accepted (use the encrypted integration store)' using errcode = '22023';
  end if;
  return new;
end $$;

do $$
begin
  if to_regclass('public.user_integrations') is not null and exists (
    select 1 from information_schema.columns where table_schema = 'public' and table_name = 'user_integrations' and column_name = 'github_token'
  ) then
    drop trigger if exists user_integrations_no_plaintext_token on public.user_integrations;
    create trigger user_integrations_no_plaintext_token before insert or update on public.user_integrations
      for each row execute function public.user_integrations_no_plaintext_token();
  end if;
end $$;

-- ---------------------------------------------------------------------
-- 8. RLS deny-by-default + no privileges for public roles
-- ---------------------------------------------------------------------
alter table public.workspace_security_policies enable row level security;
alter table public.workspace_api_keys          enable row level security;
alter table public.oauth_states                enable row level security;
alter table public.security_rate_limits        enable row level security;

do $$
declare r text; f text;
begin
  foreach f in array array[
    'public.consume_oauth_state(text)', 'public.security_rate_limit_hit(text, integer, integer)',
    'public.claim_workflow_job_v2(text, integer)', 'public.heartbeat_workflow_job_v2(uuid, text, bigint, integer)',
    'public.release_workflow_job_v2(uuid, text, bigint, text, integer, text)', 'public.user_integrations_no_plaintext_token()'
  ] loop
    execute format('revoke all on function %s from public', f);
    foreach r in array array['anon', 'authenticated'] loop
      if exists (select 1 from pg_roles where rolname = r) then execute format('revoke all on function %s from %I', f, r); end if;
    end loop;
    if exists (select 1 from pg_roles where rolname = 'service_role') and f not like '%no_plaintext%' then
      execute format('grant execute on function %s to service_role', f);
    end if;
  end loop;
  foreach r in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on public.workspace_security_policies, public.workspace_api_keys, public.oauth_states, public.security_rate_limits from %I', r);
    end if;
  end loop;
end $$;
