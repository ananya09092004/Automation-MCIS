/**
 * Layer 8 — Stripe adapter for the Layer 7 provider interface.
 *
 * No SDK / no new dependency: Stripe's REST API is called with fetch
 * (injectable, so tests use a deterministic local double — nothing in the
 * test suite talks to Stripe). The adapter is `configured` ONLY when
 *   STRIPE_ENABLED=true, a well-formed STRIPE_SECRET_KEY, a well-formed
 *   STRIPE_WEBHOOK_SECRET, at least one STRIPE_PRICE_<PLAN> and an app URL
 * are all present. Otherwise every payment action reports "unavailable".
 *
 * Interface (superset of Layer 7):
 *   name, configured, missing[] (NAMES of missing/invalid settings, never values)
 *   bindsWorkspaceBy: 'customer'   — webhooks never carry a trusted workspace id;
 *                                    the subscription service resolves the workspace
 *                                    through billing_customers / billing_checkout_sessions
 *   priceForPlan(planId) → price id | null   (from env, never from the client)
 *   createCustomer({ workspaceId, workspaceName, idempotencyKey }) → { id }
 *   createCheckout({ customerId, planId, workspaceId, userId, idempotencyKey }) → { id, url }
 *   createPortal({ customerId }) → { url }
 *   retrieveSubscription(id) → normalized subscription
 *   cancelSubscription(id, { atPeriodEnd }) → normalized subscription
 *   verifyWebhook(rawBody, headers, now) → event   (Stripe-Signature, 5 min tolerance)
 *   normalize(event) → { eventId, type, createdAt, kind, … }
 *
 * Secrets: the secret key is only ever placed in the Authorization header;
 * errors carry Stripe's HTTP status / error type, never the key, the
 * request body or the response body.
 */
'use strict';

const crypto = require('crypto');
const { WebhookError } = require('./providers');

const API_BASE = 'https://api.stripe.com/v1';
const SECRET_KEY_RE = /^(sk|rk)_(test|live)_[A-Za-z0-9]{10,}$/;
const WEBHOOK_SECRET_RE = /^whsec_[A-Za-z0-9+/=]{16,}$/;
const PRICE_RE = /^price_[A-Za-z0-9]{6,}$/;
const ID_RE = /^[A-Za-z0-9_]{3,200}$/;

class ProviderError extends Error {
  constructor(status, code, message) { super(message); this.name = 'ProviderError'; this.status = status; this.code = code; }
}

/** STRIPE_* environment → config (validated; secrets never logged). */
function stripeConfigFromEnv(env = process.env) {
  const enabled = env.STRIPE_ENABLED === 'true';
  const prices = {};
  for (const [k, v] of Object.entries(env)) {
    const m = /^STRIPE_PRICE_([A-Z][A-Z0-9_]{1,31})$/.exec(k);
    if (m && typeof v === 'string' && PRICE_RE.test(v.trim())) prices[m[1].toLowerCase()] = v.trim();
  }
  return {
    enabled,
    secretKey: env.STRIPE_SECRET_KEY || '',
    webhookSecret: env.STRIPE_WEBHOOK_SECRET || '',
    prices,
    appUrl: env.APP_BASE_URL || env.FRONTEND_URL || '',
    apiVersion: env.STRIPE_API_VERSION || '',
  };
}

function validAppUrl(u) {
  try {
    const x = new URL(u);
    return x.protocol === 'https:' || (x.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(x.hostname));
  } catch { return false; }
}

