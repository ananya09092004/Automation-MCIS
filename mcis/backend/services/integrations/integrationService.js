/**
 * Layer 5 — integrations: management API + the execution gateway.
 *
 *   Workspace → Integration → Encrypted credential → Connector → Permission/risk
 *            → Layer 3 execution (approvals, evidence) → Layer 4 workflow run
 *
 * Management (ctx = Layer 1 workspace context resolved from the verified uid):
 *   list providers / integrations / one integration ........ member+
 *   connect, update config, rotate credential, disconnect,
 *   health check, change action permissions ................. admin+
 * Responses NEVER contain credentials: only `hasCredential` and the
 * credential's key id / timestamp.
 *
 * Gateway (called by Layer 3 for connector steps; never routed):
 *   prepareAction(ws, userId, spec)  → tier, retry safety, safe labels (no secrets)
 *   executeAction(ws, userId, spec, ctx) → Layer 3 executor result
 * Every call re-checks: integration ∈ workspace, status connected, action
 * enabled, caller's CURRENT role ≥ the action's minimum role, input valid.
 * The credential is decrypted only inside executeAction and scrubbed from
 * everything the connector returns.
 */
'use strict';

const crypto = require('crypto');
const { WorkspaceError, hasRole } = require('../workspaceService');
// Layer 6: sensitive-data classifier (superset of sensitiveDataFilter).
const { sanitize, sanitizeString } = require('../security/sensitiveClassifier');

const redact = (v, o) => sanitize(v, o);
const redactString = (v, max) => sanitizeString(v, max);
const { InputError, ConnectorError } = require('./connectors/schema');
const { SafeHttpError } = require('./safeHttp');
const { CredentialError } = require('./credentialService');

const REFRESH_MARGIN_MS = 60 * 1000; // Layer 9: refresh OAuth tokens a minute before they expire

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TIER_RANK = { green: 0, yellow: 1, red: 2 };
const APPROVAL_TIER = { default: 'green', required: 'yellow', admin: 'red' };
const ROLES = ['member', 'admin', 'owner'];

const notFound = () => new WorkspaceError(404, 'INTEGRATION_NOT_FOUND', 'Integration not found');
const forbidden = (m) => new WorkspaceError(403, 'FORBIDDEN', m);
const badRequest = (m) => new WorkspaceError(400, 'BAD_REQUEST', m);

/** Gateway failures: code + safe message, consumed by Layer 3. */
class GatewayError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'GatewayError';
    this.code = code;
  }
}

const maxTier = (a, b) => (TIER_RANK[a] >= TIER_RANK[b] ? a : b);

/** Replace every occurrence of every secret string anywhere in `value`. */
function scrubSecrets(value, secrets) {
  const list = (secrets || []).filter((s) => typeof s === 'string' && s.length >= 4);
  if (!list.length) return value;
  const scrubStr = (s) => list.reduce((acc, sec) => acc.split(sec).join('[REDACTED]'), s);
  const walk = (v, depth) => {
    if (depth > 8) return v;
    if (typeof v === 'string') return scrubStr(v);
    if (Array.isArray(v)) return v.map((x) => walk(x, depth + 1));
    if (v && typeof v === 'object') {
      const o = {};
      for (const [k, x] of Object.entries(v)) o[scrubStr(k)] = walk(x, depth + 1);
      return o;
    }
    return v;
  };
  return walk(value, 0);
}

function secretStrings(credential) {
  if (!credential || typeof credential !== 'object') return [];
  return Object.values(credential).filter((v) => typeof v === 'string');
}

function requireCtx(ctx) {
  if (!ctx || !ctx.workspace || !ctx.workspace.id || !ctx.userId) throw new WorkspaceError(401, 'AUTH_REQUIRED', 'Authentication required');
  return ctx.workspace.id;
}

