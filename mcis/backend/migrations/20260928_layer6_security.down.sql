-- =====================================================================
-- Nexus Layer 6 — Enterprise Security + Agent Firewall (DOWN / ROLLBACK)
-- =====================================================================
-- Roll back the CODE first (the Layer 6 code calls the *_v2 job RPCs and
-- writes the new columns), then run this.
--
-- Deleted permanently: workspace security policies, workspace API keys
-- (all keys stop working), OAuth states, rate-limit counters.
-- Dropped columns: agent_executions.lease_expires_at / workflow_context,
-- agent_execution_approvals.binding_hash / policy_version,
-- workflow_jobs.lease_fence. Every Layer 1–5 row is kept.
-- The legacy user_integrations trigger is removed; tokens that were
-- migrated stay encrypted in the Layer 5 integration store (they are NOT
-- written back as plaintext).
-- =====================================================================

begin;

do $$
begin
  if to_regclass('public.user_integrations') is not null then
    drop trigger if exists user_integrations_no_plaintext_token on public.user_integrations;
  end if;
end $$;
drop function if exists public.user_integrations_no_plaintext_token();

drop function if exists public.claim_workflow_job_v2(text, integer);
drop function if exists public.heartbeat_workflow_job_v2(uuid, text, bigint, integer);
drop function if exists public.release_workflow_job_v2(uuid, text, bigint, text, integer, text);
drop function if exists public.consume_oauth_state(text);
drop function if exists public.security_rate_limit_hit(text, integer, integer);

drop table if exists public.security_rate_limits;
drop table if exists public.oauth_states;
drop table if exists public.workspace_api_keys;
drop table if exists public.workspace_security_policies;

alter table if exists public.workflow_jobs drop column if exists lease_fence;
alter table if exists public.agent_execution_approvals drop column if exists binding_hash;
alter table if exists public.agent_execution_approvals drop column if exists policy_version;
alter table if exists public.agent_executions drop column if exists lease_expires_at;
alter table if exists public.agent_executions drop column if exists workflow_context;

commit;
