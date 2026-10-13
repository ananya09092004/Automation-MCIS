import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import WorkflowsPage from './WorkflowsPage';
import { pickWorkspace, getStoredWorkspaceId, storeWorkspaceId } from './workflowsApi';

jest.mock('../firebase', () => ({ auth: { currentUser: { uid: 'u1', getIdToken: async () => 'tok-u1' } } }));
jest.mock('firebase/auth', () => ({
  onAuthStateChanged: (_auth, cb) => { cb({ uid: 'u1' }); return () => {}; },
}));

const P = '11111111-1111-4111-8111-111111111111';
const T = '22222222-2222-4222-8222-222222222222';
const FOREIGN = '33333333-3333-4333-8333-333333333333';
const WF_T = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const RUN = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const APPR = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

let calls;
let memberships;
let revoked;

function reply(status, data, extra = {}) {
  return Promise.resolve({ ok: status < 400, status, json: async () => (status < 400 ? { success: true, data } : { success: false, error: 'Workspace not found', code: 'WORKSPACE_NOT_FOUND', ...extra }) });
}

// Minimal backend emulator: authorization decided "server-side" here.
function fakeBackend(url, opts = {}) {
  const u = new URL(url);
  calls.push({ path: u.pathname, method: opts.method || 'GET', headers: opts.headers || {}, body: opts.body ? JSON.parse(opts.body) : undefined });
  if (u.pathname === '/api/workspaces') return reply(200, memberships);
  const m = u.pathname.match(/^\/api\/workspaces\/([^/]+)\/(.*)$/);
  if (!m) return reply(404);
  const [, ws, rest] = m;
  if (!memberships.some((w) => w.id === ws) || revoked.has(ws)) return reply(404);
  if (rest === 'workflows') return reply(200, ws === T ? [{ id: WF_T, name: 'GST filing', status: 'active' }] : []);
  if (rest === `workflows/${WF_T}`) {
    return reply(200, { id: WF_T, name: 'GST filing', status: 'active', description: '', latestVersion: 1, activeVersionId: 'v1', versions: [{ id: 'v1', version: 1 }], trigger: { type: 'manual' }, draft: { steps: [] } });
  }
  if (rest === `workflows/${WF_T}/versions/1`) {
    return reply(200, { version: 1, definition: { variables: [{ name: 'client_name', label: 'Client' }], steps: [{ key: 'a', name: 'Download GSTR-1', approval: 'required' }] } });
  }
  if (rest === `workflows/${WF_T}/runs` && opts.method === 'POST') return reply(201, { id: RUN, status: 'queued' });
  if (rest === `workflows/${WF_T}/runs`) return reply(200, []);
  if (rest === `workflow-runs/${RUN}`) {
    return reply(200, {
      id: RUN, status: 'waiting_approval', version: 1, trigger: 'manual', initiatedBy: 'u1',
      steps: [{ position: 0, name: 'Download GSTR-1', status: 'waiting_approval', attempt: 1,
        execution: { waitingForApproval: { id: APPR, status: 'pending', action: 'click', riskTier: 'yellow', requiredRole: 'creator_or_admin' }, evidenceSummary: { steps: 1, succeeded: 1, failed: 0, verified: 1 } } }],
    });
  }
  if (rest.startsWith(`workflow-runs/${RUN}/steps/0/approvals/${APPR}/`)) return reply(200, { run: { id: RUN } });
  return reply(404);
}

beforeEach(() => {
  calls = [];
  revoked = new Set();
  memberships = [
    { id: P, name: 'Personal', is_personal: true, role: 'owner' },
    { id: T, name: 'Acme Tax', is_personal: false, role: 'member' },
  ];
  window.localStorage.clear();
  global.fetch = jest.fn(fakeBackend);
});

test('pickWorkspace: a remembered id is honoured only if the server lists it; otherwise personal', () => {
  expect(pickWorkspace(memberships, T).id).toBe(T);
  expect(pickWorkspace(memberships, FOREIGN).id).toBe(P);
  expect(pickWorkspace(memberships, null).id).toBe(P);
  expect(pickWorkspace([], T)).toBeNull();
  storeWorkspaceId('u1', 'not-a-uuid');
  expect(getStoredWorkspaceId('u1')).toBeNull();
});

test('defaults to the personal workspace; switching loads that workspace\'s workflows and is remembered', async () => {
  render(<WorkflowsPage />);
  await waitFor(() => expect(calls.some((c) => c.path === `/api/workspaces/${P}/workflows`)).toBe(true));
  expect(await screen.findByText('No workflows in this workspace.')).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('Workspace'), { target: { value: T } });
  expect(await screen.findByText('GST filing')).toBeInTheDocument();
  expect(getStoredWorkspaceId('u1')).toBe(T);
  // every API call is authenticated; the workspace only ever travels in the URL
  for (const c of calls) {
    expect(c.headers.Authorization).toBe('Bearer tok-u1');
    expect(c.headers['X-Workspace-Id']).toBeUndefined();
  }
});

test('a tampered remembered workspace the user is not a member of is never requested', async () => {
  storeWorkspaceId('u1', FOREIGN);
  render(<WorkflowsPage />);
  await waitFor(() => expect(calls.some((c) => c.path === `/api/workspaces/${P}/workflows`)).toBe(true));
  expect(calls.some((c) => c.path.includes(FOREIGN))).toBe(false);
});

test('server says 404 (membership revoked) → falls back to personal and tells the user', async () => {
  storeWorkspaceId('u1', T);
  revoked.add(T);
  render(<WorkflowsPage />);
  expect(await screen.findByText('You no longer have access to that workspace.')).toBeInTheDocument();
  await waitFor(() => expect(screen.getByLabelText('Workspace').value).toBe(P));
  expect(getStoredWorkspaceId('u1')).toBeNull();
});

test('run a workflow (with idempotency key), see the pending approval, approve through the run-scoped endpoint', async () => {
  storeWorkspaceId('u1', T);
  render(<WorkflowsPage />);
  fireEvent.click(await screen.findByText('GST filing'));
  fireEvent.change(await screen.findByLabelText('input client_name'), { target: { value: 'Ravi Traders' } });
  fireEvent.click(screen.getByText('Run v1'));
  expect(await screen.findByText(/Approval needed/)).toBeInTheDocument();
  const start = calls.find((c) => c.method === 'POST' && c.path.endsWith('/runs'));
  expect(start.path).toBe(`/api/workspaces/${T}/workflows/${WF_T}/runs`);
  expect(start.body).toEqual({ inputs: { client_name: 'Ravi Traders' } });
  expect(start.headers['Idempotency-Key']).toMatch(/^ui-/);
  fireEvent.click(screen.getByText('Approve'));
  await waitFor(() => expect(calls.some((c) => c.path === `/api/workspaces/${T}/workflow-runs/${RUN}/steps/0/approvals/${APPR}/approve`)).toBe(true));
});
