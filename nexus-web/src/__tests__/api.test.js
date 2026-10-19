import { describe, it, expect, vi } from 'vitest';
import { createApi, ApiError, newIdempotencyKey } from '../lib/api.js';
import { missingFirebaseConfig } from '../config.js';

const ok = (data, status = 200) => ({ ok: status < 400, status, json: async () => ({ success: true, data }) });
const fail = (status, code, error) => ({ ok: false, status, json: async () => ({ success: false, code, error }) });

describe('api client', () => {
  it('sends the bearer token only to the configured API and unwraps data', async () => {
    const fetchImpl = vi.fn(async () => ok([{ id: 'w1' }]));
    const api = createApi({ baseUrl: 'https://api.example.com/', getToken: async () => 'tok', fetchImpl });
    const data = await api.request('/api/workspaces');
    expect(data).toEqual([{ id: 'w1' }]);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://api.example.com/api/workspaces');
    expect(init.headers.Authorization).toBe('Bearer tok');
    expect(init.credentials).toBe('omit');
  });

  it('refuses non-/api paths (the token can never be sent elsewhere)', async () => {
    const fetchImpl = vi.fn();
    const api = createApi({ getToken: async () => 'tok', fetchImpl });
    await expect(api.request('https://evil.example.com/api/x')).rejects.toThrow(/must start with \/api\//);
    await expect(api.request('/other')).rejects.toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('does not call the server without a session', async () => {
    const fetchImpl = vi.fn();
    const api = createApi({ getToken: async () => null, fetchImpl });
    await expect(api.request('/api/workspaces')).rejects.toMatchObject({ status: 401, code: 'AUTH_REQUIRED' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('maps server errors to ApiError with the server code and message', async () => {
    const api = createApi({ getToken: async () => 't', fetchImpl: async () => fail(403, 'FORBIDDEN', 'Only admins can do that') });
    const err = await api.request('/api/workspaces/x/audit').catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 403, code: 'FORBIDDEN', message: 'Only admins can do that' });
  });

  it('gives a readable message for network failures and non-JSON errors', async () => {
    const down = createApi({ getToken: async () => 't', fetchImpl: async () => { throw new TypeError('Failed to fetch'); } });
    await expect(down.request('/api/workspaces')).rejects.toMatchObject({ status: 0, code: 'NETWORK_ERROR' });
    const html = createApi({ getToken: async () => 't', fetchImpl: async () => ({ ok: false, status: 502, json: async () => { throw new Error('not json'); } }) });
    await expect(html.request('/api/workspaces')).rejects.toMatchObject({ status: 502, code: 'HTTP_502' });
  });

  it('sends JSON bodies and custom headers', async () => {
    const fetchImpl = vi.fn(async () => ok({ id: 'e1' }, 201));
    const api = createApi({ getToken: async () => 't', fetchImpl });
    await api.request('/api/workspaces/w/executions', { method: 'POST', body: { goal: 'x' }, headers: { 'Idempotency-Key': 'nexus-abc12345' } });
    const init = fetchImpl.mock.calls[0][1];
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ goal: 'x' });
    expect(init.headers['Content-Type']).toBe('application/json');
    expect(init.headers['Idempotency-Key']).toBe('nexus-abc12345');
  });

  it('idempotency keys match the backend format', () => {
    const k = newIdempotencyKey();
    expect(k).toMatch(/^[A-Za-z0-9_.:-]{8,128}$/);
    expect(newIdempotencyKey()).not.toBe(k);
  });

  it('reports missing Firebase settings by NAME only', () => {
    expect(missingFirebaseConfig({ apiKey: 'x', authDomain: '', projectId: 'p' })).toEqual(['VITE_FIREBASE_AUTH_DOMAIN', 'VITE_FIREBASE_APP_ID']);
    expect(missingFirebaseConfig({ apiKey: 'a', authDomain: 'b', projectId: 'c', appId: 'd' })).toEqual([]);
  });
});
