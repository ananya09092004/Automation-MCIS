import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import IntegrationsPage from './IntegrationsPage';
import WorkflowsPage from '../workflows/WorkflowsPage';
import { storeWorkspaceId } from '../workflows/workflowsApi';

jest.mock('../firebase', () => ({ auth: { currentUser: { uid: 'u1', getIdToken: async () => 'tok-u1' } } }));
jest.mock('firebase/auth', () => ({ onAuthStateChanged: (_a, cb) => { cb({ uid: 'u1' }); return () => {}; } }));

const P = '11111111-1111-4111-8111-111111111111';
const T = '22222222-2222-4222-8222-222222222222';
const GH = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SECRET = 'ghp_TESTONLY0123456789abcdefghijklmnop';

let calls;
let role;
let revoked;

const providers = [
  { provider: 'github', displayName: 'GitHub', description: 'Repos', credentialFields: [{ name: 'token', secret: true }],
    actions: [
      { name: 'get_repository', label: 'Read repository', risk: 'green', input: { owner: { type: 'string', required: true }, repo: { type: 'string', required: true } } },
      { name: 'create_issue', label: 'Create issue', risk: 'yellow', input: { owner: { type: 'string', required: true }, repo: { type: 'string', required: true }, title: { type: 'string', required: true } } },
    ] },
  { provider: 'http', displayName: 'HTTP / REST API', description: 'One API', credentialFields: [{ name: 'token', secret: true }], actions: [{ name: 'get', label: 'GET request', risk: 'green', input: { path: { type: 'string', required: true } } }] },
];
const ghIntegration = () => ({
  id: GH, provider: 'github', providerName: 'GitHub', name: 'Books repo', status: 'connected', hasCredential: true, config: { allowedRepos: ['acme/books'] },
  actions: [
    { name: 'get_repository', label: 'Read repository', available: true, enabled: true, approval: 'default', effectiveTier: 'green', requiresApproval: false },
    { name: 'create_issue', label: 'Create issue', available: true, enabled: false, approval: 'default', effectiveTier: 'yellow', requiresApproval: true },
  ],
});

const reply = (status, data) => Promise.resolve({ ok: status < 400, status, json: async () => (status < 400 ? { success: true, data } : { success: false, error: 'Not found', code: 'NOT_FOUND' }) });

function backend(url, opts = {}) {
  const u = new URL(url);
  const body = opts.body ? JSON.parse(opts.body) : undefined;
  calls.push({ path: u.pathname, method: opts.method || 'GET', headers: opts.headers || {}, body, raw: opts.body || '' });
  if (u.pathname === '/api/workspaces') return reply(200, [{ id: P, name: 'Personal', is_personal: true, role: 'owner' }, { id: T, name: 'Acme', is_personal: false, role }]);
  const m = u.pathname.match(/^\/api\/workspaces\/([^/]+)\/(.*)$/);
  if (!m || revoked.has(m[1])) return reply(404);
  const [, ws, rest] = m;
  if (rest === 'integrations/providers') return reply(200, providers);
  if (rest === 'integrations' && (opts.method || 'GET') === 'GET') return reply(200, ws === T ? [ghIntegration()] : []);
  if (rest === 'integrations' && opts.method === 'POST') return reply(201, { ...ghIntegration(), id: 'new' });
  if (rest.startsWith(`integrations/${GH}/`)) return reply(200, ghIntegration());
  if (rest === 'workflows' && opts.method === 'POST') return reply(201, { id: 'wf1', name: body.name, status: 'draft' });
  if (rest === 'workflows') return reply(200, []);
  if (rest === 'workflows/wf1') return reply(200, { id: 'wf1', name: 'x', status: 'draft', trigger: { type: 'manual' }, versions: [], draft: { steps: [] } });
  if (rest === 'workflows/wf1/runs') return reply(200, []);
  return reply(404);
}

beforeEach(() => {
  calls = [];
  role = 'admin';
  revoked = new Set();
  window.localStorage.clear();
  storeWorkspaceId('u1', T);
  global.fetch = jest.fn(backend);
});

