-- =====================================================================
-- Nexus Layer 10 — revenue product suite (UP)
-- =====================================================================
-- Requires Layers 1–9. Idempotent: safe to re-run.
-- Rollback: 20261002_layer10_revenue.down.sql
--
--   workspace_agents                named AI agent identities (role, risk cap,
--                                   allowed integrations) + agent_id on
--                                   executions and tasks
--   monitors … monitor_changes      generic monitoring engine (sources,
--                                   observations, de-duplicated snapshots,
--                                   deterministic changes)
--   alert_rules, alerts,            alert engine + per-channel delivery state
--   alert_deliveries
--   ci_products, ci_competitor_products, ci_recommendations
--                                   e-commerce competitor intelligence
--   qa_projects … qa_results        AI agent QA / reliability testing
--   workspace_webhooks,             signed outbound event webhooks
--   webhook_deliveries
--   usage metrics                   + monitoring_check, agent_test_scenario
--   plan limits                     + monitored products, monitoring checks,
--                                   agent test scenarios, integrations
--   RPCs                            lease-based claiming (monitors, QA results,
--                                   webhook deliveries), count-limit
--                                   enforcement, retention, workspace audit purge
--
-- References that must not dangle use ON DELETE NO ACTION DEFERRABLE
-- INITIALLY DEFERRED (checked at commit): deleting ONE referenced row is
-- refused, while deleting the whole workspace cascades through every table
-- (a non-deferred check can fire before a sibling cascade has run).
-- Every table is workspace-scoped (composite FKs keep children in their
-- parent's workspace), RLS on, no client policies, anon / authenticated
-- denied; functions are service_role only. No Layer 1–9 row is changed
-- except: new NULL columns (agent_executions.agent_id,
-- workspace_tasks.assignee_agent_id) and new limit keys merged into the
-- built-in billing plans (existing keys untouched).
-- =====================================================================

do $$
begin
  if to_regclass('public.workspaces') is null or to_regclass('public.worker_heartbeats') is null
     or to_regclass('public.usage_events') is null or to_regclass('public.integrations') is null then
    raise exception 'Layer 10 requires Layers 1-9.';
  end if;
end $$;

-- ---------------------------------------------------------------------
-- 1. Agents (AI workforce identities)
-- ---------------------------------------------------------------------
create table if not exists public.workspace_agents (
  id                      uuid primary key default gen_random_uuid(),
  workspace_id            uuid not null references public.workspaces(id) on delete cascade,
  name                    text not null check (char_length(btrim(name)) between 1 and 80),
  role                    text not null check (role in ('research','data','spreadsheet','reviewer','custom')),
  description             text not null default '' check (char_length(description) <= 1000),
  instructions            text not null default '' check (char_length(instructions) <= 2000),
  max_risk                text not null default 'yellow' check (max_risk in ('green','yellow','red')),
  allowed_integration_ids uuid[] not null default '{}',
  status                  text not null default 'active' check (status in ('active','archived')),
  created_by              text not null check (char_length(created_by) between 1 and 200),
  version                 integer not null default 0,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  unique (id, workspace_id)
);
create unique index if not exists workspace_agents_ws_name_uq on public.workspace_agents (workspace_id, lower(name));

alter table public.agent_executions add column if not exists agent_id uuid;
alter table public.workspace_tasks add column if not exists assignee_agent_id uuid;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'agent_executions_agent_fk') then
    alter table public.agent_executions add constraint agent_executions_agent_fk
      foreign key (agent_id, workspace_id) references public.workspace_agents (id, workspace_id) on delete no action deferrable initially deferred;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'workspace_tasks_agent_fk') then
    alter table public.workspace_tasks add constraint workspace_tasks_agent_fk
      foreign key (assignee_agent_id, workspace_id) references public.workspace_agents (id, workspace_id) on delete no action deferrable initially deferred;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'workspace_tasks_agent_assignee_ck') then
    alter table public.workspace_tasks add constraint workspace_tasks_agent_assignee_ck
      check (assignee_agent_id is null or assignee_type = 'agent');
  end if;
end $$;
create index if not exists agent_executions_ws_agent_idx on public.agent_executions (workspace_id, agent_id) where agent_id is not null;

