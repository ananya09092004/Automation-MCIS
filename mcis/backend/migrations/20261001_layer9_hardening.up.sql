-- =====================================================================
-- Nexus Layer 9 — production hardening (UP)
-- =====================================================================
-- Requires Layers 1–8. Idempotent: safe to re-run.
-- Rollback: 20261001_layer9_hardening.down.sql
--
--   transfer_workspace_ownership()   atomic owner hand-over (Layer 1 gap)
--   workspace_retention_policies     owner-set retention for executions / audit
--   retention_purge_workspace()      real retention (usage ledger, runs,
--                                    executions, reservations, audit) with
--                                    hard floors, one workspace at a time
--   usage_events_immutable()         still blocks UPDATE and ordinary DELETE;
--                                    only the purge RPC (transaction-local
--                                    flag) may delete expired ledger rows
--   worker_heartbeats                worker liveness for operations metrics
--   enforce_active_workflow_limit()  race-free max_active_workflows / max_members:
--   enforce_member_limit()           the post-write check runs under a per-workspace
--                                    row lock and an over-limit writer undoes ITS
--                                    OWN write in the same transaction
--
-- No Layer 1–8 row is changed by this migration. RLS on, no client
-- policies, anon / authenticated denied; functions are service_role only.
-- =====================================================================

do $$
begin
  if to_regclass('public.workspaces') is null or to_regclass('public.usage_events') is null
     or to_regclass('public.user_onboarding') is null then
    raise exception 'Layer 9 requires Layers 1-8.';
  end if;
end $$;

-- ---------------------------------------------------------------------
-- 1. Ownership transfer (one transaction; the single-owner index means the
--    old owner is demoted before the new owner is promoted).
-- ---------------------------------------------------------------------
create or replace function public.transfer_workspace_ownership(p_workspace uuid, p_from text, p_to text)
returns boolean
language plpgsql as $$
declare v_ws public.workspaces%rowtype;
begin
  if p_workspace is null or p_from is null or p_to is null or p_from = p_to then return false; end if;
  select * into v_ws from public.workspaces where id = p_workspace for update;
  if not found or v_ws.is_personal or v_ws.owner_id <> p_from then return false; end if;
  perform 1 from public.workspace_members where workspace_id = p_workspace and user_id = p_from and role = 'owner' for update;
  if not found then return false; end if;
  perform 1 from public.workspace_members where workspace_id = p_workspace and user_id = p_to and role in ('admin', 'member') for update;
  if not found then return false; end if;
  update public.workspace_members set role = 'admin', updated_at = now() where workspace_id = p_workspace and user_id = p_from;
  update public.workspace_members set role = 'owner', updated_at = now() where workspace_id = p_workspace and user_id = p_to;
  update public.workspaces set owner_id = p_to, updated_at = now() where id = p_workspace;
  return true;
end $$;

-- ---------------------------------------------------------------------
-- 2. Retention settings (null = keep; floors enforced here AND in the RPC)
-- ---------------------------------------------------------------------
create table if not exists public.workspace_retention_policies (
  workspace_id     uuid primary key references public.workspaces(id) on delete cascade,
  executions_days  integer check (executions_days is null or executions_days between 7 and 3650),
  audit_days       integer check (audit_days is null or audit_days between 90 and 3650),
  updated_by       text not null check (char_length(updated_by) between 1 and 200),
  updated_at       timestamptz not null default now()
);

-- The Layer 7 ledger stays immutable; only the purge below (transaction-local
-- flag, service_role only) may delete rows older than the retention cut-off.
create or replace function public.usage_events_immutable() returns trigger
language plpgsql as $$
begin
  if tg_op = 'UPDATE' then
    raise exception 'usage events are immutable' using errcode = '42501';
  end if;
  if coalesce(current_setting('nexus.retention_purge', true), '') = 'on' then
    return old;
  end if;
  if exists (select 1 from public.workspaces w where w.id = old.workspace_id) then
    raise exception 'usage events are immutable' using errcode = '42501';
  end if;
  return old;
end $$;

create or replace function public.retention_purge_workspace(
  p_workspace uuid, p_usage_before timestamptz, p_exec_before timestamptz, p_audit_before timestamptz)
returns jsonb
language plpgsql as $$
declare
  v_usage integer := 0; v_res integer := 0; v_runs integer := 0; v_exec integer := 0; v_audit integer := 0;
