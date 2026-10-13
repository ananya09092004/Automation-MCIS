/**
 * Layer 10 — signed outbound webhooks (developer / execution API).
 *
 * An admin registers an https endpoint and the events it wants. Nexus
 * generates the signing secret, shows it ONCE, and stores it encrypted
 * with the integration key ring (AES-256-GCM, AAD bound to the webhook).
 *
 * Delivery: durable outbox (webhook_deliveries, unique per event id →
 * an event is queued once per webhook), lease-based workers, SSRF-safe
 * client (public addresses only, no redirects, 10 s, small response),
 * exponential backoff, dead after 8 attempts. Signature header:
 *   Nexus-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>
 * Receivers verify it and reject timestamps older than 5 minutes.
 *
 * Payloads carry ids, statuses and summaries — never credentials, goals'
 * secrets (already redacted) or page content.
 */
'use strict';

const crypto = require('crypto');
const C = require('./common');
const { isInternalHostname } = require('../integrations/safeHttp');
const { sanitize } = require('../security/sensitiveClassifier');

const EVENTS = ['execution.completed', 'execution.failed', 'workflow_run.completed', 'workflow_run.failed', 'alert.created', 'monitor.changed',
  'recommendation.created', 'qa_run.completed', 'ping'];
const MAX_ATTEMPTS = 8;
const DISABLE_AFTER_FAILURES = 50;

function sign(secret, body, t) {
  return `t=${t},v1=${crypto.createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}`;
}

/** Receiver-side verification helper (also used by the SDK and tests). */
function verifySignature(secret, body, header, { toleranceSeconds = 300, now = Date.now() } = {}) {
  const m = /^t=(\d{9,12}),v1=([0-9a-f]{64})$/.exec(String(header || ''));
  if (!m) return false;
  if (Math.abs(now / 1000 - Number(m[1])) > toleranceSeconds) return false;
  const expect = crypto.createHmac('sha256', secret).update(`${m[1]}.${body}`).digest();
  const got = Buffer.from(m[2], 'hex');
  return got.length === expect.length && crypto.timingSafeEqual(got, expect);
}

