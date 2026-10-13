-- =====================================================================
-- Nexus Layer 7 — B2B SaaS: usage metering, plans, entitlements,
-- provider-neutral subscriptions (UP)
-- =====================================================================
-- Requires Layers 1–6. Idempotent: safe to re-run.
-- Rollback: 20260929_layer7_billing.down.sql
--
--   billing_plans            central plan catalogue (limits in jsonb; NO prices in code)
--   workspace_subscriptions  provider-neutral subscription state per workspace
--   usage_events             immutable, idempotent usage ledger (authoritative)
--   usage_reservations       quota reservations (atomic check-and-reserve)
--   billing_webhook_events   webhook idempotency / replay ledger
--   RPCs (service_role only): billing_reserve_usage, billing_record_usage,
--         billing_release_reservation, billing_usage_totals, billing_usage_daily
-- Nothing in Layers 1–6 is altered.
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
  if to_regclass('public.workspaces') is null or to_regclass('public.workspace_api_keys') is null then
    raise exception 'Layer 7 requires Layers 1-6.';
  end if;
end $$;

-- ---------------------------------------------------------------------
-- 1. Plan catalogue. Limits: a JSON number = cap, JSON null = unlimited.
--    price: display-only metadata (null = not configured / contact sales).
-- ---------------------------------------------------------------------
create table if not exists public.billing_plans (
  id          text primary key check (id ~ '^[a-z][a-z0-9_]{1,31}$'),
  name        text not null check (char_length(name) between 1 and 60),
  description text,
  limits      jsonb not null check (jsonb_typeof(limits) = 'object'),
  price       jsonb,
  is_public   boolean not null default true,
  sort_order  integer not null default 0,
  updated_at  timestamptz not null default now()
);

-- Seed (insert-only; an operator may later change limits in the table).
insert into public.billing_plans (id, name, description, limits, price, sort_order) values
  ('free', 'Free', 'For trying Nexus with a small team.',
   '{"executions_per_month":100,"workflow_runs_per_month":50,"api_calls_per_month":1000,"connector_calls_per_month":500,"max_members":3,"max_active_workflows":3,"max_concurrent_executions":1,"usage_retention_days":30}', null, 10),
  ('pro', 'Pro', 'For growing practices and small businesses.',
   '{"executions_per_month":2000,"workflow_runs_per_month":1000,"api_calls_per_month":20000,"connector_calls_per_month":10000,"max_members":10,"max_active_workflows":25,"max_concurrent_executions":1,"usage_retention_days":90}', null, 20),
  ('business', 'Business', 'For firms running automation across teams.',
   '{"executions_per_month":20000,"workflow_runs_per_month":10000,"api_calls_per_month":200000,"connector_calls_per_month":100000,"max_members":50,"max_active_workflows":200,"max_concurrent_executions":1,"usage_retention_days":365}', null, 30),
  ('enterprise', 'Enterprise', 'Custom limits and terms.',
   '{"executions_per_month":null,"workflow_runs_per_month":null,"api_calls_per_month":null,"connector_calls_per_month":null,"max_members":null,"max_active_workflows":null,"max_concurrent_executions":null,"usage_retention_days":null}', null, 40)
on conflict (id) do nothing;

-- ---------------------------------------------------------------------
-- 2. Subscriptions (one per workspace; no row = implicit Free)
-- ---------------------------------------------------------------------
create table if not exists public.workspace_subscriptions (
  workspace_id              uuid primary key references public.workspaces(id) on delete cascade,
  plan_id                   text not null references public.billing_plans(id),
  status                    text not null check (status in ('trialing','active','past_due','cancelled','expired')),
  provider                  text not null default 'none' check (provider ~ '^[a-z][a-z0-9_]{1,31}$'),
  external_customer_id      text check (external_customer_id is null or char_length(external_customer_id) between 1 and 200),
  external_subscription_id  text check (external_subscription_id is null or char_length(external_subscription_id) between 1 and 200),
  current_period_start      timestamptz,
  current_period_end        timestamptz,
  trial_ends_at             timestamptz,
  cancel_at_period_end      boolean not null default false,
  cancelled_at              timestamptz,
  last_provider_event_at    timestamptz,
  version                   integer not null default 1,
  updated_by                text not null,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),
  check (current_period_end is null or current_period_start is null or current_period_end > current_period_start)
);
create unique index if not exists workspace_subscriptions_external_uq
  on public.workspace_subscriptions (provider, external_subscription_id) where external_subscription_id is not null;

