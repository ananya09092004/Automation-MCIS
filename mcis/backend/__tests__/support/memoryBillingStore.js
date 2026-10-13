/**
 * TEST-ONLY in-memory implementation of services/billing/billingStore.js.
 * Mirrors migrations/20260929_layer7_billing.up.sql:
 *   - seeded plan catalogue (same limits)
 *   - subscription CAS on version; unique (provider, external_subscription_id) → 23505
 *   - usage_events unique (workspace_id, idempotency_key), quantity 1..1e6, immutable
 *   - billing_reserve_usage: one atomic section per call (the DB uses an
 *     advisory lock); same key → same reservation
 *   - webhook ledger unique (provider, event_id)
 * and migrations/20260930_layer8_customer.up.sql:
 *   - billing_customers pk (workspace_id, provider), unique (provider, external_customer_id)
 *   - billing_checkout_sessions unique (provider, external_session_id), status CAS
 *   - billing_plan_features (seeded like the migration), workspace_plan_overrides
 * Every method yields to the event loop first so concurrent callers interleave.
 */
'use strict';

const crypto = require('crypto');

const tick = () => new Promise((r) => setImmediate(r));
const clone = (o) => (o == null ? null : JSON.parse(JSON.stringify(o)));
const err = (code, message) => Object.assign(new Error(message), { code });
const METRICS = new Set(['agent_execution', 'workflow_run', 'execution_step', 'connector_call', 'api_call', 'execution_completed', 'execution_failed', 'execution_cancelled', 'monitoring_check', 'agent_test_scenario']);

const SEED = [
  { id: 'free', name: 'Free', description: 'For trying Nexus with a small team.', sort_order: 10, price: null,
    limits: { executions_per_month: 100, workflow_runs_per_month: 50, api_calls_per_month: 1000, connector_calls_per_month: 500, max_members: 3, max_active_workflows: 3, max_concurrent_executions: 1, usage_retention_days: 30 } },
  { id: 'pro', name: 'Pro', description: 'For growing practices and small businesses.', sort_order: 20, price: null,
    limits: { executions_per_month: 2000, workflow_runs_per_month: 1000, api_calls_per_month: 20000, connector_calls_per_month: 10000, max_members: 10, max_active_workflows: 25, max_concurrent_executions: 1, usage_retention_days: 90 } },
  { id: 'business', name: 'Business', description: 'For firms running automation across teams.', sort_order: 30, price: null,
    limits: { executions_per_month: 20000, workflow_runs_per_month: 10000, api_calls_per_month: 200000, connector_calls_per_month: 100000, max_members: 50, max_active_workflows: 200, max_concurrent_executions: 1, usage_retention_days: 365 } },
  { id: 'enterprise', name: 'Enterprise', description: 'Custom limits and terms.', sort_order: 40, price: null,
    limits: { executions_per_month: null, workflow_runs_per_month: null, api_calls_per_month: null, connector_calls_per_month: null, max_members: null, max_active_workflows: null, max_concurrent_executions: null, usage_retention_days: null } },
];

const FEATURE_SEED = {
  free: { api_access: true, integrations: true, workflow_templates: true, scheduled_workflows: true, audit_log: true, custom_limits: false, manual_activation: false, support: 'community' },
  pro: { api_access: true, integrations: true, workflow_templates: true, scheduled_workflows: true, audit_log: true, custom_limits: false, manual_activation: false, support: 'email' },
  business: { api_access: true, integrations: true, workflow_templates: true, scheduled_workflows: true, audit_log: true, custom_limits: false, manual_activation: false, support: 'priority_email' },
  enterprise: { api_access: true, integrations: true, workflow_templates: true, scheduled_workflows: true, audit_log: true, custom_limits: true, manual_activation: true, support: 'dedicated' },
};

