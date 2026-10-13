-- Reverts 20261009_layer10_commercial.up.sql.

alter table public.usage_events drop constraint if exists usage_events_metric_check;
alter table public.usage_events add constraint usage_events_metric_check check (metric in (
  'agent_execution','workflow_run','execution_step','connector_call','api_call',
  'execution_completed','execution_failed','execution_cancelled',
  'monitoring_check','agent_test_scenario'));

update public.billing_plans set limits = limits - 'reports_generated_per_month';
