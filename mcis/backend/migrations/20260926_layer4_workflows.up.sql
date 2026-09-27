-- =====================================================================
-- Nexus Layer 4 — Workflows + Durable Execution Foundation (UP)
-- =====================================================================
-- Requires: Layer 1 (workspaces), Layer 3 (agent_executions) and
-- Layer 2 (workspace_tasks). Idempotent: safe to re-run.
-- Rollback: 20260926_layer4_workflows.down.sql
--
--   workflows            editable definition (draft) + lifecycle + schedule
--   workflow_versions    IMMUTABLE published snapshots (UPDATE is blocked)
--   workflow_runs        one run of one immutable version
--   workflow_run_steps   per-step state; links the Layer 3 execution
--   workflow_jobs        PostgreSQL-backed durable job with a lease
--   agent_executions.inflight  (additive) the action currently in flight,
--                        so recovery knows whether a retry is safe
--
-- Every table carries workspace_id and composite FKs so that a row can
-- never point at a parent in another workspace. RLS is deny-by-default
-- and anon/authenticated have no privileges (backend = service_role).
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
  if to_regclass('public.workspaces') is null then
    raise exception 'Layer 4 requires Layer 1 (workspaces).';
  end if;
  if to_regclass('public.agent_executions') is null then
    raise exception 'Layer 4 requires Layer 3 (agent_executions).';
  end if;
  if to_regclass('public.workspace_tasks') is null then
    raise exception 'Layer 4 requires Layer 2 (workspace_tasks).';
  end if;
end $$;

-- ---------------------------------------------------------------------
-- 1. workflows
-- ---------------------------------------------------------------------
create table if not exists public.workflows (
  id                        uuid primary key default gen_random_uuid(),
  workspace_id              uuid not null references public.workspaces(id) on delete cascade,
  name                      text not null check (char_length(btrim(name)) between 1 and 120),
  description               text not null default '' check (char_length(description) <= 2000),
  status                    text not null default 'draft' check (status in ('draft','active','archived')),
  created_by                text not null,
  draft                     jsonb not null default '{"variables":[],"steps":[],"policy":{}}'::jsonb,
  active_version_id         uuid,
  latest_version            integer not null default 0 check (latest_version >= 0),
  trigger_type              text not null default 'manual' check (trigger_type in ('manual','scheduled','api')),
  schedule_interval_minutes integer check (schedule_interval_minutes is null or schedule_interval_minutes between 15 and 10080),
  schedule_inputs           jsonb,
  schedule_owner            text,
  next_run_at               timestamptz,
  revision                  integer not null default 0,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),
  archived_at               timestamptz,
  unique (id, workspace_id),
  -- a scheduled workflow always has an interval and an owner
  check (trigger_type <> 'scheduled' or (schedule_interval_minutes is not null and schedule_owner is not null))
);
create index if not exists workflows_ws_created_idx on public.workflows (workspace_id, created_at desc);
create index if not exists workflows_due_idx on public.workflows (next_run_at)
  where trigger_type = 'scheduled' and status = 'active';

-- ---------------------------------------------------------------------
-- 2. workflow_versions — immutable snapshots
-- ---------------------------------------------------------------------
create table if not exists public.workflow_versions (
  id              uuid primary key default gen_random_uuid(),
  workflow_id     uuid not null,
  workspace_id    uuid not null,
  version_number  integer not null check (version_number >= 1),
  name            text not null,
  definition      jsonb not null,
  definition_hash text not null check (char_length(definition_hash) = 64),
  created_by      text not null,
  created_at      timestamptz not null default now(),
  unique (workflow_id, version_number),
  unique (id, workflow_id),
  unique (id, workspace_id),
  foreign key (workflow_id, workspace_id) references public.workflows (id, workspace_id) on delete cascade
);

create or replace function public.workflow_versions_immutable() returns trigger
language plpgsql as $$
begin
  raise exception 'workflow_versions rows are immutable' using errcode = '55000';
end $$;

drop trigger if exists workflow_versions_no_update on public.workflow_versions;
create trigger workflow_versions_no_update before update on public.workflow_versions
  for each row execute function public.workflow_versions_immutable();

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'workflows_active_version_fk') then
    alter table public.workflows add constraint workflows_active_version_fk
      foreign key (active_version_id, id) references public.workflow_versions (id, workflow_id);
  end if;
end $$;