-- ---------------------------------------------------------------------
-- 2. Monitoring engine
-- ---------------------------------------------------------------------
create table if not exists public.monitors (
  id                     uuid primary key default gen_random_uuid(),
  workspace_id           uuid not null references public.workspaces(id) on delete cascade,
  name                   text not null check (char_length(btrim(name)) between 1 and 200),
  kind                   text not null check (kind in ('product','page','api_value')),
  source_type            text not null check (source_type in ('web_page','shopify_product','json_api','api_submission')),
  integration_id         uuid,
  source                 jsonb not null default '{}'::jsonb,
  check_interval_minutes integer not null default 360 check (check_interval_minutes between 15 and 10080),
  stale_after_minutes    integer not null default 1440 check (stale_after_minutes between 30 and 43200),
  status                 text not null default 'active' check (status in ('active','paused')),
  health                 text not null default 'PENDING' check (health in ('PENDING','VERIFIED','UNVERIFIED','STALE','UNAVAILABLE')),
  health_reason          text check (health_reason is null or char_length(health_reason) <= 300),
  current                jsonb,
  current_hash           text,
  last_check_at          timestamptz,
  last_success_at        timestamptz,
  last_observation_id    uuid,
  consecutive_failures   integer not null default 0 check (consecutive_failures >= 0),
  next_check_at          timestamptz not null default now(),
  lease_owner            text,
  lease_expires_at       timestamptz,
  lease_fence            bigint not null default 0,
  created_by             text not null check (char_length(created_by) between 1 and 200),
  version                integer not null default 0,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  unique (id, workspace_id),
  foreign key (integration_id, workspace_id) references public.integrations (id, workspace_id) on delete no action deferrable initially deferred,
  check (source_type = 'api_submission' or integration_id is not null)
);
create index if not exists monitors_ws_idx on public.monitors (workspace_id, created_at desc);
create index if not exists monitors_due_idx on public.monitors (next_check_at) where status = 'active' and source_type <> 'api_submission';

create table if not exists public.monitor_observations (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null,
  monitor_id    uuid not null,
  check_key     text not null check (char_length(check_key) between 1 and 200),
  observed_at   timestamptz not null default now(),
  status        text not null check (status in ('VERIFIED','UNVERIFIED','UNAVAILABLE')),
  "values"      jsonb,
  value_hash    text,
  method        text check (method is null or char_length(method) <= 60),
  evidence      jsonb not null default '{}'::jsonb,
  error_code    text check (error_code is null or char_length(error_code) <= 80),
  created_at    timestamptz not null default now(),
  unique (id, workspace_id),
  unique (monitor_id, check_key),
  foreign key (monitor_id, workspace_id) references public.monitors (id, workspace_id) on delete cascade
);
create index if not exists monitor_observations_ws_mon_idx on public.monitor_observations (workspace_id, monitor_id, observed_at desc);

create table if not exists public.monitor_snapshots (
  id                    uuid primary key default gen_random_uuid(),
  workspace_id          uuid not null,
  monitor_id            uuid not null,
  value_hash            text not null,
  "values"              jsonb not null,
  first_observation_id  uuid not null,
  last_observation_id   uuid not null,
  first_seen_at         timestamptz not null,
  last_seen_at          timestamptz not null,
  observation_count     integer not null default 1 check (observation_count >= 1),
  foreign key (monitor_id, workspace_id) references public.monitors (id, workspace_id) on delete cascade
);
create index if not exists monitor_snapshots_ws_mon_idx on public.monitor_snapshots (workspace_id, monitor_id, first_seen_at desc);

create table if not exists public.monitor_changes (
  id              uuid primary key default gen_random_uuid(),
  workspace_id    uuid not null,
  monitor_id      uuid not null,
  observation_id  uuid not null,
  change_type     text not null check (change_type in (
                    'price_decrease','price_increase','new_discount','discount_removed','price_restored',
                    'seller_changed','out_of_stock','back_in_stock','limited_stock','stock_changed',
                    'product_disappeared','product_reappeared','value_changed','source_unavailable',
                    'source_recovered','source_stale')),
  field           text not null check (char_length(field) between 1 and 60),
  old_value       jsonb,
  new_value       jsonb,
  detected_at     timestamptz not null default now(),
  confidence      numeric(4,3) not null default 1 check (confidence between 0 and 1),
  verification    text not null check (verification in ('VERIFIED','UNVERIFIED')),
  source          text check (source is null or char_length(source) <= 300),
  created_at      timestamptz not null default now(),
  unique (id, workspace_id),
  unique (monitor_id, observation_id, change_type, field),
  foreign key (monitor_id, workspace_id) references public.monitors (id, workspace_id) on delete cascade,
  foreign key (observation_id, workspace_id) references public.monitor_observations (id, workspace_id) on delete cascade
);
create index if not exists monitor_changes_ws_idx on public.monitor_changes (workspace_id, detected_at desc);
create index if not exists monitor_changes_ws_mon_idx on public.monitor_changes (workspace_id, monitor_id, detected_at desc);