/** Stripe's form encoding (nested objects/arrays → a[b][0][c]=v). */
function formEncode(obj, prefix = '', out = []) {
  for (const [k, v] of Object.entries(obj || {})) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === 'object') formEncode(v, key, out);
    else out.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(v))}`);
  }
  return out.join('&');
}

const STATUS_MAP = {
  trialing: 'trialing', active: 'active', past_due: 'past_due', unpaid: 'past_due', paused: 'past_due',
  canceled: 'cancelled', incomplete_expired: 'expired',
  incomplete: null, // first payment not completed: NOT a paid subscription
};

const toDate = (sec) => (Number.isInteger(sec) && sec > 0 ? new Date(sec * 1000) : null);
const idOf = (v) => (typeof v === 'string' ? v : (v && typeof v === 'object' && typeof v.id === 'string' ? v.id : null));

function signStripePayload(secret, rawBody, timestampSec) {
  const mac = crypto.createHmac('sha256', secret).update(`${timestampSec}.`).update(rawBody).digest('hex');
  return `t=${timestampSec},v1=${mac}`;
}

function createStripeProvider(config = {}, { fetchImpl = (...a) => fetch(...a), timeoutMs = 15000, toleranceSeconds = 300 } = {}) {
  const c = { enabled: false, secretKey: '', webhookSecret: '', prices: {}, appUrl: '', apiVersion: '', ...config };
  const missing = [];
  if (!c.enabled) missing.push('STRIPE_ENABLED');
  if (!SECRET_KEY_RE.test(c.secretKey)) missing.push('STRIPE_SECRET_KEY');
  if (!WEBHOOK_SECRET_RE.test(c.webhookSecret)) missing.push('STRIPE_WEBHOOK_SECRET');
  if (!Object.keys(c.prices).length) missing.push('STRIPE_PRICE_<PLAN>');
  if (!validAppUrl(c.appUrl)) missing.push('APP_BASE_URL');
  const configured = missing.length === 0;
  const planByPrice = new Map(Object.entries(c.prices).map(([plan, price]) => [price, plan]));
  const appUrl = configured ? c.appUrl.replace(/\/+$/, '') : '';

  async function request(method, path, params, { idempotencyKey } = {}) {
    if (!configured) throw new ProviderError(501, 'PAYMENTS_UNAVAILABLE', 'Payments are not configured for this deployment.');
    const qs = method === 'GET' && params ? `?${formEncode(params)}` : '';
    const headers = { Authorization: `Bearer ${c.secretKey}`, 'Content-Type': 'application/x-www-form-urlencoded' };
    if (c.apiVersion) headers['Stripe-Version'] = c.apiVersion;
    if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
    let res;
    try {
      res = await fetchImpl(`${API_BASE}${path}${qs}`, {
        method, headers, body: method === 'GET' ? undefined : formEncode(params || {}),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new ProviderError(502, 'PROVIDER_UNREACHABLE', `The payment provider could not be reached (${err.name || 'network error'}).`);
    }
    let json = null;
    try { json = await res.json(); } catch { /* non-JSON */ }
    if (!res.ok) {
      const type = json && json.error && typeof json.error.type === 'string' ? json.error.type.replace(/[^a-z_]/g, '').slice(0, 40) : 'unknown';
      throw new ProviderError(502, 'PROVIDER_ERROR', `The payment provider rejected the request (HTTP ${res.status}, ${type}).`);
    }
    if (!json || typeof json !== 'object') throw new ProviderError(502, 'PROVIDER_ERROR', 'The payment provider returned an invalid response.');
    return json;
  }

  function normalizeSubscription(obj) {
    const item = obj && obj.items && Array.isArray(obj.items.data) ? obj.items.data[0] : null;
    const priceId = item && item.price ? idOf(item.price) : null;
    // API versions ≥ 2025-03 moved the billing period onto the item.
    const ps = obj.current_period_start ?? (item && item.current_period_start);
    const pe = obj.current_period_end ?? (item && item.current_period_end);
    let periodEnd = toDate(pe);
    const endedAt = toDate(obj.ended_at);
    if (obj.status === 'canceled' && endedAt && (!periodEnd || endedAt < periodEnd)) periodEnd = endedAt; // access ends when it ended
    return {
      externalSubscriptionId: idOf(obj),
      externalCustomerId: idOf(obj.customer),
      priceId,
      planId: priceId ? planByPrice.get(priceId) || null : null,
      providerStatus: typeof obj.status === 'string' ? obj.status : null,
      status: Object.prototype.hasOwnProperty.call(STATUS_MAP, obj.status) ? STATUS_MAP[obj.status] : null,
      periodStart: toDate(ps),
      periodEnd,
      trialEndsAt: toDate(obj.trial_end),
      cancelAtPeriodEnd: obj.cancel_at_period_end === true,
    };
  }

  return {
    name: 'stripe',
    configured,
    missing,
    bindsWorkspaceBy: 'customer',
    purchasablePlans: () => Object.keys(c.prices),
    priceForPlan: (planId) => (configured ? c.prices[planId] || null : null),

    async createCustomer({ workspaceId, workspaceName, idempotencyKey }) {
      const out = await request('POST', '/customers', {
        name: workspaceName ? String(workspaceName).slice(0, 100) : undefined,
        metadata: { nexus_workspace_id: workspaceId },
      }, { idempotencyKey });
      if (!ID_RE.test(String(out.id || ''))) throw new ProviderError(502, 'PROVIDER_ERROR', 'The payment provider returned an invalid customer.');
      return { id: out.id };
    },

    async createCheckout({ customerId, planId, workspaceId, userId, idempotencyKey }) {
      const price = c.prices[planId];
      if (!price) throw new ProviderError(400, 'PLAN_NOT_PURCHASABLE', 'This plan cannot be bought online.');
      const out = await request('POST', '/checkout/sessions', {
        mode: 'subscription',
        customer: customerId,
        client_reference_id: workspaceId,
        line_items: [{ price, quantity: 1 }],
        success_url: `${appUrl}/billing?checkout=success`,
        cancel_url: `${appUrl}/billing?checkout=cancelled`,
        metadata: { nexus_workspace_id: workspaceId, nexus_plan_id: planId, nexus_requested_by: userId },
        subscription_data: { metadata: { nexus_workspace_id: workspaceId, nexus_plan_id: planId } },
      }, { idempotencyKey });
      if (!ID_RE.test(String(out.id || '')) || typeof out.url !== 'string' || !/^https:\/\//.test(out.url)) {
        throw new ProviderError(502, 'PROVIDER_ERROR', 'The payment provider returned an invalid checkout session.');
      }
      return { id: out.id, url: out.url };
    },

    async createPortal({ customerId }) {
      const out = await request('POST', '/billing_portal/sessions', { customer: customerId, return_url: `${appUrl}/billing` });
      if (typeof out.url !== 'string' || !/^https:\/\//.test(out.url)) throw new ProviderError(502, 'PROVIDER_ERROR', 'The payment provider returned an invalid portal session.');
      return { url: out.url };
    },

    async retrieveSubscription(id) {
      if (!ID_RE.test(String(id || ''))) throw new ProviderError(400, 'BAD_REQUEST', 'Invalid subscription id');
      return normalizeSubscription(await request('GET', `/subscriptions/${encodeURIComponent(id)}`));
    },

    async cancelSubscription(id, { atPeriodEnd = true, idempotencyKey } = {}) {
      if (!ID_RE.test(String(id || ''))) throw new ProviderError(400, 'BAD_REQUEST', 'Invalid subscription id');
      const out = atPeriodEnd
        ? await request('POST', `/subscriptions/${encodeURIComponent(id)}`, { cancel_at_period_end: 'true' }, { idempotencyKey })
        : await request('DELETE', `/subscriptions/${encodeURIComponent(id)}`, {}, { idempotencyKey });
      return normalizeSubscription(out);
    },

    verifyWebhook(rawBody, headers = {}, now = new Date()) {
      if (!configured) throw new WebhookError(503, 'PROVIDER_NOT_CONFIGURED', 'Webhook provider is not configured');
      if (!Buffer.isBuffer(rawBody) || !rawBody.length || rawBody.length > 256 * 1024) throw new WebhookError(400, 'BAD_PAYLOAD', 'Invalid payload');
      const header = String(headers['stripe-signature'] || '');
      if (!header || header.length > 2000) throw new WebhookError(400, 'SIGNATURE_INVALID', 'Missing or malformed signature');
      let ts = null;
      const sigs = [];
      for (const part of header.split(',')) {
        const [k, v] = part.split('=');
        if (k === 't' && /^\d{9,12}$/.test(v || '')) ts = Number(v);
        else if (k === 'v1' && /^[0-9a-f]{64}$/.test(v || '')) sigs.push(Buffer.from(v, 'hex'));
      }
      if (ts === null || !sigs.length) throw new WebhookError(400, 'SIGNATURE_INVALID', 'Missing or malformed signature');
      if (Math.abs(Math.floor(now.getTime() / 1000) - ts) > toleranceSeconds) throw new WebhookError(400, 'SIGNATURE_EXPIRED', 'Signature timestamp outside the tolerance window');
      const expect = crypto.createHmac('sha256', c.webhookSecret).update(`${ts}.`).update(rawBody).digest();
      if (!sigs.some((s) => s.length === expect.length && crypto.timingSafeEqual(s, expect))) {
        throw new WebhookError(400, 'SIGNATURE_INVALID', 'Signature does not match');
      }
      try { return JSON.parse(rawBody.toString('utf8')); } catch { throw new WebhookError(400, 'BAD_PAYLOAD', 'Invalid JSON'); }
    },

    normalize(e) {
      const bad = (m) => { throw new WebhookError(400, 'BAD_EVENT', m); };
      if (!e || typeof e !== 'object' || Array.isArray(e)) bad('event must be an object');
      if (typeof e.id !== 'string' || !/^evt_[A-Za-z0-9_]{1,200}$/.test(e.id)) bad('event.id is invalid');
      if (typeof e.type !== 'string' || !/^[a-z][a-z0-9_.]{1,99}$/.test(e.type)) bad('event.type is invalid');
      const createdAt = toDate(e.created);
      if (!createdAt) bad('event.created is invalid');
      const obj = e.data && e.data.object;
      if (!obj || typeof obj !== 'object') bad('event.data.object is required');
      const base = { eventId: e.id, type: e.type, createdAt, livemode: e.livemode === true };
      switch (e.type) {
        case 'checkout.session.completed':
        case 'checkout.session.expired':
          if (obj.mode && obj.mode !== 'subscription') return { ...base, kind: 'ignored' };
          if (!ID_RE.test(String(obj.id || ''))) bad('checkout session id is invalid');
          return {
            ...base, kind: 'checkout', completed: e.type === 'checkout.session.completed',
            sessionId: obj.id, externalCustomerId: idOf(obj.customer), externalSubscriptionId: idOf(obj.subscription),
          };
        case 'customer.subscription.created':
        case 'customer.subscription.updated':
        case 'customer.subscription.deleted': {
          const s = normalizeSubscription(obj);
          if (!s.externalSubscriptionId || !ID_RE.test(s.externalSubscriptionId) || !s.externalCustomerId) bad('subscription is invalid');
          if (e.type === 'customer.subscription.deleted') s.status = s.status === 'expired' ? 'expired' : 'cancelled';
          return { ...base, kind: 'subscription', ...s };
        }
        case 'invoice.payment_failed': {
          const subId = idOf(obj.subscription) || idOf(obj.parent && obj.parent.subscription_details && obj.parent.subscription_details.subscription);
          return { ...base, kind: 'payment_failed', externalCustomerId: idOf(obj.customer), externalSubscriptionId: subId };
        }
        default:
          return { ...base, kind: 'ignored' };
      }
    },
  };
}

module.exports = { createStripeProvider, stripeConfigFromEnv, signStripePayload, formEncode, ProviderError, STATUS_MAP };
