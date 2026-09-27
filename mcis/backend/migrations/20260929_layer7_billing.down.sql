-- =====================================================================
-- Nexus Layer 7 — usage / plans / subscriptions (DOWN / ROLLBACK)
-- =====================================================================
-- Roll back the CODE first (it writes usage events and reads plans), then
-- run this. Deleted permanently: the usage ledger, reservations, webhook
-- ledger, subscriptions and the plan catalogue. Every Layer 1–6 row is kept.
-- =====================================================================

begin;

drop function if exists public.billing_reserve_usage(uuid, text, integer, bigint, timestamptz, timestamptz, text, integer);
drop function if exists public.billing_record_usage(uuid, text, integer, text, text, text, text, uuid);
drop function if exists public.billing_release_reservation(uuid, uuid);
drop function if exists public.billing_usage_totals(uuid, timestamptz, timestamptz);
drop function if exists public.billing_usage_daily(uuid, timestamptz, timestamptz);

drop table if exists public.billing_webhook_events;
drop table if exists public.usage_reservations;
do $$
begin
  if to_regclass('public.usage_events') is not null then
    drop trigger if exists usage_events_no_change on public.usage_events;
  end if;
end $$;
drop table if exists public.usage_events;
drop function if exists public.usage_events_immutable();
drop table if exists public.workspace_subscriptions;
drop table if exists public.billing_plans;

commit;
