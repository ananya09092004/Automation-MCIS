-- =====================================================================
-- 20261004 — explicit table privileges for the backend role (service_role)
--
-- Problem (found in production on a new Supabase project):
--   Layers 1–7 created their tables without an explicit GRANT to
--   service_role and relied on Supabase's *default privileges*. Projects
--   where new tables are not automatically exposed to the API roles do not
--   apply those defaults, so the backend (service_role / sb_secret_ key)
--   got "42501 permission denied for table workspaces" and every Nexus
--   API call on Layer 1–7 tables failed with a 500. Layers 8–10 already
--   grant explicitly, which is why /health/ready (worker_heartbeats) worked.
--
-- Fix: grant SELECT/INSERT/UPDATE/DELETE on every table in schema public,
-- and USAGE/SELECT on every sequence, to service_role — the server-only
-- role the backend uses (it already bypasses RLS). anon / authenticated
-- are NOT touched: they keep no privileges (RLS + revokes stay in force).
--
-- Also sets DEFAULT privileges (service_role only) for tables / sequences
-- the current role creates later in schema public, so a future migration
-- or setup script cannot reintroduce the problem. Run this migration LAST
-- (after SUPABASE_SETUP.sql and every other *.up.sql) on existing projects.
--
-- Safe: additive only, no data or schema change, idempotent (re-running
-- grants that already exist is a no-op). Runs as the table owner
-- (Supabase SQL editor role `postgres`).
-- =====================================================================
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant usage on schema public to service_role';
    execute 'grant select, insert, update, delete on all tables in schema public to service_role';
    execute 'grant usage, select on all sequences in schema public to service_role';
    begin
      execute 'alter default privileges in schema public grant select, insert, update, delete on tables to service_role';
      execute 'alter default privileges in schema public grant usage, select on sequences to service_role';
    exception when insufficient_privilege then
      raise notice 'default privileges not changed (insufficient privilege); explicit grants above still applied';
    end;
  end if;
end $$;
