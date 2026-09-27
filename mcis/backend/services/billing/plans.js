/**
 * Layer 7 — plan / capability semantics (pure).
 *
 * Plans live in the billing_plans table; this file holds only the MEANING
 * of their limits, never prices or numbers:
 *   limits[key] = non-negative integer → cap;  null → unlimited;
 *   missing key or any other value      → treated as 0 (fail closed).
 * Layer 10: capabilities added after plans were created are `optional`: a
 * plan row without the key (a custom plan created before the Layer 10
 * migration) is unlimited for it, so upgrading never locks a workspace out.
 * The Layer 10 migration adds explicit limits to the built-in plans.
 *
 * Effective plan (what is enforced right now), from the subscription:
 *   none ................................. default plan ('free')
 *   trialing  → plan while now < trial_ends_at (else default)
 *   active    → plan while now < current_period_end + grace (else default)
 *   past_due  → plan while now < current_period_end + pastDueGraceDays
 *   cancelled → plan while now < current_period_end (paid-up period), else default
 *   expired   → default plan
 */
'use strict';

const DEFAULT_PLAN_ID = 'free';
const STATUSES = ['trialing', 'active', 'past_due', 'cancelled', 'expired'];

// capability → how it is measured and which plan limit caps it
const CAPABILITIES = Object.freeze({
  executions: { kind: 'metered', metric: 'agent_execution', limit: 'executions_per_month' },
  workflow_runs: { kind: 'metered', metric: 'workflow_run', limit: 'workflow_runs_per_month' },
  api_calls: { kind: 'metered', metric: 'api_call', limit: 'api_calls_per_month' },
  connector_calls: { kind: 'metered', metric: 'connector_call', limit: 'connector_calls_per_month' },
  members: { kind: 'count', limit: 'max_members' },
  active_workflows: { kind: 'count', limit: 'max_active_workflows' },
  concurrent_executions: { kind: 'count', limit: 'max_concurrent_executions' },
  // Layer 10 revenue dimensions
  monitoring_checks: { kind: 'metered', metric: 'monitoring_check', limit: 'monitoring_checks_per_month', optional: true },
  agent_test_scenarios: { kind: 'metered', metric: 'agent_test_scenario', limit: 'agent_test_scenarios_per_month', optional: true },
  monitored_products: { kind: 'count', limit: 'max_monitored_products', optional: true },
  integrations: { kind: 'count', limit: 'max_integrations', optional: true },
});
const LIMIT_KEYS = [...new Set([...Object.values(CAPABILITIES).map((c) => c.limit), 'usage_retention_days'])];
const METRICS = ['agent_execution', 'workflow_run', 'execution_step', 'connector_call', 'api_call', 'execution_completed', 'execution_failed', 'execution_cancelled',
  'monitoring_check', 'agent_test_scenario']; // Layer 10

/**
 * null → unlimited; valid integer → cap; anything else → 0 (fail closed).
 * `optional` (Layer 10 capabilities): a MISSING key means unlimited; a
 * present but invalid value still fails closed.
 */
function limitOf(plan, key, { optional = false } = {}) {
  if (!plan || !plan.limits || typeof plan.limits !== 'object') return 0;
  if (!Object.prototype.hasOwnProperty.call(plan.limits, key)) return optional ? null : 0;
  const v = plan.limits[key];
  if (v === null) return null;
  return Number.isInteger(v) && v >= 0 ? v : 0;
}

function calendarMonth(t) {
  const start = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), 1));
  const end = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 1));
  return { start, end };
}

/**
 * @returns {{ planId, status, source, periodStart: Date, periodEnd: Date, reason }}
 */
function resolveEffective(sub, now, { pastDueGraceDays = 7, activeGraceDays = 3 } = {}) {
  const t = now instanceof Date ? now : new Date(now);
  const day = 86400000;
  const end = sub && sub.current_period_end ? new Date(sub.current_period_end) : null;
  const start = sub && sub.current_period_start ? new Date(sub.current_period_start) : null;
  const month = calendarMonth(t);
  const fallback = (reason, status = sub ? sub.status : 'none') => ({ planId: DEFAULT_PLAN_ID, status, source: 'default', periodStart: month.start, periodEnd: month.end, reason });
  if (!sub) return fallback('NO_SUBSCRIPTION', 'none');
  if (!STATUSES.includes(sub.status)) return fallback('UNKNOWN_STATUS');
  const paidPeriod = () => (start && end && t >= start && t < end ? { periodStart: start, periodEnd: end } : { periodStart: month.start, periodEnd: month.end });
  const onPlan = (reason) => ({ planId: sub.plan_id, status: sub.status, source: 'subscription', ...paidPeriod(), reason });
  switch (sub.status) {
    case 'trialing':
      return sub.trial_ends_at && t >= new Date(sub.trial_ends_at) ? fallback('TRIAL_ENDED') : onPlan('TRIALING');
    case 'active':
      return end && t.getTime() >= end.getTime() + activeGraceDays * day ? fallback('PERIOD_ENDED_NOT_RENEWED') : onPlan('ACTIVE');
    case 'past_due':
      return end && t.getTime() < end.getTime() + pastDueGraceDays * day ? onPlan('PAST_DUE_GRACE') : fallback('PAST_DUE_GRACE_OVER');
    case 'cancelled':
      return end && t < end ? onPlan('CANCELLED_UNTIL_PERIOD_END') : fallback('CANCELLED');
    default:
      return fallback('EXPIRED');
  }
}

module.exports = { CAPABILITIES, LIMIT_KEYS, METRICS, STATUSES, DEFAULT_PLAN_ID, limitOf, resolveEffective, calendarMonth };
