-- 20261005 down — removes the Starter plan only while no workspace uses it
-- (subscriptions and checkout sessions reference billing_plans).
delete from public.billing_plan_features where plan_id = 'starter'
  and not exists (select 1 from public.workspace_subscriptions where plan_id = 'starter')
  and not exists (select 1 from public.billing_checkout_sessions where plan_id = 'starter');
delete from public.billing_plans where id = 'starter'
  and not exists (select 1 from public.workspace_subscriptions where plan_id = 'starter')
  and not exists (select 1 from public.billing_checkout_sessions where plan_id = 'starter');
