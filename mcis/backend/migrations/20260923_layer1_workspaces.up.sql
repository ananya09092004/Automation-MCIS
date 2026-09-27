-- =====================================================================
-- Nexus Layer 1 — Secure Multi-Tenant Foundation (UP)
-- =====================================================================
-- Run once in the Supabase SQL editor (or psql) BEFORE deploying the
-- backend that contains routes/workspaces.js.
--
-- Safe to re-run: every statement is idempotent (IF NOT EXISTS /
-- ON CONFLICT DO NOTHING).
--
-- This migration ONLY ADDS three new tables. It does not alter, lock
-- or rewrite any existing table. Existing per-user data (chats,
-- memories, goals, device tokens, ...) keeps working exactly as before.
--
-- Rollback: 20260923_layer1_workspaces.down.sql
-- =====================================================================

-- gen_random_uuid() is built into PostgreSQL 13+. pgcrypto is only created
-- where the server offers it (Supabase does); no placeholder extension is
-- ever required (Layer 9).
do $pgc$
begin
  if exists (select 1 from pg_available_extensions where name = 'pgcrypto') then
    create extension if not exists pgcrypto;
  end if;
end $pgc$;

-- ---------------------------------------------------------------------
-- workspaces (the tenant / organization)
-- ---------------------------------------------------------------------
create table if not exists public.workspaces (
  id           uuid primary key default gen_random_uuid(),
  name         text not null check (char_length(btrim(name)) between 1 and 100),
  owner_id     text not null,                          -- Firebase uid
  is_personal  boolean not null default false,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- Exactly one personal workspace per user (also makes lazy creation race-safe).
create unique index if not exists workspaces_one_personal_per_owner
  on public.workspaces (owner_id) where is_personal;

-- ---------------------------------------------------------------------
-- workspace_members (who belongs to which tenant, with what role)
-- ---------------------------------------------------------------------
create table if not exists public.workspace_members (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id      text not null,                          -- Firebase uid
  role         text not null check (role in ('owner', 'admin', 'member')),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  primary key (workspace_id, user_id)
);

create index if not exists workspace_members_user_idx
  on public.workspace_members (user_id);

-- A workspace can never have two owners.
create unique index if not exists workspace_members_single_owner
  on public.workspace_members (workspace_id) where role = 'owner';

-- ---------------------------------------------------------------------
-- workspace_invitations
-- Only a SHA-256 hash of the invite token is stored; the raw token is
-- returned once to the inviter and never persisted.
-- ---------------------------------------------------------------------
create table if not exists public.workspace_invitations (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  email        text not null check (email = lower(email) and position('@' in email) > 1),
  role         text not null check (role in ('admin', 'member')),   -- never 'owner'
  token_hash   text not null unique check (char_length(token_hash) = 64),
  invited_by   text not null,
  status       text not null default 'pending'
               check (status in ('pending', 'accepted', 'revoked')),
  expires_at   timestamptz not null,
  accepted_by  text,
  accepted_at  timestamptz,
  created_at   timestamptz not null default now()
);

create index if not exists workspace_invitations_workspace_idx
  on public.workspace_invitations (workspace_id);

-- At most one pending invite per (workspace, email).
create unique index if not exists workspace_invitations_one_pending
  on public.workspace_invitations (workspace_id, email) where status = 'pending';

-- ---------------------------------------------------------------------
-- Row Level Security: deny-by-default.
-- No policies are created, so the public `anon` / `authenticated`
-- Supabase roles can neither read nor write these tables. The backend
-- must use the service_role key (it bypasses RLS) and enforces
-- tenant isolation itself in services/workspaceService.js.
-- ---------------------------------------------------------------------
alter table public.workspaces            enable row level security;
alter table public.workspace_members     enable row level security;
alter table public.workspace_invitations enable row level security;

do $$
declare r text;
begin
  foreach r in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on public.workspaces, public.workspace_members, public.workspace_invitations from %I', r);
    end if;
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- Backfill: give every EXISTING user a personal workspace (role=owner).
-- Users are Firebase uids stored as user_id in the existing tables; there
-- is no users table, so we collect distinct user_ids from the known
-- per-user tables that actually exist in this database. Any user missed
-- here is still covered: the backend lazily creates the personal
-- workspace on first /api/workspaces call.
-- ---------------------------------------------------------------------
do $$
declare
  t text;
  src_tables text[] := array[
    'chats', 'conversations', 'user_memories', 'user_profiles',
    'user_preferences', 'goals', 'notifications', 'device_tokens',
    'user_permissions', 'daily_usage', 'audit_log', 'events'
  ];
begin
  create temporary table if not exists _layer1_uids (user_id text primary key) on commit drop;

  foreach t in array src_tables loop
    if exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = t and column_name = 'user_id'
    ) then
      execute format(
        'insert into _layer1_uids (user_id)
           select distinct user_id::text from public.%I
           where user_id is not null and btrim(user_id::text) <> ''''
         on conflict do nothing', t);
    end if;
  end loop;

  insert into public.workspaces (name, owner_id, is_personal)
    select 'Personal', u.user_id, true from _layer1_uids u
  on conflict do nothing;

  insert into public.workspace_members (workspace_id, user_id, role)
    select w.id, w.owner_id, 'owner' from public.workspaces w
    where w.is_personal
  on conflict do nothing;
end $$;
