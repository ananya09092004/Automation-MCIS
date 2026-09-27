/**
 * Layer 6 — GitHub OAuth (authorization-code flow) over the SSRF-safe client,
 * and the ONE place GitHub OAuth tokens are stored: the Layer 5 encrypted
 * integration store (AES-256-GCM, credentialService).
 *
 * Replaces the legacy services/githubService.js storage (plaintext
 * user_integrations.github_token + base64(userId) state). The legacy
 * column is never read or written by application code any more; the
 * Layer 6 migration adds a trigger that rejects new plaintext writes and
 * scripts/migrate-legacy-github-tokens.js moves existing rows (encrypt →
 * null the column).
 *
 * Per-user connection ("user_connect"): stored as a GitHub integration named
 * "GitHub account (OAuth)" in the user's PERSONAL workspace
 * (config { authMethod: 'oauth', account: <login>, allowedRepos: [<login>/*] }).
 * Workspace connection ("workspace_connect", owner only): same integration
 * shape in that workspace, completed by an AUTHENTICATED request whose
 * caller must be the user the state was issued to.
 *
 * Tokens never appear in logs, responses, redirects, errors or audit rows.
 */
'use strict';

const { credentialFromTokenResponse } = require('../integrations/connectors/githubConnector');

const { WorkspaceError, hasRole } = require('../workspaceService');

const PERSONAL_NAME = 'GitHub account (OAuth)';
const WORKSPACE_NAME = 'GitHub (OAuth)';
const CODE_RE = /^[A-Za-z0-9_-]{8,100}$/;
const LOGIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

class GithubOAuthError extends Error {
  constructor(code, message, status = 400) { super(message); this.name = 'GithubOAuthError'; this.code = code; this.status = status; }
}

const GITHUB_ENDPOINTS = Object.freeze({
  authorize: 'https://github.com/login/oauth/authorize', token: 'https://github.com/login/oauth/access_token', user: 'https://api.github.com/user',
});

/**
 * `endpoints` is a TEST SEAM (like the connector's apiBase): production
 * always uses the real GitHub URLs.
 */
function createGithubOAuthClient({
  http, clientId = process.env.GITHUB_CLIENT_ID, clientSecret = process.env.GITHUB_CLIENT_SECRET, redirectUri = process.env.GITHUB_REDIRECT_URI,
  endpoints = GITHUB_ENDPOINTS,
} = {}) {
  const configured = !!(http && clientId && clientSecret && redirectUri);
  const hostOf = (u) => new URL(u).hostname;
  return {
    configured,
    authorizeUrl(state) {
      const u = new URL(endpoints.authorize);
      u.searchParams.set('client_id', clientId);
      u.searchParams.set('redirect_uri', redirectUri);
      u.searchParams.set('scope', 'repo read:user');
      u.searchParams.set('state', state);
      u.searchParams.set('allow_signup', 'false');
      return u.toString();
    },
    /** code → { token, login }. The client secret travels only in the POST body. */
    async exchange(code) {
      if (!configured) throw new GithubOAuthError('OAUTH_NOT_CONFIGURED', 'GitHub OAuth is not configured on this server.', 503);
      if (typeof code !== 'string' || !CODE_RE.test(code)) throw new GithubOAuthError('OAUTH_CODE_INVALID', 'Invalid authorization code.');
      let res;
      try {
        res = await http.request({
          url: endpoints.token, method: 'POST', allowedMethods: ['POST'], allowedHosts: [hostOf(endpoints.token)],
          headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': 'nexus-integrations' },
          body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code, redirect_uri: redirectUri }),
          timeoutMs: 15000, maxBytes: 16 * 1024,
        });
      } catch (e) { throw new GithubOAuthError('OAUTH_EXCHANGE_FAILED', 'Could not reach GitHub.', 502); }
      let data = null;
      try { data = JSON.parse(res.body); } catch { data = null; }
      // Layer 9: keep the refresh token + expiry of expiring (GitHub App) user tokens.
      const credential = res.status === 200 ? credentialFromTokenResponse(data) : null;
      const token = credential ? credential.token : null;
      if (res.status !== 200 || !token || !/^[A-Za-z0-9_]{20,255}$/.test(token)) {
        throw new GithubOAuthError('OAUTH_EXCHANGE_FAILED', 'GitHub did not issue a token for this authorization.', 502);
      }
      let me;
      try {
        me = await http.request({
          url: endpoints.user, method: 'GET', allowedHosts: [hostOf(endpoints.user)],
          headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'User-Agent': 'nexus-integrations', 'X-GitHub-Api-Version': '2022-11-28' },
          timeoutMs: 15000, maxBytes: 256 * 1024,
        });
      } catch { throw new GithubOAuthError('OAUTH_EXCHANGE_FAILED', 'Could not reach GitHub.', 502); }
      let login = null;
      try { login = JSON.parse(me.body).login; } catch { login = null; }
      if (me.status !== 200 || typeof login !== 'string' || !LOGIN_RE.test(login)) throw new GithubOAuthError('OAUTH_EXCHANGE_FAILED', 'Could not read the GitHub account.', 502);
      return { token, login, credential };
    },
  };
}

