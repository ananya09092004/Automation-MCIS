-- 20261004 down — intentionally a no-op.
--
-- The up migration only grants table privileges to service_role, the
-- backend's own server-side role. Revoking them would not restore a
-- previous "safe" state: on projects without default privileges it would
-- take the backend offline again (42501 on every Layer 1–7 table), and on
-- projects with default privileges it would remove grants Supabase itself
-- created. anon / authenticated were never granted anything here.
select 1;
