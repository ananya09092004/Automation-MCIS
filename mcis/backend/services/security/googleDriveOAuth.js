/**
 * Layer 9 — Google Drive OAuth (authorization-code flow, offline access)
 * for WORKSPACE connections (owner only). Mirrors the Layer 6 GitHub
 * workspace flow: a server-side single-use state (oauth_states, purpose
 * workspace_connect, provider google_drive) bound to the workspace AND the
 * owner who started it; the code is exchanged over the SSRF-safe client;
 * the tokens go only into the Layer 5 encrypted credential store.
 *
 * Available only when GOOGLE_DRIVE_ENABLED=true and GOOGLE_OAUTH_CLIENT_ID,
 * GOOGLE_OAUTH_CLIENT_SECRET, GOOGLE_OAUTH_REDIRECT_URI are set.
 * Scope: drive.readonly (the connector has no write actions).
 *
 * Tokens never appear in logs, responses, redirects, errors or audit rows.
 */
'use strict';

const { credentialFromTokenResponse } = require('../integrations/connectors/googleDriveConnector');
const { WorkspaceError, hasRole } = require('../workspaceService');

const WORKSPACE_NAME = 'Google Drive (OAuth)';
const CODE_RE = /^[A-Za-z0-9._~/-]{8,512}$/;
const EMAIL_RE = /^[^\s@]{1,200}@[^\s@]{1,200}$/;
const SCOPE = 'https://www.googleapis.com/auth/drive.readonly';

class DriveOAuthError extends Error {
  constructor(code, message, status = 400) { super(message); this.name = 'DriveOAuthError'; this.code = code; this.status = status; }
}

const GOOGLE_ENDPOINTS = Object.freeze({
  authorize: 'https://accounts.google.com/o/oauth2/v2/auth',
  token: 'https://oauth2.googleapis.com/token',
  about: 'https://www.googleapis.com/drive/v3/about?fields=user(emailAddress)',
});

/** `endpoints` is a TEST SEAM; production always uses Google's URLs. */
function createDriveOAuthClient({
  http, clientId = process.env.GOOGLE_OAUTH_CLIENT_ID, clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET,
  redirectUri = process.env.GOOGLE_OAUTH_REDIRECT_URI, endpoints = GOOGLE_ENDPOINTS,
} = {}) {
  const configured = !!(http && clientId && clientSecret && redirectUri);
  const hostOf = (u) => new URL(u).hostname;
  return {
    configured,
    authorizeUrl(state) {
      const u = new URL(endpoints.authorize);
      u.searchParams.set('client_id', clientId);
      u.searchParams.set('redirect_uri', redirectUri);
      u.searchParams.set('response_type', 'code');
      u.searchParams.set('scope', SCOPE);
      u.searchParams.set('access_type', 'offline');
      u.searchParams.set('prompt', 'consent');
      u.searchParams.set('include_granted_scopes', 'false');
      u.searchParams.set('state', state);
      return u.toString();
    },
    /** code → { credential, account }. The client secret travels only in the POST body. */
    async exchange(code) {
      if (!configured) throw new DriveOAuthError('OAUTH_NOT_CONFIGURED', 'Google OAuth is not configured on this server.', 503);
      if (typeof code !== 'string' || !CODE_RE.test(code)) throw new DriveOAuthError('OAUTH_CODE_INVALID', 'Invalid authorization code.');
      let res;
      try {
        res = await http.request({
          url: endpoints.token, method: 'POST', allowedMethods: ['POST'], allowedHosts: [hostOf(endpoints.token)],
          headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'nexus-integrations' },
          body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, code, redirect_uri: redirectUri, grant_type: 'authorization_code' }).toString(),
          timeoutMs: 15000, maxBytes: 16 * 1024,
        });
      } catch { throw new DriveOAuthError('OAUTH_EXCHANGE_FAILED', 'Could not reach Google.', 502); }
      let data = null;
      try { data = JSON.parse(res.body); } catch { data = null; }
      const credential = res.status === 200 ? credentialFromTokenResponse(data) : null;
      if (!credential) throw new DriveOAuthError('OAUTH_EXCHANGE_FAILED', 'Google did not issue a token for this authorization.', 502);
      if (typeof data.scope === 'string' && !data.scope.split(' ').includes(SCOPE)) {
        throw new DriveOAuthError('OAUTH_SCOPE_DENIED', 'Read access to Google Drive was not granted.', 400);
      }
      let me;
      try {
        me = await http.request({
          url: endpoints.about, method: 'GET', allowedHosts: [hostOf(endpoints.about)],
          headers: { Accept: 'application/json', Authorization: `Bearer ${credential.token}`, 'User-Agent': 'nexus-integrations' },
          timeoutMs: 15000, maxBytes: 64 * 1024, maxRedirects: 0,
        });
      } catch { throw new DriveOAuthError('OAUTH_EXCHANGE_FAILED', 'Could not reach Google Drive.', 502); }
      let account = null;
      try { account = JSON.parse(me.body).user.emailAddress; } catch { account = null; }
      if (me.status !== 200 || typeof account !== 'string' || !EMAIL_RE.test(account)) throw new DriveOAuthError('OAUTH_EXCHANGE_FAILED', 'Could not read the Google account.', 502);
      return { credential, account };
    },
  };
}

