import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import SecurityPage from './SecurityPage';
import { storeWorkspaceId } from '../workflows/workflowsApi';

jest.mock('../firebase', () => ({ auth: { currentUser: { uid: 'u1', getIdToken: async () => 'tok-u1' } } }));
jest.mock('firebase/auth', () => ({ onAuthStateChanged: (_a, cb) => { cb({ uid: 'u1' }); return () => {}; } }));

const P = '11111111-1111-4111-8111-111111111111';
const T = '22222222-2222-4222-8222-222222222222';
const NEW_KEY = 'nxk_abcdefghijkl_TESTONLYxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';

let calls;
let role;
let forbidDashboard;

const dashboard = () => ({
  firewall: { enabled: true, policyVersion: 3, isDefault: false, corrupt: false },
  policy: { maxRisk: 'red' },
  builtIn: { dangerousActionsDeniedByDefault: ['run_terminal', 'kill_process'] },
  approvalPolicy: { ttlMinutes: 15, taintedRequiresApproval: true, maxRisk: 'red', minRole: { execute: 'member', stateChanging: 'member' } },
  integrations: [{ id: 'i1', name: 'Books repo', provider: 'github', status: 'connected', connectorPermissions: [{ action: 'github.create_issue', enabled: false, effectiveTier: 'yellow', minRole: 'member' }] }],
  oauthConnections: [{ integrationId: 'i1', provider: 'github', account: 'octocat', status: 'connected' }],
  apiKeys: [{ id: 'k1', name: 'CI', prefix: 'nxk_aaaaaaaaaaaa', scopes: ['workflows:run'], status: 'active', lastUsedAt: null, expiresAt: null }],
  recentEvents: [{ id: 'e1', type: 'policy_deny', success: false, at: '2026-09-24T10:00:00Z', detail: { action: 'run_terminal', reasons: ['DANGEROUS_ACTION_DENIED_BY_DEFAULT'] } }],
  blockedActions: [{ id: 'e1', type: 'policy_deny', success: false, at: '2026-09-24T10:00:00Z', detail: { action: 'run_terminal', reasons: ['DANGEROUS_ACTION_DENIED_BY_DEFAULT'] } }],
  role,
});

const reply = (status, data, code) => Promise.resolve({ ok: status < 400, status, json: async () => (status < 400 ? { success: true, data } : { success: false, error: code === 'FORBIDDEN' ? 'Forbidden' : 'Not found', code: code || 'NOT_FOUND' }) });

function backend(url, opts = {}) {
  const u = new URL(url);
  const body = opts.body ? JSON.parse(opts.body) : undefined;
  calls.push({ path: u.pathname, search: u.search, method: opts.method || 'GET', body });
  if (u.pathname === '/api/workspaces') return reply(200, [{ id: P, name: 'Personal', is_personal: true, role: 'owner' }, { id: T, name: 'Acme', is_personal: false, role }]);
  const base = `/api/workspaces/${T}/security`;
  if (u.pathname === base) return forbidDashboard ? reply(403, null, 'FORBIDDEN') : reply(200, dashboard());
  if (u.pathname === `${base}/policy` && (opts.method || 'GET') === 'GET') return reply(200, { version: 3, policy: { maxRisk: 'red' } });
  if (u.pathname === `${base}/api-keys` && opts.method === 'POST') return reply(201, { key: NEW_KEY, apiKey: { id: 'k2' } });
  if (u.pathname === `/api/workspaces/${P}/security/oauth/github/complete`) return reply(200, { account: 'octocat', integrationId: 'i9', provider: 'github', status: 'connected' });
  return reply(404);
}

beforeEach(() => {
  calls = [];
  role = 'admin';
  forbidDashboard = false;
  window.localStorage.clear();
  window.sessionStorage.clear();
  storeWorkspaceId('u1', T);
  global.fetch = jest.fn(backend);
  window.history.replaceState(null, '', '/security');
});

test('members see an explanation and never call the security API', async () => {
  role = 'member';
  render(<SecurityPage />);
  expect(await screen.findByTestId('members-notice')).toBeInTheDocument();
  expect(calls.some((c) => c.path.includes('/security'))).toBe(false);
});

test('admin sees firewall status, approval policy, integrations, OAuth, keys, events and blocked actions — but no owner controls', async () => {
  render(<SecurityPage />);
  expect(await screen.findByText(/version 3/)).toBeInTheDocument();
  expect(screen.getByTestId('approval-policy')).toHaveTextContent('approvals expire after 15 min');
  expect(screen.getByText('github.create_issue')).toBeInTheDocument();
  expect(screen.getByText(/octocat/)).toBeInTheDocument();
  expect(screen.getAllByTestId('api-key-row')).toHaveLength(1);
  expect(screen.getAllByTestId('blocked-row')[0]).toHaveTextContent('DANGEROUS_ACTION_DENIED_BY_DEFAULT');
  expect(screen.queryByText('Create key')).toBeNull();
  expect(screen.queryByText('Revoke')).toBeNull();
  expect(screen.queryByLabelText('Policy JSON')).toBeNull();
  expect(screen.queryByText(/Connect GitHub/)).toBeNull();
});

test('owner creates an API key: plaintext shown once, never stored in the browser, cleared on dismiss', async () => {
  role = 'owner';
  render(<SecurityPage />);
  fireEvent.change(await screen.findByLabelText('Key name'), { target: { value: 'Deploy bot' } });
  fireEvent.click(screen.getByText('Create key'));
  const shown = await screen.findByTestId('new-key');
  expect(shown).toHaveTextContent(NEW_KEY);
  const post = calls.find((c) => c.method === 'POST' && c.path.endsWith('/api-keys'));
  expect(post.body).toEqual({ name: 'Deploy bot', scopes: ['workflows:run'] });
  const stored = JSON.stringify({ ...window.localStorage }) + JSON.stringify({ ...window.sessionStorage });
  expect(stored).not.toContain(NEW_KEY);
  fireEvent.click(screen.getByText('I have stored it'));
  await waitFor(() => expect(screen.queryByTestId('new-key')).toBeNull());
  expect(document.body.textContent).not.toContain(NEW_KEY);
  expect(screen.getByLabelText('Policy JSON')).toBeInTheDocument();
});

test('a 403 from the backend is shown as an authorization message (backend is the authority)', async () => {
  forbidDashboard = true;
  render(<SecurityPage />);
  expect(await screen.findByRole('alert')).toHaveTextContent('Only workspace admins and owners');
});

test('OAuth completion: code/state come from the URL fragment, are POSTed in the body (never a query) and the fragment is removed', async () => {
  window.sessionStorage.setItem('nexus.oauth.workspace', P);
  window.history.replaceState(null, '', '/security#oauth=github&code=abc123codeXYZ&state=w.statevalue');
  render(<SecurityPage />);
  expect(await screen.findByText(/GitHub account octocat connected/)).toBeInTheDocument();
  const done = calls.find((c) => c.path.endsWith('/oauth/github/complete'));
  expect(done.method).toBe('POST');
  expect(done.body).toEqual({ code: 'abc123codeXYZ', state: 'w.statevalue' });
  expect(done.search).toBe('');
  expect(window.location.hash).toBe('');
  expect(window.sessionStorage.getItem('nexus.oauth.workspace')).toBeNull();
});
