-- =====================================================================
-- Nexus Layer 4 — Workflows + Durable Execution (DOWN / ROLLBACK)
-- =====================================================================
-- Roll back the CODE first (or set WORKFLOWS_ENABLED=false so the worker
-- and routes are not started/mounted), then run this.
--
-- Preserved: every Layer 1/2/3 table and row. agent_executions rows that
-- were started by workflow steps stay (with their evidence); they simply
-- lose the link back to the run. Only the added `inflight` column is
-- dropped from agent_executions.
--
-- Deleted permanently: workflows, workflow_versions, workflow_runs,
-- workflow_run_steps, workflow_jobs (export first if needed). Tasks that
-- runs created are Layer 2 rows and are kept.
-- =====================================================================

begin;

drop function if exists public.claim_workflow_job(text, integer);
drop function if exists public.heartbeat_workflow_job(uuid, text, integer);
drop function if exists public.release_workflow_job(uuid, text, text, integer, text);

drop table if exists public.workflow_jobs;
drop table if exists public.workflow_run_steps;
drop table if exists public.workflow_runs;

do $$
begin
  if to_regclass('public.workflows') is not null then
    alter table public.workflows drop constraint if exists workflows_active_version_fk;
  end if;
end $$;

drop table if exists public.workflow_versions;
drop function if exists public.workflow_versions_immutable();
drop table if exists public.workflows;

do $$
begin
  if to_regclass('public.agent_executions') is not null then
    alter table public.agent_executions drop column if exists inflight;
  end if;
end $$;

commit;
