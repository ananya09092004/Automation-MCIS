/**
 * Layer 7 — workspace billing / usage views (member+ reads).
 * Never returns provider secrets or external customer/subscription ids.
 * All numbers come from the authoritative usage ledger and plan table.
 */
'use strict';

const { WorkspaceError, hasRole } = require('../workspaceService');
const { CAPABILITIES, limitOf } = require('./plans');

const DAY = 86400000;

function createBillingService({ store, entitlements, providers, counters = {}, enabled = false, logger = console, options = {} } = {}) {
  const now = options.now || (() => new Date());
  const requireCtx = (ctx) => {
    if (!ctx || !ctx.workspace || !ctx.workspace.id || !ctx.userId) throw new WorkspaceError(401, 'AUTH_REQUIRED', 'Authentication required');
    return ctx.workspace.id;
  };
  const planView = (p) => ({
    id: p.id, name: p.name, description: p.description || null, limits: p.limits, price: p.price || null,
    features: p.features || {},
    // Layer 8: purchasable online only when the active provider has a price for it.
    purchasable: !!(providers.active.configured && providers.active.createCheckout && (!providers.active.priceForPlan || providers.active.priceForPlan(p.id))),
  });

  /**
   * Layer 8: what the payment provider can actually do on this deployment.
   * Missing configuration NAMES (never values) only for owners/admins.
   */
  async function paymentsView(ctx, sub) {
    const p = providers.active;
    const configured = !!p.configured;
    const isAdmin = hasRole(ctx.role, 'admin');
    let hasBillingAccount = false;
    if (configured && store.getCustomerBinding) {
      try { hasBillingAccount = !!(await store.getCustomerBinding(ctx.workspace.id, providers.activeName)); } catch { hasBillingAccount = false; }
    }
    const onlineSub = !!(sub && sub.provider === providers.activeName && ['active', 'trialing', 'past_due'].includes(sub.status));
    return {
      provider: providers.activeName,
      configured,
      status: configured ? 'configured' : 'not_configured',
      message: configured ? null : 'Payments are not configured for this deployment.',
      // true only when the provider can do it AND this caller may (owner/admin)
      checkoutAvailable: !!(isAdmin && configured && p.createCheckout),
      portalAvailable: !!(isAdmin && configured && p.createPortal && (hasBillingAccount || !store.getCustomerBinding)),
      cancelAvailable: !!(isAdmin && configured && p.cancelSubscription && onlineSub && sub.external_subscription_id && !sub.cancel_at_period_end),
      hasBillingAccount,
      canManage: isAdmin,
      ...(isAdmin && !configured && Array.isArray(p.missing) && providers.activeName !== 'none' ? { missingConfiguration: p.missing } : {}),
    };
  }

  async function summary(ctx) {
    const ws = requireCtx(ctx);
    const pc = await entitlements.planContext(ws);
    const from = pc.effective.periodStart.toISOString();
    const to = pc.effective.periodEnd.toISOString();
    const totals = await store.usageTotals(ws, from, to);
    const meters = [];
    for (const [capability, c] of Object.entries(CAPABILITIES)) {
      const limit = limitOf(pc.plan, c.limit, c);
      let used = null;
      if (c.kind === 'metered') used = totals[c.metric] || 0;
      else if (counters[capability]) {
        try { used = await counters[capability](ws, limit === null ? 1000 : limit); } catch { used = null; }
      }
      meters.push({ capability, kind: c.kind, limit, used, remaining: limit === null || used === null ? null : Math.max(0, limit - used), unlimited: limit === null });
    }
    const s = pc.subscription;
    return {
      billingEnabled: enabled,
      enforcement: enabled ? 'enforced' : 'not_enforced',
      plan: pc.plan ? planView(pc.plan) : null,
      subscription: {
        status: s ? s.status : 'none',
        effectiveStatus: pc.effective.status,
        effectivePlanReason: pc.effective.reason,
        source: pc.effective.source,
        provider: s ? s.provider : 'none',
        currentPeriodStart: s ? s.current_period_start : null,
        currentPeriodEnd: s ? s.current_period_end : null,
        trialEndsAt: s ? s.trial_ends_at : null,
        cancelAtPeriodEnd: s ? !!s.cancel_at_period_end : false,
      },
      period: { start: from, end: to },
      customLimits: !!pc.customLimits,
      // Layer 7 contract (unchanged shape) …
      payments: { provider: providers.activeName, configured: !!providers.active.configured, checkoutAvailable: !!(providers.active.configured && providers.active.createCheckout) },
      // … and the Layer 8 detail: which actions are really available.
      paymentStatus: await paymentsView(ctx, s),
      meters,
      totals,
    };
  }

  async function plans(ctx) {
    requireCtx(ctx);
    // Same catalogue the entitlement service enforces (Layer 8: with plan features).
    const list = entitlements.plans ? [...(await entitlements.plans()).values()] : await store.listPlans();
    return list.filter((p) => p.is_public !== false).sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0)).map(planView);
  }

  async function history(ctx, { days } = {}) {
    const ws = requireCtx(ctx);
    const pc = await entitlements.planContext(ws);
    const retention = limitOf(pc.plan, 'usage_retention_days');
    const max = Math.min(retention === null ? 366 : retention, 366);
    const n = Math.min(Math.max(parseInt(days, 10) || 30, 1), Math.max(max, 1));
    const to = new Date(Math.floor(now().getTime() / DAY) * DAY + DAY);
    const from = new Date(to.getTime() - n * DAY);
    const rows = await store.usageDaily(ws, from.toISOString(), to.toISOString());
    const byDay = new Map();
    for (let t = from.getTime(); t < to.getTime(); t += DAY) byDay.set(new Date(t).toISOString().slice(0, 10), {});
    for (const r of rows) if (byDay.has(r.day)) byDay.get(r.day)[r.metric] = r.total;
    return { from: from.toISOString(), to: to.toISOString(), days: n, retentionDays: retention, series: [...byDay.entries()].map(([day, metrics]) => ({ day, metrics })) };
  }

  async function dashboard(ctx, { days = 30 } = {}) {
    const h = await history(ctx, { days });
    const sum = (m) => h.series.reduce((a, d) => a + (d.metrics[m] || 0), 0);
    const completed = sum('execution_completed');
    const failed = sum('execution_failed');
    const cancelled = sum('execution_cancelled');
    const finished = completed + failed + cancelled;
    return {
      window: { from: h.from, to: h.to, days: h.days },
      executions: sum('agent_execution'),
      workflowRuns: sum('workflow_run'),
      steps: sum('execution_step'),
      connectorCalls: sum('connector_call'),
      apiCalls: sum('api_call'),
      outcomes: { completed, failed, cancelled },
      successRate: finished ? Math.round((completed / finished) * 1000) / 10 : null,
      failureRate: finished ? Math.round(((failed) / finished) * 1000) / 10 : null,
      trend: h.series.map((d) => ({ day: d.day, executions: d.metrics.agent_execution || 0, workflowRuns: d.metrics.workflow_run || 0, steps: d.metrics.execution_step || 0 })),
    };
  }

  return { summary, plans, history, dashboard };
}

module.exports = { createBillingService };