-- ---------------------------------------------------------------------
-- 3. workflow_runs
-- ---------------------------------------------------------------------
create table if not exists public.workflow_runs (
  id                  uuid primary key default gen_random_uuid(),
  workspace_id        uuid not null,
  workflow_id         uuid not null,
  workflow_version_id uuid not null,
  version_number      integer not null check (version_number >= 1),
  initiated_by        text not null,
  trigger             text not null check (trigger in ('manual','scheduled','api')),
  status              text not null default 'queued' check (status in
                        ('queued','running','waiting_approval','needs_review','completed','failed','cancelled')),
  current_step        integer not null default 0 check (current_step >= 0),
  inputs              jsonb not null default '{}'::jsonb,        -- REDACTED values only
  task_id             uuid,
  idempotency_key     text check (idempotency_key is null or char_length(idempotency_key) between 8 and 128),
  request_hash        text check (request_hash is null or char_length(request_hash) = 64),
  scheduled_for       timestamptz,
  cancel_requested    boolean not null default false,
  result              jsonb,
  verification        jsonb,
  failure_code        text,
  failure_message     text,
  review_reason       text,
  deadline_at         timestamptz,
  version             integer not null default 0,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  started_at          timestamptz,
  finished_at         timestamptz,
  unique (id, workspace_id),
  foreign key (workflow_id, workspace_id) references public.workflows (id, workspace_id) on delete cascade,
  -- the version MUST belong to the run's workflow
  foreign key (workflow_version_id, workflow_id) references public.workflow_versions (id, workflow_id) on delete cascade,
  -- DEFERRABLE: checked at commit, so deleting a whole workspace (which
  -- cascades to tasks AND runs in one statement) is never blocked by
  -- cascade ordering, while a dangling reference is still impossible.
  constraint workflow_runs_task_fk foreign key (task_id, workspace_id)
    references public.workspace_tasks (id, workspace_id) deferrable initially deferred
);
create index if not exists workflow_runs_ws_wf_created_idx on public.workflow_runs (workspace_id, workflow_id, created_at desc);
create unique index if not exists workflow_runs_idempotency
  on public.workflow_runs (workspace_id, idempotency_key) where idempotency_key is not null;
create unique index if not exists workflow_runs_schedule_slot
  on public.workflow_runs (workflow_id, scheduled_for) where scheduled_for is not null;

-- ---------------------------------------------------------------------
-- 4. workflow_run_steps
-- ---------------------------------------------------------------------
create table if not exists public.workflow_run_steps (
  id            uuid primary key default gen_random_uuid(),
  run_id        uuid not null,
  workspace_id  uuid not null,
  position      integer not null check (position between 0 and 49),
  step_key      text not null check (step_key ~ '^[a-z][a-z0-9_]{0,63}$'),
  status        text not null default 'pending' check (status in
                  ('pending','running','waiting_approval','succeeded','failed','needs_review','skipped','cancelled')),
  attempt       integer not null default 0 check (attempt between 0 and 10),
  execution_id  uuid,
  attempts      jsonb not null default '[]'::jsonb,   -- history: [{attempt, executionId, status, failureCode}]
  output        jsonb,                                -- redacted
  verification  jsonb,
  error_code    text,
  error_message text,
  version       integer not null default 0,
  started_at    timestamptz,
  finished_at   timestamptz,
  updated_at    timestamptz not null default now(),
  unique (run_id, position),
  foreign key (run_id, workspace_id) references public.workflow_runs (id, workspace_id) on delete cascade,
  -- the linked execution MUST be in the same workspace (deferrable: see
  -- workflow_runs_task_fk — workspace deletion cascades to both sides)
  constraint workflow_run_steps_execution_fk foreign key (execution_id, workspace_id)
    references public.agent_executions (id, workspace_id) deferrable initially deferred
);
create index if not exists workflow_run_steps_ws_run_idx on public.workflow_run_steps (workspace_id, run_id, position);
create unique index if not exists workflow_run_steps_one_execution
  on public.workflow_run_steps (execution_id) where execution_id is not null;

-- ---------------------------------------------------------------------
-- 5. workflow_jobs — durable job + lease (one job per run)
-- ---------------------------------------------------------------------
create table if not exists public.workflow_jobs (
  id               uuid primary key default gen_random_uuid(),
  workspace_id     uuid not null,
  run_id           uuid not null unique,
  status           text not null default 'queued' check (status in
                     ('queued','running','paused','completed','failed','cancelled')),
  run_at           timestamptz not null default now(),
  lease_owner      text check (lease_owner is null or char_length(lease_owner) between 1 and 200),
  lease_expires_at timestamptz,
  heartbeat_at     timestamptz,
  attempts         integer not null default 0 check (attempts >= 0),
  recoveries       integer not null default 0 check (recoveries >= 0),
  max_recoveries   integer not null default 3 check (max_recoveries between 0 and 20),
  last_error       text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  foreign key (run_id, workspace_id) references public.workflow_runs (id, workspace_id) on delete cascade,
  check (status <> 'running' or (lease_owner is not null and lease_expires_at is not null))
);
create index if not exists workflow_jobs_queued_idx on public.workflow_jobs (run_at) where status = 'queued';
create index if not exists workflow_jobs_lease_idx  on public.workflow_jobs (lease_expires_at) where status = 'running';

