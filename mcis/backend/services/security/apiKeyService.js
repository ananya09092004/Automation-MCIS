/**
 * Layer 6 — workspace API keys (machine access for automation).
 *
 * Key format:  nxk_<prefix: 12 lowercase alnum>_<secret: 43 base64url chars>
 *   - 256-bit random secret; only SHA-256(full key) is stored; the plaintext
 *     is returned ONCE (create / rotate) and never again
 *   - lookup by the non-secret prefix, then a constant-time hash compare
 *   - optional expiry, revocation, rotation (new key + old revoked),
 *     last_used_at, scopes, optional workflow allowlist
 *
 * Management: OWNER creates / revokes / rotates; ADMIN may list metadata.
 *
 * Authentication resolves a key to a Layer 1-shaped context
 *   { workspace: { id }, role: 'member', userId: <creator>, apiKeyId, scopes, workflowIds }
 * i.e. a key NEVER has more than member rights, and every request still goes
 * through workspace isolation, workflow authorization, the Agent Firewall,
 * Layer 3 approvals (a key can never decide one) and the audit log. A key
 * stops working when its creator is no longer an owner of the workspace.
 *
 * Rate limits: per key (DB-backed, all instances) and failed attempts per
 * client IP (per instance, pre-authentication) — see routes/automation.js.
 */
'use strict';

const crypto = require('crypto');
const { WorkspaceError, hasRole } = require('../workspaceService');

// Layer 7 adds 'executions:run' (submit an agent execution through /api/automation/v1/executions).
const SCOPES = Object.freeze(['workflows:run', 'runs:read', 'executions:run',
  // Layer 10: QA / reliability, monitoring and usage
  'qa:run', 'qa:read', 'monitoring:read', 'monitoring:write', 'usage:read']);
const KEY_RE = /^nxk_([a-z0-9]{12})_([A-Za-z0-9_-]{43})$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ALNUM = 'abcdefghijklmnopqrstuvwxyz0123456789';

const sha256 = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');
const unauthorized = () => new WorkspaceError(401, 'INVALID_API_KEY', 'Invalid or expired API key');
const forbidden = (m) => new WorkspaceError(403, 'FORBIDDEN', m);
const badRequest = (m) => new WorkspaceError(400, 'BAD_REQUEST', m);

function randomPrefix() {
  const b = crypto.randomBytes(12);
  return Array.from(b, (x) => ALNUM[x % 36]).join('');
}

