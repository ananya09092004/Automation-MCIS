/**
 * Layer 6 — /api/workspaces/:workspaceId/security
 *
 *   GET    /                         dashboard summary (no secrets)            admin+
 *   GET    /policy                   effective policy + version                  admin+
 *   PUT    /policy                   { version, policy } (CAS)                  owner
 *   GET    /events?limit=            workspace security events                  admin+
 *   GET    /api-keys                 key metadata (never hashes/plaintext)      admin+
 *   POST   /api-keys                 { name, scopes?, workflowIds?, expiresInDays? } → plaintext ONCE   owner
 *   POST   /api-keys/:keyId/revoke                                               owner
 *   POST   /api-keys/:keyId/rotate   → new plaintext ONCE, old key revoked       owner
 *   POST   /oauth/github/start       → { url }                                   owner
 *   POST   /oauth/github/complete    { code, state } (caller must be the user the state was issued to)  owner
 *   POST   /emergency-stop           { active }  (Layer 9)                       admin+
 *   GET    /oauth/providers          { github, google_drive } booleans (Layer 9) member
 *   POST   /oauth/google_drive/start     → { url }  (Layer 9, GOOGLE_DRIVE_ENABLED)  owner
 *   POST   /oauth/google_drive/complete  { code, state }                        owner
 *
 * Behind Firebase auth + Layer 1 workspaceContext (non-members get 404).
 * Plus the production wiring (createSecuritySystem) and the Agent Firewall
 * feature flag.
 */
'use strict';

const express = require('express');
const { createWorkspaceService, WorkspaceError } = require('../services/workspaceService');
const { createSupabaseWorkspaceStore } = require('../services/workspaceStore');
const { workspaceContext } = require('../middleware/workspaceContext');

function sendError(res, err, logger) {
  if (err instanceof WorkspaceError || (err && Number.isInteger(err.status) && err.status < 500 && err.code)) {
    return res.status(err.status).json({ success: false, error: err.message, code: err.code });
  }
  if (err && err.status === 503) return res.status(503).json({ success: false, error: err.message, code: err.code });
  if (logger && logger.error) logger.error(`Security route error: ${err && (err.code || err.name)}`);
  return res.status(500).json({ success: false, error: 'Security service error' });
}

function createSecurityRouter({ workspaceService, securityService, apiKeyService, githubAccounts = null, driveAccounts = null, logger } = {}) {
  const wsSvc = workspaceService || createWorkspaceService(createSupabaseWorkspaceStore());
  const router = express.Router({ mergeParams: true });
  router.use(workspaceContext(wsSvc, { logger }));
  const h = (fn, ok = 200) => async (req, res) => {
    try {
      res.set('Cache-Control', 'no-store');
      return res.status(ok).json({ success: true, data: await fn(req) });
    } catch (err) { return sendError(res, err, logger); }
  };
  router.get('/', h((req) => securityService.dashboard(req.workspace)));
  router.get('/policy', h((req) => securityService.getPolicy(req.workspace)));
  router.put('/policy', h((req) => securityService.updatePolicy(req.workspace, req.body || {})));
  // Layer 9: workspace emergency stop (owner/admin): { active: true|false }
  router.post('/emergency-stop', h((req) => securityService.setEmergencyStop(req.workspace, { active: (req.body || {}).active })));
  router.get('/events', h((req) => securityService.listEvents(req.workspace, { limit: req.query.limit })));
  router.get('/api-keys', h((req) => apiKeyService.listKeys(req.workspace)));
  router.post('/api-keys', h((req) => apiKeyService.createKey(req.workspace, req.body || {}), 201));
  router.post('/api-keys/:keyId/revoke', h((req) => apiKeyService.revokeKey(req.workspace, req.params.keyId)));
  router.post('/api-keys/:keyId/rotate', h((req) => apiKeyService.rotateKey(req.workspace, req.params.keyId), 201));
  router.post('/oauth/github/start', h((req) => {
    if (!githubAccounts) throw new WorkspaceError(503, 'OAUTH_UNAVAILABLE', 'GitHub OAuth is not available on this server.');
    return githubAccounts.startWorkspaceConnect(req.workspace);
  }));
  router.post('/oauth/github/complete', h(async (req) => {
    if (!githubAccounts) throw new WorkspaceError(503, 'OAUTH_UNAVAILABLE', 'GitHub OAuth is not available on this server.');
    const b = req.body || {};
    const v = await githubAccounts.completeWorkspaceConnect(req.workspace, { code: b.code, state: b.state });
    return { integrationId: v.id, provider: v.provider, account: v.config.account, status: v.status };
  }));
  // Layer 9: which OAuth connections this server can offer (booleans only).
  router.get('/oauth/providers', h(() => ({
    github: !!(githubAccounts && githubAccounts.configured()),
    google_drive: !!(driveAccounts && driveAccounts.configured()),
  })));
  // Layer 9: Google Drive (read-only) workspace connection.
  const driveOff = () => new WorkspaceError(503, 'OAUTH_UNAVAILABLE', 'Google Drive is not available on this server.');
  router.post('/oauth/google_drive/start', h((req) => {
    if (!driveAccounts) throw driveOff();
    return driveAccounts.startWorkspaceConnect(req.workspace);
  }));
  router.post('/oauth/google_drive/complete', h(async (req) => {
    if (!driveAccounts) throw driveOff();
    const b = req.body || {};
    const v = await driveAccounts.completeWorkspaceConnect(req.workspace, { code: b.code, state: b.state });
    return { integrationId: v.id, provider: v.provider, account: v.config.account, status: v.status };
  }));
  return router;
}

