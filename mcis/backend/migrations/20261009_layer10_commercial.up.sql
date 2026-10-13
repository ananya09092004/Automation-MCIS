-- Layer 10 — commercial pass: a `reports_generated` usage dimension for
-- the new reports/export surface (services/revenue/competitorService.js
-- `report()`), metered through the SAME billing ledger as every other
-- capability — no second entitlement authority, no client-controlled
-- billing. Idempotent: safe to run more than once.

-- 1. Allow the new metric in the usage_events check constraint, the same
--    way the Layer 10 migration extended Layer 7's constraint.
do $$
declare c text;
begin
  select conname into c from pg_constraint
   where conrelid = 'public.usage_events'::regclass and contype = 'c' and pg_get_constraintdef(oid) like '%agent_execution%';
  if c is not null then execute format('alter table public.usage_events drop constraint %I', c); end if;
  alter table public.usage_events add constraint usage_events_metric_check check (metric in (
    'agent_execution','workflow_run','execution_step','connector_call','api_call',
    'execution_completed','execution_failed','execution_cancelled',
    'monitoring_check','agent_test_scenario','report_generated'));
end $$;

-- 2. New limit key is ADDED to the built-in plans only (existing keys and
--    operator-set values are never overwritten). `reports_generated` is an
--    `optional` capability in plans.js, so a plan row without this key
--    (any custom plan created before this migration) stays unlimited.
update public.billing_plans p set limits = x.add || p.limits
  from (values
    ('free',       '{"reports_generated_per_month":200}'::jsonb),
    ('pro',        '{"reports_generated_per_month":5000}'::jsonb),
    ('business',   '{"reports_generated_per_month":50000}'::jsonb),
    ('enterprise', '{"reports_generated_per_month":null}'::jsonb)
  ) as x(id, add)
 where p.id = x.id;
