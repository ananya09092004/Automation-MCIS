/**
 * Layer 9 — frontend hardening: emergency stop, Google Drive OAuth wiring.
 */
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import SecurityPage from '../security/SecurityPage';
import { storeWorkspaceId } from '../workflows/workflowsApi';

jest.mock('../firebase', () => ({ auth: { currentUser: { uid: 'u1', getIdToken: async () => 'tok-u1' } } }));
jest.mock('firebase/auth', () => ({ onAuthStateChanged: (_a, cb) => { cb({ uid: 'u1' }); return () => {}; } }));

const T = '22222222-2222-4222-8222-222222222222';
let calls; let role; let stopped; let drive;

const dashboard = () => ({
  firewall: { enabled: true, policyVersion: 3, isDefault: false, corrupt: false },
  policy: { maxRisk: 'red', emergencyStop: stopped },
  builtIn: { dangerousActionsDeniedByDefault: ['run_terminal'] },
  approvalPolicy: null, integrations: [], oauthConnections: [], apiKeys: [], recentEvents: [], blockedActions: [], role,
});
const reply = (status, data, code) => Promise.resolve({ ok: status < 400, status, json: async () => (status < 400 ? { success: true, data } : { success: false, error: 'err', code: code || 'NOT_FOUND' }) });
function backend(url, opts = {}) {
  const u = new URL(url);
  const body = opts.body ? JSON.parse(opts.body) : undefined;
  calls.push({ path: u.pathname, search: u.search, method: opts.method || 'GET', body });
  if (u.pathname === '/api/workspaces') return reply(200, [{ id: T, name: 'Acme', is_personal: false, role }]);
  const base = `/api/workspaces/${T}/security`;
  if (u.pathname === base) return reply(200, dashboard());
  if (u.pathname === `${base}/emergency-stop`) { stopped = !!body.active; return reply(200, { emergencyStop: stopped }); }
  if (u.pathname === `${base}/oauth/providers`) return reply(200, { github: false, google_drive: drive });
  if (u.pathname === `${base}/oauth/google_drive/start`) return reply(200, { url: 'https://accounts.google.com/o/oauth2/v2/auth?state=w.x' });
  if (u.pathname === `${base}/oauth/google_drive/complete`) return reply(200, { account: 'ops@example.com', integrationId: 'i9', provider: 'google_drive', status: 'connected' });
  return reply(404);
}

beforeEach(() => {
  calls = []; role = 'owner'; stopped = false; drive = true;
  window.localStorage.clear(); window.sessionStorage.clear();
  storeWorkspaceId('u1', T);
  global.fetch = jest.fn(backend);
  window.history.replaceState(null, '', '/security');
});

test('emergency stop: an owner/admin can stop all actions and turn it off again; the state comes from the server', async () => {
  role = 'admin';
  render(<SecurityPage />);
  fireEvent.click(await screen.findByRole('button', { name: 'Stop all actions' }));
  expect(await screen.findByTestId('emergency-stop-on')).toBeInTheDocument();
  expect(calls.find((c) => c.path.endsWith('/emergency-stop')).body).toEqual({ active: true });
  fireEvent.click(screen.getByRole('button', { name: 'Turn off' }));
  await waitFor(() => expect(screen.queryByTestId('emergency-stop-on')).toBeNull());
  expect(calls.filter((c) => c.path.endsWith('/emergency-stop')).map((c) => c.body.active)).toEqual([true, false]);
});

test('Google Drive: the connect button appears only when the server offers it; GitHub is hidden when not configured', async () => {
  render(<SecurityPage />);
  expect(await screen.findByRole('button', { name: 'Connect Google Drive (read-only)' })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Connect GitHub (OAuth)' })).toBeNull();
});

test('Google Drive: not offered by the server → no button', async () => {
  drive = false;
  render(<SecurityPage />);
  await screen.findByRole('region', { name: 'OAuth connections' });
  await waitFor(() => expect(calls.some((c) => c.path.endsWith('/oauth/providers'))).toBe(true));
  expect(screen.queryByRole('button', { name: 'Connect Google Drive (read-only)' })).toBeNull();
});

test('Google Drive completion: code/state from the fragment are POSTed in the body to the Drive endpoint; the fragment is removed', async () => {
  window.sessionStorage.setItem('nexus.oauth.workspace', T);
  window.history.replaceState(null, '', '/security#oauth=google_drive&code=4/0AbCdEfGh&state=w.statevalue');
  render(<SecurityPage />);
  expect(await screen.findByText(/Google Drive account ops@example.com connected/)).toBeInTheDocument();
  const done = calls.find((c) => c.path.endsWith('/oauth/google_drive/complete'));
  expect(done.body).toEqual({ code: '4/0AbCdEfGh', state: 'w.statevalue' });
  expect(done.search).toBe('');
  expect(window.location.hash).toBe('');
});

test('Google Drive completion: an error fragment never calls the server', async () => {
  window.sessionStorage.setItem('nexus.oauth.workspace', T);
  window.history.replaceState(null, '', '/security#oauth=google_drive&error=1');
  render(<SecurityPage />);
  expect(await screen.findByRole('alert')).toHaveTextContent('Could not complete the Google Drive connection');
  expect(calls.some((c) => c.path.includes('/complete'))).toBe(false);
});
