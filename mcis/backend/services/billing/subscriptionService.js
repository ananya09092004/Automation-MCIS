/**
 * Layer 7 — provider-neutral subscription state + webhook processing.
 *
 * Subscription status only changes through:
 *   1. a VERIFIED provider webhook (applyWebhook), or
 *   2. an operator running scripts/billing-set-plan.js (provider 'manual',
 *      e.g. a B2B customer paying by invoice) — audited.
 * There is no code path that marks a subscription paid without one of
 * these. Checkout / cancel requests from the app are forwarded to the
 * active provider adapter; with no provider they return 501.
 *
 * Webhook rules:
 *   - signature + timestamp tolerance verified by the adapter (400 otherwise)
 *   - idempotency / replay: (provider, event_id) is unique in
 *     billing_webhook_events; a repeated delivery is acknowledged, never re-applied
 *   - ordering: an event older than the last applied one is ignored
 *   - workspace binding: a subscription id bound to workspace A can never
 *     move to workspace B; a workspace bound to customer X cannot be
 *     re-bound to customer Y by a webhook
 *
 * Layer 8 (Stripe / providers with bindsWorkspaceBy = 'customer'):
 *   - the webhook body is NEVER trusted for the workspace: it is resolved
 *     through billing_customers (customer → workspace) or, for
 *     checkout-completed events, through billing_checkout_sessions (a
 *     session THIS server created; its customer must match)
 *   - the plan comes from the provider price id (server config), never
 *     from event metadata; unknown prices are rejected
 *   - `incomplete` subscriptions (first payment not made) change nothing
 *   - checkout / portal / cancel are owner/admin only, never via API keys,
 *     and only when the active provider is actually configured
 *   - a processing error removes the ledger row so the provider's retry
 *     is processed (instead of being mistaken for a duplicate)
 */
'use strict';

