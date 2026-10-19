-- =====================================================================
-- Final hardening — deny-by-default for LEGACY tables (UP)
-- =====================================================================
-- The Layer 1–10 migrations enable RLS and revoke anon/authenticated
-- access on their own tables. The legacy MCIS tables created from
-- SUPABASE_SETUP.sql / the Supabase SQL editor (device_tokens,
-- pairing_sessions, chats, user_memories, memory_vectors, goals,
-- notifications, user_permissions, user_integrations, …) were never
-- covered. On Supabase, tables created in `public` are granted to anon and
-- authenticated by default; without RLS, anyone holding the project's
-- public anon key could read or write them (e.g. desktop-agent tokens).
--
-- No client uses the anon key: the backend uses the service-role key
-- (BYPASSRLS) for every query, and the web apps never talk to Supabase
-- directly. So this changes nothing for the application.
--
-- What it does, for every table in schema public:
--   - ENABLE ROW LEVEL SECURITY (no policies = deny for non-bypass roles)
--   - REVOKE ALL from anon and authenticated (if those roles exist)
-- and for every non-extension function in public:
--   - REVOKE EXECUTE from public / anon / authenticated, GRANT to service_role
-- Idempotent: safe to re-run. Requires: nothing (works with or without
-- the Layer 1–10 tables). Rollback: see the .down.sql (intentionally a no-op).
-- =====================================================================

do $$
declare
  t record;
  f record;
  r text;
begin
  for t in
    select c.relname from pg_class c
    where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p')
  loop
    execute format('alter table public.%I enable row level security', t.relname);
    foreach r in array array['anon', 'authenticated'] loop
      if exists (select 1 from pg_roles where rolname = r) then
        execute format('revoke all on table public.%I from %I', t.relname, r);
      end if;
    end loop;
  end loop;

  for f in
    select p.oid::regprocedure::text as sig
    from pg_proc p
    where p.pronamespace = 'public'::regnamespace
      and p.prokind in ('f', 'p')
      and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')  -- skip extension functions (pgvector, pgcrypto)
  loop
    execute format('revoke all on function %s from public', f.sig);
    foreach r in array array['anon', 'authenticated'] loop
      if exists (select 1 from pg_roles where rolname = r) then
        execute format('revoke all on function %s from %I', f.sig, r);
      end if;
    end loop;
    if exists (select 1 from pg_roles where rolname = 'service_role') then
      execute format('grant execute on function %s to service_role', f.sig);
    end if;
  end loop;
end $$;