function createIntegrationService({
  store, registry, credentials, http, getMemberRole, appendAuditLog, logger = console, options = {}, firewall = null,
} = {}) {
  if (!store || !registry || !credentials || !http) throw new Error('integration service: store, registry, credentials and http are required');
  const now = options.now || (() => new Date());
  const isAdmin = (ctx) => hasRole(ctx.role, 'admin');
  // Layer 6: when an Agent Firewall is attached, executeAction only runs
  // with a single-use firewall ticket bound to this exact action + input.
  let fw = firewall;
  // Layer 10: plan limit on the number of integrations (count capability).
  let entitlements = null;

  const audit = (userId, action, payload, workspaceId, success = true, error = null) => {
    if (!appendAuditLog) return;
    try {
      Promise.resolve(appendAuditLog(userId, action, redact(payload), { success, error: error ? redactString(error, 300) : null }, workspaceId)).catch(() => {});
    } catch { /* audit never breaks the request */ }
  };

  const asInputError = (err) => {
    if (err instanceof InputError) return new WorkspaceError(400, err.code, err.message);
    if (err instanceof CredentialError) return new WorkspaceError(err.status, err.code, err.message);
    return err;
  };

  function connectorFor(provider) {
    const c = registry.get(provider);
    if (!c) throw new WorkspaceError(400, 'UNKNOWN_PROVIDER', 'Unknown integration provider');
    return c;
  }

  function effectivePermissions(integration, rows) {
    const c = registry.get(integration.provider);
    if (!c) return [];
    const byAction = new Map((rows || []).map((r) => [r.action, r]));
    return Object.entries(c.actions).map(([name, a]) => {
      const available = !a.available || a.available(integration.config);
      const row = byAction.get(name);
      const enabled = available && (row ? !!row.enabled : !!a.defaultEnabled);
      const approval = row ? row.approval : 'default';
      const tier = maxTier(a.risk, APPROVAL_TIER[approval]);
      return {
        name,
        qualifiedName: `${integration.provider}.${name}`,
        label: a.label,
        available,
        enabled,
        risk: a.risk,
        approval,
        minRole: row ? row.min_role : 'member',
        effectiveTier: tier,
        requiresApproval: tier !== 'green',
        requiresAdminApproval: tier === 'red',
        readOnly: !!a.readOnly,
        safeToRetry: !!a.safeToRepeat(integration.config),
      };
    });
  }

  async function view(i) {
    const [rows, meta] = await Promise.all([store.listPermissions(i.workspace_id, i.id), store.getCredentialMeta(i.workspace_id, i.id)]);
    const c = registry.get(i.provider);
    return {
      id: i.id,
      workspaceId: i.workspace_id,
      provider: i.provider,
      providerName: c ? c.displayName : i.provider,
      name: i.name,
      status: i.status,
      config: i.config,
      createdBy: i.created_by,
      hasCredential: !!meta,
      credentialUpdatedAt: meta ? meta.created_at : null,
      lastUsedAt: i.last_used_at || null,
      lastCheckedAt: i.last_checked_at || null,
      lastError: i.last_error || null,
      version: i.version,
      createdAt: i.created_at,
      updatedAt: i.updated_at,
      actions: effectivePermissions(i, rows),
    };
  }

  async function load(ctx, id) {
    const ws = requireCtx(ctx);
    if (typeof id !== 'string' || !UUID_RE.test(id)) throw notFound();
    const i = await store.getIntegration(ws, id);
    if (!i) throw notFound();
    return i;
  }

  function requireAdmin(ctx) {
    if (!isAdmin(ctx)) throw forbidden('Only a workspace admin or owner can manage integrations.');
  }

  function cleanName(v) {
    if (typeof v !== 'string' || !v.trim() || v.trim().length > 80) throw badRequest('name must be 1-80 characters');
    return redactString(v.trim(), 80);
  }

  async function cas(i, patch) {
    const u = await store.updateIntegration(i.workspace_id, i.id, i.version, patch);
    if (!u) throw new WorkspaceError(409, 'INTEGRATION_CONFLICT', 'The integration was changed concurrently; reload and retry.');
    return u;
  }

  // ------------------------------------------------------------------
  // Management
  // ------------------------------------------------------------------
  function listProviders(ctx) {
    requireCtx(ctx);
    return registry.list();
  }

  async function listIntegrations(ctx) {
    const ws = requireCtx(ctx);
    const out = [];
    for (const i of await store.listIntegrations(ws)) out.push(await view(i));
    return out;
  }

  async function getIntegration(ctx, id) {
    return view(await load(ctx, id));
  }

  async function createIntegration(ctx, body = {}) {
    const ws = requireCtx(ctx);
    requireAdmin(ctx);
    const connector = connectorFor(body.provider);
    const name = cleanName(body.name);
    let config;
    let secret;
    try {
      config = connector.validateConfig(body.config || {});
      secret = connector.validateCredential(body.credentials === undefined ? null : body.credentials, config);
    } catch (err) { throw asInputError(err); }
    // Fail closed BEFORE creating anything if we could not encrypt.
    if (secret && !credentials.isConfigured()) {
      throw new WorkspaceError(503, 'CREDENTIALS_UNAVAILABLE', 'Credential encryption is not configured on this server (INTEGRATION_ENCRYPTION_KEY).');
    }
    let row;
    try {
      row = await store.insertIntegration({
        id: crypto.randomUUID(), workspace_id: ws, provider: connector.provider, name, status: 'disconnected', config, created_by: ctx.userId,
      });
    } catch (err) {
      if (err.code === '23505') throw new WorkspaceError(409, 'INTEGRATION_EXISTS', 'An integration with this name already exists in this workspace.');
      throw err;
    }
    // Layer 10: race-free plan limit (re-counted under a workspace lock after the insert;
    // an over-limit insert is removed by the database).
    if (entitlements && entitlements.enforceCount && store.enforceIntegrationLimit) {
      try {
        await entitlements.enforceCount(ws, 'integrations', (limit) => store.enforceIntegrationLimit(ws, row.id, limit));
      } catch (err) {
        if (err.code === 'ENTITLEMENT_UNAVAILABLE') await store.deleteIntegration(ws, row.id).catch(() => {});
        throw new WorkspaceError(err.status || 402, err.code || 'QUOTA_EXCEEDED', err.message);
      }
    }
    if (secret) {
      try {
        await credentials.storeCredential({ workspaceId: ws, integrationId: row.id, secret, actorId: ctx.userId });
      } catch (err) {
        throw asInputError(err);
      }
    }
    row = await cas(row, { status: 'connected', last_error: null });
    audit(ctx.userId, 'integration_connected', { workspaceId: ws, integrationId: row.id, provider: row.provider, name: row.name }, ws);
    return view(row);
  }

  async function updateIntegration(ctx, id, body = {}) {
    const i = await load(ctx, id);
    requireAdmin(ctx);
    if (!Number.isInteger(body.version) || body.version !== i.version) {
      throw new WorkspaceError(409, 'INTEGRATION_CONFLICT', 'version is required and must match the current version.');
    }
    const patch = {};
    if (body.name !== undefined) patch.name = cleanName(body.name);
    if (body.config !== undefined) {
      try { patch.config = connectorFor(i.provider).validateConfig(body.config); } catch (err) { throw asInputError(err); }
    }
    if (!Object.keys(patch).length) throw badRequest('Nothing to update');
    let u;
    try { u = await cas(i, patch); } catch (err) {
      if (err.code === '23505') throw new WorkspaceError(409, 'INTEGRATION_EXISTS', 'An integration with this name already exists in this workspace.');
      throw err;
    }
    audit(ctx.userId, 'integration_updated', { workspaceId: i.workspace_id, integrationId: i.id, provider: i.provider, fields: Object.keys(patch) }, i.workspace_id);
    return view(u);
  }

  async function rotateCredential(ctx, id, body = {}) {
    const i = await load(ctx, id);
    requireAdmin(ctx);
    const c = connectorFor(i.provider);
    let secret;
    try { secret = c.validateCredential(body.credentials, i.config); } catch (err) { throw asInputError(err); }
    if (!secret) throw badRequest('This integration does not use a credential');
    try {
      await credentials.storeCredential({ workspaceId: i.workspace_id, integrationId: i.id, secret, actorId: ctx.userId });
    } catch (err) { throw asInputError(err); }
    const u = await cas(i, { status: 'connected', last_error: null });
    audit(ctx.userId, 'integration_credential_rotated', { workspaceId: i.workspace_id, integrationId: i.id, provider: i.provider }, i.workspace_id);
    return view(u);
  }

  async function disconnect(ctx, id) {
    const i = await load(ctx, id);
    requireAdmin(ctx);
    await credentials.deleteCredential(i.workspace_id, i.id);
    const u = await cas(i, { status: 'disconnected' });
    try { await connectorFor(i.provider).disconnect(); } catch { /* best effort */ }
    audit(ctx.userId, 'integration_disconnected', { workspaceId: i.workspace_id, integrationId: i.id, provider: i.provider }, i.workspace_id);
    return view(u);
  }

  async function reconnectWithoutCredential(ctx, id) {
    const i = await load(ctx, id);
    requireAdmin(ctx);
    const c = connectorFor(i.provider);
    if (c.requiresCredential(i.config)) throw badRequest('Provide credentials to reconnect this integration');
    const u = await cas(i, { status: 'connected', last_error: null });
    audit(ctx.userId, 'integration_connected', { workspaceId: i.workspace_id, integrationId: i.id, provider: i.provider, name: i.name }, i.workspace_id);
    return view(u);
  }

  async function healthCheck(ctx, id) {
    const i = await load(ctx, id);
    requireAdmin(ctx);
    if (i.status === 'disconnected') throw new WorkspaceError(409, 'INTEGRATION_DISCONNECTED', 'Connect the integration before checking its health.');
    const c = connectorFor(i.provider);
    let credential = null;
    let result;
    try {
      if (c.requiresCredential(i.config)) credential = await loadCredential(i, c);
      const r = await c.healthCheck({ config: i.config, credential, http });
      result = { ok: !!r.ok, detail: scrubSecrets(redactString(String(r.detail || ''), 200), secretStrings(credential)) };
    } catch (err) {
      const safe = safeError(err, credential);
      result = { ok: false, detail: safe.message, code: safe.code, authFailed: safe.authFailed };
    }
    const status = result.ok ? 'connected' : (result.authFailed ? 'revoked' : 'error');
    // CAS on the version loaded above: a concurrent credential rotation wins.
    await store.updateIntegration(i.workspace_id, i.id, i.version, { status, last_checked_at: now().toISOString(), last_error: result.ok ? null : redactString(result.detail, 500) });
    audit(ctx.userId, 'integration_health_checked', { workspaceId: i.workspace_id, integrationId: i.id, provider: i.provider, status }, i.workspace_id, result.ok, result.ok ? null : result.detail);
    return { ok: result.ok, status, detail: result.detail, checkedAt: now().toISOString() };
  }

  async function updatePermissions(ctx, id, body = {}) {
    const i = await load(ctx, id);
    requireAdmin(ctx);
    const c = connectorFor(i.provider);
    const changes = body.actions;
    if (!changes || typeof changes !== 'object' || Array.isArray(changes) || !Object.keys(changes).length) throw badRequest('actions must be an object keyed by action name');
    const current = new Map((await store.listPermissions(i.workspace_id, i.id)).map((r) => [r.action, r]));
    const rows = [];
    for (const [name, ch] of Object.entries(changes)) {
      const a = c.actions[name];
      if (!a) throw badRequest(`Unknown action "${name}"`);
      if (!ch || typeof ch !== 'object') throw badRequest(`actions.${name} must be an object`);
      const prev = current.get(name) || { enabled: !!a.defaultEnabled, approval: 'default', min_role: 'member' };
      const enabled = ch.enabled === undefined ? prev.enabled : ch.enabled;
      const approval = ch.approval === undefined ? prev.approval : ch.approval;
      const minRole = ch.minRole === undefined ? prev.min_role : ch.minRole;
      if (typeof enabled !== 'boolean') throw badRequest(`actions.${name}.enabled must be boolean`);
      if (!Object.prototype.hasOwnProperty.call(APPROVAL_TIER, approval)) throw badRequest(`actions.${name}.approval must be default, required or admin`);
      if (!ROLES.includes(minRole)) throw badRequest(`actions.${name}.minRole must be member, admin or owner`);
      if (enabled && a.available && !a.available(i.config)) throw badRequest(`Action "${name}" is not available with this integration's configuration`);
      rows.push({ integration_id: i.id, workspace_id: i.workspace_id, action: name, enabled, approval, min_role: minRole, updated_by: ctx.userId, updated_at: now().toISOString() });
    }
    await store.upsertPermissions(rows);
    audit(ctx.userId, 'integration_permissions_changed', {
      workspaceId: i.workspace_id, integrationId: i.id, provider: i.provider,
      changes: rows.map((r) => ({ action: r.action, enabled: r.enabled, approval: r.approval, minRole: r.min_role })),
    }, i.workspace_id);
    return view(i);
  }

  /** Used by Layer 4 when publishing: does this step reference make sense? */
  async function validateStepReference(workspaceId, integrationId, action) {
    if (typeof integrationId !== 'string' || !UUID_RE.test(integrationId)) throw notFound();
    const i = await store.getIntegration(workspaceId, integrationId);
    if (!i) throw notFound();
    const c = registry.get(i.provider);
    if (!c || !c.actions[action]) throw badRequest(`Integration "${i.name}" has no action "${action}"`);
    return { provider: i.provider, name: i.name, label: `${c.displayName} — ${c.actions[action].label}` };
  }

  // ------------------------------------------------------------------
  // Gateway (Layer 3)
  // ------------------------------------------------------------------
  /**
   * Layer 9: the credential for a server-side call. An expiring OAuth token
   * (connector.refreshCredential + credential.expiresAt) is refreshed shortly
   * before it expires and stored encrypted again. If the refresh fails —
   * e.g. another instance already rotated the single-use refresh token — the
   * credential is re-read once and used if that copy is still valid.
   */
  const refreshing = new Map(); // integration id → in-flight refresh (single flight per instance)
  async function loadCredential(i, c) {
    const ids = { workspaceId: i.workspace_id, integrationId: i.id };
    const cred = await credentials.getCredentialForExecution(ids);
    const expiring = (x) => !!(x && x.expiresAt && Date.parse(x.expiresAt) - now().getTime() < REFRESH_MARGIN_MS);
    if (!c.refreshCredential || !expiring(cred)) return cred;
    if (refreshing.has(i.id)) return refreshing.get(i.id);
    const p = (async () => {
      try {
        const fresh = c.validateCredential(await c.refreshCredential({ credential: cred, config: i.config, http }), i.config);
        await credentials.storeCredential({ ...ids, secret: fresh, actorId: 'system:oauth-refresh' });
        audit('system:oauth-refresh', 'integration_credential_refreshed', { workspaceId: i.workspace_id, integrationId: i.id, provider: i.provider }, i.workspace_id);
        return fresh;
      } catch (err) {
        // Another instance may have used the single-use refresh token a
        // moment earlier: give its write a short, bounded chance to land.
        for (let attempt = 0; attempt < 4; attempt++) {
          const again = await credentials.getCredentialForExecution(ids);
          if (again && !expiring(again)) return again;
          if (attempt < 3) await new Promise((r) => { const t = setTimeout(r, 150 * (attempt + 1)); if (t.unref) t.unref(); });
        }
        throw err;
      }
    })();
    refreshing.set(i.id, p);
    try { return await p; } finally { refreshing.delete(i.id); }
  }

  function safeError(err, credential) {
    const secrets = secretStrings(credential);
    let code = 'CONNECTOR_ERROR';
    let message = 'The connector failed.';
    let authFailed = false;
    let retryable = false;
    if (err instanceof ConnectorError) ({ code, message, authFailed, retryable } = err);
    else if (err instanceof SafeHttpError) { code = err.code; message = err.message; retryable = ['TIMEOUT', 'NETWORK_ERROR', 'DNS_FAILURE'].includes(err.code); }
    else if (err instanceof InputError) { code = err.code; message = err.message; }
    else if (err instanceof CredentialError) { code = err.code; message = err.message; }
    else if (err instanceof GatewayError) { code = err.code; message = err.message; }
    else logger.error?.(`[integrations] unexpected connector error (${err && err.name})`);
    return { code, message: scrubSecrets(redactString(String(message), 300), secrets), authFailed, retryable };
  }

  async function prepareAction(workspaceId, userId, spec) {
    if (!spec || typeof spec !== 'object') throw new GatewayError('INVALID_CONNECTOR_STEP', 'Invalid connector step');
    const { integrationId, action } = spec;
    if (typeof integrationId !== 'string' || !UUID_RE.test(integrationId)) throw new GatewayError('INTEGRATION_NOT_FOUND', 'Integration not found in this workspace');
    const i = await store.getIntegration(workspaceId, integrationId);
    if (!i) throw new GatewayError('INTEGRATION_NOT_FOUND', 'Integration not found in this workspace');
    const c = registry.get(i.provider);
    if (!c) throw new GatewayError('INTEGRATION_NOT_FOUND', 'Integration provider is not available');
    if (i.status !== 'connected') {
      throw new GatewayError('INTEGRATION_UNAVAILABLE', `${c.displayName} integration "${i.name}" is ${i.status}; an admin must reconnect it.`);
    }
    const a = c.actions[action];
    if (!a || (a.available && !a.available(i.config))) throw new GatewayError('ACTION_NOT_AVAILABLE', `Action "${action}" is not available for "${i.name}"`);
    const perm = effectivePermissions(i, await store.listPermissions(workspaceId, i.id)).find((p) => p.name === action);
    if (!perm || !perm.enabled) throw new GatewayError('ACTION_NOT_ENABLED', `Action "${a.label}" is not enabled for "${i.name}"; a workspace admin can enable it.`);
    const role = getMemberRole ? await getMemberRole(workspaceId, userId) : null;
    if (!role) throw new GatewayError('PERMISSION_DENIED', 'The run\'s initiator is no longer a member of this workspace');
    if (!hasRole(role, perm.minRole)) throw new GatewayError('PERMISSION_DENIED', `Action "${a.label}" requires the ${perm.minRole} role`);
    let input;
    try { input = c.validateAction(action, spec.input || {}, i.config); } catch (err) {
      throw new GatewayError(err.code || 'INVALID_CONNECTOR_INPUT', redactString(err.message, 300));
    }
    return {
      integration: i,
      connector: c,
      input,
      tier: perm.effectiveTier,
      safeToRepeat: !!a.safeToRepeat(i.config),
      qualifiedName: `${i.provider}.${action}`,
      label: `${c.displayName} — ${a.label}`,
      integrationName: i.name,
      provider: i.provider,
      target: c.describeTarget(action, input, i.config),
      timeoutMs: a.timeoutMs || 15000,
      readOnly: !!a.readOnly,
      resource: firewallResource(i.provider, input, i.config),
    };
  }

  /** Layer 3 executor result: { success, data, message, evidence:{verified} } or { success:false, error, errorCode, retryable }. */
  async function executeAction(workspaceId, userId, spec, { executionId, idempotencyKey, firewallTicket } = {}) {
    let prepared;
    let credential = null;
    try {
      if (fw && !fw.consumeTicket(firewallTicket, {
        workspaceId, actorId: userId, integrationId: spec && spec.integrationId, action: spec && spec.action, input: (spec && spec.input) || {},
      })) {
        if (fw.events) fw.events.record(workspaceId, userId, 'connector_blocked', { integrationId: spec && spec.integrationId, action: spec && spec.action, executionId: executionId || null, reason: 'FIREWALL_TICKET_MISSING_OR_INVALID' }, { success: false });
        throw new GatewayError('FIREWALL_BYPASS_BLOCKED', 'Connector actions must be authorized by the workspace Agent Firewall.');
      }
      prepared = await prepareAction(workspaceId, userId, spec); // fresh checks at execution time
      const { integration: i, connector: c } = prepared;
      if (c.requiresCredential(i.config)) credential = await loadCredential(i, c);
      const exec = c.execute({
        action: spec.action, input: prepared.input, config: i.config, credential, http,
        idempotencyKey: idempotencyKey || (executionId ? `nexus-${executionId}` : undefined),
      });
      const out = await Promise.race([
        exec,
        new Promise((_, rej) => { const t = setTimeout(() => rej(new SafeHttpError('TIMEOUT', 'The connector timed out')), prepared.timeoutMs + 2000); if (t.unref) t.unref(); }),
      ]);
      const data = scrubSecrets(c.redactResult(out.data), secretStrings(credential));
      const summary = scrubSecrets(redactString(String(out.summary || ''), 300), secretStrings(credential));
      store.touchIntegration(workspaceId, i.id, { last_used_at: now().toISOString() }).catch(() => {});
      audit(userId, 'connector_executed', {
        workspaceId, integrationId: i.id, provider: i.provider, action: spec.action, executionId: executionId || null, target: prepared.target,
      }, workspaceId, true);
      return { success: true, data, message: summary, evidence: { verified: !!out.verified } };
    } catch (err) {
      const safe = safeError(err, credential);
      if (fw && fw.events && ['BLOCKED_DESTINATION', 'HOST_NOT_ALLOWED'].includes(safe.code)) {
        fw.events.record(workspaceId, userId, 'ssrf_blocked', { integrationId: spec && spec.integrationId, action: spec && spec.action, executionId: executionId || null }, { success: false });
      }
      if (prepared && safe.authFailed) {
        // Compare-and-set on the version read before the call: if an admin
        // rotated the credential meanwhile, their reconnect wins.
        await store.updateIntegration(workspaceId, prepared.integration.id, prepared.integration.version, { status: 'revoked', last_error: safe.message }).catch(() => null);
      }
      let provider = prepared ? prepared.provider : null;
      if (!provider && spec && typeof spec.integrationId === 'string' && UUID_RE.test(spec.integrationId)) {
        const i = await store.getIntegration(workspaceId, spec.integrationId).catch(() => null);
        provider = i ? i.provider : null; // only this workspace's integration can be named
      }
      audit(userId, 'connector_executed', {
        workspaceId, integrationId: spec && spec.integrationId, provider, action: spec && spec.action,
        executionId: executionId || null, code: safe.code,
      }, workspaceId, false, safe.message);
      return { success: false, error: safe.message, errorCode: safe.code, retryable: safe.retryable };
    } finally {
      credential = null;
    }
  }

  // Layer 10 internal helpers (never routed): raw row for server-side
  // callers that already hold a workspace id, and connector input validation
  // (host allowlists etc.) without executing anything.
  async function getIntegrationRow(workspaceId, integrationId) {
    if (typeof integrationId !== 'string' || !UUID_RE.test(integrationId)) return null;
    return store.getIntegration(workspaceId, integrationId);
  }
  function validateActionInput(i, action, input) {
    const c = registry.get(i.provider);
    if (!c || !c.actions[action]) throw new InputError(`Action "${action}" is not available`);
    return c.validateAction(action, input || {}, i.config);
  }

  return {
    getIntegrationRow, validateActionInput,
    listProviders, listIntegrations, getIntegration, createIntegration, updateIntegration, rotateCredential,
    disconnect, reconnectWithoutCredential, healthCheck, updatePermissions, validateStepReference,
    gateway: { prepareAction, executeAction },
    registry,
    setFirewall(f) { fw = f || null; },
    setEntitlements(e) { entitlements = e || null; },
  };
}

/** Layer 6: what the firewall evaluates for a connector action (no secrets). */
function firewallResource(provider, input, config) {
  const r = {};
  if (config && typeof config.baseUrl === 'string') r.url = config.baseUrl;
  // Layer 10 connectors: the destination the firewall's host rules see.
  if (provider === 'web_page' && input && typeof input.url === 'string') {
    r.url = input.url;
    try { r.host = new URL(input.url).hostname.toLowerCase(); } catch { /* validated earlier */ }
  }
  if (provider === 'slack') r.host = 'hooks.slack.com';
  if (provider === 'email' && config) r.host = config.provider === 'sendgrid' ? 'api.sendgrid.com' : 'api.resend.com';
  if (provider === 'github') {
    r.host = 'api.github.com';
    if (input && typeof input.owner === 'string' && typeof input.repo === 'string') r.repo = `${input.owner}/${input.repo}`;
    if (input && typeof input.path === 'string') r.paths = [input.path];
  }
  return r;
}

module.exports = { createIntegrationService, GatewayError, scrubSecrets };
