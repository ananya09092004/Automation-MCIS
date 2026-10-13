-- =====================================================================
-- Nexus Layer 10 — revenue product suite (DOWN / ROLLBACK)
-- =====================================================================
-- Roll back the CODE first, then run this. Removes every Layer 10 table and
-- function, the agent columns on agent_executions / workspace_tasks, the
-- new plan limit keys and the two new usage metrics (usage rows of those
-- metrics are removed first — they cannot exist under the Layer 7
-- constraint). Every Layer 1–9 row is kept.
-- =====================================================================

begin;

drop function if exists public.purge_workspace_audit(uuid);
drop function if exists public.retention_purge_revenue(uuid, timestamptz, timestamptz);
drop function if exists public.enforce_integration_limit(uuid, uuid, integer);
drop function if exists public.enforce_monitored_product_limit(uuid, uuid, integer);
drop function if exists public.claim_webhook_deliveries(text, integer, integer);
drop function if exists public.claim_qa_result(text, integer);
drop function if exists public.claim_due_monitors(text, integer, integer);

drop table if exists public.webhook_deliveries;
drop table if exists public.workspace_webhooks;
drop table if exists public.qa_results;
drop table if exists public.qa_runs;
drop table if exists public.qa_scenarios;
drop table if exists public.qa_suites;
drop table if exists public.qa_projects;
drop table if exists public.alert_deliveries;
drop table if exists public.alerts;
drop table if exists public.alert_rules;
drop table if exists public.ci_recommendations;
drop table if exists public.ci_competitor_products;
drop table if exists public.ci_products;
drop table if exists public.monitor_changes;
drop table if exists public.monitor_snapshots;
drop table if exists public.monitor_observations;
drop table if exists public.monitors;

alter table public.workspace_tasks drop constraint if exists workspace_tasks_agent_assignee_ck;
alter table public.workspace_tasks drop constraint if exists workspace_tasks_agent_fk;
alter table public.agent_executions drop constraint if exists agent_executions_agent_fk;
drop index if exists public.agent_executions_ws_agent_idx;
alter table public.workspace_tasks drop column if exists assignee_agent_id;
alter table public.agent_executions drop column if exists agent_id;
drop table if exists public.workspace_agents;

-- Usage metrics back to the Layer 7 set (ledger rows of the Layer 10
-- metrics are deleted through the retention flag; nothing else is touched).
do $$
begin
  perform set_config('nexus.retention_purge', 'on', true);
  delete from public.usage_events where metric in ('monitoring_check','agent_test_scenario');
  perform set_config('nexus.retention_purge', 'off', true);
end $$;
delete from public.usage_reservations where metric in ('monitoring_check','agent_test_scenario');
alter table public.usage_events drop constraint if exists usage_events_metric_check;
alter table public.usage_events add constraint usage_events_metric_check check (metric in (
  'agent_execution','workflow_run','execution_step','connector_call','api_call',
  'execution_completed','execution_failed','execution_cancelled'));

update public.billing_plans
   set limits = limits - 'max_monitored_products' - 'monitoring_checks_per_month' - 'agent_test_scenarios_per_month' - 'max_integrations'
 where limits ?| array['max_monitored_products','monitoring_checks_per_month','agent_test_scenarios_per_month','max_integrations'];

commit;
