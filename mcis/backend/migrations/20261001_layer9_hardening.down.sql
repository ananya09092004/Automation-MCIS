-- =====================================================================
-- Nexus Layer 9 — production hardening (DOWN / ROLLBACK)
-- =====================================================================
-- Roll back the CODE first, then run this. Removed: the ownership-transfer,
-- retention-purge and count-limit functions, retention settings and worker heartbeats.
-- The Layer 7 usage-ledger trigger function is restored to its Layer 7
-- body (no purge exception). Rows already purged by retention are not
-- restored. Every other Layer 1–8 row is kept.
-- =====================================================================

begin;

drop function if exists public.retention_purge_workspace(uuid, timestamptz, timestamptz, timestamptz);
drop function if exists public.transfer_workspace_ownership(uuid, text, text);
drop function if exists public.enforce_active_workflow_limit(uuid, uuid, integer, text, uuid, timestamptz);
drop function if exists public.enforce_member_limit(uuid, uuid, integer);
drop table if exists public.worker_heartbeats;
drop table if exists public.workspace_retention_policies;

-- Restore the Layer 7 body verbatim (byte-identical to 20260929_layer7_billing.up.sql).
create or replace function public.usage_events_immutable() returns trigger
language plpgsql as $$
begin
  if tg_op = 'UPDATE' then
    raise exception 'usage events are immutable' using errcode = '42501';
  end if;
  if exists (select 1 from public.workspaces w where w.id = old.workspace_id) then
    raise exception 'usage events are immutable' using errcode = '42501';
  end if;
  return old;
end $$;

commit;
