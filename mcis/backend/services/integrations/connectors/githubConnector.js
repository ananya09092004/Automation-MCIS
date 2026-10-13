/**
 * Layer 5 — GitHub connector (provider "github"), GitHub REST API v2022-11-28.
 *
 * Auth: a fine-grained or classic personal access token stored encrypted
 * (credential { token }). Every call goes to https://api.github.com through
 * the SSRF-safe client. Repositories are limited to the admin-configured
 * allowlist (config.allowedRepos: "owner/repo" or "owner/*").
 *
 * Actions                     risk    retry                       default
 *   get_repository            GREEN   safe (read-only)            enabled
 *   list_issues               GREEN   safe                        enabled
 *   list_pull_requests        GREEN   safe                        enabled
 *   read_file                 GREEN   safe                        enabled
 *   create_issue              YELLOW  NEVER (not idempotent)      disabled until an admin enables it
 *   comment_on_issue          YELLOW  NEVER (not idempotent)      disabled until an admin enables it
 * Merging, closing, deleting, pushing are deliberately not implemented.
 */
'use strict';

const { validateInput, InputError, ConnectorError } = require('./schema');
const { redact } = require('../../../backend-routing/sensitiveDataFilter');

const API = 'https://api.github.com';
const OWNER = { type: 'string', required: true, maxLength: 39, pattern: /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/, description: 'Repository owner' };
const REPO = { type: 'string', required: true, maxLength: 100, pattern: /^(?!\.\.?$)[A-Za-z0-9._-]{1,100}$/, description: 'Repository name' };
const LIMIT = { type: 'integer', min: 1, max: 50, default: 20, description: 'Maximum items' };
const STATE = { type: 'enum', options: ['open', 'closed', 'all'], default: 'open' };
const MAX_FILE_BYTES = 100 * 1024;

const bad = (m) => { throw new InputError(m); };

function validateConfig(raw = {}) {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) bad('config must be an object');
  for (const k of Object.keys(raw)) if (!['allowedRepos', 'authMethod', 'account'].includes(k)) bad(`unknown config "${k}"`);
  // Layer 6: integrations connected through GitHub OAuth record how they
  // were authorized and the (public) account login — never the token.
  const extra = {};
  if (raw.authMethod !== undefined) {
    if (!['token', 'oauth'].includes(raw.authMethod)) bad('config.authMethod must be token or oauth');
    extra.authMethod = raw.authMethod;
  }
  if (raw.account !== undefined) {
    if (typeof raw.account !== 'string' || !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(raw.account)) bad('config.account must be a GitHub login');
    extra.account = raw.account;
  }
  const repos = raw.allowedRepos;
  if (!Array.isArray(repos) || !repos.length || repos.length > 50) bad('config.allowedRepos must list 1-50 repositories ("owner/repo" or "owner/*")');
  const out = [];
  for (const r of repos) {
    const m = String(r).match(/^([A-Za-z0-9][A-Za-z0-9-]{0,38})\/(\*|(?!\.\.?$)[A-Za-z0-9._-]{1,100})$/);
    if (!m) bad(`config.allowedRepos: "${r}" must look like owner/repo or owner/*`);
    out.push(`${m[1].toLowerCase()}/${m[2].toLowerCase()}`);
  }
  return { allowedRepos: [...new Set(out)], ...extra };
}

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

/**
 * { token } — plus, for GitHub App user tokens that EXPIRE (Layer 9):
 * { refreshToken, expiresAt, refreshTokenExpiresAt } (ISO times). All of it
 * is stored encrypted and never returned.
 */
function validateCredential(raw) {
  if (!raw || typeof raw !== 'object' || typeof raw.token !== 'string') bad('credentials.token is required');
  for (const k of Object.keys(raw)) if (!['token', 'refreshToken', 'expiresAt', 'refreshTokenExpiresAt'].includes(k)) bad(`unknown credential field "${k}"`);
  const t = raw.token.trim();
  if (!/^[A-Za-z0-9_]{20,255}$/.test(t)) bad('credentials.token does not look like a GitHub token');
  const out = { token: t };
  if (raw.refreshToken !== undefined) {
    if (typeof raw.refreshToken !== 'string' || !/^[A-Za-z0-9_]{20,255}$/.test(raw.refreshToken.trim())) bad('credentials.refreshToken does not look like a GitHub refresh token');
    out.refreshToken = raw.refreshToken.trim();
  }
  for (const k of ['expiresAt', 'refreshTokenExpiresAt']) {
    if (raw[k] === undefined) continue;
    if (typeof raw[k] !== 'string' || !ISO_RE.test(raw[k]) || Number.isNaN(Date.parse(raw[k]))) bad(`credentials.${k} must be an ISO time`);
    out[k] = raw[k];
  }
  if (out.expiresAt && !out.refreshToken) bad('credentials.expiresAt requires a refreshToken');
  return out;
}