-- ---------------------------------------------------------------------
-- 3. Usage ledger — append-only, idempotent per (workspace, key)
-- ---------------------------------------------------------------------
create table if not exists public.usage_events (
  id              uuid primary key default gen_random_uuid(),
  workspace_id    uuid not null references public.workspaces(id) on delete cascade,
  metric          text not null check (metric in (
                    'agent_execution','workflow_run','execution_step','connector_call','api_call',
                    'execution_completed','execution_failed','execution_cancelled')),
  quantity        integer not null check (quantity between 1 and 1000000),
  idempotency_key text not null check (char_length(idempotency_key) between 1 and 200),
  source          text check (source is null or char_length(source) <= 40),
  source_id       text check (source_id is null or char_length(source_id) <= 200),
  actor_id        text check (actor_id is null or char_length(actor_id) <= 200),
  reservation_id  uuid,
  occurred_at     timestamptz not null default now(),
  unique (workspace_id, idempotency_key)
);
create index if not exists usage_events_ws_metric_time_idx on public.usage_events (workspace_id, metric, occurred_at);
create index if not exists usage_events_ws_time_idx on public.usage_events (workspace_id, occurred_at);

-- Immutable: no updates; deletes only via the workspace cascade.
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
drop trigger if exists usage_events_no_change on public.usage_events;
create trigger usage_events_no_change before update or delete on public.usage_events
  for each row execute function public.usage_events_immutable();

-- ---------------------------------------------------------------------
-- 4. Quota reservations
-- ---------------------------------------------------------------------
create table if not exists public.usage_reservations (
  id              uuid primary key default gen_random_uuid(),
  workspace_id    uuid not null references public.workspaces(id) on delete cascade,
  metric          text not null,
  quantity        integer not null check (quantity between 1 and 1000000),
  idempotency_key text not null check (char_length(idempotency_key) between 1 and 200),
  status          text not null default 'reserved' check (status in ('reserved','committed','released')),
  period_start    timestamptz not null,
  period_end      timestamptz not null,
  expires_at      timestamptz not null,
  created_at      timestamptz not null default now(),
  finalized_at    timestamptz,
  unique (workspace_id, idempotency_key),
  check (period_end > period_start)
);
create index if not exists usage_reservations_active_idx on public.usage_reservations (workspace_id, metric, status, period_start);

-- Atomic check-and-reserve. Serialized per (workspace, metric) with a
-- transaction-scoped advisory lock, so N concurrent callers can never
-- together exceed the limit. Same key → the same reservation (idempotent,
-- no second charge). p_limit null = unlimited.
create or replace function public.billing_reserve_usage(
  p_workspace uuid, p_metric text, p_quantity integer, p_limit bigint,
  p_period_start timestamptz, p_period_end timestamptz, p_key text, p_ttl_seconds integer)
returns table (reservation_id uuid, allowed boolean, replayed boolean, used bigint, reserved bigint)
language plpgsql as $$
declare v_used bigint; v_res bigint; v_existing public.usage_reservations%rowtype; v_id uuid;
begin
  if p_quantity is null or p_quantity < 1 or p_quantity > 1000000 then raise exception 'invalid quantity' using errcode = '22023'; end if;
  if p_limit is not null and p_limit < 0 then raise exception 'invalid limit' using errcode = '22023'; end if;
  if p_key is null or char_length(p_key) not between 1 and 200 then raise exception 'invalid key' using errcode = '22023'; end if;
  if p_ttl_seconds is null or p_ttl_seconds not between 1 and 86400 then raise exception 'invalid ttl' using errcode = '22023'; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_workspace::text || ':' || p_metric, 7));
  select * into v_existing from public.usage_reservations r where r.workspace_id = p_workspace and r.idempotency_key = p_key;
  if found and v_existing.status <> 'released' then
    return query select v_existing.id, true, true, 0::bigint, 0::bigint;
    return;
  end if;
  if found then
    -- the earlier attempt never happened (released): evaluate afresh
    delete from public.usage_reservations r where r.id = v_existing.id;
  end if;
  -- the ledger may already hold the event (recorded without a reservation)
  if exists (select 1 from public.usage_events e where e.workspace_id = p_workspace and e.idempotency_key = p_key) then
    return query select null::uuid, true, true, 0::bigint, 0::bigint;
    return;
  end if;
  select coalesce(sum(e.quantity), 0) into v_used from public.usage_events e
   where e.workspace_id = p_workspace and e.metric = p_metric and e.occurred_at >= p_period_start and e.occurred_at < p_period_end;
  select coalesce(sum(r.quantity), 0) into v_res from public.usage_reservations r
   where r.workspace_id = p_workspace and r.metric = p_metric and r.status = 'reserved' and r.expires_at > now()
     and r.period_start = p_period_start;
  if p_limit is not null and v_used + v_res + p_quantity > p_limit then
    return query select null::uuid, false, false, v_used, v_res;
    return;
  end if;
  insert into public.usage_reservations (workspace_id, metric, quantity, idempotency_key, period_start, period_end, expires_at)
  values (p_workspace, p_metric, p_quantity, p_key, p_period_start, p_period_end, now() + make_interval(secs => p_ttl_seconds))
  returning id into v_id;
  return query select v_id, true, false, v_used, v_res;