-- Atomic claim: the oldest due queued job, or a running job whose lease
-- expired (crashed worker → recovery). FOR UPDATE SKIP LOCKED guarantees
-- two concurrent workers never receive the same job.
create or replace function public.claim_workflow_job(p_worker text, p_lease_seconds integer)
returns setof public.workflow_jobs
language plpgsql
as $$
begin
  if p_worker is null or char_length(p_worker) not between 1 and 200 then
    raise exception 'invalid worker id';
  end if;
  if p_lease_seconds is null or p_lease_seconds not between 1 and 3600 then
    raise exception 'invalid lease';
  end if;
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
         lease_expires_at = now() + make_interval(secs => p_lease_seconds),
         heartbeat_at     = now(),
         attempts         = j.attempts + 1,
         updated_at       = now()
    from candidate
   where j.id = candidate.id
  returning j.*;
end $$;

-- Heartbeat: extends the lease only while THIS worker still owns it.
create or replace function public.heartbeat_workflow_job(p_job uuid, p_worker text, p_lease_seconds integer)
returns boolean
language plpgsql
as $$
declare n integer;
begin
  if p_lease_seconds is null or p_lease_seconds not between 1 and 3600 then
    raise exception 'invalid lease';
  end if;
  update public.workflow_jobs
     set lease_expires_at = now() + make_interval(secs => p_lease_seconds),
         heartbeat_at = now(), updated_at = now()
   where id = p_job and lease_owner = p_worker and status = 'running';
  get diagnostics n = row_count;
  return n = 1;
end $$;

-- Release: owner-only transition out of 'running'.
create or replace function public.release_workflow_job(p_job uuid, p_worker text, p_status text,
                                                       p_delay_seconds integer, p_error text)
returns boolean
language plpgsql
as $$
declare n integer;
begin
  if p_status not in ('queued','paused','completed','failed','cancelled') then
    raise exception 'invalid job status';
  end if;
  update public.workflow_jobs
     set status = p_status,
         run_at = case when p_status = 'queued'
                       then now() + make_interval(secs => greatest(coalesce(p_delay_seconds, 0), 0))
                       else run_at end,
         lease_owner = null, lease_expires_at = null,
         last_error = case when p_error is null then last_error else left(p_error, 1000) end,
         updated_at = now()
   where id = p_job and lease_owner = p_worker and status = 'running';
  get diagnostics n = row_count;
  return n = 1;
end $$;

-- ---------------------------------------------------------------------
-- 6. Layer 3 additive column: in-flight action marker for safe recovery
-- ---------------------------------------------------------------------
alter table public.agent_executions add column if not exists inflight jsonb;

-- ---------------------------------------------------------------------
-- 7. RLS deny-by-default + no privileges for public roles
-- ---------------------------------------------------------------------
alter table public.workflows          enable row level security;
alter table public.workflow_versions  enable row level security;
alter table public.workflow_runs      enable row level security;
alter table public.workflow_run_steps enable row level security;
alter table public.workflow_jobs      enable row level security;

do $$
declare r text;
begin
  execute 'revoke all on function public.claim_workflow_job(text, integer) from public';
  execute 'revoke all on function public.heartbeat_workflow_job(uuid, text, integer) from public';
  execute 'revoke all on function public.release_workflow_job(uuid, text, text, integer, text) from public';
  execute 'revoke all on function public.workflow_versions_immutable() from public';
  foreach r in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on public.workflows, public.workflow_versions, public.workflow_runs, public.workflow_run_steps, public.workflow_jobs from %I', r);
      execute format('revoke all on function public.claim_workflow_job(text, integer) from %I', r);
      execute format('revoke all on function public.heartbeat_workflow_job(uuid, text, integer) from %I', r);
      execute format('revoke all on function public.release_workflow_job(uuid, text, text, integer, text) from %I', r);
    end if;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function public.claim_workflow_job(text, integer) to service_role';
    execute 'grant execute on function public.heartbeat_workflow_job(uuid, text, integer) to service_role';
    execute 'grant execute on function public.release_workflow_job(uuid, text, text, integer, text) to service_role';
  end if;
end $$;