function createGithubAccountService({
  integrationService, integrationStore, credentials, workspaceService, oauthStates, oauthClient, events = null, logger = console,
} = {}) {
  if (!integrationService || !integrationStore || !credentials || !workspaceService || !oauthStates || !oauthClient) {
    throw new Error('github account service: missing dependencies');
  }
  const configured = () => oauthClient.configured && credentials.isConfigured();
  const requireConfigured = () => {
    if (!configured()) throw new GithubOAuthError('OAUTH_UNAVAILABLE', 'GitHub connection is not available on this server (OAuth or credential encryption is not configured).', 503);
  };

  async function findOAuthIntegration(workspaceId, name) {
    const all = await integrationStore.listIntegrations(workspaceId);
    return all.find((i) => i.provider === 'github' && i.name === name && i.config && i.config.authMethod === 'oauth') || null;
  }

  /** Store/replace the encrypted credential via the Layer 5 service (audited, CAS). */
  async function saveConnection(ctx, name, { token, login, credential }) {
    const secret = credential && credential.token === token ? credential : { token };
    const config = { allowedRepos: [`${login}/*`], authMethod: 'oauth', account: login };
    const existing = await findOAuthIntegration(ctx.workspace.id, name);
    let view;
    if (existing) {
      view = await integrationService.rotateCredential(ctx, existing.id, { credentials: secret });
      if (!existing.config || existing.config.account !== login) {
        view = await integrationService.updateIntegration(ctx, existing.id, { version: view.version, config });
      }
    } else {
      view = await integrationService.createIntegration(ctx, { provider: 'github', name, config, credentials: secret });
    }
    events && events.record(ctx.workspace.id, ctx.userId, 'oauth_connected', { provider: 'github', integrationId: view.id, account: login });
    return view;
  }

  // ---------------- per-user (legacy API contract) ----------------
  async function startUserConnect(uid) {
    requireConfigured();
    const ws = await workspaceService.ensurePersonalWorkspace(uid);
    const state = await oauthStates.create({ workspaceId: ws.id, userId: uid, provider: 'github', purpose: 'user_connect' });
    return oauthClient.authorizeUrl(state);
  }

  /** Public callback: the state (server-side, single-use) is the binding. */
  async function completeUserConnect({ code, state }) {
    requireConfigured();
    const b = await oauthStates.consume(state, { provider: 'github', purpose: 'user_connect' });
    const personal = await workspaceService.ensurePersonalWorkspace(b.userId);
    if (personal.id !== b.workspaceId) throw new GithubOAuthError('OAUTH_STATE_INVALID', 'The authorization request is invalid or has expired. Please start again.');
    const conn = await oauthClient.exchange(code);
    await saveConnection({ workspace: { id: personal.id }, role: 'owner', userId: b.userId }, PERSONAL_NAME, conn);
    return { username: conn.login, userId: b.userId };
  }

  async function status(uid) {
    const ws = await workspaceService.ensurePersonalWorkspace(uid);
    const i = await findOAuthIntegration(ws.id, PERSONAL_NAME);
    const connected = !!(i && i.status === 'connected');
    return { connected, username: connected ? i.config.account : null };
  }

  /** Decrypted token for SERVER-SIDE use only (never returned to a client). */
  async function getUserToken(uid) {
    const ws = await workspaceService.ensurePersonalWorkspace(uid);
    const i = await findOAuthIntegration(ws.id, PERSONAL_NAME);
    if (!i || i.status !== 'connected' || !credentials.isConfigured()) return null;
    try {
      const cred = await credentials.getCredentialForExecution({ workspaceId: ws.id, integrationId: i.id });
      return cred && cred.token ? { token: cred.token, username: i.config.account } : null;
    } catch {
      return null;
    }
  }

  async function disconnectUser(uid) {
    const ws = await workspaceService.ensurePersonalWorkspace(uid);
    const i = await findOAuthIntegration(ws.id, PERSONAL_NAME);
    if (!i) return { disconnected: false };
    await integrationService.disconnect({ workspace: { id: ws.id }, role: 'owner', userId: uid }, i.id);
    return { disconnected: true };
  }

  // ---------------- workspace connection (owner, authenticated completion) ----------------
  async function startWorkspaceConnect(ctx) {
    if (!ctx || !hasRole(ctx.role, 'owner') || ctx.apiKeyId) throw new WorkspaceError(403, 'FORBIDDEN', 'Only the workspace owner can connect an OAuth account.');
    requireConfigured();
    const state = await oauthStates.create({ workspaceId: ctx.workspace.id, userId: ctx.userId, provider: 'github', purpose: 'workspace_connect' });
    return { url: oauthClient.authorizeUrl(state) };
  }

  async function completeWorkspaceConnect(ctx, { code, state } = {}) {
    if (!ctx || !hasRole(ctx.role, 'owner') || ctx.apiKeyId) throw new WorkspaceError(403, 'FORBIDDEN', 'Only the workspace owner can connect an OAuth account.');
    requireConfigured();
    await oauthStates.consume(state, { provider: 'github', purpose: 'workspace_connect', userId: ctx.userId, workspaceId: ctx.workspace.id });
    const conn = await oauthClient.exchange(code);
    return saveConnection(ctx, WORKSPACE_NAME, conn);
  }

  return {
    configured, startUserConnect, completeUserConnect, status, getUserToken, disconnectUser,
    startWorkspaceConnect, completeWorkspaceConnect, PERSONAL_NAME, WORKSPACE_NAME,
  };
}