-- ---------------------------------------------------------------------
-- 3. Competitor intelligence
-- ---------------------------------------------------------------------
create table if not exists public.ci_products (
  id                uuid primary key default gen_random_uuid(),
  workspace_id      uuid not null references public.workspaces(id) on delete cascade,
  name              text not null check (char_length(btrim(name)) between 1 and 200),
  sku               text check (sku is null or char_length(sku) between 1 and 100),
  gtin              text check (gtin is null or gtin ~ '^[0-9]{8,14}$'),
  mpn               text check (mpn is null or char_length(mpn) between 1 and 100),
  brand             text check (brand is null or char_length(brand) <= 100),
  model             text check (model is null or char_length(model) <= 100),
  attributes        jsonb not null default '{}'::jsonb,
  currency          text not null default 'INR' check (currency ~ '^[A-Z]{3}$'),
  cost              numeric(14,4) check (cost is null or cost >= 0),
  selling_price     numeric(14,4) check (selling_price is null or selling_price >= 0),
  fees_fixed        numeric(14,4) check (fees_fixed is null or fees_fixed >= 0),
  fees_pct          numeric(7,4) check (fees_pct is null or (fees_pct >= 0 and fees_pct < 100)),
  target_margin_pct numeric(7,4) check (target_margin_pct is null or target_margin_pct between -100 and 100),
  min_margin_pct    numeric(7,4) check (min_margin_pct is null or min_margin_pct between -100 and 100),
  own_monitor_id    uuid,
  created_by        text not null,
  version           integer not null default 0,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (id, workspace_id),
  foreign key (own_monitor_id, workspace_id) references public.monitors (id, workspace_id) on delete no action deferrable initially deferred
);
create unique index if not exists ci_products_ws_sku_uq on public.ci_products (workspace_id, lower(sku)) where sku is not null;
create index if not exists ci_products_ws_idx on public.ci_products (workspace_id, created_at desc);

create table if not exists public.ci_competitor_products (
  id                      uuid primary key default gen_random_uuid(),
  workspace_id            uuid not null,
  product_id              uuid not null,
  competitor_name         text not null check (char_length(btrim(competitor_name)) between 1 and 120),
  marketplace             text not null check (marketplace in ('amazon','flipkart','shopify','website','other')),
  source_url              text check (source_url is null or char_length(source_url) <= 2000),
  marketplace_product_id  text check (marketplace_product_id is null or char_length(marketplace_product_id) <= 100),
  identifiers             jsonb not null default '{}'::jsonb,
  title                   text check (title is null or char_length(title) <= 300),
  brand                   text check (brand is null or char_length(brand) <= 100),
  model                   text check (model is null or char_length(model) <= 100),
  monitor_id              uuid,
  match_status            text not null default 'UNVERIFIED' check (match_status in ('VERIFIED','UNVERIFIED','REJECTED')),
  match_confidence        numeric(4,3) not null default 0 check (match_confidence between 0 and 1),
  match_method            text check (match_method is null or char_length(match_method) <= 60),
  match_evidence          jsonb not null default '{}'::jsonb,
  confirmed_by            text,
  confirmed_at            timestamptz,
  created_by              text not null,
  version                 integer not null default 0,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  unique (id, workspace_id),
  foreign key (product_id, workspace_id) references public.ci_products (id, workspace_id) on delete cascade,
  foreign key (monitor_id, workspace_id) references public.monitors (id, workspace_id) on delete no action deferrable initially deferred
);
create index if not exists ci_competitors_ws_product_idx on public.ci_competitor_products (workspace_id, product_id);
create index if not exists ci_competitors_ws_monitor_idx on public.ci_competitor_products (workspace_id, monitor_id);

create table if not exists public.ci_recommendations (
  id              uuid primary key default gen_random_uuid(),
  workspace_id    uuid not null,
  product_id      uuid not null,
  competitor_id   uuid,
  change_id       uuid,
  rec_type        text not null check (rec_type in ('review_pricing','review_promotion','investigate_margin','monitor_competitor','no_action')),
  priority        text not null default 'medium' check (priority in ('low','medium','high')),
  rationale       jsonb not null default '{}'::jsonb,
  status          text not null default 'open' check (status in ('open','acknowledged','dismissed','actioned')),
  dedup_key       text not null check (char_length(dedup_key) between 1 and 300),
  decided_by      text,
  decided_at      timestamptz,
  created_at      timestamptz not null default now(),
  unique (workspace_id, dedup_key),
  foreign key (product_id, workspace_id) references public.ci_products (id, workspace_id) on delete cascade,
  foreign key (competitor_id, workspace_id) references public.ci_competitor_products (id, workspace_id) on delete cascade,
  foreign key (change_id, workspace_id) references public.monitor_changes (id, workspace_id) on delete set null (change_id)
);
create index if not exists ci_recommendations_ws_idx on public.ci_recommendations (workspace_id, status, created_at desc);

