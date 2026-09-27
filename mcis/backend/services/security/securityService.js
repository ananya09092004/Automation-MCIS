/**
 * Layer 6 — security management: workspace policy, security events and the
 * /security dashboard summary. Never returns secrets (no credentials, key
 * hashes, OAuth tokens or states).
 *
 *   OWNER  → change the policy (full security configuration), API keys, OAuth
 *   ADMIN  → view policy / dashboard / events / API key metadata; manage
 *            integrations, connector permissions and approvals (Layer 3/5)
 *   MEMBER → none of this (use permitted tools only)
 */
'use strict';

const { WorkspaceError, hasRole } = require('../workspaceService');
const { validatePolicy, effectivePolicy, defaultPolicy, PolicyError, DANGEROUS_ACTIONS } = require('./policyEngine');

const forbidden = (m) => new WorkspaceError(403, 'FORBIDDEN', m);

function createSecurityService({ store, firewall = null, firewallEnabled = false, apiKeys, integrations = null, events = null, logger = console } = {}) {
  if (!store || !apiKeys) throw new Error('security service: store and apiKeys are required');

  const requireAdmin = (ctx) => { if (!ctx || !hasRole(ctx.role, 'admin') || ctx.apiKeyId) throw forbidden('Only a workspace admin or owner can view security settings.'); };
  const requireOwner = (ctx) => { if (!ctx || !hasRole(ctx.role, 'owner') || ctx.apiKeyId) throw forbidden('Only the workspace owner can change the security policy.'); };

  async function getPolicy(ctx) {
    requireAdmin(ctx);
    const row = await store.getPolicy(ctx.workspace.id);
    let policy;
    let corrupt = false;
    try { policy = effectivePolicy(row ? row.policy : null); } catch { corrupt = true; policy = null; }
    return {
      firewallEnabled: !!firewallEnabled,
      isDefault: !row,
      version: row ? row.version : 0,
      updatedBy: row ? row.updated_by : null,
      updatedAt: row ? row.updated_at : null,
      policy,
      corrupt, // a corrupt stored policy makes the firewall deny everything (fail closed)
      builtIn: {
        dangerousActionsDeniedByDefault: Object.keys(DANGEROUS_ACTIONS),
        alwaysDenied: ['credential extraction (ssh keys, cloud credentials, .env, browser cookie/login stores, keychains)', 'resources naming another workspace', 'cloud metadata endpoints'],
        taintedExecutionsNeedApproval: true,
      },
    };
  }

  async function updatePolicy(ctx, body = {}) {
    requireOwner(ctx);
    if (!Number.isInteger(body.version) || body.version < 0) throw new WorkspaceError(409, 'POLICY_CONFLICT', 'version is required (0 when no policy has been saved yet).');
    let policy;
    try { policy = validatePolicy(body.policy); } catch (err) {
      if (err instanceof PolicyError) throw new WorkspaceError(400, err.code, err.message);
      throw err;
    }
    const saved = await store.savePolicy(ctx.workspace.id, body.version, policy, ctx.userId);
    if (!saved) throw new WorkspaceError(409, 'POLICY_CONFLICT', 'The policy was changed concurrently; reload and retry.');
    if (firewall) firewall.invalidate(ctx.workspace.id);
    events && events.record(ctx.workspace.id, ctx.userId, 'policy_updated', { version: saved.version, maxRisk: policy.maxRisk, executionTypes: policy.executionTypes });
    return getPolicy(ctx);
  }

  /**
   * Layer 9: workspace emergency stop. Owners and admins can switch it on or
   * off; while on, the firewall denies every agent and connector action in
   * this workspace (checked again right before each action runs). The voice
   * emergency stop (/api/emergency) is unchanged.
   */
  async function setEmergencyStop(ctx, { active } = {}) {
    requireAdmin(ctx);
    if (typeof active !== 'boolean') throw new WorkspaceError(400, 'BAD_REQUEST', 'active must be true or false');
    for (let i = 0; i < 4; i++) {
      const row = await store.getPolicy(ctx.workspace.id);
      let policy;
      try { policy = effectivePolicy(row ? row.policy : null); } catch { policy = defaultPolicy(); } // a corrupt policy must not block a STOP
      policy.emergencyStop = active;
      const saved = await store.savePolicy(ctx.workspace.id, row ? row.version : 0, policy, ctx.userId);
      if (!saved) continue;
      if (firewall) firewall.invalidate(ctx.workspace.id);
      events && events.record(ctx.workspace.id, ctx.userId, 'policy_updated', { version: saved.version, emergencyStop: active });
      return { emergencyStop: active, version: saved.version };
    }
    throw new WorkspaceError(409, 'POLICY_CONFLICT', 'The policy was changed concurrently; retry.');
  }

  async function listEvents(ctx, { limit } = {}) {
    requireAdmin(ctx);
    const n = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);
    const rows = await store.listSecurityEvents(ctx.workspace.id, { limit: n });
    return rows.map((r) => ({
      id: r.id, type: String(r.action).replace(/^security\./, ''), actorId: r.user_id, success: r.success,
      detail: r.payload || null, error: r.error || null, at: r.created_at,
    }));
  }

  async function dashboard(ctx) {
    requireAdmin(ctx);
    const [policy, keys, evts] = await Promise.all([getPolicy(ctx), apiKeys.listKeys(ctx), listEvents(ctx, { limit: 100 })]);
    let integrationList = [];
    if (integrations) {
      try { integrationList = await integrations.listIntegrations(ctx); } catch (err) { logger.warn?.(`[security] integrations unavailable: ${err.code || err.message}`); }
    }
    return {
      firewall: { enabled: !!firewallEnabled, policyVersion: policy.version, isDefault: policy.isDefault, corrupt: policy.corrupt },
      policy: policy.policy,
      builtIn: policy.builtIn,
      approvalPolicy: policy.policy ? { ...policy.policy.approval, maxRisk: policy.policy.maxRisk, minRole: policy.policy.minRole } : null,
      integrations: integrationList.map((i) => ({
        id: i.id, name: i.name, provider: i.provider, status: i.status, hasCredential: i.hasCredential, lastUsedAt: i.lastUsedAt,
        connectorPermissions: (i.actions || []).map((a) => ({
          action: a.qualifiedName, enabled: a.enabled, effectiveTier: a.effectiveTier, minRole: a.minRole, readOnly: a.readOnly,
        })),
      })),
      oauthConnections: integrationList.filter((i) => i.config && i.config.authMethod === 'oauth')
        .map((i) => ({ integrationId: i.id, provider: i.provider, account: i.config.account || null, status: i.status })),
      apiKeys: keys,
      recentEvents: evts.slice(0, 25),
      blockedActions: evts.filter((e) => ['policy_deny', 'connector_blocked', 'credential_access_denied', 'sensitive_data_blocked', 'ssrf_blocked'].includes(e.type)).slice(0, 25),
      role: ctx.role,
    };
  }

  return { getPolicy, updatePolicy, setEmergencyStop, listEvents, dashboard };
}

module.exports = { createSecurityService };