let defaultSvc = null;
/** Lazily-built production instance (Supabase stores, env key ring). */
function getDefaultGithubAccountService() {
  if (defaultSvc) return defaultSvc;
  const { createSupabaseWorkspaceStore } = require('../workspaceStore');
  const { createWorkspaceService } = require('../workspaceService');
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
  const events = createSecurityEvents({ appendAuditLog });
  defaultSvc = createGithubAccountService({
    integrationService: createIntegrationService({
      store: integrationStore, registry: createDefaultRegistry(), credentials, http, appendAuditLog,
      getMemberRole: async (ws, uid) => { const m = uid ? await wsStore.getMember(ws, uid) : null; return m ? m.role : null; },
    }),
    integrationStore,
    credentials,
    workspaceService: createWorkspaceService(wsStore),
    oauthStates: createOAuthStateService({ store: secStore, events, rateLimiter: createDbRateLimiter({ store: secStore }) }),
    oauthClient: createGithubOAuthClient({ http }),
    events,
  });
  return defaultSvc;
}
function setDefaultGithubAccountService(svc) { defaultSvc = svc; }

module.exports = {
  createGithubOAuthClient, createGithubAccountService, getDefaultGithubAccountService, setDefaultGithubAccountService,
  GithubOAuthError, PERSONAL_NAME, WORKSPACE_NAME,
};