-- ---------------------------------------------------------------------
-- 4. Alerts
-- ---------------------------------------------------------------------
create table if not exists public.alert_rules (
  id                uuid primary key default gen_random_uuid(),
  workspace_id      uuid not null references public.workspaces(id) on delete cascade,
  name              text not null check (char_length(btrim(name)) between 1 and 120),
  rule_type         text not null check (rule_type in (
                      'price_below','price_drop_pct','out_of_stock','back_in_stock','margin_below',
                      'product_disappeared','source_stale','source_unavailable','any_change')),
  monitor_id        uuid,
  product_id        uuid,
  threshold         numeric(14,4),
  channels          jsonb not null default '[{"type":"in_app"}]'::jsonb,
  cooldown_minutes  integer not null default 60 check (cooldown_minutes between 0 and 10080),
  enabled           boolean not null default true,
  created_by        text not null,
  version           integer not null default 0,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (id, workspace_id),
  foreign key (monitor_id, workspace_id) references public.monitors (id, workspace_id) on delete cascade,
  foreign key (product_id, workspace_id) references public.ci_products (id, workspace_id) on delete cascade
);
create index if not exists alert_rules_ws_idx on public.alert_rules (workspace_id, enabled);

create table if not exists public.alerts (
  id               uuid primary key default gen_random_uuid(),
  workspace_id     uuid not null,
  rule_id          uuid not null,
  monitor_id       uuid,
  change_id        uuid,
  alert_type       text not null check (char_length(alert_type) between 1 and 60),
  severity         text not null default 'warning' check (severity in ('info','warning','critical')),
  title            text not null check (char_length(title) between 1 and 300),
  details          jsonb not null default '{}'::jsonb,
  dedup_key        text not null check (char_length(dedup_key) between 1 and 300),
  acknowledged_by  text,
  acknowledged_at  timestamptz,
  created_at       timestamptz not null default now(),
  unique (id, workspace_id),
  unique (workspace_id, dedup_key),
  foreign key (rule_id, workspace_id) references public.alert_rules (id, workspace_id) on delete cascade,
  foreign key (monitor_id, workspace_id) references public.monitors (id, workspace_id) on delete cascade,
  foreign key (change_id, workspace_id) references public.monitor_changes (id, workspace_id) on delete set null (change_id)
);
create index if not exists alerts_ws_created_idx on public.alerts (workspace_id, created_at desc);
create index if not exists alerts_ws_rule_idx on public.alerts (workspace_id, rule_id, created_at desc);

create table if not exists public.alert_deliveries (
  id               uuid primary key default gen_random_uuid(),
  workspace_id     uuid not null,
  alert_id         uuid not null,
  channel          text not null check (channel in ('in_app','slack','email','webhook')),
  channel_key      text not null check (char_length(channel_key) between 1 and 100),
  integration_id   uuid,
  status           text not null default 'pending' check (status in ('pending','delivered','failed','blocked','skipped')),
  error_code       text check (error_code is null or char_length(error_code) <= 80),
  attempts         integer not null default 0 check (attempts >= 0),
  last_attempt_at  timestamptz,
  delivered_at     timestamptz,
  created_at       timestamptz not null default now(),
  unique (alert_id, channel_key),
  foreign key (alert_id, workspace_id) references public.alerts (id, workspace_id) on delete cascade
);
create index if not exists alert_deliveries_ws_idx on public.alert_deliveries (workspace_id, status);

-- ---------------------------------------------------------------------
-- 5. Agent QA / reliability
-- ---------------------------------------------------------------------
create table if not exists public.qa_projects (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references public.workspaces(id) on delete cascade,
  name          text not null check (char_length(btrim(name)) between 1 and 120),
  description   text not null default '' check (char_length(description) <= 2000),
  agent_label   text not null default 'Nexus agent' check (char_length(agent_label) between 1 and 120),
  agent_id      uuid,
  environment   jsonb not null default '{}'::jsonb,
  created_by    text not null,
  version       integer not null default 0,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (id, workspace_id),
  foreign key (agent_id, workspace_id) references public.workspace_agents (id, workspace_id) on delete no action deferrable initially deferred
);
create index if not exists qa_projects_ws_idx on public.qa_projects (workspace_id, created_at desc);