/** SECURITY_FIREWALL_ENABLED: on unless explicitly 'false'. */
function firewallFlag(env = process.env) {
  const v = env.SECURITY_FIREWALL_ENABLED;
  if (v === undefined || v === '' || v === 'true') return true;
  if (v === 'false') return false;
  throw new Error('SECURITY_FIREWALL_ENABLED must be "true" or "false"');
}

/**
 * Production wiring. Attaches the Agent Firewall to the SHARED Layer 3
 * execution service and the Layer 5 gateway. Disabling the firewall
 * (SECURITY_FIREWALL_ENABLED=false) leaves Layer 3 approvals, API-key
 * hashing, OAuth state checks and the encrypted GitHub storage in place.
 * An invalid flag value fails closed (firewall on).
 */
function createSecuritySystem({ workspaceService, executionService, integrationSystem = null, logger = console } = {}) {
  const { createSupabaseSecurityStore } = require('../services/security/securityStore');
  const { createSecurityEvents, createDbRateLimiter } = require('../services/security/securityEvents');
  const { createAgentFirewall } = require('../services/security/agentFirewall');
  const { createApiKeyService } = require('../services/security/apiKeyService');
  const { createSecurityService } = require('../services/security/securityService');
  const { getDefaultGithubAccountService } = require('../services/security/githubOAuth');
  const { appendAuditLog } = require('../security-engine/auditLog');

  const wsStore = createSupabaseWorkspaceStore();
  const wsSvc = workspaceService || createWorkspaceService(wsStore);
  const getMemberRole = async (workspaceId, uid) => {
    if (!uid) return null;
    const m = await wsStore.getMember(workspaceId, uid);
    return m ? m.role : null;
  };
  const store = createSupabaseSecurityStore();
  const events = createSecurityEvents({ appendAuditLog, logger });
  const rateLimiter = createDbRateLimiter({ store, logger });
  let enabled;
  try { enabled = firewallFlag(); } catch (err) {
    logger.error?.(`Security: ${err.message}; the Agent Firewall stays ON (fail closed).`);
    enabled = true;
  }
  const firewall = createAgentFirewall({ store, getMemberRole, events, rateLimiter, logger });
  const execSvc = executionService || require('./executions').executionService;
  if (enabled) {
    execSvc.setFirewall(firewall);
    if (integrationSystem && integrationSystem.service) integrationSystem.service.setFirewall(firewall);
    // Probe the policy table once: a missing migration means every action
    // will be denied (POLICY_UNAVAILABLE) — say so loudly at boot.
    store.getPolicy('00000000-0000-0000-0000-000000000000').catch((err) => {
      logger.error?.(`Security: policy store unavailable (${err.code || err.message}); the Agent Firewall will DENY all agent actions until migrations/20260928_layer6_security.up.sql is applied.`);
    });
  } else {
    logger.warn?.('Security: SECURITY_FIREWALL_ENABLED=false — Agent Firewall is OFF (Layer 3 approvals still apply).');
  }
  const apiKeyService = createApiKeyService({ store, getMemberRole, events, rateLimiter, logger });
  let githubAccounts = null;
  try { githubAccounts = getDefaultGithubAccountService(); } catch (err) { logger.error?.(`Security: GitHub OAuth unavailable (${err.message})`); }
  let driveAccounts = null;
  try { driveAccounts = require('../services/security/googleDriveOAuth').createDefaultDriveAccountService({ integrationSystem, logger }); } catch (err) { logger.error?.(`Security: Google Drive OAuth unavailable (${err.message})`); }
  const securityService = createSecurityService({
    store, firewall, firewallEnabled: enabled, apiKeys: apiKeyService, integrations: integrationSystem ? integrationSystem.service : null, events, logger,
  });
  return {
    router: createSecurityRouter({ workspaceService: wsSvc, securityService, apiKeyService, githubAccounts, driveAccounts, logger }),
    firewall, firewallEnabled: enabled, apiKeyService, securityService, events, rateLimiter, store,
  };
}

module.exports = { createSecurityRouter, createSecuritySystem, firewallFlag };
