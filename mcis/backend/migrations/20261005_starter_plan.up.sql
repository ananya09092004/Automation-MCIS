-- =====================================================================
-- 20261005 — "Starter" plan (between Free and Pro)
--
-- Data only: one row in billing_plans + its features. No price is stored
-- (price = null, display only): online purchase becomes available when the
-- operator sets STRIPE_PRICE_STARTER (the Stripe provider maps
-- STRIPE_PRICE_<PLAN> → plan id). Limits use the same keys as the built-in
-- plans (Layers 7 + 10); number = cap, null = unlimited.
-- Idempotent: insert-only (an operator's edits are never overwritten).
-- =====================================================================
insert into public.billing_plans (id, name, description, limits, price, sort_order)
values ('starter', 'Starter', 'For individuals and small teams getting started with automation.',
  '{"executions_per_month":500,"workflow_runs_per_month":250,"api_calls_per_month":5000,"connector_calls_per_month":2500,"max_members":5,"max_active_workflows":10,"max_concurrent_executions":1,"usage_retention_days":60,"max_monitored_products":30,"monitoring_checks_per_month":12000,"agent_test_scenarios_per_month":500,"max_integrations":5}',
  null, 15)
on conflict (id) do nothing;

insert into public.billing_plan_features (plan_id, features)
values ('starter', '{"api_access":true,"integrations":true,"workflow_templates":true,"scheduled_workflows":true,"audit_log":true,"custom_limits":false,"manual_activation":false,"support":"email"}')
on conflict (plan_id) do nothing;
