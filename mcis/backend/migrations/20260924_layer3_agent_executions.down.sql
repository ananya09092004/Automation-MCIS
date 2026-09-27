-- =====================================================================
-- Nexus Layer 3 — Agent Execution & Verification (DOWN / ROLLBACK)
-- =====================================================================
-- Drops ONLY the three Layer 3 tables. Layer 1 tables and all
-- pre-existing data are untouched. Permanently deletes execution
-- history/evidence/approvals — export first if needed.
-- Roll back the code first (remove the executions mount in server.js).
-- =====================================================================

begin;
drop table if exists public.agent_execution_approvals;
drop table if exists public.agent_execution_steps;
drop table if exists public.agent_executions;
commit;
