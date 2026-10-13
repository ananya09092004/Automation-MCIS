-- =====================================================================
-- Nexus Layer 2 — Workspace Data Scoping & Collaboration Foundation (UP)
-- =====================================================================
-- Requires: Layer 1 (workspaces) and Layer 3 (agent_executions).
-- Idempotent: every statement is guarded (IF [NOT] EXISTS / DO blocks).
--
-- What this does
--   1. Adds a NULLABLE workspace_id to existing business-data tables
--      (chats, conversations, user_memories, memory_vectors, goals,
--      goal_breakdowns) and back-fills it with each row owner's PERSONAL
--      workspace. No existing column/row is modified other than filling
--      the new column; rows without an owner (user_id NULL) stay NULL.
--      NULL keeps meaning "personal/legacy" in the backend, so the voice
--      pipeline (which never sets workspace_id) keeps working unchanged.
--   2. Adds workspace_id to audit_log (attribution only, no FK).
--   3. Creates workspace_tasks, workspace_task_activity and
--      workspace_permission_grants (RLS deny-by-default).
--   4. Links agent_executions → workspace_tasks via (task_id, workspace_id).
--   5. Creates search_memories_scoped() (only if memory_vectors.embedding
--      is a pgvector column), executable by service_role only.
--
-- Rollback: 20260925_layer2_workspace_data_scoping.down.sql
-- =====================================================================

-- ---------------------------------------------------------------------
-- 0. Make sure every owner found in the tables below has a personal
--    workspace (Layer 1 already did this for most tables; memory_vectors
--    and goal_breakdowns were not in its list).
-- ---------------------------------------------------------------------
do $$
declare
  t text;
  src text[] := array['chats','conversations','user_memories','memory_vectors','goals','goal_breakdowns'];
