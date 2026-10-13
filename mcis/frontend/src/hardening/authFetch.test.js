/**
 * Layer 9 — the global fetch wrapper: the Firebase token goes ONLY to our
 * API, and chat/memory/goals carry the selected workspace.
 */
import { setupAuthenticatedFetch, shouldAttachToken } from '../authFetch';
import { storeWorkspaceId, getStoredWorkspaceId } from '../workflows/workflowsApi';

jest.mock('../firebase', () => ({ auth: { currentUser: { uid: 'u1', getIdToken: async () => 'tok-u1' } } }));

const W = '22222222-2222-4222-8222-222222222222';
let seen; let respond;
beforeEach(() => {
  seen = [];
  respond = () => ({ ok: true, status: 200, clone() { return this; }, json: async () => ({ success: true }) });
  window.__mcisAuthenticatedFetchInstalled = false;
  window.localStorage.clear();
  window.fetch = jest.fn(async (input, init = {}) => { seen.push({ url: input, headers: new Headers(init.headers || {}) }); return respond(input, init); });
  setupAuthenticatedFetch();
});

test('the ID token is never sent to another origin, even on an /api/ path', async () => {
  expect(shouldAttachToken('https://evil.example/api/chat')).toBe(false);
  await window.fetch('https://evil.example/api/chat', { method: 'POST', body: '{}' });
  expect(seen[0].headers.get('Authorization')).toBeNull();
  await window.fetch('/api/goals');
  expect(seen[1].headers.get('Authorization')).toBe('Bearer tok-u1');
  await window.fetch('https://mcis-backend.onrender.com/api/memory');
  expect(seen[2].headers.get('Authorization')).toBe('Bearer tok-u1');
});

test('chat / memory / goals carry X-Workspace-Id of the selected workspace; other routes do not', async () => {
  storeWorkspaceId('u1', W);
  await window.fetch('https://mcis-backend.onrender.com/api/chat', { method: 'POST', body: '{}' });
  await window.fetch('/api/memory/list', { headers: { Authorization: 'Bearer caller-set' } });
  await window.fetch('/api/workspaces');
  expect(seen[0].headers.get('X-Workspace-Id')).toBe(W);
  expect(seen[1].headers.get('X-Workspace-Id')).toBe(W);
  expect(seen[1].headers.get('Authorization')).toBe('Bearer caller-set');
  expect(seen[2].headers.get('X-Workspace-Id')).toBeNull();
});

test('a workspace the user no longer belongs to is forgotten and the request is retried in the personal workspace', async () => {
  storeWorkspaceId('u1', W);
  respond = (_i, init) => {
    const h = new Headers(init.headers || {});
    if (h.get('X-Workspace-Id')) return { ok: false, status: 404, clone() { return this; }, json: async () => ({ success: false, code: 'WORKSPACE_NOT_FOUND' }) };
    return { ok: true, status: 200, clone() { return this; }, json: async () => ({ success: true }) };
  };
  const res = await window.fetch('/api/goals', { method: 'GET' });
  expect(res.status).toBe(200);
  expect(seen).toHaveLength(2);
  expect(seen[1].headers.get('X-Workspace-Id')).toBeNull();
  expect(getStoredWorkspaceId('u1')).toBeNull();
});