const crypto = require('crypto');
const { WorkspaceError, hasRole } = require('../workspaceService');
const { WebhookError } = require('./providers');
const { STATUSES, LIMIT_KEYS } = require('./plans');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function createSubscriptionService({ store, providers, entitlements, audit = () => {}, logger = console, options = {} } = {}) {
  if (!store || !providers) throw new Error('subscription service: store and providers are required');
  const now = options.now || (() => new Date());

  async function save(ws, cur, patch) {
    for (let i = 0; i < 4; i++) {
      const c = i === 0 ? cur : await store.getSubscription(ws);
      const row = await store.saveSubscription(ws, c ? c.version : 0, patch);
      if (row) return row;
    }
    throw new WebhookError(409, 'SUBSCRIPTION_CONFLICT', 'Concurrent subscription update');
  }

  /** Verified webhook → subscription change. Returns { status, duplicate? }. */
  async function applyWebhook(providerName, rawBody, headers) {
    const provider = providers.map[providerName];
    if (!provider || providerName === 'none') throw new WebhookError(404, 'UNKNOWN_PROVIDER', 'Unknown billing provider');
    if (!provider.configured) throw new WebhookError(503, 'PROVIDER_NOT_CONFIGURED', 'Billing provider is not configured');
    const parsed = provider.verifyWebhook(rawBody, headers, now()); // throws on bad signature
    const e = provider.normalize(parsed);
    const payloadHash = crypto.createHash('sha256').update(rawBody).digest('hex');
    const ledger = { inserted: false };
    try {
      return provider.bindsWorkspaceBy === 'customer'
        ? await applyBoundEvent(providerName, provider, e, payloadHash, ledger)
        : await applyWorkspaceEvent(providerName, e, payloadHash, ledger);
    } catch (err) {
      // Not a verdict on the event: forget the delivery so the provider's retry is processed.
      if (ledger.inserted && !(err instanceof WebhookError) && store.deleteWebhookEvent) {
        await store.deleteWebhookEvent(providerName, e.eventId).catch(() => {});
      }
      throw err;
    }
  }

  /** Layer 7 providers (generic): the signed event names the workspace. */
  async function applyWorkspaceEvent(providerName, e, payloadHash, ledger) {
    const wsId = typeof e.workspaceId === 'string' && UUID_RE.test(e.workspaceId) ? e.workspaceId.toLowerCase() : null;
    const exists = wsId ? await store.workspaceExists(wsId) : false;
    const first = await store.insertWebhookEvent({
      provider: providerName, event_id: e.eventId, event_type: e.type, workspace_id: exists ? wsId : null, status: 'processed', payload_hash: payloadHash,
    });
    ledger.inserted = first;
    if (!first) {
      if (exists) audit(wsId, `webhook:${providerName}`, 'webhook_duplicate', { provider: providerName, eventId: e.eventId });
      return { status: 'duplicate', duplicate: true };
    }
    const finish = async (status, detail) => {
      await store.updateWebhookEvent(providerName, e.eventId, { status, detail });
      if (exists) audit(wsId, `webhook:${providerName}`, status === 'processed' ? 'subscription_changed' : 'webhook_rejected', { provider: providerName, eventId: e.eventId, type: e.type, detail }, { success: status !== 'rejected' });
      return { status, detail };
    };
    if (!exists) return finish('rejected', 'UNKNOWN_WORKSPACE');
    const plan = await store.getPlan(e.planId);
    if (!plan) return finish('rejected', 'UNKNOWN_PLAN');
    return applySubscriptionChange(providerName, wsId, plan, e, finish);
  }

  /** Binding rules + ordering + CAS write, shared by every provider. */
  async function applySubscriptionChange(providerName, wsId, plan, e, finish, { sameSecondApplies = false } = {}) {
    const cur = await store.getSubscription(wsId);
    if (e.externalSubscriptionId) {
      const bound = await store.findSubscriptionByExternal(providerName, e.externalSubscriptionId);
      if (bound && bound.workspace_id !== wsId) return finish('rejected', 'SUBSCRIPTION_BOUND_TO_OTHER_WORKSPACE');
    }
    if (cur && cur.provider === providerName && cur.external_customer_id && e.externalCustomerId && cur.external_customer_id !== e.externalCustomerId) {
      return finish('rejected', 'WORKSPACE_BOUND_TO_OTHER_CUSTOMER');
    }
    if (cur && cur.provider !== providerName && cur.provider !== 'none' && ['active', 'trialing', 'past_due'].includes(cur.status)) {
      return finish('rejected', 'WORKSPACE_MANAGED_BY_OTHER_PROVIDER');
    }
    if (cur && cur.last_provider_event_at) {
      const last = new Date(cur.last_provider_event_at);
      if (sameSecondApplies ? e.createdAt < last : e.createdAt <= last) return finish('ignored', 'STALE_EVENT');
    }
    try {
      await save(wsId, cur, {
        plan_id: plan.id, status: e.status, provider: providerName,
        external_customer_id: e.externalCustomerId, external_subscription_id: e.externalSubscriptionId,
        current_period_start: e.periodStart ? e.periodStart.toISOString() : null,
        current_period_end: e.periodEnd ? e.periodEnd.toISOString() : null,
        trial_ends_at: e.trialEndsAt ? e.trialEndsAt.toISOString() : null,
        cancel_at_period_end: e.cancelAtPeriodEnd,
        cancelled_at: e.status === 'cancelled' ? (cur && cur.cancelled_at) || now().toISOString() : null,
        last_provider_event_at: e.createdAt.toISOString(),
        updated_by: `webhook:${providerName}`,
      });
    } catch (err) {
      if (err.code === '23505') return finish('rejected', 'SUBSCRIPTION_BOUND_TO_OTHER_WORKSPACE');
      throw err;
    }
    return finish('processed', `${e.type} → ${plan.id}/${e.status}`);
  }

  /**
   * Layer 8 — providers that bind by customer (Stripe). The workspace is
   * resolved from OUR records, never from the event body.
   */
  async function applyBoundEvent(providerName, provider, e, payloadHash, ledger) {
    const insert = async (wsId, status, detail = null) => {
      const first = await store.insertWebhookEvent({
        provider: providerName, event_id: e.eventId, event_type: e.type, workspace_id: wsId, status, payload_hash: payloadHash, detail,
      });
      ledger.inserted = first;
      return first;
    };
    const dup = (wsId) => {
      if (wsId) audit(wsId, `webhook:${providerName}`, 'webhook_duplicate', { provider: providerName, eventId: e.eventId });
      return { status: 'duplicate', duplicate: true };
    };
    if (e.kind === 'ignored') return (await insert(null, 'ignored', 'EVENT_TYPE_NOT_HANDLED')) ? { status: 'ignored', detail: 'EVENT_TYPE_NOT_HANDLED' } : dup(null);

    // Resolve the workspace through our own bindings.
    let wsId = null;
    let session = null;
    let reason = null;
    if (e.kind === 'checkout') {
      session = e.sessionId ? await store.getCheckoutSession(providerName, e.sessionId) : null;
      if (!session) reason = 'UNKNOWN_CHECKOUT_SESSION';
      else if (!e.externalCustomerId || session.external_customer_id !== e.externalCustomerId) reason = 'CHECKOUT_CUSTOMER_MISMATCH';
      else wsId = session.workspace_id;
    } else {
      const binding = e.externalCustomerId ? await store.findCustomerBinding(providerName, e.externalCustomerId) : null;
      if (!binding) reason = 'UNKNOWN_CUSTOMER';
      else wsId = binding.workspace_id;
    }
    if (!(await insert(wsId, reason ? 'rejected' : 'processed', reason))) return dup(wsId);
    const finish = async (status, detail, auditType) => {
      await store.updateWebhookEvent(providerName, e.eventId, { status, detail });
      if (wsId) {
        audit(wsId, `webhook:${providerName}`, auditType || (status === 'processed' ? 'subscription_changed' : 'webhook_rejected'),
          { provider: providerName, eventId: e.eventId, type: e.type, detail }, { success: status !== 'rejected' });
      }
      return { status, detail };
    };
    if (reason) {
      logger.warn?.(`[billing] ${providerName} webhook rejected: ${reason}`);
      return finish('rejected', reason);
    }

    if (e.kind === 'checkout') {
      if (session.status !== 'open') return finish('ignored', `CHECKOUT_ALREADY_${session.status.toUpperCase()}`);
      await store.updateCheckoutSession(providerName, e.sessionId, 'open', e.completed
        ? { status: 'completed', completed_at: now().toISOString(), external_subscription_id: e.externalSubscriptionId || null }
        : { status: 'expired' });
      // The plan changes only when the provider reports the subscription itself.
      return finish('processed', e.completed ? `checkout completed (${session.plan_id})` : 'checkout expired', e.completed ? 'checkout_completed' : 'checkout_expired');
    }
    if (e.kind === 'payment_failed') {
      return finish('processed', 'invoice payment failed', 'payment_failed');
    }

    // Subscription event: re-read the authoritative state (order-independent).
    let sub = e;
    if (provider.retrieveSubscription) {
      const latest = await provider.retrieveSubscription(e.externalSubscriptionId); // throws → provider retries
      if (latest.externalCustomerId !== e.externalCustomerId) return finish('rejected', 'SUBSCRIPTION_CUSTOMER_MISMATCH');
      sub = { ...e, ...latest, eventId: e.eventId, type: e.type, createdAt: e.createdAt };
    }
    if (!sub.planId) return finish('rejected', 'UNKNOWN_PRICE');
    const plan = await store.getPlan(sub.planId);
    if (!plan) return finish('rejected', 'UNKNOWN_PLAN');
    if (!sub.status) return finish('ignored', `NOT_ACTIVE_${String(sub.providerStatus || 'unknown').toUpperCase()}`);
    return applySubscriptionChange(providerName, wsId, plan, sub, finish, { sameSecondApplies: true });
  }

  /** Operator-only (CLI): assign a plan without a payment provider. Audited. */
  async function assignPlanManually(workspaceId, { planId, status = 'active', periodStart = null, periodEnd = null, operator, note = null }) {
    if (typeof workspaceId !== 'string' || !UUID_RE.test(workspaceId)) throw new Error('invalid workspace id');
    if (!operator || typeof operator !== 'string') throw new Error('operator is required');
    if (!STATUSES.includes(status)) throw new Error(`status must be one of ${STATUSES.join(', ')}`);
    if (!(await store.workspaceExists(workspaceId))) throw new Error('workspace not found');
    const plan = await store.getPlan(planId);
    if (!plan) throw new Error('unknown plan');
    const cur = await store.getSubscription(workspaceId);
    const row = await save(workspaceId, cur, {
      plan_id: plan.id, status, provider: 'manual', external_customer_id: null, external_subscription_id: null,
      current_period_start: periodStart, current_period_end: periodEnd, trial_ends_at: null, cancel_at_period_end: false,
      cancelled_at: status === 'cancelled' ? now().toISOString() : null, updated_by: `operator:${operator}`,
    });
    audit(workspaceId, `operator:${operator}`, 'plan_assigned', { planId: plan.id, status, from: cur ? { planId: cur.plan_id, status: cur.status } : null, note });
    if (entitlements) entitlements.invalidatePlans();
    return row;
  }

  /**
   * Operator-only (CLI, Layer 8): Enterprise custom limits for one
   * workspace. Same semantics as plan limits (integer ≥ 0 = cap, null =
   * unlimited); only known limit keys are accepted. `limits: null` clears.
   */
  async function setPlanOverride(workspaceId, { limits, operator, note = null }) {
    if (typeof workspaceId !== 'string' || !UUID_RE.test(workspaceId)) throw new Error('invalid workspace id');
    if (!operator || typeof operator !== 'string') throw new Error('operator is required');
    if (!store.setPlanOverride) throw new Error('plan overrides are not supported by this store');
    if (!(await store.workspaceExists(workspaceId))) throw new Error('workspace not found');
    let clean = null;
    if (limits !== null) {
      if (!limits || typeof limits !== 'object' || Array.isArray(limits) || !Object.keys(limits).length) throw new Error('limits must be a non-empty object');
      clean = {};
      for (const [k, v] of Object.entries(limits)) {
        if (!LIMIT_KEYS.includes(k)) throw new Error(`unknown limit "${k}"`);
        if (v !== null && !(Number.isInteger(v) && v >= 0 && v <= 1e9)) throw new Error(`limit "${k}" must be a non-negative integer or null`);
        clean[k] = v;
      }
    }
    const before = await store.getPlanOverride(workspaceId);
    const row = await store.setPlanOverride(workspaceId, clean === null ? null : { limits: clean, note: note ? String(note).slice(0, 300) : null, set_by: `operator:${operator}` });
    audit(workspaceId, `operator:${operator}`, clean === null ? 'custom_limits_cleared' : 'custom_limits_set', { limits: clean, previous: before ? before.limits : null, note });
    if (entitlements) entitlements.invalidatePlans();
    return row;
  }

  const requireBillingAdmin = (ctx) => {
    if (!ctx || !hasRole(ctx.role, 'admin') || ctx.apiKeyId) throw new WorkspaceError(403, 'FORBIDDEN', 'Only a workspace owner or admin can manage the subscription.');
  };

  const PAYING = ['active', 'trialing', 'past_due'];

  /** Customer binding for this workspace (created once, race-safe). */
  async function ensureCustomer(ctx, providerName, p) {
    const ws = ctx.workspace.id;
    const existing = await store.getCustomerBinding(ws, providerName);
    if (existing) return existing.external_customer_id;
    // Stripe idempotency: concurrent requests get the SAME customer back.
    const created = await p.createCustomer({ workspaceId: ws, workspaceName: ctx.workspace.name, idempotencyKey: `nexus-customer-${ws}` });
    const row = await store.insertCustomerBinding({ workspace_id: ws, provider: providerName, external_customer_id: created.id, created_by: ctx.userId });
    if (row) {
      audit(ws, ctx.userId, 'customer_created', { provider: providerName });
      return row.external_customer_id;
    }
    const again = await store.getCustomerBinding(ws, providerName);
    if (!again) throw new WorkspaceError(409, 'CUSTOMER_CONFLICT', 'The billing account could not be linked; try again.');
    return again.external_customer_id;
  }

  const unavailable = (what) => new WorkspaceError(501, 'PAYMENTS_UNAVAILABLE', `Payments are not configured for this deployment. ${what}`);

  async function requestCheckout(ctx, { planId } = {}) {
    requireBillingAdmin(ctx);
    const p = providers.active;
    const plan = typeof planId === 'string' ? await store.getPlan(planId) : null;
    if (!plan || plan.is_public === false) throw new WorkspaceError(400, 'UNKNOWN_PLAN', 'Unknown plan');
    const available = !!(p.configured && p.createCheckout);
    audit(ctx.workspace.id, ctx.userId, 'checkout_requested', { planId: plan.id, provider: providers.activeName, available }, { success: available });
    if (!available) throw unavailable('Contact the Nexus team to change your plan.');
    if (p.priceForPlan && !p.priceForPlan(plan.id)) {
      throw new WorkspaceError(400, 'PLAN_NOT_PURCHASABLE', plan.id === 'enterprise'
        ? 'Enterprise plans are arranged with the Nexus team and activated manually.'
        : 'This plan cannot be bought online.');
    }
    if (!p.createCustomer) return p.createCheckout({ workspaceId: ctx.workspace.id, planId: plan.id, userId: ctx.userId });
    const cur = await store.getSubscription(ctx.workspace.id);
    if (cur && PAYING.includes(cur.status)) {
      if (cur.provider !== providers.activeName && cur.provider !== 'none') {
        throw new WorkspaceError(409, 'MANAGED_BY_OTHER_PROVIDER', 'This workspace\'s plan is managed by the Nexus team. Contact us to change it.');
      }
      if (cur.provider === providers.activeName && cur.external_subscription_id) {
        throw new WorkspaceError(409, 'USE_MANAGE_SUBSCRIPTION', 'This workspace already has a subscription. Use "Manage subscription" to change plans.');
      }
    }
    const customerId = await ensureCustomer(ctx, providers.activeName, p);
    const session = await p.createCheckout({
      customerId, planId: plan.id, workspaceId: ctx.workspace.id, userId: ctx.userId,
      idempotencyKey: `nexus-checkout-${ctx.workspace.id}-${plan.id}-${crypto.randomUUID()}`,
    });
    await store.insertCheckoutSession({
      workspace_id: ctx.workspace.id, provider: providers.activeName, external_session_id: session.id,
      external_customer_id: customerId, plan_id: plan.id, requested_by: ctx.userId,
    });
    audit(ctx.workspace.id, ctx.userId, 'checkout_created', { planId: plan.id, provider: providers.activeName });
    return { url: session.url, provider: providers.activeName };
  }

  /** Provider-hosted subscription management (payment method, invoices, plan changes). */
  async function requestPortal(ctx) {
    requireBillingAdmin(ctx);
    const p = providers.active;
    const available = !!(p.configured && p.createPortal);
    audit(ctx.workspace.id, ctx.userId, 'portal_requested', { provider: providers.activeName, available }, { success: available });
    if (!available) throw unavailable('Contact the Nexus team to manage your subscription.');
    if (!store.getCustomerBinding) return p.createPortal({ workspaceId: ctx.workspace.id, userId: ctx.userId });
    const binding = await store.getCustomerBinding(ctx.workspace.id, providers.activeName);
    if (!binding) throw new WorkspaceError(409, 'NO_BILLING_ACCOUNT', 'This workspace has no billing account yet. Choose a plan first.');
    const out = await p.createPortal({ customerId: binding.external_customer_id });
    return { url: out.url, provider: providers.activeName };
  }

  /**
   * Cancel at the end of the paid period. The provider confirms by webhook;
   * nothing is marked cancelled locally until it does.
   */
  async function requestCancel(ctx) {
    requireBillingAdmin(ctx);
    const p = providers.active;
    if (p.configured && p.cancelSubscription) {
      const cur = await store.getSubscription(ctx.workspace.id);
      if (!cur || cur.provider !== providers.activeName || !cur.external_subscription_id || !PAYING.includes(cur.status)) {
        audit(ctx.workspace.id, ctx.userId, 'cancel_requested', { provider: providers.activeName, available: false, reason: 'NO_ACTIVE_SUBSCRIPTION' }, { success: false });
        throw new WorkspaceError(409, 'NO_ACTIVE_SUBSCRIPTION', 'There is no active online subscription to cancel.');
      }
      await p.cancelSubscription(cur.external_subscription_id, { atPeriodEnd: true, idempotencyKey: `nexus-cancel-${cur.external_subscription_id}` });
      audit(ctx.workspace.id, ctx.userId, 'cancel_requested', { provider: providers.activeName, available: true, planId: cur.plan_id });
      return { status: 'cancel_requested', effective: 'period_end', currentPeriodEnd: cur.current_period_end };
    }
    audit(ctx.workspace.id, ctx.userId, 'cancel_requested', { provider: providers.activeName, available: !!(p.configured && p.createPortal) }, { success: !!(p.configured && p.createPortal) });
    if (!p.configured || !p.createPortal) {
      throw new WorkspaceError(501, 'PAYMENTS_UNAVAILABLE', 'Subscription management is not set up on this server yet. Contact the Nexus team.');
    }
    return p.createPortal({ workspaceId: ctx.workspace.id, userId: ctx.userId });
  }

  return { applyWebhook, assignPlanManually, setPlanOverride, requestCheckout, requestPortal, requestCancel };
}

module.exports = { createSubscriptionService };
