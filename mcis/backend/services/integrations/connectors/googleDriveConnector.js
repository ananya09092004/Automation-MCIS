/**
 * Layer 9 — Google Drive connector (provider "google_drive"), Drive API v3.
 * READ-ONLY. Off unless GOOGLE_DRIVE_ENABLED=true.
 *
 * Auth: an OAuth 2.0 access token (scope drive.readonly or drive.file) and,
 * normally, a refresh token — credential { token, refreshToken?, expiresAt? },
 * stored encrypted by Layer 5 and refreshed through Google's token endpoint
 * shortly before it expires (integrationService.loadCredential). Every call
 * goes through the SSRF-safe client to www.googleapis.com only.
 *
 * Scope control: the admin lists the Drive folder ids the integration may
 * touch (config.allowedFolders). list_files only lists those folders;
 * get_file / read_text first read the file's metadata and refuse any file
 * whose parent is not on the allowlist.
 *
 * Actions        risk    retry                 default
 *   list_files   GREEN   safe (read-only)      enabled
 *   get_file     GREEN   safe                  enabled
 *   read_text    GREEN   safe                  enabled
 * Upload, edit, share, move and delete are deliberately not implemented.
 *
 * Like every connector it is reached only through the Layer 5 gateway, so
 * the Layer 6 firewall, action enablement, approvals, metering (Layer 7)
 * and evidence apply unchanged. File contents are untrusted DATA for the
 * planner (Layer 6 prompt-injection classifier).
 */
'use strict';

const { validateInput, InputError, ConnectorError } = require('./schema');
const { redact } = require('../../../backend-routing/sensitiveDataFilter');

const API = 'https://www.googleapis.com';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const MAX_TEXT_BYTES = 100 * 1024;
const ID_RE = /^[A-Za-z0-9_-]{10,128}$/;
const FOLDER_RE = /^(?:root|[A-Za-z0-9_-]{10,128})$/;
// Google access tokens ("ya29.…") and refresh tokens ("1//…") are opaque.
const TOKEN_RE = /^[A-Za-z0-9._~+/-]{20,2048}$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

const TEXT_TYPES = ['text/plain', 'text/csv', 'text/markdown', 'text/tab-separated-values', 'application/json'];
const EXPORTS = {
  'application/vnd.google-apps.document': 'text/plain',
  'application/vnd.google-apps.spreadsheet': 'text/csv',
  'application/vnd.google-apps.presentation': 'text/plain',
};

const bad = (m) => { throw new InputError(m); };

function validateConfig(raw = {}) {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) bad('config must be an object');
  for (const k of Object.keys(raw)) if (!['allowedFolders', 'authMethod', 'account'].includes(k)) bad(`unknown config "${k}"`);
  const out = {};
  const f = raw.allowedFolders;
  if (!Array.isArray(f) || !f.length || f.length > 50) bad('config.allowedFolders must list 1-50 Drive folder ids ("root" = My Drive)');
  for (const id of f) if (typeof id !== 'string' || !FOLDER_RE.test(id)) bad(`config.allowedFolders: "${String(id).slice(0, 40)}" is not a Drive folder id`);
  out.allowedFolders = [...new Set(f)];
  if (raw.authMethod !== undefined) {
    if (!['token', 'oauth'].includes(raw.authMethod)) bad('config.authMethod must be token or oauth');
    out.authMethod = raw.authMethod;
  }
  if (raw.account !== undefined) {
    if (typeof raw.account !== 'string' || raw.account.length > 254 || !/^[^\s@]+@[^\s@]+$/.test(raw.account)) bad('config.account must be an e-mail address');
    out.account = raw.account;
  }
  return out;
}

