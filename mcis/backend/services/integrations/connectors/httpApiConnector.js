/**
 * Layer 5 — generic HTTP/API connector (provider "http").
 *
 * NOT an open proxy: every integration is pinned to ONE https base URL, an
 * explicit host allowlist and path prefixes chosen by a workspace admin.
 * Requests go through the SSRF-safe client (DNS pinning, private-address
 * blocking, redirect re-validation, timeout, size and content-type limits).
 *
 * Actions
 *   get        GET  <base><path>?query       GREEN, read-only, safe to retry, enabled by default
 *   post_json  POST <base><path> (JSON body) YELLOW, only if config.allowPost; disabled by default;
 *                                            safe to retry ONLY if the API honours an idempotency
 *                                            header named in config.idempotencyHeader
 * There is deliberately no PUT / PATCH / DELETE.
 *
 * Config (non-secret): baseUrl, allowedHosts?, allowedPathPrefixes?, allowPost?,
 *   postPathPrefixes?, idempotencyHeader?, authType (none|bearer|header|query),
 *   authQueryParam (Layer 9, authType "query": the key goes in this query
 *   parameter; the URL with the key is never logged, stored or returned and
 *   redirects are not followed so the key cannot be forwarded),
 *   authHeaderName?, timeoutMs?, maxResponseKb?
 * Credential (encrypted): { token }   — required unless authType is "none"
 */
'use strict';

const { validateInput, describeFields, InputError, ConnectorError } = require('./schema');
const { isInternalHostname } = require('../safeHttp');
const { redact } = require('../../../backend-routing/sensitiveDataFilter');

