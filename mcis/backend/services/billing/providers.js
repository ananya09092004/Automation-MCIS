/**
 * Layer 7 — billing provider adapters (provider-neutral interface).
 *
 * An adapter is:
 *   { name, configured,
 *     verifyWebhook(rawBody: Buffer, headers, now) → parsed event   (throws WebhookError)
 *     normalize(event) → { eventId, type, createdAt: Date, workspaceId, planId, status,
 *                          externalCustomerId, externalSubscriptionId, periodStart, periodEnd,
 *                          cancelAtPeriodEnd, trialEndsAt }
 *     createCheckout?(…) / createPortal?(…) → { url }   (optional: only real providers) }
 *
 * Shipped:
 *   none     — nothing configured; every payment action is reported as unavailable.
 *   generic  — provider-neutral subscription events POSTed by an external billing
 *              system (or an internal invoicing tool), authenticated with an
 *              HMAC-SHA256 signature over "<timestamp>.<raw body>" (header
 *              `Nexus-Signature: t=<unix seconds>,v1=<hex>`), 5-minute tolerance.
 *              It never initiates payments (no checkout).
 *   stripe   — Layer 8 (services/billing/stripeProvider.js): real Stripe Checkout,
 *              Customer Portal and signed webhooks; configured only when every
 *              STRIPE_* setting is present (STRIPE_ENABLED=true). No keys in the repo.
 */
'use strict';

const crypto = require('crypto');
const { STATUSES } = require('./plans');

class WebhookError extends Error {
  constructor(status, code, message) { super(message); this.name = 'WebhookError'; this.status = status; this.code = code; }
}

function createNoProvider() {
  return { name: 'none', configured: false };
}

function signGenericPayload(secret, rawBody, timestampSec) {
  const mac = crypto.createHmac('sha256', secret).update(`${timestampSec}.`).update(rawBody).digest('hex');
  return `t=${timestampSec},v1=${mac}`;
}

const ISO = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const d = typeof v === 'number' ? new Date(v * 1000) : new Date(String(v));
  return Number.isNaN(d.getTime()) ? undefined : d;
};

function createGenericProvider({ secret, toleranceSeconds = 300 } = {}) {
  const configured = typeof secret === 'string' && secret.length >= 32;
  return {
    name: 'generic',
    configured,
    verifyWebhook(rawBody, headers = {}, now = new Date()) {
      if (!configured) throw new WebhookError(503, 'PROVIDER_NOT_CONFIGURED', 'Webhook provider is not configured');
      if (!Buffer.isBuffer(rawBody) || !rawBody.length || rawBody.length > 256 * 1024) throw new WebhookError(400, 'BAD_PAYLOAD', 'Invalid payload');
      const header = String(headers['nexus-signature'] || '');
      const m = /^t=(\d{9,12}),v1=([0-9a-f]{64})$/.exec(header);
      if (!m) throw new WebhookError(400, 'SIGNATURE_INVALID', 'Missing or malformed signature');
      const ts = Number(m[1]);
      if (Math.abs(Math.floor(now.getTime() / 1000) - ts) > toleranceSeconds) throw new WebhookError(400, 'SIGNATURE_EXPIRED', 'Signature timestamp outside the tolerance window');
      const expect = Buffer.from(signGenericPayload(secret, rawBody, ts).split('v1=')[1], 'hex');
      const got = Buffer.from(m[2], 'hex');
      if (got.length !== expect.length || !crypto.timingSafeEqual(got, expect)) throw new WebhookError(400, 'SIGNATURE_INVALID', 'Signature mismatch');
      try { return JSON.parse(rawBody.toString('utf8')); } catch { throw new WebhookError(400, 'BAD_PAYLOAD', 'Invalid JSON'); }
    },
    normalize(e) {
      const bad = (m) => { throw new WebhookError(400, 'BAD_EVENT', m); };
      if (!e || typeof e !== 'object' || Array.isArray(e)) bad('event must be an object');
      if (typeof e.id !== 'string' || !/^[A-Za-z0-9_.:-]{1,200}$/.test(e.id)) bad('event.id is invalid');
      if (typeof e.type !== 'string' || !/^[a-z][a-z0-9_.]{1,99}$/.test(e.type)) bad('event.type is invalid');
      const d = e.data;
      if (!d || typeof d !== 'object') bad('event.data is required');
      const createdAt = ISO(e.created);
      if (!createdAt) bad('event.created is required');
      const out = {
        eventId: e.id, type: e.type, createdAt,
        workspaceId: d.workspace_id, planId: d.plan_id, status: d.status,
        externalCustomerId: d.customer_id ?? null, externalSubscriptionId: d.subscription_id ?? null,
        periodStart: ISO(d.current_period_start), periodEnd: ISO(d.current_period_end), trialEndsAt: ISO(d.trial_ends_at),
        cancelAtPeriodEnd: d.cancel_at_period_end === true,
      };
      if (!STATUSES.includes(out.status)) bad('data.status is invalid');
      if (typeof out.planId !== 'string' || !/^[a-z][a-z0-9_]{1,31}$/.test(out.planId)) bad('data.plan_id is invalid');
      for (const k of ['periodStart', 'periodEnd', 'trialEndsAt']) if (out[k] === undefined) bad(`data.${k} is not a valid time`);
      for (const k of ['externalCustomerId', 'externalSubscriptionId']) {
        if (out[k] !== null && (typeof out[k] !== 'string' || !/^[A-Za-z0-9_.:-]{1,200}$/.test(out[k]))) bad(`data.${k} is invalid`);
      }
      if (out.periodStart && out.periodEnd && out.periodEnd <= out.periodStart) bad('period end must be after start');
      return out;
    },
  };
}

/**
 * Active provider: STRIPE_ENABLED=true selects Stripe (Layer 8); otherwise
 * BILLING_PROVIDER (none | generic). Every adapter is in the map so its
 * webhook endpoint answers "not configured" (503) instead of 404.
 */
function createProviders(env = process.env, { stripeOptions } = {}) {
  const { createStripeProvider, stripeConfigFromEnv } = require('./stripeProvider'); // lazy: avoids a require cycle
  const map = {
    none: createNoProvider(),
    generic: createGenericProvider({ secret: env.BILLING_WEBHOOK_SECRET }),
    stripe: createStripeProvider(stripeConfigFromEnv(env), stripeOptions),
  };
  const active = env.STRIPE_ENABLED === 'true' ? 'stripe' : (env.BILLING_PROVIDER || 'none').toLowerCase();
  return { map, active: map[active] || map.none, activeName: map[active] ? active : 'none' };
}

module.exports = { createNoProvider, createGenericProvider, createProviders, signGenericPayload, WebhookError };