create table if not exists public.qa_suites (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null,
  project_id    uuid not null,
  name          text not null check (char_length(btrim(name)) between 1 and 120),
  description   text not null default '' check (char_length(description) <= 2000),
  created_by    text not null,
  created_at    timestamptz not null default now(),
  unique (id, workspace_id),
  foreign key (project_id, workspace_id) references public.qa_projects (id, workspace_id) on delete cascade
);
create index if not exists qa_suites_ws_project_idx on public.qa_suites (workspace_id, project_id);

create table if not exists public.qa_scenarios (
  id               uuid primary key default gen_random_uuid(),
  workspace_id     uuid not null,
  project_id       uuid not null,
  suite_id         uuid not null,
  name             text not null check (char_length(btrim(name)) between 1 and 200),
  executor         text not null check (executor in ('nexus_agent','workflow','external_agent')),
  goal             text check (goal is null or char_length(goal) <= 2000),
  workflow_id      uuid,
  inputs           jsonb not null default '{}'::jsonb,
  expected         jsonb not null default '{}'::jsonb,
  timeout_seconds  integer not null default 600 check (timeout_seconds between 10 and 7200),
  created_by       text not null,
  version          integer not null default 0,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (id, workspace_id),
  foreign key (suite_id, workspace_id) references public.qa_suites (id, workspace_id) on delete cascade,
  foreign key (project_id, workspace_id) references public.qa_projects (id, workspace_id) on delete cascade,
  foreign key (workflow_id, workspace_id) references public.workflows (id, workspace_id) on delete no action deferrable initially deferred,
  check ((executor = 'workflow') = (workflow_id is not null)),
  check (executor <> 'nexus_agent' or goal is not null)
);
create index if not exists qa_scenarios_ws_suite_idx on public.qa_scenarios (workspace_id, suite_id);

create table if not exists public.qa_runs (
  id               uuid primary key default gen_random_uuid(),
  workspace_id     uuid not null,
  project_id       uuid not null,
  suite_id         uuid,
  status           text not null default 'queued' check (status in ('queued','running','completed','cancelled')),
  trigger          text not null default 'app' check (trigger in ('app','api')),
  triggered_by     text not null,
  idempotency_key  text check (idempotency_key is null or char_length(idempotency_key) between 8 and 128),
  scenario_count   integer not null default 0 check (scenario_count >= 0),
  summary          jsonb not null default '{}'::jsonb,
  started_at       timestamptz,
  finished_at      timestamptz,
  version          integer not null default 0,
  created_at       timestamptz not null default now(),
  unique (id, workspace_id),
  foreign key (project_id, workspace_id) references public.qa_projects (id, workspace_id) on delete cascade,
  foreign key (suite_id, workspace_id) references public.qa_suites (id, workspace_id) on delete cascade
);
create unique index if not exists qa_runs_ws_idem_uq on public.qa_runs (workspace_id, idempotency_key) where idempotency_key is not null;
create index if not exists qa_runs_ws_project_idx on public.qa_runs (workspace_id, project_id, created_at desc);

create table if not exists public.qa_results (
  id                       uuid primary key default gen_random_uuid(),
  workspace_id             uuid not null,
  run_id                   uuid not null,
  scenario_id              uuid not null,
  position                 integer not null check (position >= 0),
  status                   text not null default 'pending' check (status in ('pending','running','awaiting_submission','passed','failed','error','cancelled')),
  execution_id             uuid,
  workflow_run_id          uuid,
  verdict                  jsonb,
  failure_category         text check (failure_category is null or failure_category in (
                             'WRONG_ACTION','WRONG_DATA','NAVIGATION_FAILURE','SELECTOR_FAILURE','TIMEOUT',
                             'AUTHENTICATION_FAILURE','PERMISSION_FAILURE','POLICY_DENIAL','PROMPT_INJECTION',
                             'INCOMPLETE_TASK','FALSE_SUCCESS','VERIFICATION_MISMATCH','EXTERNAL_SOURCE_UNAVAILABLE',
                             'CONNECTOR_FAILURE','UNKNOWN')),
  classification_evidence  jsonb,
  verified                 boolean,
  evidence_complete        boolean,
  duration_ms              integer check (duration_ms is null or duration_ms >= 0),
  retries                  integer not null default 0 check (retries >= 0),
  recovered                boolean not null default false,
  policy_denials           integer not null default 0 check (policy_denials >= 0),
  injection_detections     integer not null default 0 check (injection_detections >= 0),
  lease_owner              text,
  lease_expires_at         timestamptz,
  lease_fence              bigint not null default 0,
  started_at               timestamptz,
  finished_at              timestamptz,
  version                  integer not null default 0,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  unique (id, workspace_id),
  unique (run_id, scenario_id),
  foreign key (run_id, workspace_id) references public.qa_runs (id, workspace_id) on delete cascade,
  foreign key (scenario_id, workspace_id) references public.qa_scenarios (id, workspace_id) on delete cascade
);
create index if not exists qa_results_ws_run_idx on public.qa_results (workspace_id, run_id, position);
create index if not exists qa_results_pending_idx on public.qa_results (created_at) where status in ('pending','running');

