-- =====================================================================
-- Nexus Layer 1 — Secure Multi-Tenant Foundation (DOWN / ROLLBACK)
-- =====================================================================
-- Removes ONLY the three tables added by 20260923_layer1_workspaces.up.sql.
-- No existing table (chats, memories, goals, device_tokens, ...) is
-- touched, so all pre-Layer-1 data and behaviour is preserved.
--
-- WARNING: this permanently deletes all workspaces, memberships and
-- invitations. Export them first if you may want them back:
--   copy (select * from public.workspaces)            to stdout with csv header;
--   copy (select * from public.workspace_members)     to stdout with csv header;
--   copy (select * from public.workspace_invitations) to stdout with csv header;
--
-- Roll back the CODE first (remove the /api/workspaces mount in
-- server.js, or deploy the previous build), then run this file.
-- =====================================================================

begin;
drop table if exists public.workspace_invitations;
drop table if exists public.workspace_members;
drop table if exists public.workspaces;
commit;