end $$;

-- Append a usage event (idempotent) and commit its reservation.
create or replace function public.billing_record_usage(
  p_workspace uuid, p_metric text, p_quantity integer, p_key text, p_source text, p_source_id text,
  p_actor text, p_reservation uuid)
returns boolean
language plpgsql as $$
declare v_n integer;
begin
  insert into public.usage_events (workspace_id, metric, quantity, idempotency_key, source, source_id, actor_id, reservation_id)
  values (p_workspace, p_metric, p_quantity, p_key, p_source, p_source_id, p_actor, p_reservation)
  on conflict (workspace_id, idempotency_key) do nothing;
  get diagnostics v_n = row_count;
  if p_reservation is not null then
    update public.usage_reservations set status = 'committed', finalized_at = now()
     where id = p_reservation and workspace_id = p_workspace and status = 'reserved';
  end if;
  return v_n = 1;
end $$;

create or replace function public.billing_release_reservation(p_workspace uuid, p_reservation uuid)
returns boolean
language plpgsql as $$
declare v_n integer;
begin
  update public.usage_reservations set status = 'released', finalized_at = now()
   where id = p_reservation and workspace_id = p_workspace and status = 'reserved';
  get diagnostics v_n = row_count;
  return v_n = 1;
end $$;

create or replace function public.billing_usage_totals(p_workspace uuid, p_from timestamptz, p_to timestamptz)
returns table (metric text, total bigint)
language sql stable as $$
  select e.metric, sum(e.quantity)::bigint from public.usage_events e
   where e.workspace_id = p_workspace and e.occurred_at >= p_from and e.occurred_at < p_to
   group by e.metric;
$$;

create or replace function public.billing_usage_daily(p_workspace uuid, p_from timestamptz, p_to timestamptz)
returns table (day date, metric text, total bigint)
language sql stable as $$
  select (e.occurred_at at time zone 'UTC')::date, e.metric, sum(e.quantity)::bigint from public.usage_events e
   where e.workspace_id = p_workspace and e.occurred_at >= p_from and e.occurred_at < p_to
   group by 1, 2 order by 1, 2;
$$;

-- ---------------------------------------------------------------------
-- 5. Webhook ledger (idempotency + replay protection)
-- ---------------------------------------------------------------------
create table if not exists public.billing_webhook_events (
  id            uuid primary key default gen_random_uuid(),
  provider      text not null check (provider ~ '^[a-z][a-z0-9_]{1,31}$'),
  event_id      text not null check (char_length(event_id) between 1 and 200),
  event_type    text check (event_type is null or char_length(event_type) <= 100),
  workspace_id  uuid references public.workspaces(id) on delete set null,
  status        text not null check (status in ('processed','ignored','rejected')),
  detail        text check (detail is null or char_length(detail) <= 300),
  payload_hash  text check (payload_hash is null or payload_hash ~ '^[0-9a-f]{64}$'),
  received_at   timestamptz not null default now(),
  unique (provider, event_id)
);

-- ---------------------------------------------------------------------
-- 6. RLS deny-by-default + no privileges for public roles
-- ---------------------------------------------------------------------
alter table public.billing_plans            enable row level security;
alter table public.workspace_subscriptions  enable row level security;
alter table public.usage_events             enable row level security;
alter table public.usage_reservations       enable row level security;
alter table public.billing_webhook_events   enable row level security;

do $$
declare r text; f text;
begin
  foreach f in array array[
    'public.billing_reserve_usage(uuid, text, integer, bigint, timestamptz, timestamptz, text, integer)',
    'public.billing_record_usage(uuid, text, integer, text, text, text, text, uuid)',
    'public.billing_release_reservation(uuid, uuid)',
    'public.billing_usage_totals(uuid, timestamptz, timestamptz)',
    'public.billing_usage_daily(uuid, timestamptz, timestamptz)',
    'public.usage_events_immutable()'
  ] loop
    execute format('revoke all on function %s from public', f);
    foreach r in array array['anon', 'authenticated'] loop
      if exists (select 1 from pg_roles where rolname = r) then execute format('revoke all on function %s from %I', f, r); end if;
    end loop;
    if exists (select 1 from pg_roles where rolname = 'service_role') and f not like '%immutable%' then
      execute format('grant execute on function %s to service_role', f);
    end if;
  end loop;
  foreach r in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on public.billing_plans, public.workspace_subscriptions, public.usage_events, public.usage_reservations, public.billing_webhook_events from %I', r);
    end if;
  end loop;
end $$;