function createMemoryBillingStore({ now = () => new Date(), workspaceExists = async () => true } = {}) {
  const customers = new Map(); // `${ws}|${provider}` → row
  const sessions = new Map(); // `${provider}|${sessionId}` → row
  const features = new Map(Object.entries(FEATURE_SEED).map(([plan_id, f]) => [plan_id, { plan_id, features: clone(f) }]));
  const overrides = new Map();
  const plans = new Map(SEED.map((p) => [p.id, { is_public: true, updated_at: now().toISOString(), ...clone(p) }]));
  const subs = new Map();
  const events = [];
  const reservations = new Map();
  const webhooks = new Map();
  const ms = (d) => new Date(d).getTime();

  return {
    _events: events, _reservations: reservations, _subs: subs, _plans: plans, _webhooks: webhooks,
    async listPlans() { await tick(); return [...plans.values()].sort((a, b) => a.sort_order - b.sort_order).map(clone); },
    async getPlan(id) { await tick(); return clone(plans.get(id) || null); },
    async getSubscription(ws) { await tick(); return clone(subs.get(ws) || null); },
    async findSubscriptionByExternal(provider, ext) {
      await tick();
      return clone([...subs.values()].find((s) => s.provider === provider && s.external_subscription_id === ext) || null);
    },
    async saveSubscription(ws, expectedVersion, patch) {
      await tick();
      const cur = subs.get(ws);
      if (patch.plan_id && !plans.has(patch.plan_id)) throw err('23503', 'violates foreign key constraint plan_id');
      const clash = patch.external_subscription_id && [...subs.values()].some((s) => s.workspace_id !== ws
        && s.provider === (patch.provider || (cur && cur.provider)) && s.external_subscription_id === patch.external_subscription_id);
      if (clash) throw err('23505', 'duplicate key value violates unique constraint "workspace_subscriptions_external_uq"');
      if (expectedVersion === 0) {
        if (cur) return null;
        const row = { provider: 'none', cancel_at_period_end: false, created_at: now().toISOString(), ...clone(patch), workspace_id: ws, version: 1, updated_at: now().toISOString() };
        subs.set(ws, row);
        return clone(row);
      }
      if (!cur || cur.version !== expectedVersion) return null;
      Object.assign(cur, clone(patch), { version: expectedVersion + 1, updated_at: now().toISOString() });
      return clone(cur);
    },
    async workspaceExists(ws) { await tick(); return workspaceExists(ws); },

    async reserveUsage({ workspaceId, metric, quantity, limit, periodStart, periodEnd, key, ttlSeconds }) {
      await tick();
      if (!Number.isInteger(quantity) || quantity < 1 || quantity > 1000000) throw err('22023', 'invalid quantity');
      if (limit !== null && limit !== undefined && limit < 0) throw err('22023', 'invalid limit');
      // ---- atomic section (no awaits) ----
      const existing = [...reservations.values()].find((r) => r.workspace_id === workspaceId && r.idempotency_key === key);
      if (existing && existing.status !== 'released') return { reservationId: existing.id, allowed: true, replayed: true, used: 0, reserved: 0 };
      if (existing) reservations.delete(existing.id); // released earlier: evaluate afresh
      if (events.some((e) => e.workspace_id === workspaceId && e.idempotency_key === key)) return { reservationId: null, allowed: true, replayed: true, used: 0, reserved: 0 };
      const t = now().getTime();
      const used = events.filter((e) => e.workspace_id === workspaceId && e.metric === metric && ms(e.occurred_at) >= ms(periodStart) && ms(e.occurred_at) < ms(periodEnd))
        .reduce((a, e) => a + e.quantity, 0);
      const reserved = [...reservations.values()].filter((r) => r.workspace_id === workspaceId && r.metric === metric && r.status === 'reserved'
        && ms(r.expires_at) > t && ms(r.period_start) === ms(periodStart)).reduce((a, r) => a + r.quantity, 0);
      if (limit !== null && limit !== undefined && used + reserved + quantity > limit) return { reservationId: null, allowed: false, replayed: false, used, reserved };
      const r = {
        id: crypto.randomUUID(), workspace_id: workspaceId, metric, quantity, idempotency_key: key, status: 'reserved',
        period_start: new Date(periodStart).toISOString(), period_end: new Date(periodEnd).toISOString(),
        expires_at: new Date(t + ttlSeconds * 1000).toISOString(), created_at: new Date(t).toISOString(), finalized_at: null,
      };
      reservations.set(r.id, r);
      return { reservationId: r.id, allowed: true, replayed: false, used, reserved };
    },
    async recordUsage({ workspaceId, metric, quantity, key, source = null, sourceId = null, actorId = null, reservationId = null }) {
      await tick();
      if (!METRICS.has(metric)) throw err('23514', 'violates check constraint usage_events_metric_check');
      if (!Number.isInteger(quantity) || quantity < 1 || quantity > 1000000) throw err('23514', 'violates check constraint usage_events_quantity_check');
      let inserted = false;
      if (!events.some((e) => e.workspace_id === workspaceId && e.idempotency_key === key)) {
        events.push({ id: crypto.randomUUID(), workspace_id: workspaceId, metric, quantity, idempotency_key: key, source, source_id: sourceId, actor_id: actorId, reservation_id: reservationId, occurred_at: now().toISOString() });
        inserted = true;
      }
      const r = reservationId ? reservations.get(reservationId) : null;
      if (r && r.workspace_id === workspaceId && r.status === 'reserved') Object.assign(r, { status: 'committed', finalized_at: now().toISOString() });
      return inserted;
    },
    async releaseReservation(workspaceId, id) {
      await tick();
      const r = reservations.get(id);
      if (!r || r.workspace_id !== workspaceId || r.status !== 'reserved') return false;
      Object.assign(r, { status: 'released', finalized_at: now().toISOString() });
      return true;
    },
    async usageTotals(ws, from, to) {
      await tick();
      const out = {};
      for (const e of events) if (e.workspace_id === ws && ms(e.occurred_at) >= ms(from) && ms(e.occurred_at) < ms(to)) out[e.metric] = (out[e.metric] || 0) + e.quantity;
      return out;
    },
    async usageDaily(ws, from, to) {
      await tick();
      const m = new Map();
      for (const e of events) {
        if (e.workspace_id !== ws || ms(e.occurred_at) < ms(from) || ms(e.occurred_at) >= ms(to)) continue;
        const k = `${e.occurred_at.slice(0, 10)}|${e.metric}`;
        m.set(k, (m.get(k) || 0) + e.quantity);
      }
      return [...m.entries()].map(([k, total]) => { const [day, metric] = k.split('|'); return { day, metric, total }; })
        .sort((a, b) => a.day.localeCompare(b.day) || a.metric.localeCompare(b.metric));
    },
    async insertWebhookEvent(row) {
      await tick();
      const k = `${row.provider}|${row.event_id}`;
      if (webhooks.has(k)) return false;
      webhooks.set(k, { received_at: now().toISOString(), ...clone(row) });
      return true;
    },
    async updateWebhookEvent(provider, eventId, patch) {
      await tick();
      const w = webhooks.get(`${provider}|${eventId}`);
      if (w) Object.assign(w, clone(patch));
    },
    async deleteWebhookEvent(provider, eventId) { await tick(); webhooks.delete(`${provider}|${eventId}`); },

    // ---- Layer 8 ----
    _customers: customers, _sessions: sessions, _features: features, _overrides: overrides,
    async getCustomerBinding(ws, provider) { await tick(); return clone(customers.get(`${ws}|${provider}`) || null); },
    async findCustomerBinding(provider, ext) {
      await tick();
      for (const c of customers.values()) if (c.provider === provider && c.external_customer_id === ext) return clone(c);
      return null;
    },
    async insertCustomerBinding(row) {
      await tick();
      if (customers.has(`${row.workspace_id}|${row.provider}`)) return null;
      for (const c of customers.values()) if (c.provider === row.provider && c.external_customer_id === row.external_customer_id) return null;
      const r = { created_at: now().toISOString(), ...clone(row) };
      customers.set(`${row.workspace_id}|${row.provider}`, r);
      return clone(r);
    },
    async insertCheckoutSession(row) {
      await tick();
      const k = `${row.provider}|${row.external_session_id}`;
      if (sessions.has(k)) throw err('23505', 'duplicate checkout session');
      if (!plans.has(row.plan_id)) throw err('23503', 'unknown plan');
      const r = { id: crypto.randomUUID(), status: 'open', external_subscription_id: null, completed_at: null, created_at: now().toISOString(), ...clone(row) };
      sessions.set(k, r);
      return clone(r);
    },
    async getCheckoutSession(provider, ext) { await tick(); return clone(sessions.get(`${provider}|${ext}`) || null); },
    async updateCheckoutSession(provider, ext, fromStatus, patch) {
      await tick();
      const r = sessions.get(`${provider}|${ext}`);
      if (!r || r.status !== fromStatus) return null;
      Object.assign(r, clone(patch));
      return clone(r);
    },
    async listPlanFeatures() { await tick(); return [...features.values()].map(clone); },
    async getPlanOverride(ws) { await tick(); return clone(overrides.get(ws) || null); },
    async setPlanOverride(ws, row) {
      await tick();
      if (row === null) { overrides.delete(ws); return null; }
      const r = { workspace_id: ws, updated_at: now().toISOString(), ...clone(row) };
      overrides.set(ws, r);
      return clone(r);
    },
  };
}

module.exports = { createMemoryBillingStore, SEED_PLANS: SEED, FEATURE_SEED };