-- ---------------------------------------------------------------------
-- 6. Outbound webhooks (signed event delivery)
-- ---------------------------------------------------------------------
create table if not exists public.workspace_webhooks (
  id                uuid primary key default gen_random_uuid(),
  workspace_id      uuid not null references public.workspaces(id) on delete cascade,
  url               text not null check (char_length(url) between 12 and 2000 and url ~ '^https://'),
  events            text[] not null check (cardinality(events) between 1 and 20),
  secret_key_id     text not null check (secret_key_id ~ '^[A-Za-z0-9_.-]{1,64}$'),
  secret_iv         text not null,
  secret_tag        text not null,
  secret_ciphertext text not null,
  status            text not null default 'active' check (status in ('active','disabled')),
  failure_count     integer not null default 0 check (failure_count >= 0),
  last_delivery_at  timestamptz,
  created_by        text not null,
  version           integer not null default 0,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (id, workspace_id)
);
create index if not exists workspace_webhooks_ws_idx on public.workspace_webhooks (workspace_id, status);

create table if not exists public.webhook_deliveries (
  id                uuid primary key default gen_random_uuid(),
  workspace_id      uuid not null,
  webhook_id        uuid not null,
  event_type        text not null check (char_length(event_type) between 1 and 60),
  event_id          text not null check (char_length(event_id) between 1 and 200),
  payload           jsonb not null,
  status            text not null default 'pending' check (status in ('pending','delivered','failed','dead')),
  attempts          integer not null default 0 check (attempts >= 0),
  next_attempt_at   timestamptz not null default now(),
  last_status_code  integer,
  last_error        text check (last_error is null or char_length(last_error) <= 200),
  lease_owner       text,
  lease_expires_at  timestamptz,
  delivered_at      timestamptz,
  created_at        timestamptz not null default now(),
  unique (webhook_id, event_id),
  foreign key (webhook_id, workspace_id) references public.workspace_webhooks (id, workspace_id) on delete cascade
);
create index if not exists webhook_deliveries_due_idx on public.webhook_deliveries (next_attempt_at) where status in ('pending','failed');
create index if not exists webhook_deliveries_ws_idx on public.webhook_deliveries (workspace_id, created_at desc);

-- ---------------------------------------------------------------------
-- 7. Billing: new usage metrics + plan limits
-- ---------------------------------------------------------------------
do $$
declare c text;
begin
  select conname into c from pg_constraint
   where conrelid = 'public.usage_events'::regclass and contype = 'c' and pg_get_constraintdef(oid) like '%agent_execution%';
  if c is not null then execute format('alter table public.usage_events drop constraint %I', c); end if;
  alter table public.usage_events add constraint usage_events_metric_check check (metric in (
    'agent_execution','workflow_run','execution_step','connector_call','api_call',
    'execution_completed','execution_failed','execution_cancelled',
    'monitoring_check','agent_test_scenario'));
end $$;

-- New limit keys are ADDED to the built-in plans (existing keys and
-- operator-set values are never overwritten).
update public.billing_plans p set limits = x.add || p.limits
  from (values
    ('free',       '{"max_monitored_products":10,"monitoring_checks_per_month":3000,"agent_test_scenarios_per_month":100,"max_integrations":3}'::jsonb),
    ('pro',        '{"max_monitored_products":100,"monitoring_checks_per_month":60000,"agent_test_scenarios_per_month":2000,"max_integrations":10}'::jsonb),
    ('business',   '{"max_monitored_products":1000,"monitoring_checks_per_month":600000,"agent_test_scenarios_per_month":20000,"max_integrations":50}'::jsonb),
    ('enterprise', '{"max_monitored_products":null,"monitoring_checks_per_month":null,"agent_test_scenarios_per_month":null,"max_integrations":null}'::jsonb)
  ) as x(id, add)
 where p.id = x.id;

