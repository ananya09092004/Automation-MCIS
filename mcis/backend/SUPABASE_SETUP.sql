-- Run this once in Supabase SQL editor before deploying

create table device_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id text not null,
  device_id text not null,
  token text not null unique,
  created_at timestamptz default now(),
  unique(user_id, device_id)
);

create table user_permissions (
  id uuid primary key default gen_random_uuid(),
  user_id text not null,
  resource_name text not null,
  granted boolean default true,
  granted_at timestamptz default now(),
  unique(user_id, resource_name)
);

create table audit_log (
  id uuid primary key default gen_random_uuid(),
  user_id text not null,
  action text not null,
  payload jsonb,
  success boolean,
  error text,
  created_at timestamptz default now()
);

create table pairing_sessions (
  session_id text primary key,
  device_id text not null,
  approved boolean default false,
  token text,
  user_id text,
  created_at timestamptz default now()
);