function createApiKeyService({ store, getMemberRole, events = null, rateLimiter = null, logger = console, options = {} } = {}) {
  if (!store || !getMemberRole) throw new Error('api key service: store and getMemberRole are required');
  const now = options.now || (() => new Date());
  const perKey = options.perKeyLimit || { limit: 60, windowSeconds: 60 };
  const maxKeys = options.maxKeysPerWorkspace || 50;

  const view = (k) => ({
    id: k.id,
    name: k.name,
    prefix: k.prefix,
    scopes: k.scopes,
    workflowIds: k.workflow_ids || null,
    createdBy: k.created_by,
    createdAt: k.created_at,
    expiresAt: k.expires_at || null,
    lastUsedAt: k.last_used_at || null,
    revokedAt: k.revoked_at || null,
    rotatedFrom: k.rotated_from || null,
    status: k.revoked_at ? 'revoked' : (k.expires_at && Date.parse(k.expires_at) <= now().getTime() ? 'expired' : 'active'),
  });

  const requireOwner = (ctx) => {
    if (!ctx || !ctx.workspace || !hasRole(ctx.role, 'owner') || ctx.apiKeyId) throw forbidden('Only the workspace owner can manage API keys.');
  };

  function validate(body) {
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name || name.length > 80) throw badRequest('name must be 1-80 characters');
    const scopes = body.scopes === undefined ? ['workflows:run'] : body.scopes;
    if (!Array.isArray(scopes) || !scopes.length || scopes.some((s) => !SCOPES.includes(s))) throw badRequest(`scopes must be a non-empty subset of ${SCOPES.join(', ')}`);
    let workflowIds = null;
    if (body.workflowIds !== undefined && body.workflowIds !== null) {
      if (!Array.isArray(body.workflowIds) || !body.workflowIds.length || body.workflowIds.length > 50 || body.workflowIds.some((w) => typeof w !== 'string' || !UUID_RE.test(w))) {
        throw badRequest('workflowIds must be 1-50 workflow ids');
      }
      workflowIds = [...new Set(body.workflowIds.map((w) => w.toLowerCase()))];
    }
    let expiresAt = null;
    if (body.expiresInDays !== undefined && body.expiresInDays !== null) {
      if (!Number.isInteger(body.expiresInDays) || body.expiresInDays < 1 || body.expiresInDays > 365) throw badRequest('expiresInDays must be 1-365');
      expiresAt = new Date(now().getTime() + body.expiresInDays * 86400000).toISOString();
    }
    return { name, scopes: [...new Set(scopes)], workflowIds, expiresAt };
  }

  async function mint(ctx, { name, scopes, workflowIds, expiresAt, rotatedFrom = null }) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const prefix = `nxk_${randomPrefix()}`;
      const key = `${prefix}_${crypto.randomBytes(32).toString('base64url')}`;
      try {
        const row = await store.insertApiKey({
          id: crypto.randomUUID(), workspace_id: ctx.workspace.id, name, prefix, key_hash: sha256(key), scopes,
          workflow_ids: workflowIds, created_by: ctx.userId, expires_at: expiresAt, rotated_from: rotatedFrom,
        });
        return { key, row };
      } catch (err) {
        if (err.code !== '23505') throw err; // prefix collision → retry
      }
    }
    throw new Error('could not generate a unique API key');
  }

  async function createKey(ctx, body = {}) {
    requireOwner(ctx);
    const v = validate(body);
    const active = (await store.listApiKeys(ctx.workspace.id)).filter((k) => !k.revoked_at);
    if (active.length >= maxKeys) throw new WorkspaceError(409, 'TOO_MANY_KEYS', `A workspace can have at most ${maxKeys} active API keys.`);
    const { key, row } = await mint(ctx, v);
    events && events.record(ctx.workspace.id, ctx.userId, 'api_key_created', { apiKeyId: row.id, prefix: row.prefix, scopes: row.scopes });
    return { key, apiKey: view(row), notice: 'Store this key now — it cannot be shown again.' };
  }

  async function listKeys(ctx) {
    if (!ctx || !hasRole(ctx.role, 'admin') || ctx.apiKeyId) throw forbidden('Only a workspace admin or owner can view API keys.');
    return (await store.listApiKeys(ctx.workspace.id)).map(view);
  }

  async function loadKey(ctx, id) {
    if (typeof id !== 'string' || !UUID_RE.test(id)) throw new WorkspaceError(404, 'API_KEY_NOT_FOUND', 'API key not found');
    const k = await store.getApiKey(ctx.workspace.id, id);
    if (!k) throw new WorkspaceError(404, 'API_KEY_NOT_FOUND', 'API key not found');
    return k;
  }

  async function revokeKey(ctx, id) {
    requireOwner(ctx);
    await loadKey(ctx, id);
    const r = await store.revokeApiKey(ctx.workspace.id, id, ctx.userId);
    if (!r) throw new WorkspaceError(409, 'API_KEY_REVOKED', 'API key is already revoked');
    events && events.record(ctx.workspace.id, ctx.userId, 'api_key_revoked', { apiKeyId: id, prefix: r.prefix });
    return view(r);
  }

  async function rotateKey(ctx, id) {
    requireOwner(ctx);
    const old = await loadKey(ctx, id);
    // Revoke FIRST (single transition): two concurrent rotations cannot both succeed.
    const revoked = await store.revokeApiKey(ctx.workspace.id, id, ctx.userId);
    if (!revoked) throw new WorkspaceError(409, 'API_KEY_REVOKED', 'API key is already revoked');
    const remaining = old.expires_at ? Math.max(Date.parse(old.expires_at) - Date.parse(old.created_at), 86400000) : null;
    const { key, row } = await mint(ctx, {
      name: old.name, scopes: old.scopes, workflowIds: old.workflow_ids || null,
      expiresAt: remaining ? new Date(now().getTime() + remaining).toISOString() : null, rotatedFrom: old.id,
    });
    events && events.record(ctx.workspace.id, ctx.userId, 'api_key_rotated', { apiKeyId: row.id, rotatedFrom: old.id, prefix: row.prefix });
    return { key, apiKey: view(row), notice: 'Store this key now — it cannot be shown again. The previous key no longer works.' };
  }

  /** raw key → API-key context, or throws 401 / 429. Never reveals why. */
  async function authenticate(raw) {
    const m = typeof raw === 'string' ? KEY_RE.exec(raw.trim()) : null;
    if (!m) throw unauthorized();
    const k = await store.getApiKeyByPrefix(`nxk_${m[1]}`);
    const got = Buffer.from(sha256(raw.trim()), 'hex');
    const expect = Buffer.from(k ? k.key_hash : '0'.repeat(64), 'hex');
    const match = crypto.timingSafeEqual(got, expect) && !!k;
    const failed = (reason) => {
      if (k) events && events.record(k.workspace_id, k.created_by, 'api_key_auth_failed', { apiKeyId: k.id, prefix: k.prefix, reason }, { success: false });
      return unauthorized();
    };
    if (!match) throw failed('hash_mismatch');
    if (k.revoked_at) throw failed('revoked');
    if (k.expires_at && Date.parse(k.expires_at) <= now().getTime()) throw failed('expired');
    const role = await getMemberRole(k.workspace_id, k.created_by);
    if (!role || !hasRole(role, 'owner')) throw failed('creator_no_longer_owner');
    if (rateLimiter && !(await rateLimiter.hit(['apikey', k.id], perKey.windowSeconds, perKey.limit))) {
      events && events.record(k.workspace_id, k.created_by, 'rate_limited', { apiKeyId: k.id, bucket: 'api_key' }, { success: false });
      throw new WorkspaceError(429, 'RATE_LIMITED', 'Too many requests for this API key');
    }
    store.touchApiKey(k.workspace_id, k.id).catch(() => {});
    return {
      workspace: { id: k.workspace_id },
      role: 'member', // capped: a key never acts with more than member rights
      userId: k.created_by,
      apiKeyId: k.id,
      scopes: [...k.scopes],
      workflowIds: k.workflow_ids ? [...k.workflow_ids] : null,
    };
  }

  function requireScope(ctx, scope, workflowId = null) {
    if (!ctx || !ctx.apiKeyId || !ctx.scopes.includes(scope)) throw forbidden(`This API key lacks the "${scope}" scope.`);
    if (workflowId && ctx.workflowIds && !ctx.workflowIds.includes(String(workflowId).toLowerCase())) throw forbidden('This API key is not allowed to run this workflow.');
  }

  return { createKey, listKeys, revokeKey, rotateKey, authenticate, requireScope, SCOPES };
}

module.exports = { createApiKeyService, SCOPES, KEY_RE, sha256 };
