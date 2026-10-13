-- =====================================================================
-- Layer 9 — schema audit for the Nexus Layer 1–9 tables and RPCs.
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/schema-audit.sql
-- Prints one row per VIOLATION (none = pass) and a summary line.
-- Checks: every table exists, RLS is on, anon/authenticated hold no table
-- privileges and no RLS policy targets them, every workspace-owned table has
-- a NOT NULL workspace_id covered by a foreign key (to workspaces directly
-- or through a composite key to its parent) and by an index, and every
-- Layer 1–9 RPC is not executable by public / anon / authenticated.
-- Read-only: it changes nothing.
-- =====================================================================
with t(name, ws_owned) as (values
  ('workspaces', false), ('workspace_members', true), ('workspace_invitations', true),
  ('workspace_tasks', true), ('workspace_task_activity', true), ('workspace_permission_grants', true),
  ('agent_executions', true), ('agent_execution_steps', true), ('agent_execution_approvals', true),
  ('workflows', true), ('workflow_versions', true), ('workflow_runs', true), ('workflow_run_steps', true), ('workflow_jobs', true),
  ('integrations', true), ('integration_credentials', true), ('integration_permissions', true),
  ('workspace_security_policies', true), ('workspace_api_keys', true), ('oauth_states', true), ('security_rate_limits', false),
  ('billing_plans', false), ('workspace_subscriptions', true), ('usage_events', true), ('usage_reservations', true), ('billing_webhook_events', false),
  ('user_onboarding', false), ('billing_customers', true), ('billing_checkout_sessions', true), ('billing_plan_features', false), ('workspace_plan_overrides', true),
  ('workspace_retention_policies', true), ('worker_heartbeats', false),
  -- Layer 10
  ('workspace_agents', true), ('monitors', true), ('monitor_observations', true), ('monitor_snapshots', true), ('monitor_changes', true),
  ('ci_products', true), ('ci_competitor_products', true), ('ci_recommendations', true), ('alert_rules', true), ('alerts', true), ('alert_deliveries', true),
  ('qa_projects', true), ('qa_suites', true), ('qa_scenarios', true), ('qa_runs', true), ('qa_results', true), ('workspace_webhooks', true), ('webhook_deliveries', true)
),
cls as (select t.*, c.oid as relid, c.relrowsecurity from t left join pg_class c on c.relname = t.name and c.relnamespace = 'public'::regnamespace and c.relkind = 'r'),
v as (
  select name, 'missing table' as problem from cls where relid is null
  union all select name, 'RLS disabled' from cls where relid is not null and not relrowsecurity
  union all select name, format('%s has %s', r, p) from cls, unnest(array['anon','authenticated']) r, unnest(array['SELECT','INSERT','UPDATE','DELETE']) p
    where relid is not null and exists (select 1 from pg_roles where rolname = r) and has_table_privilege(r, relid, p)
  union all select tablename::text, 'policy for ' || array_to_string(roles, ',') from pg_policies
    where schemaname = 'public' and tablename in (select name from t) and (roles && array['anon','authenticated','public']::name[])
  union all select name, 'workspace_id missing or nullable' from cls where ws_owned and relid is not null and not exists (
    select 1 from pg_attribute a where a.attrelid = cls.relid and a.attname = 'workspace_id' and a.attnotnull and not a.attisdropped)
  union all select name, 'no foreign key covering workspace_id' from cls where ws_owned and relid is not null and not exists (
    select 1 from pg_constraint k join pg_attribute a on a.attrelid = k.conrelid and a.attnum = any(k.conkey)
    where k.conrelid = cls.relid and k.contype = 'f' and a.attname = 'workspace_id')
    and name not in ('oauth_states') -- short-lived, deleted on use/expiry; bound by value, checked at consume time
  union all select name, 'no index containing workspace_id' from cls where ws_owned and relid is not null and not exists (
    select 1 from pg_index i join pg_attribute a on a.attrelid = i.indrelid and a.attnum = any(i.indkey::int2[])
    where i.indrelid = cls.relid and a.attname = 'workspace_id')
    -- reached only through their parent's key (primary key / unique parent id), never scanned by workspace:
    and name not in ('integration_credentials', 'integration_permissions', 'oauth_states', 'workflow_jobs')
  union all select p.proname::text, format('function executable by %s', r) from pg_proc p, unnest(array['public','anon','authenticated']) r
    where p.pronamespace = 'public'::regnamespace
      and p.proname in ('transfer_workspace_ownership','retention_purge_workspace','enforce_active_workflow_limit','enforce_member_limit','claim_workflow_job_v2','security_rate_limit_hit','consume_oauth_state','billing_reserve_usage',
        'claim_due_monitors','claim_qa_result','claim_webhook_deliveries','enforce_monitored_product_limit','enforce_integration_limit','retention_purge_revenue','purge_workspace_audit')
      and ((r = 'public' and exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) x where x.grantee = 0 and x.privilege_type = 'EXECUTE'))
        or (r <> 'public' and exists (select 1 from pg_roles where rolname = r) and has_function_privilege(r, p.oid, 'EXECUTE')))
)
select name, problem from v order by 1, 2;

select 'schema audit complete: the rows above (if any) are violations' as summary;
