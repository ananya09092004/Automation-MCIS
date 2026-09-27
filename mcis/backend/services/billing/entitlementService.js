/**
 * Layer 7 — the ONE place quota decisions are made, plus the usage meter.
 *
 *   checkEntitlement(workspaceId, capability, quantity, { reserve, key })
 *     → { allowed, enforced, capability, planId, status, limit, used, remaining, reason, reservation? }
 *
 * Server-side only: the workspace comes from Layer 1 context, quantities
 * from the operation itself, counts from the database — never from a
 * client. Roles (owner/admin/member) do not affect entitlements: nobody
 * can bypass a plan limit.
 *
 * Metered capabilities (executions, workflow runs, API calls, connector
 * calls) are counted from the immutable usage ledger. With `reserve: true`
 * the check and a reservation happen atomically in the database
 * (billing_reserve_usage: advisory lock per workspace+metric), so two
 * concurrent requests can never together exceed a limit. Count
 * capabilities (members, active workflows, concurrent executions) are
 * counted from the source tables.
 *
 * Meter lifecycle for a limited operation:
 *   h = begin(ws, capability, key)   → reserve (or QuotaError 402)
 *   … do the operation …
 *   commit(h, meta)                  → immutable usage event (same key)
 *   release(h)                       → if the operation never happened
 * The same key always maps to the same reservation/event: a retried or
 * replayed operation is never charged twice.
 *
 * BILLING_ENABLED=false: nothing is enforced (allowed, enforced:false) but
 * usage is still recorded best-effort. BILLING_ENABLED=true: enforcement
 * fails CLOSED — if plan/usage cannot be read, the operation is refused.
 */
'use strict';

const { CAPABILITIES, METRICS, DEFAULT_PLAN_ID, limitOf, resolveEffective } = require('./plans');
const { sanitize, sanitizeString } = require('../security/sensitiveClassifier');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KEY_RE = /^[A-Za-z0-9_.:@-]{1,200}$/;

class QuotaError extends Error {
  constructor(status, code, message, extra) {
    super(message);
    this.name = 'QuotaError';
    this.status = status;
    this.code = code;
    if (extra) this.extra = extra;
  }
}

function createBillingAudit({ appendAuditLog, logger = console } = {}) {
  return function record(workspaceId, actorId, type, payload = {}, { success = true, error = null } = {}) {
    if (!appendAuditLog || !workspaceId) return;
    try {
      Promise.resolve(appendAuditLog(actorId || 'system', `billing.${type}`, sanitize({ ...payload, workspaceId }, { maxString: 300 }),
        { success, error: error ? sanitizeString(String(error), 300) : null }, workspaceId)).catch(() => {});
    } catch { logger.warn?.(`[billing] audit write failed (${type})`); }
  };
}

