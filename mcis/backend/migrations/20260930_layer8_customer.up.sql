-- =====================================================================
-- Nexus Layer 8 — customer-ready SaaS: onboarding, payment-provider
-- bindings, plan features, enterprise limit overrides (UP)
-- =====================================================================
-- Requires Layers 1–7. Idempotent: safe to re-run.
-- Rollback: 20260930_layer8_customer.down.sql
--
--   user_onboarding            resumable first-run onboarding state (one row per user)
--   billing_customers          workspace ↔ payment-provider customer binding
--   billing_checkout_sessions  checkout sessions WE created (webhooks are matched against these)
--   billing_plan_features      per-plan capability flags (display + feature gates)
--   workspace_plan_overrides   operator-set custom limits (Enterprise)
--
-- No Layer 1–7 table, column, row, function or policy is altered.
-- All tables: RLS on, no policies, no privileges for anon / authenticated
-- (the backend uses the service role; clients never touch them directly).
-- =====================================================================

do $$
begin
  if to_regclass('public.workspaces') is null or to_regclass('public.billing_plans') is null
     or to_regclass('public.workflows') is null or to_regclass('public.workflow_runs') is null then
    raise exception 'Layer 8 requires Layers 1-7.';
  end if;
end $$;

-- ---------------------------------------------------------------------
-- 1. Onboarding (per user; references are workspace-scoped and nulled
--    when the referenced row disappears)
-- ---------------------------------------------------------------------
create table if not exists public.user_onboarding (
  user_id                text primary key check (char_length(user_id) between 1 and 128),
  step                   text not null default 'workspace'
                           check (step in ('workspace','team','use_case','template','first_run','done')),
  personal_workspace_id  uuid references public.workspaces(id) on delete set null,
  company_workspace_id   uuid references public.workspaces(id) on delete set null,
  invites_sent           integer not null default 0 check (invites_sent between 0 and 100),
  invites_skipped        boolean not null default false,
  use_case               text check (use_case is null or use_case ~ '^[a-z][a-z0-9_]{1,40}$'),
  template_id            text check (template_id is null or template_id ~ '^[a-z][a-z0-9_]{1,63}$'),
  first_workflow_id      uuid references public.workflows(id) on delete set null,
  first_run_id           uuid references public.workflow_runs(id) on delete set null,
  completed_at           timestamptz,
  version                integer not null default 1 check (version >= 1),
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);
create index if not exists user_onboarding_company_ws_idx on public.user_onboarding (company_workspace_id) where company_workspace_id is not null;

-- ---------------------------------------------------------------------
-- 2. Payment-provider customer binding. A workspace has at most one
--    customer per provider; a provider customer belongs to exactly one
--    workspace. Webhooks resolve the workspace THROUGH this table — never
--    from a workspace id in the webhook body.
-- ---------------------------------------------------------------------
create table if not exists public.billing_customers (
  workspace_id          uuid not null references public.workspaces(id) on delete cascade,
  provider              text not null check (provider ~ '^[a-z][a-z0-9_]{1,31}$'),
  external_customer_id  text not null check (char_length(external_customer_id) between 1 and 200),
  created_by            text not null check (char_length(created_by) between 1 and 200),
  created_at            timestamptz not null default now(),
  primary key (workspace_id, provider),
  unique (provider, external_customer_id)
);

-- ---------------------------------------------------------------------
-- 3. Checkout sessions created by this server (ownership proof for
--    checkout-completed webhooks).
-- ---------------------------------------------------------------------
create table if not exists public.billing_checkout_sessions (
  id                        uuid primary key default gen_random_uuid(),
  workspace_id              uuid not null references public.workspaces(id) on delete cascade,
  provider                  text not null check (provider ~ '^[a-z][a-z0-9_]{1,31}$'),
  external_session_id       text not null check (char_length(external_session_id) between 1 and 200),
  external_customer_id      text not null check (char_length(external_customer_id) between 1 and 200),
  plan_id                   text not null references public.billing_plans(id),
  status                    text not null default 'open' check (status in ('open','completed','expired')),
  external_subscription_id  text check (external_subscription_id is null or char_length(external_subscription_id) between 1 and 200),
  requested_by              text not null check (char_length(requested_by) between 1 and 200),
  created_at                timestamptz not null default now(),
  completed_at              timestamptz,
  unique (provider, external_session_id)
);
create index if not exists billing_checkout_sessions_ws_idx on public.billing_checkout_sessions (workspace_id, created_at desc);

-- ---------------------------------------------------------------------
-- 4. Plan features (capability flags). Missing flag = included; an
--    explicit false = not included in the plan.
-- ---------------------------------------------------------------------
create table if not exists public.billing_plan_features (
  plan_id     text primary key references public.billing_plans(id) on delete cascade,
  features    jsonb not null default '{}'::jsonb check (jsonb_typeof(features) = 'object'),
  updated_at  timestamptz not null default now()
);
insert into public.billing_plan_features (plan_id, features)
select p.id, f.features from (values
  ('free',       '{"api_access":true,"integrations":true,"workflow_templates":true,"scheduled_workflows":true,"audit_log":true,"custom_limits":false,"manual_activation":false,"support":"community"}'::jsonb),
  ('pro',        '{"api_access":true,"integrations":true,"workflow_templates":true,"scheduled_workflows":true,"audit_log":true,"custom_limits":false,"manual_activation":false,"support":"email"}'::jsonb),
  ('business',   '{"api_access":true,"integrations":true,"workflow_templates":true,"scheduled_workflows":true,"audit_log":true,"custom_limits":false,"manual_activation":false,"support":"priority_email"}'::jsonb),
  ('enterprise', '{"api_access":true,"integrations":true,"workflow_templates":true,"scheduled_workflows":true,"audit_log":true,"custom_limits":true,"manual_activation":true,"support":"dedicated"}'::jsonb)
) as f(plan_id, features)
join public.billing_plans p on p.id = f.plan_id
on conflict (plan_id) do nothing;

-- ---------------------------------------------------------------------
-- 5. Enterprise custom limits (operator only; same limit semantics as
--    billing_plans.limits: number = cap, null = unlimited). Applied only
--    while the workspace's subscription is in force.
-- ---------------------------------------------------------------------
create table if not exists public.workspace_plan_overrides (
  workspace_id  uuid primary key references public.workspaces(id) on delete cascade,
  limits        jsonb not null check (jsonb_typeof(limits) = 'object'),
  note          text check (note is null or char_length(note) <= 300),
  set_by        text not null check (char_length(set_by) between 1 and 200),
  updated_at    timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- 6. RLS deny-by-default + no privileges for public roles
-- ---------------------------------------------------------------------
alter table public.user_onboarding            enable row level security;
alter table public.billing_customers          enable row level security;
alter table public.billing_checkout_sessions  enable row level security;
alter table public.billing_plan_features      enable row level security;
alter table public.workspace_plan_overrides   enable row level security;

do $$
declare r text;
begin
  foreach r in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on public.user_onboarding, public.billing_customers, public.billing_checkout_sessions, public.billing_plan_features, public.workspace_plan_overrides from %I', r);
    end if;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant select, insert, update, delete on public.user_onboarding, public.billing_customers, public.billing_checkout_sessions, public.billing_plan_features, public.workspace_plan_overrides to service_role;
  end if;
end $$;