function validateCredential(raw) {
  if (!raw || typeof raw !== 'object' || typeof raw.token !== 'string') bad('credentials.token is required');
  for (const k of Object.keys(raw)) if (!['token', 'refreshToken', 'expiresAt'].includes(k)) bad(`unknown credential field "${k}"`);
  const token = raw.token.trim();
  if (!TOKEN_RE.test(token)) bad('credentials.token does not look like a Google access token');
  const out = { token };
  if (raw.refreshToken !== undefined) {
    if (typeof raw.refreshToken !== 'string' || !TOKEN_RE.test(raw.refreshToken.trim())) bad('credentials.refreshToken does not look like a Google refresh token');
    out.refreshToken = raw.refreshToken.trim();
  }
  if (raw.expiresAt !== undefined) {
    if (typeof raw.expiresAt !== 'string' || !ISO_RE.test(raw.expiresAt) || Number.isNaN(Date.parse(raw.expiresAt))) bad('credentials.expiresAt must be an ISO time');
    out.expiresAt = raw.expiresAt;
  }
  return out;
}

/**
 * Google's token response → credential. Google normally does NOT return a
 * new refresh token on refresh, so the previous one is kept.
 */
function credentialFromTokenResponse(data, previousRefreshToken = null, now = Date.now()) {
  const token = data && typeof data.access_token === 'string' ? data.access_token : null;
  if (!token || !TOKEN_RE.test(token)) return null;
  const cred = { token };
  const rt = typeof data.refresh_token === 'string' && TOKEN_RE.test(data.refresh_token) ? data.refresh_token : previousRefreshToken;
  if (rt) cred.refreshToken = rt;
  if (Number.isInteger(data.expires_in) && data.expires_in > 0 && rt) cred.expiresAt = new Date(now + data.expires_in * 1000).toISOString();
  return cred;
}

