/**
 * Thin client for the MCIS/Nexus backend.
 *
 * - Sends the Firebase ID token ONLY to the configured API (baseUrl + /api/…).
 * - Unwraps the backend envelope { success, data } / { success:false, error, code }.
 * - Normalizes failures into ApiError(status, code, message); server messages are
 *   already sanitized by the backend and are shown as-is.
 */
export class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

const DEFAULT_MESSAGES = {
  0: 'Cannot reach the Nexus API. Check your connection and the configured API URL.',
  401: 'Your session has expired. Please sign in again.',
  402: 'Your plan does not allow this action.',
  403: 'You do not have permission to do this in this workspace.',
  404: 'Not found — it may have been removed, or you are not a member of this workspace.',
  409: 'This changed in the meantime. Refresh and try again.',
  429: 'Too many requests. Wait a moment and try again.',
  503: 'This feature is not available on this server right now.',
};

export function messageFor(status) {
  if (DEFAULT_MESSAGES[status]) return DEFAULT_MESSAGES[status];
  return status >= 500 ? 'The server had a problem handling this request.' : 'The request could not be completed.';
}

export function newIdempotencyKey() {
  const c = typeof globalThis !== 'undefined' ? globalThis.crypto : null;
  if (c && typeof c.randomUUID === 'function') return `nexus-${c.randomUUID()}`;
  return `nexus-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

export function createApi({ baseUrl = '', getToken, fetchImpl } = {}) {
  const doFetch = fetchImpl || ((...a) => globalThis.fetch(...a));
  const root = String(baseUrl || '').replace(/\/+$/, '');

  async function request(path, { method = 'GET', body, headers = {}, signal } = {}) {
    if (typeof path !== 'string' || !path.startsWith('/api/')) throw new Error('API paths must start with /api/');
    const token = getToken ? await getToken() : null;
    if (!token) throw new ApiError(401, 'AUTH_REQUIRED', messageFor(401));
    const h = { Accept: 'application/json', ...headers, Authorization: `Bearer ${token}` };
    let payload;
    if (body !== undefined) {
      h['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    let res;
    try {
      res = await doFetch(`${root}${path}`, { method, headers: h, body: payload, signal, credentials: 'omit' });
    } catch (err) {
      if (err && err.name === 'AbortError') throw err;
      throw new ApiError(0, 'NETWORK_ERROR', messageFor(0));
    }
    let json = null;
    try { json = await res.json(); } catch { json = null; }
    if (!res.ok || (json && json.success === false)) {
      const status = res.ok ? 400 : res.status;
      throw new ApiError(status, (json && json.code) || `HTTP_${status}`, (json && json.error) || messageFor(status));
    }
    return json && typeof json === 'object' && 'data' in json ? json.data : json;
  }

  return { request };
}
