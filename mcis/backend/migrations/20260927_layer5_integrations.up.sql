-- =====================================================================
-- Nexus Layer 5 — Integrations, Credentials & Connectors (UP)
-- =====================================================================
-- Requires Layer 1 (workspaces). Idempotent: safe to re-run.
-- Rollback: 20260927_layer5_integrations.down.sql
--
--   integrations             one connection to one provider, in ONE workspace
--                            (metadata + non-secret config only)
--   integration_credentials  AES-256-GCM ciphertext ONLY (never plaintext);
--                            separate table so no business query touches it
--   integration_permissions  per-action enablement / approval / minimum role
--
-- Composite FKs pin credentials and permissions to their integration's
-- workspace. RLS deny-by-default; anon/authenticated have no privileges.
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

do $$
begin
  if to_regclass('public.workspaces') is null then
    raise exception 'Layer 5 requires Layer 1 (workspaces).';
  end if;
end $$;

create table if not exists public.integrations (
  id              uuid primary key default gen_random_uuid(),
  workspace_id    uuid not null references public.workspaces(id) on delete cascade,
  provider        text not null check (provider ~ '^[a-z][a-z0-9_]{1,31}$'),
  name            text not null check (char_length(btrim(name)) between 1 and 80),
  status          text not null default 'disconnected'
                    check (status in ('disconnected','connected','revoked','error')),
  config          jsonb not null default '{}'::jsonb,        -- NON-secret, validated by the connector
  created_by      text not null,
  last_used_at    timestamptz,
  last_checked_at timestamptz,
  last_error      text check (last_error is null or char_length(last_error) <= 500),
  version         integer not null default 0,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (id, workspace_id)
);
create unique index if not exists integrations_ws_name_uq on public.integrations (workspace_id, lower(name));
create index if not exists integrations_ws_created_idx on public.integrations (workspace_id, created_at desc);

create table if not exists public.integration_credentials (
  integration_id uuid primary key,                         -- one active credential per integration
  workspace_id   uuid not null,
  key_id         text not null check (key_id ~ '^[A-Za-z0-9_.-]{1,64}$'),
  algorithm      text not null check (algorithm = 'aes-256-gcm'),
  iv             text not null check (char_length(iv) between 8 and 64),
  auth_tag       text not null check (char_length(auth_tag) between 8 and 64),
  ciphertext     text not null check (char_length(ciphertext) between 1 and 20000),
  created_by     text not null,
  created_at     timestamptz not null default now(),
  foreign key (integration_id, workspace_id) references public.integrations (id, workspace_id) on delete cascade
);

create table if not exists public.integration_permissions (
  integration_id uuid not null,
  workspace_id   uuid not null,
  action         text not null check (action ~ '^[a-z][a-z0-9_]{1,63}$'),
  enabled        boolean not null default false,
  approval       text not null default 'default' check (approval in ('default','required','admin')),
  min_role       text not null default 'member' check (min_role in ('member','admin','owner')),
  updated_by     text not null,
  updated_at     timestamptz not null default now(),
  primary key (integration_id, action),
  foreign key (integration_id, workspace_id) references public.integrations (id, workspace_id) on delete cascade
);

alter table public.integrations            enable row level security;
alter table public.integration_credentials enable row level security;
alter table public.integration_permissions enable row level security;

do $$
declare r text;
begin
  foreach r in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on public.integrations, public.integration_credentials, public.integration_permissions from %I', r);
    end if;
  end loop;
end $$;