const FILE_ID = { type: 'string', required: true, maxLength: 128, pattern: ID_RE, description: 'Drive file id' };
const ACTIONS = {
  list_files: {
    label: 'List files', description: 'Files in one allowed folder (not trashed).', risk: 'green', readOnly: true, defaultEnabled: true,
    permission: 'drive:files:read',
    fields: {
      folder_id: { type: 'string', required: true, maxLength: 128, pattern: FOLDER_RE, description: 'Folder id (must be on the allowlist)' },
      name_contains: { type: 'string', maxLength: 100, pattern: /^[^'\\\0\n\r]{1,100}$/, description: 'Only files whose name contains this text' },
      limit: { type: 'integer', min: 1, max: 100, default: 25, description: 'Maximum files' },
    },
    output: '{ count, items: [{ id, name, mimeType, size, modifiedTime, webViewLink }] }',
  },
  get_file: {
    label: 'Get file details', description: 'Metadata of one file in an allowed folder.', risk: 'green', readOnly: true, defaultEnabled: true,
    permission: 'drive:files:read', fields: { file_id: FILE_ID },
    output: '{ id, name, mimeType, size, modifiedTime, webViewLink }',
  },
  read_text: {
    label: 'Read file text', description: 'Text of a Google Doc / Sheet (CSV) / Slides or a plain-text file (max 100 KB).', risk: 'green', readOnly: true, defaultEnabled: true,
    permission: 'drive:files:read', fields: { file_id: FILE_ID },
    output: '{ id, name, mimeType, content, truncated }',
  },
};
for (const a of Object.values(ACTIONS)) {
  a.safeToRepeat = () => true;
  a.timeoutMs = 15000;
  a.retry = 'Safe to retry (read-only).';
}

function statusError(res) {
  const s = res.status;
  if (s === 401) return new ConnectorError('AUTH_FAILED', 'Google rejected the token (HTTP 401)', { authFailed: true });
  if (s === 429) return new ConnectorError('RATE_LIMITED', 'Google Drive rate limit reached', { retryable: true });
  if (s === 403) return new ConnectorError('FORBIDDEN', 'The token lacks permission for this file or the Drive quota is exhausted (HTTP 403)');
  if (s === 404) return new ConnectorError('NOT_FOUND', 'File or folder not found, or not visible to this account (HTTP 404)');
  if (s >= 500) return new ConnectorError('PROVIDER_ERROR', `Google Drive returned HTTP ${s}`, { retryable: true });
  return new ConnectorError(`HTTP_${s}`, `Google Drive returned HTTP ${s}`);
}

const FILE_FIELDS = 'id,name,mimeType,size,modifiedTime,webViewLink,parents,trashed';
const pickFile = (f) => ({
  id: f.id, name: f.name, mimeType: f.mimeType, size: f.size !== undefined ? Number(f.size) : null,
  modifiedTime: f.modifiedTime || null, webViewLink: f.webViewLink || null,
});

/**
 * `apiBase` and `oauth.tokenUrl` are TEST SEAMS for the local Drive double;
 * production wiring never passes them.
 */
function createGoogleDriveConnector({ apiBase = API, oauth = null } = {}) {
  const api = { base: apiBase.replace(/\/$/, ''), host: new URL(apiBase).hostname };

  async function call(http, credential, path, { json = true, maxBytes = 2 * 1024 * 1024 } = {}) {
    const headers = { Accept: json ? 'application/json' : '*/*', 'User-Agent': 'nexus-integrations' };
    if (credential && credential.token) headers.Authorization = `Bearer ${credential.token}`;
    let res;
    try {
      res = await http.request({
        url: `${api.base}${path}`, method: 'GET', headers, allowedHosts: [api.host], allowedMethods: ['GET'],
        timeoutMs: 15000, maxBytes, maxRedirects: 0,
        ...(json ? { allowedContentTypes: ['application/json'] } : {}),
      });
    } catch (e) {
      if (e && e.code === 'RESPONSE_TOO_LARGE') throw new ConnectorError('FILE_TOO_LARGE', 'The file is larger than this connector reads');
      throw e;
    }
    if (res.status < 200 || res.status >= 300) throw statusError(res);
    if (!json) return res;
    try { return JSON.parse(res.body); } catch { throw new ConnectorError('INVALID_RESPONSE', 'Google Drive returned an unreadable response'); }
  }

  async function allowedFile(http, credential, config, fileId) {
    const f = await call(http, credential, `/drive/v3/files/${encodeURIComponent(fileId)}?fields=${encodeURIComponent(FILE_FIELDS)}&supportsAllDrives=true`);
    if (!f || f.id !== fileId) throw new ConnectorError('INVALID_RESPONSE', 'Google Drive returned a different file');
    if (f.trashed) throw new ConnectorError('NOT_FOUND', 'The file is in the trash');
    const parents = Array.isArray(f.parents) ? f.parents : [];
    // "root" on the allowlist means files directly in My Drive; Drive reports
    // the real root id, so that case needs the account's root id.
    let ok = parents.some((p) => config.allowedFolders.includes(p));
    if (!ok && config.allowedFolders.includes('root') && parents.length) {
      const root = await call(http, credential, '/drive/v3/files/root?fields=id');
      ok = !!(root && parents.includes(root.id));
    }
    if (!ok) throw new ConnectorError('FORBIDDEN_RESOURCE', 'The file is not in a folder this integration may read');
    return f;
  }

  return {
    provider: 'google_drive',
    displayName: 'Google Drive',
    description: 'Read-only: list files in allowed folders, read file details and the text of documents.',
    credentialFields: [
      { name: 'token', label: 'OAuth access token (drive.readonly)', secret: true },
      { name: 'refreshToken', label: 'OAuth refresh token (recommended)', secret: true },
    ],
    actions: ACTIONS,
    validateConfig,
    validateCredential: (raw) => validateCredential(raw),
    requiresCredential: () => true,

    async refreshCredential({ credential, http }) {
      if (!credential || !credential.refreshToken) throw new ConnectorError('AUTH_FAILED', 'The Google Drive connection has expired; reconnect it.', { authFailed: true });
      if (!oauth || !oauth.clientId || !oauth.clientSecret) {
        throw new ConnectorError('AUTH_FAILED', 'Google OAuth is not configured on this server, so the connection cannot be refreshed.', { authFailed: true });
      }
      const url = oauth.tokenUrl || TOKEN_URL;
      const form = new URLSearchParams({ client_id: oauth.clientId, client_secret: oauth.clientSecret, grant_type: 'refresh_token', refresh_token: credential.refreshToken });
      let res;
      try {
        res = await http.request({
          url, method: 'POST', allowedMethods: ['POST'], allowedHosts: [new URL(url).hostname],
          headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'nexus-integrations' },
          body: form.toString(), timeoutMs: 15000, maxBytes: 16 * 1024,
        });
      } catch { throw new ConnectorError('PROVIDER_ERROR', 'Could not reach Google to refresh the connection.', { retryable: true }); }
      let data = null;
      try { data = JSON.parse(res.body); } catch { data = null; }
      const fresh = res.status === 200 ? credentialFromTokenResponse(data, credential.refreshToken) : null;
      if (!fresh) throw new ConnectorError('AUTH_FAILED', 'Google refused to refresh the connection; reconnect it.', { authFailed: true });
      return fresh;
    },

    connect({ config, credential }) {
      return { config: validateConfig(config), credential: validateCredential(credential) };
    },
    disconnect() { /* the user revokes access at myaccount.google.com; we delete our encrypted copy */ },

    validateAction(action, input, config) {
      const a = ACTIONS[action];
      if (!a) throw new InputError(`Action "${action}" is not available for this integration`);
      const v = validateInput(a.fields, input);
      if (action === 'list_files' && !config.allowedFolders.includes(v.folder_id)) throw new InputError(`Folder ${v.folder_id} is not on this integration's allowlist`);
      return v;
    },

    describeTarget(action, input) {
      return action === 'list_files' ? `google_drive:folder/${input.folder_id}` : `google_drive:file/${input.file_id}`;
    },

    async healthCheck({ credential, http }) {
      const about = await call(http, credential, '/drive/v3/about?fields=user(emailAddress)');
      return { ok: true, detail: about && about.user && about.user.emailAddress ? `authenticated as ${about.user.emailAddress}` : 'authenticated' };
    },

    async execute({ action, input, config, credential, http }) {
      switch (action) {
        case 'list_files': {
          const parts = [`'${input.folder_id}' in parents`, 'trashed = false'];
          if (input.name_contains) parts.push(`name contains '${input.name_contains}'`);
          const q = encodeURIComponent(parts.join(' and '));
          const r = await call(http, credential, `/drive/v3/files?q=${q}&pageSize=${input.limit}&fields=${encodeURIComponent(`files(${FILE_FIELDS})`)}&supportsAllDrives=true&includeItemsFromAllDrives=true`);
          const items = (r && Array.isArray(r.files) ? r.files : []).slice(0, input.limit).map(pickFile);
          return { data: { count: items.length, items }, summary: `${items.length} file(s) in folder ${input.folder_id}`, verified: true };
        }
        case 'get_file': {
          const f = await allowedFile(http, credential, config, input.file_id);
          return { data: pickFile(f), summary: `Read details of ${f.name}`, verified: true };
        }
        case 'read_text': {
          const f = await allowedFile(http, credential, config, input.file_id);
          const id = encodeURIComponent(f.id);
          let path;
          if (EXPORTS[f.mimeType]) path = `/drive/v3/files/${id}/export?mimeType=${encodeURIComponent(EXPORTS[f.mimeType])}`;
          else if (TEXT_TYPES.includes(f.mimeType)) path = `/drive/v3/files/${id}?alt=media&supportsAllDrives=true`;
          else throw new ConnectorError('UNSUPPORTED_FILE', `Files of type ${String(f.mimeType).slice(0, 80)} cannot be read as text`);
          // Up to 4× the text limit is downloaded and truncated; anything larger is refused (FILE_TOO_LARGE).
          const res = await call(http, credential, path, { json: false, maxBytes: 4 * MAX_TEXT_BYTES });
          const buf = Buffer.from(res.body, 'utf8');
          const truncated = buf.length > MAX_TEXT_BYTES;
          return {
            data: { id: f.id, name: f.name, mimeType: f.mimeType, content: buf.subarray(0, MAX_TEXT_BYTES).toString('utf8'), truncated },
            summary: `Read text of ${f.name}`, verified: true,
          };
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

module.exports = { createGoogleDriveConnector, validateConfig, validateCredential, credentialFromTokenResponse, API, TOKEN_URL };