function createWebhookService({ store, credentials, http, appendAuditLog = null, logger = console, options = {} } = {}) {
  if (!store) throw new Error('webhook service: store is required');
  const now = options.now || (() => new Date());
  const iso = () => now().toISOString();
  const workerId = options.workerId || `whk_${crypto.randomBytes(6).toString('hex')}`;
  const allowInsecureHttpForTests = !!options.allowInsecureHttpForTests;
  const aad = (ws, id) => Buffer.from(`nexus-webhook:${ws}:${id}`, 'utf8');
  const audit = (actor, action, payload, ws) => {
    if (!appendAuditLog) return;
    try { Promise.resolve(appendAuditLog(actor, action, payload, { success: true, error: null }, ws)).catch(() => {}); } catch { /* never */ }
  };

  const view = (w) => ({
    id: w.id, url: w.url, events: w.events, status: w.status, failureCount: w.failure_count, lastDeliveryAt: w.last_delivery_at,
    secretKeyId: w.secret_key_id, createdBy: w.created_by, version: w.version, createdAt: w.created_at,
  });
  const deliveryView = (d) => ({
    id: d.id, eventType: d.event_type, eventId: d.event_id, status: d.status, attempts: d.attempts, nextAttemptAt: d.status === 'pending' || d.status === 'failed' ? d.next_attempt_at : null,
    lastStatusCode: d.last_status_code, lastError: d.last_error, deliveredAt: d.delivered_at, createdAt: d.created_at,
  });

  function checkUrl(raw) {
    let u;
    try { u = new URL(String(raw || '')); } catch { throw C.bad('url must be a valid https URL'); }
    const schemeOk = u.protocol === 'https:' || (allowInsecureHttpForTests && u.protocol === 'http:');
    if (!schemeOk || u.username || u.password || u.hash || String(raw).length > 2000) throw C.bad('url must be a plain https URL (no credentials or fragment)');
    // Always (test mode included): no internal names, no IP literals. The
    // delivery client re-checks the resolved address on every request.
    if (isInternalHostname(u.hostname) || /^\d+\.\d+\.\d+\.\d+$/.test(u.hostname) || u.hostname.includes(':') || u.hostname.startsWith('[')) {
      throw C.bad('url must use a public DNS hostname');
    }
    return u.toString();
  }
  function checkEvents(list) {
    if (!Array.isArray(list) || !list.length || list.length > 20) throw C.bad('events must list 1-20 event types');
    const out = [...new Set(list)];
    for (const e of out) if (!EVENTS.includes(e) || e === 'ping') throw C.bad(`Unknown event "${String(e).slice(0, 60)}"`);
    return out;
  }
  function requireCrypto() {
    if (!credentials || !credentials.isConfigured()) throw new C.WorkspaceError(503, 'CREDENTIALS_UNAVAILABLE', 'Secret encryption is not configured on this server (INTEGRATION_ENCRYPTION_KEY).');
  }
  function sealed(ws, id, secret) {
    const e = credentials.encrypt({ secret }, aad(ws, id));
    return { secret_key_id: e.key_id, secret_iv: e.iv, secret_tag: e.auth_tag, secret_ciphertext: e.ciphertext };
  }
  function unseal(w) {
    return credentials.decrypt({ key_id: w.secret_key_id, algorithm: 'aes-256-gcm', iv: w.secret_iv, auth_tag: w.secret_tag, ciphertext: w.secret_ciphertext }, aad(w.workspace_id, w.id)).secret;
  }
  const newSecret = () => `whsec_${crypto.randomBytes(32).toString('base64url')}`;

  async function create(ctx, body = {}) {
    const ws = C.requireCtx(ctx);
    C.requireAdmin(ctx, 'webhooks');
    C.onlyKeys(body, ['url', 'events']);
    requireCrypto();
    if ((await store.count('workspace_webhooks', ws)) >= 10) throw C.conflict('A workspace can have at most 10 webhooks', 'WEBHOOK_LIMIT');
    const id = crypto.randomUUID();
    const secret = newSecret();
    const row = await store.insert('workspace_webhooks', { id, workspace_id: ws, url: checkUrl(body.url), events: checkEvents(body.events), ...sealed(ws, id, secret), created_by: ctx.userId });
    audit(ctx.userId, 'webhook_created', { workspaceId: ws, webhookId: id, events: row.events }, ws);
    return { ...view(row), secret, secretNotice: 'Store this signing secret now; it will not be shown again.' };
  }

  async function load(ctx, id) {
    const ws = C.requireCtx(ctx);
    const w = await store.get('workspace_webhooks', ws, C.uuidOr404(id, 'Webhook'));
    if (!w) throw C.notFound('Webhook');
    return w;
  }

  async function list(ctx) {
    const ws = C.requireCtx(ctx);
    C.requireAdmin(ctx, 'webhooks');
    return (await store.list('workspace_webhooks', ws, { limit: 20 })).map(view);
  }

  async function update(ctx, id, body = {}) {
    const w = await load(ctx, id);
    C.requireAdmin(ctx, 'webhooks');
    C.onlyKeys(body, ['version', 'url', 'events', 'status']);
    if (body.version !== w.version) throw C.conflict('version is required and must match the current version', 'WEBHOOK_CONFLICT');
    const patch = {};
    if (body.url !== undefined) patch.url = checkUrl(body.url);
    if (body.events !== undefined) patch.events = checkEvents(body.events);
    if (body.status !== undefined) { patch.status = C.oneOf(body.status, 'status', ['active', 'disabled']); if (patch.status === 'active') patch.failure_count = 0; }
    if (!Object.keys(patch).length) throw C.bad('Nothing to update');
    const u = await store.update('workspace_webhooks', w.workspace_id, w.id, patch, { expectVersion: w.version });
    if (!u) throw C.conflict('The webhook was changed concurrently; reload and retry.', 'WEBHOOK_CONFLICT');
    audit(ctx.userId, 'webhook_updated', { workspaceId: w.workspace_id, webhookId: w.id, fields: Object.keys(patch) }, w.workspace_id);
    return view(u);
  }

  async function rotateSecret(ctx, id) {
    const w = await load(ctx, id);
    C.requireAdmin(ctx, 'webhooks');
    requireCrypto();
    const secret = newSecret();
    const u = await store.update('workspace_webhooks', w.workspace_id, w.id, sealed(w.workspace_id, w.id, secret), { expectVersion: w.version });
    if (!u) throw C.conflict('The webhook was changed concurrently; reload and retry.', 'WEBHOOK_CONFLICT');
    audit(ctx.userId, 'webhook_secret_rotated', { workspaceId: w.workspace_id, webhookId: w.id }, w.workspace_id);
    return { ...view(u), secret, secretNotice: 'Store this signing secret now; it will not be shown again.' };
  }

  async function remove(ctx, id) {
    const w = await load(ctx, id);
    C.requireAdmin(ctx, 'webhooks');
    await store.remove('workspace_webhooks', w.workspace_id, w.id);
    audit(ctx.userId, 'webhook_deleted', { workspaceId: w.workspace_id, webhookId: w.id }, w.workspace_id);
    return { deleted: true };
  }

  async function deliveries(ctx, id, { limit } = {}) {
    const w = await load(ctx, id);
    C.requireAdmin(ctx, 'webhooks');
    return (await store.list('webhook_deliveries', w.workspace_id, { filter: { webhook_id: w.id }, limit: Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200) })).map(deliveryView);
  }

  /** Queue a ping to one webhook (delivered by the worker like any event). */
  async function test(ctx, id) {
    const w = await load(ctx, id);
    C.requireAdmin(ctx, 'webhooks');
    const eventId = `ping:${crypto.randomUUID()}`;
    const d = await store.insert('webhook_deliveries', {
      workspace_id: w.workspace_id, webhook_id: w.id, event_type: 'ping', event_id: eventId,
      payload: { id: eventId, type: 'ping', createdAt: iso(), workspaceId: w.workspace_id, data: { message: 'Nexus webhook test' } }, next_attempt_at: iso(),
    });
    return deliveryView(d);
  }

  /** Fan an event out to the workspace's subscribed webhooks (idempotent per event id). */
  async function emit(ws, type, eventId, data) {
    if (!EVENTS.includes(type)) return 0;
    const hooks = await store.list('workspace_webhooks', ws, { filter: { status: 'active', events: { contains: [type] } }, limit: 20 });
    let n = 0;
    for (const w of hooks) {
      const payload = { id: `${type}:${eventId}`, type, createdAt: iso(), workspaceId: ws, data: sanitize(data, { maxString: 1000 }) };
      const d = await store.tryInsert('webhook_deliveries', { workspace_id: ws, webhook_id: w.id, event_type: type, event_id: payload.id, payload, next_attempt_at: iso() });
      if (d) n += 1;
    }
    return n;
  }

  async function deliverOne(d) {
    const ws = d.workspace_id;
    const w = await store.get('workspace_webhooks', ws, d.webhook_id);
    if (!w) return null;
    const settle = (patch) => store.updateWhere('webhook_deliveries', ws, { id: d.id, lease_owner: workerId }, { ...patch, lease_owner: null, lease_expires_at: null });
    if (w.status !== 'active') return settle({ status: 'dead', last_error: 'WEBHOOK_DISABLED' });
    let secret;
    try { secret = unseal(w); } catch (err) { return settle({ status: 'failed', attempts: d.attempts + 1, last_error: 'SECRET_UNAVAILABLE', next_attempt_at: new Date(now().getTime() + 600000).toISOString() }); }
    const body = JSON.stringify(d.payload);
    const t = Math.floor(now().getTime() / 1000);
    let status = null;
    let error = null;
    try {
      const u = new URL(w.url);
      const res = await http.request({
        url: w.url, method: 'POST', allowedMethods: ['POST'], allowedHosts: [u.hostname.toLowerCase()],
        headers: { 'Content-Type': 'application/json', 'User-Agent': 'Nexus-Webhooks/1.0', 'Nexus-Event': d.event_type, 'Nexus-Delivery': d.id, 'Nexus-Signature': sign(secret, body, t) },
        body, timeoutMs: 10000, maxBytes: 16 * 1024, maxRedirects: 0,
      });
      status = res.status;
      if (res.status < 200 || res.status >= 300) error = `HTTP_${res.status}`;
    } catch (err) {
      error = String(err.code || 'NETWORK_ERROR').slice(0, 60);
    } finally { secret = null; }
    const attempts = d.attempts + 1;
    if (!error) {
      await settle({ status: 'delivered', attempts, last_status_code: status, last_error: null, delivered_at: iso() });
      await store.update('workspace_webhooks', ws, w.id, { failure_count: 0, last_delivery_at: iso() }, { touch: false });
      return 'delivered';
    }
    const dead = attempts >= MAX_ATTEMPTS;
    const backoffS = Math.min(6 * 3600, 30 * 2 ** (attempts - 1));
    await settle({ status: dead ? 'dead' : 'failed', attempts, last_status_code: status, last_error: error, next_attempt_at: new Date(now().getTime() + backoffS * 1000).toISOString() });
    const fc = (w.failure_count || 0) + 1;
    await store.update('workspace_webhooks', ws, w.id, { failure_count: fc, ...(fc >= DISABLE_AFTER_FAILURES ? { status: 'disabled' } : {}) }, { touch: false });
    if (fc >= DISABLE_AFTER_FAILURES) logger.warn?.('[webhooks] endpoint disabled after repeated failures');
    return dead ? 'dead' : 'failed';
  }

  async function tick({ limit = 20 } = {}) {
    const rows = await store.rpc('claim_webhook_deliveries', { p_worker: workerId, p_lease_seconds: 60, p_limit: limit });
    const out = { delivered: 0, failed: 0, dead: 0 };
    for (const d of rows || []) {
      try {
        const r = await deliverOne(d);
        if (r && out[r] !== undefined) out[r] += 1;
      } catch (err) { logger.error?.(`[webhooks] delivery error (${err.code || err.name})`); }
    }
    return out;
  }

  return { create, list, update, rotateSecret, remove, deliveries, test, emit, tick, EVENTS, workerId };
}

module.exports = { createWebhookService, verifySignature, sign, EVENTS };
