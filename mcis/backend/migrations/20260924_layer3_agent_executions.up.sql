-- =====================================================================
-- Nexus Layer 3 — Agent Execution & Verification (UP)
-- =====================================================================
-- Requires Layer 1 (public.workspaces) to be applied first.
-- Idempotent: safe to re-run. Adds three new tables only; no existing
-- table is altered.
-- Rollback: 20260924_layer3_agent_executions.down.sql
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

-- ---------------------------------------------------------------------
-- agent_executions — one row per workspace task run
-- ---------------------------------------------------------------------
create table if not exists public.agent_executions (
  id                  uuid primary key default gen_random_uuid(),
  workspace_id        uuid not null references public.workspaces(id) on delete cascade,
  created_by          text not null,                         -- Firebase uid (server-resolved)
  goal                text not null check (char_length(goal) between 1 and 4000),  -- REDACTED copy
  goal_hash           text not null check (char_length(goal_hash) = 64),
  status              text not null default 'created' check (status in
                        ('created','planning','waiting_approval','executing','verifying',
                         'completed','failed','cancelled')),
  idempotency_key     text check (idempotency_key is null or char_length(idempotency_key) between 8 and 128),
  current_step        integer not null default 0 check (current_step >= 0),
  steps_executed      integer not null default 0 check (steps_executed >= 0),
  max_steps           integer not null check (max_steps between 1 and 100),
  pending_approval_id uuid,
  result              jsonb,
  failure_code        text,
  failure_message     text,
  verification        jsonb,
  runner_id           text,
  version             integer not null default 0,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  started_at          timestamptz,
  finished_at         timestamptz,
  unique (id, workspace_id)            -- target for composite FKs below
);

create index if not exists agent_executions_ws_created_idx
  on public.agent_executions (workspace_id, created_at desc);

-- Duplicate request protection: an idempotency key is unique per workspace.
create unique index if not exists agent_executions_idempotency
  on public.agent_executions (workspace_id, idempotency_key) where idempotency_key is not null;

-- Concurrency safety: at most ONE non-terminal execution per workspace.
create unique index if not exists agent_executions_one_active_per_ws
  on public.agent_executions (workspace_id)
  where status in ('created','planning','waiting_approval','executing','verifying');

-- ---------------------------------------------------------------------
-- agent_execution_steps — structured, REDACTED evidence per step
-- ---------------------------------------------------------------------
create table if not exists public.agent_execution_steps (
  id            uuid primary key default gen_random_uuid(),
  execution_id  uuid not null,
  workspace_id  uuid not null,
  step_index    integer not null check (step_index >= 0),
  action        text not null,
  tool          text,                                          -- desktop | browser | ...
  risk_tier     text not null check (risk_tier in ('green','yellow','red')),
  status        text not null check (status in ('succeeded','failed')),
  attempts      integer not null default 1 check (attempts between 1 and 10),
  output        jsonb,                                         -- redacted summary
  verification  jsonb not null,                                -- {status, note}
  error_code    text,
  error_message text,
  recovery      jsonb,
  approval_id   uuid,
  started_at    timestamptz not null,
  finished_at   timestamptz not null,
  created_at    timestamptz not null default now(),
  unique (execution_id, step_index),
  -- the step's workspace MUST equal its execution's workspace
  foreign key (execution_id, workspace_id)
    references public.agent_executions (id, workspace_id) on delete cascade
);

create index if not exists agent_execution_steps_ws_exec_idx
  on public.agent_execution_steps (workspace_id, execution_id, step_index);

-- ---------------------------------------------------------------------
-- agent_execution_approvals — human approval gates
-- ---------------------------------------------------------------------
create table if not exists public.agent_execution_approvals (
  id            uuid primary key default gen_random_uuid(),
  execution_id  uuid not null,
  workspace_id  uuid not null,
  step_index    integer not null check (step_index >= 0),
  action        text not null,
  risk_tier     text not null check (risk_tier in ('green','yellow','red')),
  reason        text not null,
  step_hash     text not null check (char_length(step_hash) = 64),
  step_summary  jsonb,                                         -- redacted
  required_role text not null check (required_role in ('creator_or_admin','admin')),
  status        text not null default 'pending' check (status in
                  ('pending','approved','rejected','expired','superseded')),
  decided_by    text,
  decision_note text,
  expires_at    timestamptz not null,
  decided_at    timestamptz,
  created_at    timestamptz not null default now(),
  foreign key (execution_id, workspace_id)
    references public.agent_executions (id, workspace_id) on delete cascade
);

create index if not exists agent_execution_approvals_ws_exec_idx
  on public.agent_execution_approvals (workspace_id, execution_id);

-- At most one pending approval per execution.
create unique index if not exists agent_execution_approvals_one_pending
  on public.agent_execution_approvals (execution_id) where status = 'pending';

-- ---------------------------------------------------------------------
-- RLS: deny-by-default (same model as Layer 1). Backend uses service_role
-- and enforces workspace authorization in services/agentExecution/.
-- ---------------------------------------------------------------------
alter table public.agent_executions          enable row level security;
alter table public.agent_execution_steps     enable row level security;
alter table public.agent_execution_approvals enable row level security;

do $$
declare r text;
begin
  foreach r in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on public.agent_executions, public.agent_execution_steps, public.agent_execution_approvals from %I', r);
    end if;
  end loop;
end $$;