function createDriveAccountService({ integrationService, integrationStore, credentials, oauthStates, oauthClient, events = null } = {}) {
  if (!integrationService || !integrationStore || !credentials || !oauthStates || !oauthClient) throw new Error('drive account service: missing dependencies');
  const configured = () => oauthClient.configured && credentials.isConfigured();
  const requireOwner = (ctx) => {
    if (!ctx || !hasRole(ctx.role, 'owner') || ctx.apiKeyId) throw new WorkspaceError(403, 'FORBIDDEN', 'Only the workspace owner can connect an OAuth account.');
  };
  const requireConfigured = () => {
    if (!configured()) throw new DriveOAuthError('OAUTH_UNAVAILABLE', 'Google Drive connection is not available on this server (OAuth or credential encryption is not configured).', 503);
  };

  async function startWorkspaceConnect(ctx) {
    requireOwner(ctx);
    requireConfigured();
    const state = await oauthStates.create({ workspaceId: ctx.workspace.id, userId: ctx.userId, provider: 'google_drive', purpose: 'workspace_connect' });
    return { url: oauthClient.authorizeUrl(state) };
  }

  async function completeWorkspaceConnect(ctx, { code, state } = {}) {
    requireOwner(ctx);
    requireConfigured();
    await oauthStates.consume(state, { provider: 'google_drive', purpose: 'workspace_connect', userId: ctx.userId, workspaceId: ctx.workspace.id });
    const { credential, account } = await oauthClient.exchange(code);
    const all = await integrationStore.listIntegrations(ctx.workspace.id);
    const existing = all.find((i) => i.provider === 'google_drive' && i.name === WORKSPACE_NAME && i.config && i.config.authMethod === 'oauth') || null;
    let view;
    if (existing) {
      view = await integrationService.rotateCredential(ctx, existing.id, { credentials: credential });
      if (existing.config.account !== account) {
        view = await integrationService.updateIntegration(ctx, existing.id, { version: view.version, config: { ...existing.config, account } });
      }
    } else {
      // Least privilege by default: only files directly in My Drive; the
      // owner/admin widens the folder allowlist explicitly.
      view = await integrationService.createIntegration(ctx, {
        provider: 'google_drive', name: WORKSPACE_NAME, config: { allowedFolders: ['root'], authMethod: 'oauth', account }, credentials: credential,
      });
    }
    events && events.record(ctx.workspace.id, ctx.userId, 'oauth_connected', { provider: 'google_drive', integrationId: view.id, account });
    return view;
  }

  return { configured, startWorkspaceConnect, completeWorkspaceConnect, WORKSPACE_NAME };
}

/** Production instance, or null when Drive is disabled. */
function createDefaultDriveAccountService({ integrationSystem = null, logger = console } = {}) {
  if (String(process.env.GOOGLE_DRIVE_ENABLED || '').toLowerCase() !== 'true') return null;
  const { createSupabaseWorkspaceStore } = require('../workspaceStore');
  const { createSupabaseIntegrationStore } = require('../integrations/integrationStore');
  const { createCredentialService, loadKeyRing } = require('../integrations/credentialService');
  const { createSafeHttpClient } = require('../integrations/safeHttp');
  const { createDefaultRegistry } = require('../integrations/connectorRegistry');
  const { createIntegrationService } = require('../integrations/integrationService');
  const { createSupabaseSecurityStore } = require('./securityStore');
  const { createOAuthStateService } = require('./oauthStateService');
  const { createSecurityEvents, createDbRateLimiter } = require('./securityEvents');
  const { appendAuditLog } = require('../../security-engine/auditLog');
  const wsStore = createSupabaseWorkspaceStore();
  const integrationStore = createSupabaseIntegrationStore();
  const credentials = createCredentialService({ store: integrationStore, keyRing: loadKeyRing() });
  const http = createSafeHttpClient();
  const secStore = createSupabaseSecurityStore();
  const events = createSecurityEvents({ appendAuditLog, logger });
  const integrationService = (integrationSystem && integrationSystem.service) || createIntegrationService({
    store: integrationStore, registry: createDefaultRegistry(), credentials, http, appendAuditLog,
    getMemberRole: async (ws, uid) => { const m = uid ? await wsStore.getMember(ws, uid) : null; return m ? m.role : null; },
  });
  return createDriveAccountService({
    integrationService, integrationStore, credentials,
    oauthStates: createOAuthStateService({ store: secStore, events, rateLimiter: createDbRateLimiter({ store: secStore }) }),
    oauthClient: createDriveOAuthClient({ http }), events,
  });
}

module.exports = { createDriveOAuthClient, createDriveAccountService, createDefaultDriveAccountService, DriveOAuthError, WORKSPACE_NAME, SCOPE };