-- ---------------------------------------------------------------------
-- 8. RPCs
-- ---------------------------------------------------------------------
-- Lease-based claiming: several workers can run; SKIP LOCKED + fence.
create or replace function public.claim_due_monitors(p_worker text, p_lease_seconds integer, p_limit integer)
returns setof public.monitors
language plpgsql as $$
begin
  if p_worker is null or char_length(p_worker) < 1 or p_lease_seconds not between 5 and 3600 or p_limit not between 1 and 200 then
    raise exception 'invalid arguments' using errcode = '22023';
  end if;
  return query
  update public.monitors m
     set lease_owner = p_worker, lease_expires_at = now() + make_interval(secs => p_lease_seconds), lease_fence = m.lease_fence + 1
   where m.id in (
     select id from public.monitors
      where status = 'active' and source_type <> 'api_submission' and next_check_at <= now()
        and (lease_expires_at is null or lease_expires_at < now())
      order by next_check_at
      limit p_limit
      for update skip locked)
  returning m.*;
end $$;

create or replace function public.claim_qa_result(p_worker text, p_lease_seconds integer)
returns setof public.qa_results
language plpgsql as $$
begin
  if p_worker is null or char_length(p_worker) < 1 or p_lease_seconds not between 5 and 7200 then
    raise exception 'invalid arguments' using errcode = '22023';
  end if;
  return query
  update public.qa_results r
     set lease_owner = p_worker, lease_expires_at = now() + make_interval(secs => p_lease_seconds), lease_fence = r.lease_fence + 1,
         status = 'running', started_at = coalesce(r.started_at, now()), updated_at = now(), version = r.version + 1
   where r.id = (
     select q.id from public.qa_results q
      join public.qa_scenarios s on s.id = q.scenario_id
      where s.executor <> 'external_agent'
        and (q.status = 'pending' or (q.status = 'running' and q.lease_expires_at < now()))
      order by q.created_at, q.position
      limit 1
      for update of q skip locked)
  returning r.*;
end $$;

create or replace function public.claim_webhook_deliveries(p_worker text, p_lease_seconds integer, p_limit integer)
returns setof public.webhook_deliveries
language plpgsql as $$
begin
  if p_worker is null or char_length(p_worker) < 1 or p_lease_seconds not between 5 and 600 or p_limit not between 1 and 200 then
    raise exception 'invalid arguments' using errcode = '22023';
  end if;
  return query
  update public.webhook_deliveries d
     set lease_owner = p_worker, lease_expires_at = now() + make_interval(secs => p_lease_seconds)
   where d.id in (
     select id from public.webhook_deliveries
      where status in ('pending','failed') and next_attempt_at <= now()
        and (lease_expires_at is null or lease_expires_at < now())
      order by next_attempt_at
      limit p_limit
      for update skip locked)
  returning d.*;
end $$;

-- Count limits (same pattern as Layer 9): verify after the write under the
-- workspace row lock; an over-limit writer's own row is removed.
create or replace function public.enforce_monitored_product_limit(p_workspace uuid, p_product uuid, p_limit integer)
returns boolean
language plpgsql as $$
declare v_n integer;
begin
  if p_workspace is null or p_product is null or p_limit is null or p_limit < 0 then raise exception 'invalid arguments' using errcode = '22023'; end if;
  perform 1 from public.workspaces where id = p_workspace for update;
  if not found then return false; end if;
  select count(*) into v_n from public.ci_products where workspace_id = p_workspace;
  if v_n <= p_limit then return true; end if;
  delete from public.ci_products where workspace_id = p_workspace and id = p_product;
  return false;
end $$;

create or replace function public.enforce_integration_limit(p_workspace uuid, p_integration uuid, p_limit integer)
returns boolean
language plpgsql as $$
declare v_n integer;
begin
  if p_workspace is null or p_integration is null or p_limit is null or p_limit < 0 then raise exception 'invalid arguments' using errcode = '22023'; end if;
  perform 1 from public.workspaces where id = p_workspace for update;
  if not found then return false; end if;
  select count(*) into v_n from public.integrations where workspace_id = p_workspace;
  if v_n <= p_limit then return true; end if;
  delete from public.integrations where workspace_id = p_workspace and id = p_integration;
  return false;
end $$;