function createEntitlementService({ store, enabled = false, counters = {}, audit = null, logger = console, options = {} } = {}) {
  if (!store) throw new Error('entitlement service: store is required');
  const now = options.now || (() => new Date());
  const reservationTtlSeconds = options.reservationTtlSeconds || 900;
  const graceOpts = { pastDueGraceDays: options.pastDueGraceDays ?? 7, activeGraceDays: options.activeGraceDays ?? 3 };
  const planCacheMs = options.planCacheMs ?? 30000;
  let planCache = null;

  async function plans() {
    if (planCache && now().getTime() - planCache.at < planCacheMs) return planCache.map;
    const [list, features] = await Promise.all([store.listPlans(), loadFeatures()]);
    planCache = { at: now().getTime(), map: new Map(list.map((p) => [p.id, { ...p, features: features.get(p.id) || {} }])) };
    return planCache.map;
  }

  // Layer 8: plan feature flags (display + feature gates). Optional table:
  // a deployment without the Layer 8 migration simply has no flags.
  async function loadFeatures() {
    if (!store.listPlanFeatures) return new Map();
    try {
      return new Map((await store.listPlanFeatures()).map((r) => [r.plan_id, r.features && typeof r.features === 'object' ? r.features : {}]));
    } catch (err) {
      logger.warn?.(`[billing] plan features unavailable (${err.code || err.name})`);
      return new Map();
    }
  }

  /**
   * Effective plan + period for a workspace (throws if storage fails).
   * Layer 8: operator-set custom limits (Enterprise) override the plan's
   * limits while the subscription is in force — never for a lapsed one.
   */
  async function planContext(workspaceId) {
    const [sub, map, override] = await Promise.all([
      store.getSubscription(workspaceId), plans(),
      store.getPlanOverride ? store.getPlanOverride(workspaceId) : null,
    ]);
    const eff = resolveEffective(sub, now(), graceOpts);
    let plan = map.get(eff.planId) || map.get(DEFAULT_PLAN_ID) || null;
    const custom = !!(plan && override && eff.source === 'subscription' && override.limits && typeof override.limits === 'object');
    if (custom) plan = { ...plan, limits: { ...plan.limits, ...override.limits }, customLimits: true };
    return { subscription: sub, effective: eff, plan, planId: plan ? plan.id : eff.planId, customLimits: custom };
  }

  /**
   * Layer 8 feature gate. A flag that is missing counts as included; only
   * an explicit `false` excludes a feature. Enforced only with billing on;
   * fails closed when the plan cannot be read.
   */
  async function checkFeature(workspaceId, feature) {
    if (typeof workspaceId !== 'string' || !UUID_RE.test(workspaceId) || typeof feature !== 'string' || !/^[a-z][a-z0-9_]{1,40}$/.test(feature)) {
      throw new QuotaError(400, 'BAD_REQUEST', 'Invalid feature check');
    }
    if (!enabled) return { allowed: true, enforced: false, feature };
    try {
      const ctx = await planContext(workspaceId);
      const flags = (ctx.plan && ctx.plan.features) || {};
      const allowed = flags[feature] !== false;
      if (!allowed && audit) audit(workspaceId, null, 'feature_denied', { feature, planId: ctx.planId }, { success: false });
      return { allowed, enforced: true, feature, planId: ctx.planId };
    } catch (err) {
      logger.error?.(`[billing] feature check failed (${err.code || err.name}); refusing (fail closed)`);
      return { allowed: false, enforced: true, feature, reason: 'ENTITLEMENT_UNAVAILABLE' };
    }
  }

  async function assertFeature(workspaceId, feature) {
    const r = await checkFeature(workspaceId, feature);
    if (r.allowed) return r;
    if (r.reason === 'ENTITLEMENT_UNAVAILABLE') throw new QuotaError(503, 'ENTITLEMENT_UNAVAILABLE', 'Plan features could not be verified; the operation was not started.');
    throw new QuotaError(402, 'FEATURE_NOT_IN_PLAN', `Your plan does not include ${feature.replace(/_/g, ' ')}.`, { feature, planId: r.planId });
  }

  const validate = (workspaceId, capability, quantity) => {
    if (typeof workspaceId !== 'string' || !UUID_RE.test(workspaceId)) throw new QuotaError(400, 'BAD_REQUEST', 'Invalid workspace');
    if (!Object.prototype.hasOwnProperty.call(CAPABILITIES, capability)) throw new QuotaError(400, 'BAD_REQUEST', `Unknown capability "${capability}"`);
    if (!Number.isInteger(quantity) || quantity < 0 || quantity > 1000000) throw new QuotaError(400, 'BAD_REQUEST', 'Quantity must be a non-negative integer');
  };

  async function checkEntitlement(workspaceId, capability, quantity = 1, { reserve = false, key = null, feature = null } = {}) {
    validate(workspaceId, capability, quantity);
    const cap = CAPABILITIES[capability];
    if (reserve && (cap.kind !== 'metered' || quantity < 1 || typeof key !== 'string' || !KEY_RE.test(key))) {
      throw new QuotaError(400, 'BAD_REQUEST', 'A reservation needs a metered capability, quantity ≥ 1 and a valid key');
    }
    if (!enabled) return { allowed: true, enforced: false, capability, reason: 'BILLING_DISABLED', limit: null, used: null, remaining: null };
    let ctx;
    let result;
    try {
      ctx = await planContext(workspaceId);
      const limit = limitOf(ctx.plan, cap.limit, cap);
      const base = { enforced: true, capability, planId: ctx.planId, status: ctx.effective.status, limit };
      // Layer 8: optional plan feature required by the operation (same plan read).
      if (feature && ctx.plan && ctx.plan.features && ctx.plan.features[feature] === false) {
        result = { ...base, allowed: false, used: null, remaining: null, reason: 'FEATURE_NOT_IN_PLAN', feature };
      } else if (cap.kind === 'count') {
        const counter = counters[capability];
        if (limit === null) result = { ...base, allowed: true, used: null, remaining: null, reason: 'UNLIMITED' };
        else if (!counter) result = { ...base, allowed: false, used: null, remaining: 0, reason: 'COUNTER_UNAVAILABLE' };
        else {
          const used = await counter(workspaceId, limit);
          const ok = used + quantity <= limit;
          result = { ...base, allowed: ok, used, remaining: Math.max(0, limit - used), reason: ok ? 'WITHIN_LIMIT' : 'LIMIT_REACHED' };
        }
      } else if (reserve) {
        if (limit === null) {
          result = { ...base, allowed: true, used: null, remaining: null, reason: 'UNLIMITED', reservation: { id: null, key, replayed: false } };
        } else {
          const r = await store.reserveUsage({
            workspaceId, metric: cap.metric, quantity, limit, key, ttlSeconds: reservationTtlSeconds,
            periodStart: ctx.effective.periodStart.toISOString(), periodEnd: ctx.effective.periodEnd.toISOString(),
          });
          result = {
            ...base, allowed: r.allowed, used: r.used, remaining: r.replayed ? null : Math.max(0, limit - r.used - r.reserved - (r.allowed ? quantity : 0)),
            reason: r.replayed ? 'ALREADY_RESERVED' : (r.allowed ? 'WITHIN_LIMIT' : 'LIMIT_REACHED'),
            ...(r.allowed ? { reservation: { id: r.reservationId, key, replayed: r.replayed } } : {}),
          };
        }
      } else {
        const totals = await store.usageTotals(workspaceId, ctx.effective.periodStart.toISOString(), ctx.effective.periodEnd.toISOString());
        const used = totals[cap.metric] || 0;
        const ok = limit === null || used + quantity <= limit;
        result = { ...base, allowed: ok, used, remaining: limit === null ? null : Math.max(0, limit - used), reason: limit === null ? 'UNLIMITED' : (ok ? 'WITHIN_LIMIT' : 'LIMIT_REACHED') };
      }
    } catch (err) {
      if (err instanceof QuotaError) throw err;
      logger.error?.(`[billing] entitlement check failed (${err.code || err.name}); refusing (fail closed)`);
      return { allowed: false, enforced: true, capability, reason: 'ENTITLEMENT_UNAVAILABLE', limit: null, used: null, remaining: null };
    }
    if (!result.allowed && audit) {
      audit(workspaceId, null, result.reason === 'FEATURE_NOT_IN_PLAN' ? 'feature_denied' : 'quota_exceeded', { capability, planId: result.planId, limit: result.limit, used: result.used, quantity, reason: result.reason, ...(result.feature ? { feature: result.feature } : {}) }, { success: false });
    }
    return result;
  }

  // ------------------------------------------------------------------
  // Meter
  // ------------------------------------------------------------------
  function deny(r) {
    if (r.reason === 'FEATURE_NOT_IN_PLAN') {
      return new QuotaError(402, 'FEATURE_NOT_IN_PLAN', `Your plan does not include ${String(r.feature).replace(/_/g, ' ')}.`, { feature: r.feature, planId: r.planId });
    }
    if (r.reason === 'ENTITLEMENT_UNAVAILABLE') {
      return new QuotaError(503, 'ENTITLEMENT_UNAVAILABLE', 'Usage limits could not be verified; the operation was not started.');
    }
    return new QuotaError(402, 'QUOTA_EXCEEDED', `Your plan's limit for ${r.capability.replace(/_/g, ' ')} has been reached.`,
      { capability: r.capability, limit: r.limit, used: r.used, planId: r.planId });
  }

  /** Reserve quota for a limited operation (throws QuotaError when not allowed). */
  async function begin(workspaceId, capability, key, { quantity = 1, feature = null } = {}) {
    const r = await checkEntitlement(workspaceId, capability, quantity, { reserve: enabled, key: enabled ? key : null, feature });
    if (!r.allowed) throw deny(r);
    return { workspaceId, capability, metric: CAPABILITIES[capability].metric, quantity, key, reservationId: r.reservation ? r.reservation.id : null, replayed: !!(r.reservation && r.reservation.replayed) };
  }

  /** Count-capability gate (members, active workflows, concurrency). */
  async function assert(workspaceId, capability, quantity = 1) {
    const r = await checkEntitlement(workspaceId, capability, quantity);
    if (!r.allowed) throw deny(r);
    return r;
  }

  /**
   * Layer 9: race-free count limits. Called AFTER the caller's write with
   * `enforce(limit)`, a store operation that re-counts under a per-workspace
   * lock and undoes the caller's own write when over the limit (returns
   * false). Throws QUOTA_EXCEEDED (write already undone) or
   * ENTITLEMENT_UNAVAILABLE (caller must undo its write: fail closed).
   */
  async function enforceCount(workspaceId, capability, enforce) {
    if (!CAPABILITIES[capability] || CAPABILITIES[capability].kind !== 'count') throw new QuotaError(400, 'BAD_REQUEST', 'enforceCount needs a count capability');
    const r = await checkEntitlement(workspaceId, capability, 0);
    if (!r.enforced || r.reason === 'UNLIMITED') return r;
    if (!Number.isInteger(r.limit)) throw deny({ ...r, reason: 'ENTITLEMENT_UNAVAILABLE' });
    let kept;
    try { kept = await enforce(r.limit); } catch (err) {
      logger.error?.(`[billing] count-limit enforcement failed (${err.code || err.name}); refusing (fail closed)`);
      throw deny({ ...r, reason: 'ENTITLEMENT_UNAVAILABLE' });
    }
    if (kept !== true) {
      if (audit) audit(workspaceId, null, 'quota_exceeded', { capability, planId: r.planId, limit: r.limit, reason: 'LIMIT_REACHED_CONCURRENT' }, { success: false });
      throw deny({ ...r, allowed: false, reason: 'LIMIT_REACHED', used: r.limit });
    }
    return r;
  }

  /** Append a usage event (idempotent by key). Never throws when billing is off. */
  async function record(workspaceId, metric, quantity, key, { source = null, sourceId = null, actorId = null, reservationId = null } = {}) {
    if (!METRICS.includes(metric)) throw new QuotaError(400, 'BAD_REQUEST', `Unknown metric "${metric}"`);
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 1000000) throw new QuotaError(400, 'BAD_REQUEST', 'Usage quantity must be a positive integer');
    if (typeof key !== 'string' || !KEY_RE.test(key) || typeof workspaceId !== 'string' || !UUID_RE.test(workspaceId)) throw new QuotaError(400, 'BAD_REQUEST', 'Invalid usage key or workspace');
    try {
      return await store.recordUsage({ workspaceId, metric, quantity, key, source, sourceId: sourceId ? String(sourceId).slice(0, 200) : null, actorId, reservationId });
    } catch (err) {
      logger.error?.(`[billing] usage record failed (${metric}, ${err.code || err.name})`);
      if (enabled) throw new QuotaError(503, 'USAGE_UNAVAILABLE', 'Usage could not be recorded.');
      return false;
    }
  }

  async function commit(h, meta = {}) {
    if (!h) return false;
    return record(h.workspaceId, h.metric, h.quantity, h.key, { ...meta, reservationId: h.reservationId });
  }

  async function release(h) {
    if (!h || !h.reservationId || h.replayed) return false;
    try { return await store.releaseReservation(h.workspaceId, h.reservationId); } catch (err) {
      logger.warn?.(`[billing] reservation release failed (${err.code || err.name}); it expires on its own`);
      return false;
    }
  }

  function invalidatePlans() { planCache = null; }

  return { enabled, checkEntitlement, checkFeature, assertFeature, begin, assert, enforceCount, commit, release, record, planContext, invalidatePlans, plans };
}

module.exports = { createEntitlementService, createBillingAudit, QuotaError };