begin
  foreach t in array src loop
    if exists (select 1 from information_schema.columns
               where table_schema = 'public' and table_name = t and column_name = 'user_id') then
      execute format(
        'insert into public.workspaces (name, owner_id, is_personal)
           select distinct ''Personal'', user_id::text, true from public.%I
           where user_id is not null and btrim(user_id::text) <> ''''
         on conflict do nothing', t);
    end if;
  end loop;

  insert into public.workspace_members (workspace_id, user_id, role)
    select w.id, w.owner_id, 'owner' from public.workspaces w where w.is_personal
  on conflict do nothing;
end $$;

-- ---------------------------------------------------------------------
-- 1. workspace_id on existing business-data tables + backfill
-- ---------------------------------------------------------------------
do $$
declare
  t text;
  scoped text[] := array['chats','conversations','user_memories','memory_vectors','goals','goal_breakdowns'];
begin
  foreach t in array scoped loop
    if to_regclass(format('public.%I', t)) is null then
      raise notice 'Layer 2: table % not found — skipped', t;
      continue;
    end if;

    execute format('alter table public.%I add column if not exists workspace_id uuid
                    references public.workspaces(id) on delete cascade', t);
    execute format('create index if not exists %I on public.%I (workspace_id)', t || '_workspace_id_idx', t);

    if exists (select 1 from information_schema.columns
               where table_schema = 'public' and table_name = t and column_name = 'user_id') then
      execute format('create index if not exists %I on public.%I (user_id, workspace_id)', t || '_user_ws_idx', t);
      execute format(
        'update public.%I x set workspace_id = w.id
           from public.workspaces w
          where x.workspace_id is null
            and x.user_id is not null
            and w.is_personal
            and w.owner_id = x.user_id::text', t);
    end if;
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- 2. audit_log attribution
-- ---------------------------------------------------------------------
do $$
begin
  if to_regclass('public.audit_log') is not null then
    alter table public.audit_log add column if not exists workspace_id uuid;
    create index if not exists audit_log_workspace_created_idx on public.audit_log (workspace_id, created_at desc);
  end if;
end $$;

-- ---------------------------------------------------------------------
-- 3. Collaboration: tasks + activity (comments / history)
-- ---------------------------------------------------------------------
create table if not exists public.workspace_tasks (
  id               uuid primary key default gen_random_uuid(),
  workspace_id     uuid not null references public.workspaces(id) on delete cascade,
  title            text not null check (char_length(btrim(title)) between 1 and 200),
  description      text not null default '' check (char_length(description) <= 5000),
  status           text not null default 'todo'
                   check (status in ('todo','in_progress','blocked','done','cancelled')),
  priority         text not null default 'medium'
                   check (priority in ('low','medium','high','urgent')),
  created_by       text not null,
  assignee_type    text check (assignee_type in ('human','agent')),
  assignee_user_id text,
  version          integer not null default 0,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  completed_at     timestamptz,
  unique (id, workspace_id),
  -- a human assignee needs a user; an agent/unassigned task must not carry one
  check ((assignee_type = 'human' and assignee_user_id is not null)
      or (assignee_type is distinct from 'human' and assignee_user_id is null))
);

create index if not exists workspace_tasks_ws_created_idx on public.workspace_tasks (workspace_id, created_at desc);
create index if not exists workspace_tasks_ws_status_idx  on public.workspace_tasks (workspace_id, status);
create index if not exists workspace_tasks_ws_assignee_idx on public.workspace_tasks (workspace_id, assignee_user_id);

create table if not exists public.workspace_task_activity (
  id           uuid primary key default gen_random_uuid(),
  task_id      uuid not null,
  workspace_id uuid not null,
  actor_id     text not null,
  kind         text not null check (kind in
                 ('created','updated','assigned','status_changed','comment','execution_started')),
  body         text check (body is null or char_length(body) <= 5000),
  data         jsonb,
  created_at   timestamptz not null default now(),
  foreign key (task_id, workspace_id)
    references public.workspace_tasks (id, workspace_id) on delete cascade
);

create index if not exists workspace_task_activity_ws_task_idx
  on public.workspace_task_activity (workspace_id, task_id, created_at);

-- ---------------------------------------------------------------------
-- 4. Workspace-level resource grants (used by Layer 3 when
--    PERMISSIONS_ENFORCED=true). The legacy user_permissions table is
--    NOT changed — it keeps serving the voice/device path.
-- ---------------------------------------------------------------------
create table if not exists public.workspace_permission_grants (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references public.workspaces(id) on delete cascade,
  resource_name text not null check (char_length(resource_name) between 1 and 500),
  granted_by    text not null,
  created_at    timestamptz not null default now(),
  unique (workspace_id, resource_name)
);

-- ---------------------------------------------------------------------
-- 5. Task → execution link (Layer 3 table, additive nullable column)
-- ---------------------------------------------------------------------
do $$
begin
  if to_regclass('public.agent_executions') is null then
    raise exception 'Layer 2 requires Layer 3 (agent_executions). Apply 20260924_layer3_agent_executions.up.sql first.';
  end if;
  alter table public.agent_executions add column if not exists task_id uuid;
  if not exists (select 1 from pg_constraint where conname = 'agent_executions_task_fk') then
    alter table public.agent_executions
      add constraint agent_executions_task_fk foreign key (task_id, workspace_id)
      references public.workspace_tasks (id, workspace_id) on delete restrict;
  end if;
  create index if not exists agent_executions_ws_task_idx on public.agent_executions (workspace_id, task_id);
end $$;

-- ---------------------------------------------------------------------
-- 6. RLS deny-by-default on the NEW tables (same model as Layers 1 & 3).
--    Existing tables' RLS settings are intentionally left untouched.
-- ---------------------------------------------------------------------
alter table public.workspace_tasks             enable row level security;
alter table public.workspace_task_activity     enable row level security;
alter table public.workspace_permission_grants enable row level security;

do $$
declare r text;
begin
  foreach r in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on public.workspace_tasks, public.workspace_task_activity, public.workspace_permission_grants from %I', r);
    end if;
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- 7. Workspace-scoped memory search (pgvector). Mirrors the conventional
--    cosine-similarity RPC; only created when the column really is a
--    vector, so this migration never guesses at an unknown schema.
-- ---------------------------------------------------------------------
do $$
begin
  if exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'memory_vectors'
       and column_name = 'embedding' and udt_name = 'vector'
  ) then
    execute $f$
      create or replace function public.search_memories_scoped(
        query_embedding    vector,
        match_user_id      text,
        match_workspace_id uuid,
        include_unscoped   boolean,
        match_count        integer default 8
      ) returns table (content text, similarity double precision)
      language sql stable
      set search_path = public
      as $body$
        select m.content, 1 - (m.embedding <=> query_embedding) as similarity
          from public.memory_vectors m
         where m.user_id::text = match_user_id
           and (m.workspace_id = match_workspace_id
                or (include_unscoped and m.workspace_id is null))
         order by m.embedding <=> query_embedding
         limit least(greatest(match_count, 1), 50)
      $body$;
    $f$;
    revoke all on function public.search_memories_scoped(vector, text, uuid, boolean, integer) from public;
    if exists (select 1 from pg_roles where rolname = 'anon') then
      revoke all on function public.search_memories_scoped(vector, text, uuid, boolean, integer) from anon;
    end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then
      revoke all on function public.search_memories_scoped(vector, text, uuid, boolean, integer) from authenticated;
    end if;
    if exists (select 1 from pg_roles where rolname = 'service_role') then
      grant execute on function public.search_memories_scoped(vector, text, uuid, boolean, integer) to service_role;
    end if;
  else
    raise notice 'Layer 2: memory_vectors.embedding is not a pgvector column — search_memories_scoped not created (scoped memory search will fail closed for team workspaces).';
  end if;
end $$;
