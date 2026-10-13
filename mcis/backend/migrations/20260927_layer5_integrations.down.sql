-- =====================================================================
-- Nexus Layer 5 — Integrations (DOWN / ROLLBACK)
-- =====================================================================
-- Roll back the CODE first (or leave INTEGRATIONS_ENABLED unset/false),
-- then run this.
--
-- Deleted permanently: integrations, integration_credentials (encrypted
-- secrets) and integration_permissions. Every Layer 1–4 table and row is
-- preserved: executions and workflow evidence of connector steps stay
-- (they never contained credentials). Published workflow versions that
-- reference an integration id keep the id; runs of such steps fail safely
-- with INTEGRATIONS_DISABLED / INTEGRATION_NOT_FOUND.
-- =====================================================================

begin;
drop table if exists public.integration_permissions;
drop table if exists public.integration_credentials;
drop table if exists public.integrations;
commit;