/** GitHub's token endpoint response → credential (shared by exchange and refresh). */
function credentialFromTokenResponse(data, now = Date.now()) {
  const token = data && typeof data.access_token === 'string' ? data.access_token : null;
  if (!token || !/^[A-Za-z0-9_]{20,255}$/.test(token)) return null;
  const cred = { token };
  if (typeof data.refresh_token === 'string' && /^[A-Za-z0-9_]{20,255}$/.test(data.refresh_token)) {
    cred.refreshToken = data.refresh_token;
    if (Number.isInteger(data.expires_in) && data.expires_in > 0) cred.expiresAt = new Date(now + data.expires_in * 1000).toISOString();
    if (Number.isInteger(data.refresh_token_expires_in) && data.refresh_token_expires_in > 0) cred.refreshTokenExpiresAt = new Date(now + data.refresh_token_expires_in * 1000).toISOString();
  }
  return cred;
}

function repoAllowed(config, owner, repo) {
  const o = owner.toLowerCase();
  const r = repo.toLowerCase();
  return config.allowedRepos.some((e) => e === `${o}/${r}` || e === `${o}/*`);
}

const ACTIONS = {
  get_repository: {
    label: 'Read repository', description: 'Repository metadata.', risk: 'green', readOnly: true, defaultEnabled: true,
    permission: 'github:repo:read', fields: { owner: OWNER, repo: REPO },
    output: '{ full_name, private, default_branch, description, open_issues_count, html_url, updated_at }',
  },
  list_issues: {
    label: 'List issues', description: 'Issues (pull requests excluded).', risk: 'green', readOnly: true, defaultEnabled: true,
    permission: 'github:issues:read', fields: { owner: OWNER, repo: REPO, state: STATE, limit: LIMIT },
    output: '{ count, items: [{ number, title, state, html_url, user, created_at }] }',
  },
  list_pull_requests: {
    label: 'List pull requests', description: 'Pull requests.', risk: 'green', readOnly: true, defaultEnabled: true,
    permission: 'github:pulls:read', fields: { owner: OWNER, repo: REPO, state: STATE, limit: LIMIT },
    output: '{ count, items: [{ number, title, state, draft, html_url, user, created_at }] }',
  },
  read_file: {
    label: 'Read file', description: 'Text content of one file (max 100 KB).', risk: 'green', readOnly: true, defaultEnabled: true,
    permission: 'github:contents:read',
    fields: {
      owner: OWNER, repo: REPO,
      path: { type: 'string', required: true, maxLength: 500, pattern: /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[^\0\\?#]+$/, description: 'File path in the repository' },
      ref: { type: 'string', maxLength: 200, pattern: /^[A-Za-z0-9._/-]{1,200}$/, description: 'Branch, tag or commit (optional)' },
    },
    output: '{ path, size, sha, content, truncated }',
  },
  create_issue: {
    label: 'Create issue', description: 'Open a new issue.', risk: 'yellow', readOnly: false, defaultEnabled: false,
    permission: 'github:issues:write',
    fields: { owner: OWNER, repo: REPO, title: { type: 'string', required: true, maxLength: 256 }, body: { type: 'string', maxLength: 10000 } },
    output: '{ number, title, html_url }',
  },
  comment_on_issue: {
    label: 'Comment on issue', description: 'Add a comment to an issue or pull request.', risk: 'yellow', readOnly: false, defaultEnabled: false,
    permission: 'github:issues:write',
    fields: { owner: OWNER, repo: REPO, issue_number: { type: 'integer', required: true, min: 1, max: 100000000 }, body: { type: 'string', required: true, maxLength: 10000 } },
    output: '{ id, html_url }',
  },
};
for (const a of Object.values(ACTIONS)) {
  a.safeToRepeat = () => a.readOnly; // GitHub has no idempotency keys for these writes
  a.timeoutMs = 15000;
  a.retry = a.readOnly ? 'Safe to retry (read-only).' : 'Never retried automatically (not idempotent).';
}

function statusError(res) {
  const s = res.status;
  if (s === 401) return new ConnectorError('AUTH_FAILED', 'GitHub rejected the token (HTTP 401)', { authFailed: true });
  if (s === 403 && res.headers && res.headers['x-ratelimit-remaining'] === '0') return new ConnectorError('RATE_LIMITED', 'GitHub rate limit reached', { retryable: true });
  if (s === 429) return new ConnectorError('RATE_LIMITED', 'GitHub rate limit reached', { retryable: true });
  if (s === 403) return new ConnectorError('FORBIDDEN', 'The token lacks permission for this repository or action (HTTP 403)');
  if (s === 404) return new ConnectorError('NOT_FOUND', 'Repository, issue or file not found, or not visible to this token (HTTP 404)');
  if (s === 422) return new ConnectorError('VALIDATION_FAILED', 'GitHub rejected the request as invalid (HTTP 422)');
  if (s >= 500) return new ConnectorError('PROVIDER_ERROR', `GitHub returned HTTP ${s}`, { retryable: true });
  return new ConnectorError(`HTTP_${s}`, `GitHub returned HTTP ${s}`);
}

function user(u) {
  return u && typeof u === 'object' ? u.login || null : null;
}

async function call(http, api, credential, method, path, body) {
  const headers = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'nexus-mcis-connector',
  };
  if (credential && credential.token) headers.Authorization = `Bearer ${credential.token}`;
  let payload;
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await http.request({
    url: `${api.base}${path}`, method, headers, body: payload,
    allowedHosts: [api.host], allowedMethods: [method], timeoutMs: 15000, maxBytes: 2 * 1024 * 1024,
    allowedContentTypes: ['application/json'],
  });
  if (res.status < 200 || res.status >= 300) throw statusError(res);
  try {
    return JSON.parse(res.body);
  } catch {
    throw new ConnectorError('INVALID_RESPONSE', 'GitHub returned an unreadable response');
  }
}

const enc = encodeURIComponent;
const repoPath = (i) => `/repos/${enc(i.owner)}/${enc(i.repo)}`;

/**
 * The API base is fixed to https://api.github.com. The `apiBase` factory
 * argument exists ONLY so the test suite can point the connector at a
 * local GitHub API double; production wiring never passes it.
 */
const TOKEN_URL = 'https://github.com/login/oauth/access_token';

/**
 * `oauthRefresh` (Layer 9): { clientId, clientSecret, tokenUrl? } — only
 * needed for expiring GitHub App user tokens. tokenUrl is a TEST SEAM.
 */
function createGithubConnector({ apiBase = API, oauthRefresh = null } = {}) {
  const api = { base: apiBase.replace(/\/$/, ''), host: new URL(apiBase).hostname };
  return {
    provider: 'github',
    displayName: 'GitHub',
    description: 'Read repositories, issues, pull requests and files; optionally open issues and comments.',
    credentialFields: [{ name: 'token', label: 'Personal access token (fine-grained recommended)', secret: true }],
    actions: ACTIONS,
    validateConfig,
    validateCredential: (raw) => validateCredential(raw),
    requiresCredential: () => true,

    /**
     * Layer 9: exchange a refresh token for a new access token (GitHub
     * rotates the refresh token too; the old one stops working). Uses the
     * SSRF-safe client; the client secret travels only in the POST body.
     */
    async refreshCredential({ credential, http }) {
      if (!credential || !credential.refreshToken) throw new ConnectorError('AUTH_FAILED', 'The GitHub connection has expired; reconnect it.', { authFailed: true });
      if (credential.refreshTokenExpiresAt && Date.parse(credential.refreshTokenExpiresAt) <= Date.now()) {
        throw new ConnectorError('AUTH_FAILED', 'The GitHub connection has expired; reconnect it.', { authFailed: true });
      }
      if (!oauthRefresh || !oauthRefresh.clientId || !oauthRefresh.clientSecret) {
        throw new ConnectorError('AUTH_FAILED', 'GitHub OAuth is not configured on this server, so the connection cannot be refreshed.', { authFailed: true });
      }
      const url = oauthRefresh.tokenUrl || TOKEN_URL;
      let res;
      try {
        res = await http.request({
          url, method: 'POST', allowedMethods: ['POST'], allowedHosts: [new URL(url).hostname],
          headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': 'nexus-integrations' },
          body: JSON.stringify({ client_id: oauthRefresh.clientId, client_secret: oauthRefresh.clientSecret, grant_type: 'refresh_token', refresh_token: credential.refreshToken }),
          timeoutMs: 15000, maxBytes: 16 * 1024,
        });
      } catch { throw new ConnectorError('PROVIDER_ERROR', 'Could not reach GitHub to refresh the connection.', { retryable: true }); }
      let data = null;
      try { data = JSON.parse(res.body); } catch { data = null; }
      const fresh = res.status === 200 ? credentialFromTokenResponse(data) : null;
      if (!fresh) throw new ConnectorError('AUTH_FAILED', 'GitHub refused to refresh the connection; reconnect it.', { authFailed: true });
      return fresh;
    },

    connect({ config, credential }) {
      return { config: validateConfig(config), credential: validateCredential(credential) };
    },
    disconnect() { /* PATs are revoked by the owner on github.com; we delete our encrypted copy */ },

    validateAction(action, input, config) {
      const a = ACTIONS[action];
      if (!a) throw new InputError(`Action "${action}" is not available for this integration`);
      const v = validateInput(a.fields, input);
      if (!repoAllowed(config, v.owner, v.repo)) throw new InputError(`Repository ${v.owner}/${v.repo} is not on this integration's allowlist`);
      return v;
    },

    describeTarget(action, input) {
      const base = `github:${input.owner}/${input.repo}`;
      if (action === 'read_file') return `${base}:${input.path}`;
      if (action === 'comment_on_issue') return `${base}#${input.issue_number}`;
      return base;
    },

    async healthCheck({ credential, http }) {
      const me = await call(http, api, credential, 'GET', '/user');
      return { ok: true, detail: `authenticated as ${me && me.login ? me.login : 'a GitHub account'}` };
    },

    async execute({ action, input, credential, http }) {
      const rp = repoPath(input);
      switch (action) {
        case 'get_repository': {
          const r = await call(http, api, credential, 'GET', rp);
          return {
            data: { full_name: r.full_name, private: !!r.private, default_branch: r.default_branch, description: r.description || null,
              open_issues_count: r.open_issues_count, html_url: r.html_url, updated_at: r.updated_at },
            summary: `Read repository ${r.full_name}`, verified: true,
          };
        }
        case 'list_issues': {
          const rows = await call(http, api, credential, 'GET', `${rp}/issues?state=${input.state}&per_page=${input.limit}`);
          const items = (Array.isArray(rows) ? rows : []).filter((i) => !i.pull_request).map((i) => ({
            number: i.number, title: i.title, state: i.state, html_url: i.html_url, user: user(i.user), created_at: i.created_at,
          }));
          return { data: { count: items.length, items }, summary: `${items.length} issue(s) in ${input.owner}/${input.repo}`, verified: true };
        }
        case 'list_pull_requests': {
          const rows = await call(http, api, credential, 'GET', `${rp}/pulls?state=${input.state}&per_page=${input.limit}`);
          const items = (Array.isArray(rows) ? rows : []).map((p) => ({
            number: p.number, title: p.title, state: p.state, draft: !!p.draft, html_url: p.html_url, user: user(p.user), created_at: p.created_at,
          }));
          return { data: { count: items.length, items }, summary: `${items.length} pull request(s) in ${input.owner}/${input.repo}`, verified: true };
        }
        case 'read_file': {
          const path = input.path.split('/').map(enc).join('/');
          const f = await call(http, api, credential, 'GET', `${rp}/contents/${path}${input.ref ? `?ref=${enc(input.ref)}` : ''}`);
          if (!f || Array.isArray(f) || f.type !== 'file') throw new ConnectorError('NOT_A_FILE', 'The path is not a file');
          if (f.encoding !== 'base64' || typeof f.content !== 'string') throw new ConnectorError('UNSUPPORTED_FILE', 'The file content is not available through the contents API');
          const buf = Buffer.from(f.content, 'base64');
          const truncated = buf.length > MAX_FILE_BYTES;
          return {
            data: { path: f.path, size: f.size, sha: f.sha, content: buf.subarray(0, MAX_FILE_BYTES).toString('utf8'), truncated },
            summary: `Read ${f.path} (${f.size} bytes)`, verified: true,
          };
        }
        case 'create_issue': {
          const i = await call(http, api, credential, 'POST', `${rp}/issues`, { title: input.title, ...(input.body ? { body: input.body } : {}) });
          if (!i || !Number.isInteger(i.number)) throw new ConnectorError('INVALID_RESPONSE', 'GitHub did not confirm the new issue');
          return { data: { number: i.number, title: i.title, html_url: i.html_url }, summary: `Created issue #${i.number}`, verified: true };
        }
        case 'comment_on_issue': {
          const c = await call(http, api, credential, 'POST', `${rp}/issues/${input.issue_number}/comments`, { body: input.body });
          if (!c || !c.id) throw new ConnectorError('INVALID_RESPONSE', 'GitHub did not confirm the comment');
          return { data: { id: c.id, html_url: c.html_url }, summary: `Commented on #${input.issue_number}`, verified: true };
        }
        default:
          throw new InputError(`Action "${action}" is not available`);
      }
    },

    redactResult(data) {
      return redact(data);
    },
  };
}

module.exports = { createGithubConnector, validateConfig, validateCredential, credentialFromTokenResponse, API, TOKEN_URL };