-- Retention for the Layer 10 data (floors: 7 days of monitoring history,
-- 7 days of QA runs). Current monitor state and open alerts' monitors stay.
create or replace function public.retention_purge_revenue(p_workspace uuid, p_monitoring_before timestamptz, p_qa_before timestamptz)
returns jsonb
language plpgsql as $$
declare v_obs integer := 0; v_snap integer := 0; v_alerts integer := 0; v_qa integer := 0; v_hooks integer := 0;
begin
  if p_workspace is null then raise exception 'workspace is required' using errcode = '22023'; end if;
  if p_monitoring_before is not null and p_monitoring_before > now() - interval '7 days' then
    raise exception 'monitoring retention below the 7-day floor' using errcode = '22023';
  end if;
  if p_qa_before is not null and p_qa_before > now() - interval '7 days' then
    raise exception 'QA retention below the 7-day floor' using errcode = '22023';
  end if;
  if p_monitoring_before is not null then
    delete from public.alerts where workspace_id = p_workspace and created_at < p_monitoring_before;
    get diagnostics v_alerts = row_count;
    -- changes cascade from their observation; the monitor's latest observation is kept
    delete from public.monitor_observations o
     where o.workspace_id = p_workspace and o.observed_at < p_monitoring_before
       and not exists (select 1 from public.monitors m where m.last_observation_id = o.id);
    get diagnostics v_obs = row_count;
    delete from public.monitor_snapshots s
     where s.workspace_id = p_workspace and s.last_seen_at < p_monitoring_before
       and not exists (select 1 from public.monitors m where m.id = s.monitor_id and m.current_hash = s.value_hash);
    get diagnostics v_snap = row_count;
    delete from public.webhook_deliveries where workspace_id = p_workspace and created_at < p_monitoring_before and status in ('delivered','dead');
    get diagnostics v_hooks = row_count;
  end if;
  if p_qa_before is not null then
    delete from public.qa_runs where workspace_id = p_workspace and status in ('completed','cancelled') and created_at < p_qa_before;
    get diagnostics v_qa = row_count;
  end if;
  return jsonb_build_object('observations', v_obs, 'snapshots', v_snap, 'alerts', v_alerts, 'qaRuns', v_qa, 'webhookDeliveries', v_hooks);
end $$;

-- Workspace deletion: remove the workspace's audit rows (they would
-- otherwise outlive it); the caller records one content-free deletion row.
create or replace function public.purge_workspace_audit(p_workspace uuid)
returns integer
language plpgsql as $$
declare v integer := 0;
begin
  if p_workspace is null then raise exception 'workspace is required' using errcode = '22023'; end if;
  if to_regclass('public.audit_log') is not null then
    execute 'delete from public.audit_log where workspace_id = $1' using p_workspace;
    get diagnostics v = row_count;
  end if;
  return v;
end $$;

-- ---------------------------------------------------------------------
-- 9. RLS + privileges
-- ---------------------------------------------------------------------
do $$
declare t text; r text; f text;
begin
  foreach t in array array['workspace_agents','monitors','monitor_observations','monitor_snapshots','monitor_changes',
    'ci_products','ci_competitor_products','ci_recommendations','alert_rules','alerts','alert_deliveries',
    'qa_projects','qa_suites','qa_scenarios','qa_runs','qa_results','workspace_webhooks','webhook_deliveries'] loop
    execute format('alter table public.%I enable row level security', t);
    foreach r in array array['anon','authenticated'] loop
      if exists (select 1 from pg_roles where rolname = r) then execute format('revoke all on public.%I from %I', t, r); end if;
    end loop;
    if exists (select 1 from pg_roles where rolname = 'service_role') then
      execute format('grant select, insert, update, delete on public.%I to service_role', t);
    end if;
  end loop;
  foreach f in array array[
    'public.claim_due_monitors(text, integer, integer)',
    'public.claim_qa_result(text, integer)',
    'public.claim_webhook_deliveries(text, integer, integer)',
    'public.enforce_monitored_product_limit(uuid, uuid, integer)',
    'public.enforce_integration_limit(uuid, uuid, integer)',
    'public.retention_purge_revenue(uuid, timestamptz, timestamptz)',
    'public.purge_workspace_audit(uuid)'
  ] loop
    execute format('revoke all on function %s from public', f);
    foreach r in array array['anon','authenticated'] loop
      if exists (select 1 from pg_roles where rolname = r) then execute format('revoke all on function %s from %I', f, r); end if;
    end loop;
    if exists (select 1 from pg_roles where rolname = 'service_role') then execute format('grant execute on function %s to service_role', f); end if;
  end loop;
end $$;