const HOST_RE = /^(\*\.)?([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const HEADER_RE = /^[A-Za-z][A-Za-z0-9-]{1,63}$/;
const FORBIDDEN_HEADERS = new Set(['host', 'cookie', 'set-cookie', 'content-length', 'transfer-encoding', 'connection', 'upgrade', 'te', 'trailer', 'expect', 'content-type', 'accept', 'user-agent']);
// Layer 10: caller-supplied request headers (validated in validateAction).
const HEADERS_FIELD = { type: 'object', stringValues: true, maxKeys: 10, description: 'Extra request headers (no auth, cookie or hop-by-hop headers)' };
const PATH_FIELD = { type: 'string', required: true, maxLength: 1000, pattern: /^\/(?!\/)[^\s?#\\]*$/, description: 'Path under the base URL, e.g. /v1/prices' };

const bad = (msg) => { throw new InputError(msg); };

function normalizePrefix(p, field) {
  if (typeof p !== 'string' || !/^\/[^\s?#\\]*$/.test(p) || p.includes('..') || p.length > 300) bad(`${field} entries must be absolute paths`);
  return p;
}

function validateConfig(raw = {}, { allowInsecureHttpForTests = false } = {}) {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) bad('config must be an object');
  const allowedKeys = ['baseUrl', 'allowedHosts', 'allowedPathPrefixes', 'allowPost', 'postPathPrefixes', 'idempotencyHeader', 'authType', 'authHeaderName', 'authQueryParam', 'timeoutMs', 'maxResponseKb'];
  for (const k of Object.keys(raw)) if (!allowedKeys.includes(k)) bad(`unknown config "${k}"`);
  let base;
  try { base = new URL(String(raw.baseUrl || '')); } catch { bad('config.baseUrl must be a valid https URL'); }
  const schemeOk = base.protocol === 'https:' || (allowInsecureHttpForTests && base.protocol === 'http:');
  if (!schemeOk || base.username || base.password || base.search || base.hash || (base.port && !allowInsecureHttpForTests)) {
    bad('config.baseUrl must be a plain https URL (no credentials, port, query or fragment)');
  }
  const baseHost = base.hostname.toLowerCase();
  if (!HOST_RE.test(baseHost) || isInternalHostname(baseHost)) bad('config.baseUrl must use a public DNS hostname');
  const basePath = base.pathname.endsWith('/') ? base.pathname : `${base.pathname}/`;
  const extraHosts = raw.allowedHosts === undefined ? [] : raw.allowedHosts;
  if (!Array.isArray(extraHosts) || extraHosts.length > 10) bad('config.allowedHosts must be a list of at most 10 hostnames');
  const hosts = [baseHost];
  for (const h of extraHosts) {
    const v = String(h).toLowerCase();
    if (!HOST_RE.test(v) || isInternalHostname(v.replace(/^\*\./, ''))) bad(`config.allowedHosts: "${h}" is not a public hostname`);
    if (!hosts.includes(v)) hosts.push(v);
  }
  const prefixes = raw.allowedPathPrefixes === undefined ? [basePath] : raw.allowedPathPrefixes;
  if (!Array.isArray(prefixes) || !prefixes.length || prefixes.length > 10) bad('config.allowedPathPrefixes must list 1-10 path prefixes');
  const allowPost = raw.allowPost === true;
  const postPrefixes = raw.postPathPrefixes === undefined ? prefixes : raw.postPathPrefixes;
  if (!Array.isArray(postPrefixes) || !postPrefixes.length || postPrefixes.length > 10) bad('config.postPathPrefixes must list 1-10 path prefixes');
  const authType = raw.authType === undefined ? 'none' : raw.authType;
  if (!['none', 'bearer', 'header', 'query'].includes(authType)) bad('config.authType must be none, bearer, header or query');
  let authQueryParam = null;
  if (authType === 'query') {
    authQueryParam = String(raw.authQueryParam || '');
    if (!/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(authQueryParam)) bad('config.authQueryParam must be a query parameter name such as api_key');
  }
  let authHeaderName = null;
  if (authType === 'header') {
    authHeaderName = String(raw.authHeaderName || '');
    if (!HEADER_RE.test(authHeaderName) || FORBIDDEN_HEADERS.has(authHeaderName.toLowerCase()) || authHeaderName.toLowerCase().startsWith('proxy-')) {
      bad('config.authHeaderName must be a custom header name such as X-API-Key');
    }
  }
  let idempotencyHeader = null;
  if (raw.idempotencyHeader !== undefined && raw.idempotencyHeader !== null && raw.idempotencyHeader !== '') {
    idempotencyHeader = String(raw.idempotencyHeader);
    if (!HEADER_RE.test(idempotencyHeader) || FORBIDDEN_HEADERS.has(idempotencyHeader.toLowerCase()) || ['authorization'].includes(idempotencyHeader.toLowerCase())) {
      bad('config.idempotencyHeader must be a header name such as Idempotency-Key');
    }
  }
  const timeoutMs = raw.timeoutMs === undefined ? 15000 : raw.timeoutMs;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 30000) bad('config.timeoutMs must be 1000-30000');
  const maxResponseKb = raw.maxResponseKb === undefined ? 512 : raw.maxResponseKb;
  if (!Number.isInteger(maxResponseKb) || maxResponseKb < 1 || maxResponseKb > 2048) bad('config.maxResponseKb must be 1-2048');
  return {
    baseUrl: `${base.origin}${basePath}`,
    allowedHosts: hosts,
    allowedPathPrefixes: prefixes.map((p) => normalizePrefix(p, 'config.allowedPathPrefixes')),
    allowPost,
    postPathPrefixes: postPrefixes.map((p) => normalizePrefix(p, 'config.postPathPrefixes')),
    idempotencyHeader,
    authType,
    authHeaderName,
    authQueryParam,
    timeoutMs,
    maxResponseKb,
  };
}

function validateCredential(raw, config) {
  if (config.authType === 'none') {
    if (raw && Object.keys(raw).length) bad('This integration uses no authentication; do not send a credential');
    return null;
  }
  if (!raw || typeof raw !== 'object' || typeof raw.token !== 'string' || !raw.token.trim() || raw.token.length > 4096 || /[\r\n]/.test(raw.token)) {
    bad('credentials.token is required (single line, at most 4096 characters)');
  }
  for (const k of Object.keys(raw)) if (k !== 'token') bad(`unknown credential field "${k}"`);
  return { token: raw.token.trim() };
}

function buildUrl(config, path, query, prefixes) {
  const base = new URL(config.baseUrl);
  const u = new URL(`${base.origin}${path}`); // path validated: starts with a single '/'
  if (u.origin !== base.origin) throw new InputError('path must stay on the configured base URL');
  if (!prefixes.some((p) => u.pathname.startsWith(p))) throw new InputError('path is outside the allowed path prefixes');
  for (const [k, v] of Object.entries(query || {})) {
    // Layer 9: a caller can never supply (or override) the credential parameter.
    if (config.authType === 'query' && k.toLowerCase() === String(config.authQueryParam).toLowerCase()) throw new InputError(`query parameter "${k}" is reserved`);
    u.searchParams.set(k, String(v));
  }
  return u;
}

/** Layer 9: the URL actually sent (credential added last, only here). */
function withQueryAuth(url, config, credential) {
  if (config.authType !== 'query') return url;
  const u = new URL(url);
  u.searchParams.set(config.authQueryParam, credential.token);
  return u.toString();
}

/**
 * Layer 10: extra headers from the step input. Never authentication,
 * cookies, proxy/forwarding or hop-by-hop headers, never the configured
 * auth / idempotency header, never CR/LF (header injection).
 */
function checkHeaders(headers, config) {
  if (headers === undefined || headers === null) return {};
  const out = {};
  const reserved = new Set([...FORBIDDEN_HEADERS, 'authorization', 'proxy-authorization', 'x-api-key', 'origin', 'referer',
    ...(config.authHeaderName ? [config.authHeaderName.toLowerCase()] : []), ...(config.idempotencyHeader ? [config.idempotencyHeader.toLowerCase()] : [])]);
  for (const [k, v] of Object.entries(headers)) {
    const lk = k.toLowerCase();
    if (!HEADER_RE.test(k) || reserved.has(lk) || lk.startsWith('proxy-') || lk.startsWith('x-forwarded-') || lk.startsWith('sec-')) throw new InputError(`header "${String(k).slice(0, 64)}" is not allowed`);
    if (typeof v !== 'string' || v.length > 500 || /[\r\n\0]/.test(v)) throw new InputError(`header "${k}" has an invalid value`);
    out[k] = v;
  }
  return out;
}

function authHeaders(config, credential) {
  if (config.authType === 'bearer') return { Authorization: `Bearer ${credential.token}` };
  if (config.authType === 'header') return { [config.authHeaderName]: credential.token };
  return {};
}

function parseBody(res) {
  if (res.contentType === 'application/json' || res.contentType.endsWith('+json')) {
    try { return JSON.parse(res.body || 'null'); } catch { return res.body.slice(0, 2000); }
  }
  return res.body.length > 20000 ? `${res.body.slice(0, 20000)}…` : res.body;
}

function statusError(status, authed) {
  if ((status === 401 || status === 403) && authed) return new ConnectorError('AUTH_FAILED', `The API rejected the credential (HTTP ${status})`, { authFailed: status === 401 });
  if (status === 429) return new ConnectorError('RATE_LIMITED', 'The API rate limit was reached (HTTP 429)', { retryable: true });
  if (status >= 500) return new ConnectorError('PROVIDER_ERROR', `The API returned HTTP ${status}`, { retryable: true });
  return new ConnectorError(`HTTP_${status}`, `The API returned HTTP ${status}`);
}

const ACTIONS = {
  get: {
    label: 'GET request',
    description: 'Read data from an allowed path of this API.',
    risk: 'green',
    readOnly: true,
    safeToRepeat: () => true,
    defaultEnabled: true,
    permission: 'http:read',
    fields: {
      path: PATH_FIELD,
      query: { type: 'object', stringValues: true, maxKeys: 20, description: 'Query parameters' },
      headers: HEADERS_FIELD,
    },
    output: '{ status, contentType, data }',
    timeoutMs: 15000,
    retry: 'Safe to retry (read-only).',
  },
  post_json: {
    label: 'POST JSON',
    description: 'Send a JSON body to an allowed path. Only available when the admin enabled POST for this API.',
    risk: 'yellow',
    readOnly: false,
    safeToRepeat: (config) => !!config.idempotencyHeader,
    defaultEnabled: false,
    permission: 'http:write',
    available: (config) => config.allowPost,
    fields: {
      path: PATH_FIELD,
      body: { type: 'object', required: true, maxBytes: 16384, description: 'JSON object body' },
      headers: HEADERS_FIELD,
    },
    output: '{ status, contentType, data }',
    timeoutMs: 15000,
    retry: 'Never retried automatically unless the API supports the configured idempotency header.',
  },
};

/**
 * `allowInsecureHttpForTests` exists ONLY so the test suite can exercise the
 * network path against a local http server; production wiring never sets it.
 */
function createHttpApiConnector({ allowInsecureHttpForTests = false } = {}) {
  const vc = (raw) => validateConfig(raw, { allowInsecureHttpForTests });
  return {
    provider: 'http',
    displayName: 'HTTP / REST API',
    description: 'Call one approved HTTPS API (GET; optional controlled POST).',
    credentialFields: [{ name: 'token', label: 'API token (if the API needs one)', secret: true }],
    actions: ACTIONS,
    validateConfig: vc,
    validateCredential,
    requiresCredential: (config) => config.authType !== 'none',

    connect({ config, credential }) {
      return { config: vc(config), credential: validateCredential(credential, vc(config)) };
    },
    disconnect() { /* token-based: nothing to revoke at the provider */ },

    validateAction(action, input, config) {
      const a = ACTIONS[action];
      if (!a || (a.available && !a.available(config))) throw new InputError(`Action "${action}" is not available for this integration`);
      const v = validateInput(a.fields, input);
      buildUrl(config, v.path, v.query, action === 'post_json' ? config.postPathPrefixes : config.allowedPathPrefixes);
      checkHeaders(v.headers, config);
      return v;
    },

    describeTarget(action, input, config) {
      const u = buildUrl(config, input.path, null, action === 'post_json' ? config.postPathPrefixes : config.allowedPathPrefixes);
      return `${action === 'post_json' ? 'POST' : 'GET'} ${u.host}${u.pathname}`;
    },

    async healthCheck({ config, credential, http }) {
      // A GET of the base URL: proves DNS/TLS/allowlist and (if any) auth.
      const res = await http.request({
        url: withQueryAuth(config.baseUrl, config, credential || {}), method: 'GET', headers: { Accept: 'application/json, text/plain;q=0.8', ...authHeaders(config, credential || {}) },
        allowedHosts: config.allowedHosts, allowedMethods: ['GET'], timeoutMs: config.timeoutMs, maxBytes: config.maxResponseKb * 1024,
        ...(config.authType === 'query' ? { maxRedirects: 0 } : {}),
      });
      if ((res.status === 401 || res.status === 403) && config.authType !== 'none') throw statusError(res.status, true);
      return { ok: res.status < 500, detail: `HTTP ${res.status}` };
    },

    async execute({ action, input, config, credential, http, idempotencyKey }) {
      const isPost = action === 'post_json';
      const u = buildUrl(config, input.path, input.query, isPost ? config.postPathPrefixes : config.allowedPathPrefixes);
      const headers = { ...checkHeaders(input.headers, config), Accept: 'application/json, text/plain;q=0.8', 'User-Agent': 'nexus-mcis-connector', ...authHeaders(config, credential || {}) };
      let body;
      if (isPost) {
        headers['Content-Type'] = 'application/json';
        if (config.idempotencyHeader && idempotencyKey) headers[config.idempotencyHeader] = idempotencyKey;
        body = JSON.stringify(input.body);
      }
      const res = await http.request({
        url: withQueryAuth(u.toString(), config, credential || {}), method: isPost ? 'POST' : 'GET', headers, body,
        ...(config.authType === 'query' ? { maxRedirects: 0 } : {}),
        allowedHosts: config.allowedHosts, allowedMethods: isPost ? ['POST'] : ['GET'],
        timeoutMs: config.timeoutMs, maxBytes: config.maxResponseKb * 1024,
        allowedContentTypes: ['application/json', 'application/problem+json', 'text/*', 'application/xml'],
      });
      if (res.status < 200 || res.status >= 300) throw statusError(res.status, config.authType !== 'none');
      return {
        data: { status: res.status, contentType: res.contentType, data: parseBody(res) },
        summary: `HTTP ${res.status} from ${u.host}${u.pathname}`,
        verified: true, // the provider acknowledged the request with a 2xx
      };
    },

    redactResult(data) {
      return redact(data);
    },
  };
}

module.exports = { createHttpApiConnector, validateConfig, checkHeaders };
