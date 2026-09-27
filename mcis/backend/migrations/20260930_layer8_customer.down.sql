-- =====================================================================
-- Nexus Layer 8 — customer onboarding / provider bindings (DOWN / ROLLBACK)
-- =====================================================================
-- Roll back the CODE first, then run this. Deleted permanently: onboarding
-- progress, payment-provider customer bindings, checkout-session records,
-- plan feature flags and Enterprise limit overrides. Every Layer 1–7 row
-- (workspaces, workflows, runs, executions, usage ledger, subscriptions,
-- plans, …) is kept.
-- =====================================================================

begin;

drop table if exists public.workspace_plan_overrides;
drop table if exists public.billing_plan_features;
drop table if exists public.billing_checkout_sessions;
drop table if exists public.billing_customers;
drop table if exists public.user_onboarding;

commit;