test('member: sees integrations, statuses and permissions, but no admin controls and no secrets', async () => {
  role = 'member';
  render(<IntegrationsPage />);
  const card = await screen.findByTestId('integration-card');
  expect(within(card).getByText('Books repo')).toBeInTheDocument();
  expect(within(card).getByText('GitHub — Read repository')).toBeInTheDocument();
  expect(within(card).getByText('credential stored (encrypted)')).toBeInTheDocument();
  expect(screen.queryByText('Connect integration')).toBeNull();
  expect(screen.queryByText('Disconnect')).toBeNull();
  expect(screen.queryByLabelText('enable create_issue')).toBeNull();
  expect(screen.getByText(/Only workspace admins/)).toBeInTheDocument();
});

test('admin connect: token is sent once, cleared from the input, never kept in storage or the DOM', async () => {
  render(<IntegrationsPage />);
  fireEvent.click(await screen.findByText('Connect integration'));
  fireEvent.change(screen.getByLabelText('Integration name'), { target: { value: 'Finance repo' } });
  fireEvent.change(screen.getByLabelText('Allowed repositories'), { target: { value: 'acme/books, acme/*' } });
  const tokenInput = screen.getByLabelText('Token');
  expect(tokenInput).toHaveAttribute('type', 'password');
  fireEvent.change(tokenInput, { target: { value: SECRET } });
  fireEvent.click(screen.getByText('Connect'));
  await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.path === `/api/workspaces/${T}/integrations`)).toBe(true));
  const post = calls.find((c) => c.method === 'POST' && c.path.endsWith('/integrations'));
  expect(post.body).toEqual({ provider: 'github', name: 'Finance repo', config: { allowedRepos: ['acme/books', 'acme/*'] }, credentials: { token: SECRET } });
  expect(post.headers.Authorization).toBe('Bearer tok-u1');
  expect(calls.filter((c) => c.raw.includes(SECRET))).toHaveLength(1);
  await waitFor(() => expect(screen.queryByLabelText('Token')).toBeNull());
  expect(document.body.innerHTML).not.toContain(SECRET);
  expect(JSON.stringify({ ...window.localStorage })).not.toContain(SECRET);
});

test('admin: enable an action and disconnect call the right endpoints', async () => {
  render(<IntegrationsPage />);
  fireEvent.click(await screen.findByLabelText('enable create_issue'));
  await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true));
  const put = calls.find((c) => c.method === 'PUT');
  expect(put.path).toBe(`/api/workspaces/${T}/integrations/${GH}/permissions`);
  expect(put.body).toEqual({ actions: { create_issue: { enabled: true } } });
  fireEvent.click(screen.getByText('Disconnect'));
  await waitFor(() => expect(calls.some((c) => c.path.endsWith(`${GH}/disconnect`))).toBe(true));
});

test('workspace access revoked (404) → falls back to personal', async () => {
  revoked.add(T);
  render(<IntegrationsPage />);
  expect(await screen.findByText('You no longer have access to that workspace.')).toBeInTheDocument();
  await waitFor(() => expect(screen.getByLabelText('Workspace').value).toBe(P));
});

test('workflow editor: a step can pick Integration → Action → input; only references are sent', async () => {
  render(<WorkflowsPage />);
  await waitFor(() => expect(calls.some((c) => c.path === `/api/workspaces/${T}/workflows`)).toBe(true)); // workspace loaded
  fireEvent.click(screen.getByText('New'));
  fireEvent.change(screen.getByLabelText('Workflow name'), { target: { value: 'Repo check' } });
  fireEvent.change(screen.getByLabelText('Step 1 name'), { target: { value: 'Read repo' } });
  fireEvent.change(await screen.findByLabelText('Step 1 integration'), { target: { value: GH } });
  const actionSelect = screen.getByLabelText('Step 1 action');
  expect(within(actionSelect).getByText(/GitHub — Create issue \(disabled\)/)).toBeDisabled();
  fireEvent.change(actionSelect, { target: { value: 'get_repository' } });
  fireEvent.change(screen.getByLabelText('Step 1 input owner'), { target: { value: 'acme' } });
  fireEvent.change(screen.getByLabelText('Step 1 input repo'), { target: { value: 'books' } });
  expect(screen.queryByLabelText('Step 1 instruction')).toBeNull();
  fireEvent.click(screen.getByText('Save draft'));
  await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.path.endsWith('/workflows'))).toBe(true));
  const post = calls.find((c) => c.method === 'POST' && c.path.endsWith('/workflows'));
  expect(post.body.definition.steps[0]).toEqual({
    key: 'step_1', name: 'Read repo', approval: 'auto',
    connector: { integrationId: GH, action: 'get_repository', input: { owner: 'acme', repo: 'books' } },
  });
});
