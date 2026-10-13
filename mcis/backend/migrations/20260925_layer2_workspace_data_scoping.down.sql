-- =====================================================================
-- Nexus Layer 2 — Workspace Data Scoping & Collaboration (DOWN / ROLLBACK)
-- =====================================================================
-- Roll back the CODE first (or set WORKSPACE_DATA_SCOPING=off and remove
-- the tasks / workspace-admin mounts in server.js), then run this.
--
-- Preserved: every existing row and every pre-existing column of chats,
-- conversations, user_memories, memory_vectors, goals, goal_breakdowns,
-- audit_log and agent_executions. Only the ADDED workspace_id / task_id
-- columns are dropped (their values were derived from user_id and can be
-- recomputed by re-running the UP migration).
--
-- Deleted permanently: workspace_tasks, workspace_task_activity,
-- workspace_permission_grants (export first if needed).
-- =====================================================================

begin;

drop function if exists public.search_memories_scoped(vector, text, uuid, boolean, integer);

do $$
begin
  if to_regclass('public.agent_executions') is not null then
    alter table public.agent_executions drop constraint if exists agent_executions_task_fk;
    drop index if exists public.agent_executions_ws_task_idx;
    alter table public.agent_executions drop column if exists task_id;
  end if;
end $$;

drop table if exists public.workspace_task_activity;
drop table if exists public.workspace_permission_grants;
drop table if exists public.workspace_tasks;

do $$
declare
  t text;
  scoped text[] := array['chats','conversations','user_memories','memory_vectors','goals','goal_breakdowns','audit_log'];
begin
  foreach t in array scoped loop
    if to_regclass(format('public.%I', t)) is not null then
      execute format('drop index if exists public.%I', t || '_user_ws_idx');
      execute format('drop index if exists public.%I', t || '_workspace_id_idx');
      execute format('alter table public.%I drop column if exists workspace_id', t);
    end if;
  end loop;
  drop index if exists public.audit_log_workspace_created_idx;
end $$;

commit;