begin
  if p_workspace is null then raise exception 'workspace is required' using errcode = '22023'; end if;
  -- Hard floors: the current billing month of usage, a week of runs and
  -- executions and 90 days of audit are never purged, whatever is passed.
  if p_usage_before is not null and p_usage_before > now() - interval '35 days' then
    raise exception 'usage retention below the 35-day floor' using errcode = '22023';
  end if;
  if p_exec_before is not null and p_exec_before > now() - interval '7 days' then
    raise exception 'execution retention below the 7-day floor' using errcode = '22023';
  end if;
  if p_audit_before is not null and p_audit_before > now() - interval '90 days' then
    raise exception 'audit retention below the 90-day floor' using errcode = '22023';
  end if;

  if p_usage_before is not null then
    perform set_config('nexus.retention_purge', 'on', true);
    delete from public.usage_events where workspace_id = p_workspace and occurred_at < p_usage_before;
    get diagnostics v_usage = row_count;
    perform set_config('nexus.retention_purge', 'off', true);
    delete from public.usage_reservations
     where workspace_id = p_workspace and status <> 'reserved' and created_at < p_usage_before;
    get diagnostics v_res = row_count;
  end if;

  if p_exec_before is not null then
    -- finished runs first (their steps and jobs cascade) …
    delete from public.workflow_runs
     where workspace_id = p_workspace and status in ('completed', 'failed', 'cancelled')
       and coalesce(finished_at, updated_at) < p_exec_before;
    get diagnostics v_runs = row_count;
    -- … then finished executions no remaining run step points to (evidence and approvals cascade)
    delete from public.agent_executions e
     where e.workspace_id = p_workspace and e.status in ('completed', 'failed', 'cancelled')
       and coalesce(e.finished_at, e.updated_at) < p_exec_before
       and not exists (select 1 from public.workflow_run_steps s where s.execution_id = e.id);
    get diagnostics v_exec = row_count;
  end if;

  if p_audit_before is not null and to_regclass('public.audit_log') is not null then
    execute 'delete from public.audit_log where workspace_id = $1 and created_at < $2' using p_workspace, p_audit_before;
    get diagnostics v_audit = row_count;
  end if;

  return jsonb_build_object('usageEvents', v_usage, 'reservations', v_res, 'workflowRuns', v_runs, 'executions', v_exec, 'auditRows', v_audit);
end $$;

-- ---------------------------------------------------------------------
-- 3. Worker liveness (operations metrics; no workspace data)
-- ---------------------------------------------------------------------
create table if not exists public.worker_heartbeats (
  worker_id     text primary key check (char_length(worker_id) between 1 and 200),
  kind          text not null default 'workflow' check (kind ~ '^[a-z][a-z0-9_]{1,31}$'),
  started_at    timestamptz not null default now(),
  last_seen_at  timestamptz not null default now(),
  running_jobs  integer not null default 0 check (running_jobs >= 0),
  version       text check (version is null or char_length(version) <= 64)
);
create index if not exists worker_heartbeats_seen_idx on public.worker_heartbeats (last_seen_at desc);

-- ---------------------------------------------------------------------
-- 4. Count limits (Layer 7 gap): serialized verification per workspace.
--    Called AFTER the caller's write. Under the workspace row lock, count;
--    if over the limit, undo this caller's write and return false. Because
--    every verifier holds the lock while it counts and undoes, the total
--    never stays above the limit and at least min(limit, writers) survive.
-- ---------------------------------------------------------------------
create or replace function public.enforce_active_workflow_limit(
  p_workspace uuid, p_workflow uuid, p_limit integer, p_prev_status text, p_prev_version uuid, p_prev_archived_at timestamptz)
returns boolean
language plpgsql as $$
declare v_n integer;
begin
  if p_workspace is null or p_workflow is null or p_limit is null or p_limit < 0 then
    raise exception 'invalid arguments' using errcode = '22023';
  end if;
  if p_prev_status not in ('draft', 'archived') then raise exception 'invalid previous status' using errcode = '22023'; end if;
  perform 1 from public.workspaces where id = p_workspace for update;
  if not found then return false; end if;
  select count(*) into v_n from public.workflows where workspace_id = p_workspace and status = 'active';
  if v_n <= p_limit then return true; end if;
  update public.workflows
     set status = p_prev_status, active_version_id = p_prev_version,
         archived_at = case when p_prev_status = 'archived' then coalesce(p_prev_archived_at, now()) else archived_at end,
         revision = revision + 1, updated_at = now()
   where workspace_id = p_workspace and id = p_workflow and status = 'active';
  return false;
end $$;

create or replace function public.enforce_member_limit(p_workspace uuid, p_invitation uuid, p_limit integer)
returns boolean
language plpgsql as $$
declare v_n integer;
begin
  if p_workspace is null or p_invitation is null or p_limit is null or p_limit < 0 then
    raise exception 'invalid arguments' using errcode = '22023';
  end if;
  perform 1 from public.workspaces where id = p_workspace for update;
  if not found then return false; end if;
  select (select count(*) from public.workspace_members where workspace_id = p_workspace)
       + (select count(*) from public.workspace_invitations where workspace_id = p_workspace and status = 'pending' and expires_at > now())
    into v_n;
  if v_n <= p_limit then return true; end if;
  update public.workspace_invitations set status = 'revoked'
   where workspace_id = p_workspace and id = p_invitation and status = 'pending';
  return false;
end $$;

-- ---------------------------------------------------------------------
-- 5. RLS + privileges
-- ---------------------------------------------------------------------
alter table public.workspace_retention_policies enable row level security;
alter table public.worker_heartbeats            enable row level security;

do $$
declare r text; f text;
begin
  foreach f in array array[
    'public.transfer_workspace_ownership(uuid, text, text)',
    'public.retention_purge_workspace(uuid, timestamptz, timestamptz, timestamptz)',
    'public.enforce_active_workflow_limit(uuid, uuid, integer, text, uuid, timestamptz)',
    'public.enforce_member_limit(uuid, uuid, integer)'
  ] loop
    execute format('revoke all on function %s from public', f);
    foreach r in array array['anon', 'authenticated'] loop
      if exists (select 1 from pg_roles where rolname = r) then execute format('revoke all on function %s from %I', f, r); end if;
    end loop;
    if exists (select 1 from pg_roles where rolname = 'service_role') then
      execute format('grant execute on function %s to service_role', f);
    end if;
  end loop;
  foreach r in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on public.workspace_retention_policies, public.worker_heartbeats from %I', r);
    end if;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant select, insert, update, delete on public.workspace_retention_policies, public.worker_heartbeats to service_role;
  end if;
end $$;
