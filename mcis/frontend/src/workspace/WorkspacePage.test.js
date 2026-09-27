import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import WorkspacePage from './WorkspacePage';
import { storeWorkspaceId } from '../workflows/workflowsApi';

jest.mock('../firebase', () => ({ auth: { currentUser: { uid: 'u1', getIdToken: async () => 'tok-u1' } } }));
jest.mock('firebase/auth', () => ({ onAuthStateChanged: (_a, cb) => { cb({ uid: 'u1' }); return () => {}; } }));

const T = '22222222-2222-4222-8222-222222222222';
let calls; let role; let revoked;

const overview = (admin) => ({
  workspace: { id: T, name: 'Acme', isPersonal: false, role },
  usage: { executions: 42, workflowRuns: 7, steps: 90, connectorCalls: 5, apiCalls: 12, successRate: 92.5, failureRate: 7.5 },
  executions: { sample: 10, latencyMs: { avg: 2000, p50: 1500, p95: 9000 }, waitingApproval: 1, oldestApprovalWaitMinutes: 12 },
  workflowRuns: { sample: 7, successRate: 85.7, waitingApproval: 1 },
  approvals: { waiting: 2, oldestWaitMinutes: 12 },
  connectors: { total: 2, connected: 1, needsAttention: 1, ...(admin ? { failing: [{ id: 'i1', name: 'Prices API', provider: 'http', status: 'error', lastError: 'HTTP 500' }] } : {}) },
  tasks: { open: 3, assignedToMe: 1, assignedToAgent: 1 },
  detail: admin ? 'admin' : 'member',
  ...(admin ? { failures: { quotaDenials: 4, billingFailures: 1, securityDenials: 2 } } : {}),
});
const reply = (status, data, code, error) => Promise.resolve({ ok: status < 400, status, json: async () => (status < 400 ? { success: true, data } : { success: false, error: error || 'err', code }) });
function backend(url, opts = {}) {
  const u = new URL(url);
  const body = opts.body ? JSON.parse(opts.body) : undefined;
  calls.push({ path: u.pathname, method: opts.method || 'GET', body });
  if (u.pathname === '/api/workspaces') return reply(200, [{ id: T, name: 'Acme', is_personal: false, role }]);
  const w = `/api/workspaces/${T}`;
  if (revoked) return reply(404, null, 'WORKSPACE_NOT_FOUND', 'Workspace not found');
  if (u.pathname === `${w}/overview`) return reply(200, overview(role !== 'member'));
  if (u.pathname === `${w}/members`) return reply(200, [{ user_id: 'u1', role }, { user_id: 'u2', role: 'member' }]);
  if (u.pathname === `${w}/invitations` && (opts.method || 'GET') === 'GET') return role === 'member' ? reply(403, null, 'FORBIDDEN') : reply(200, []);
  if (u.pathname === `${w}/invitations`) return reply(201, { invitation: { id: 'i9' }, token: 'one-time-token' });
  if (u.pathname === `${w}/tasks` && (opts.method || 'GET') === 'GET') return reply(200, []);
  if (u.pathname === `${w}/tasks`) return reply(201, { id: 't1' });
  if (u.pathname === `${w}/templates`) return reply(200, [
    { id: 'data_validation', name: 'Data validation', description: 'd', category: 'data', riskLevel: 'low', requiresApproval: false, available: true, requiredIntegrations: [] },
    { id: 'competitor_monitoring', name: 'Competitor monitoring', description: 'c', category: 'monitoring', riskLevel: 'medium', requiresApproval: false, available: false, requiredIntegrations: [{ provider: 'http', label: 'An approved REST API', available: false, candidates: [] }] },
  ]);
  if (u.pathname === `${w}/templates/data_validation/instantiate`) return reply(201, { workflow: { id: 'w1', name: 'Data validation' } });
  return reply(404, null, 'NOT_FOUND');
}

beforeEach(() => {
  calls = []; role = 'member'; revoked = false;
  window.localStorage.clear();
  storeWorkspaceId('u1', T);
  global.fetch = jest.fn(backend);
});

test('O/X overview: members see usage, latency, approvals, tasks — but not failure / security detail', async () => {
  render(<WorkspacePage />);
  expect(await screen.findByTestId('stat-Executions')).toHaveTextContent('42');
  expect(screen.getByTestId('stat-Success rate')).toHaveTextContent('92.5%');
  expect(screen.getByTestId('stat-Waiting for approval')).toHaveTextContent('oldest 12 min');
  expect(screen.getByTestId('stat-Typical run time')).toHaveTextContent('1.5 s');
  expect(screen.getByTestId('stat-Open tasks')).toHaveTextContent('1 for the AI agent');
  expect(screen.queryByTestId('admin-health')).toBeNull();
});

test('observability: owners/admins also see quota, billing, security and connector failures', async () => {
  role = 'owner';
  render(<WorkspacePage />);
  const h = await screen.findByTestId('admin-health');
  expect(h).toHaveTextContent('Quota denials');
  expect(within(h).getByTestId('stat-Billing failures')).toHaveTextContent('1');
  expect(h).toHaveTextContent('Prices API (http): error — HTTP 500');
});

test('G team: members get a read-only team view (no role changes, no invites) — the server still enforces it', async () => {
  render(<WorkspacePage />);
  fireEvent.click(await screen.findByRole('tab', { name: 'Team' }));
  expect(await screen.findByTestId('member-u2')).toHaveTextContent('Member');
  expect(screen.queryByLabelText('Role of u2')).toBeNull();
  expect(screen.queryByRole('region', { name: 'Invite' })).toBeNull();
  expect(screen.getByText('Only owners and admins can change the team.')).toBeInTheDocument();
  expect(calls.some((c) => c.path.endsWith('/invitations') && c.method === 'GET')).toBe(false);
});

test('D team: an owner can invite and gets the one-time code; roles are editable', async () => {
  role = 'owner';
  render(<WorkspacePage />);
  fireEvent.click(await screen.findByRole('tab', { name: 'Team' }));
  expect(await screen.findByLabelText('Role of u2')).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('Invite email'), { target: { value: 'new@acme.co' } });
  fireEvent.change(screen.getByLabelText('Invite role'), { target: { value: 'admin' } });
  fireEvent.click(screen.getByRole('button', { name: 'Invite' }));
  expect(await screen.findByRole('status')).toHaveTextContent('one-time-token');
  expect(calls.find((c) => c.path.endsWith('/invitations') && c.method === 'POST').body).toEqual({ email: 'new@acme.co', role: 'admin' });
});

test('tasks: work can be assigned to the AI agent', async () => {
  render(<WorkspacePage />);
  fireEvent.click(await screen.findByRole('tab', { name: 'Tasks' }));
  fireEvent.change(await screen.findByLabelText('Task title'), { target: { value: 'Reconcile September invoices' } });
  fireEvent.change(screen.getByLabelText('Assign to'), { target: { value: 'agent' } });
  fireEvent.click(screen.getByRole('button', { name: 'Add task' }));
  await waitFor(() => expect(calls.find((c) => c.path.endsWith('/tasks') && c.method === 'POST').body).toEqual({ title: 'Reconcile September invoices', assignee: { type: 'agent' } }));
});

test('E/F templates: missing integrations are stated plainly and block creation; available ones create a draft', async () => {
  render(<WorkspacePage />);
  fireEvent.click(await screen.findByRole('tab', { name: 'Templates' }));
  const mon = await screen.findByTestId('template-competitor_monitoring');
  expect(mon).toHaveTextContent('not connected');
  expect(within(mon).getByRole('button')).toBeDisabled();
  fireEvent.click(within(screen.getByTestId('template-data_validation')).getByRole('button', { name: 'Create workflow' }));
  expect(await screen.findByRole('status')).toHaveTextContent('created as a draft');
});

test('workspace access lost → clear message, no stale numbers', async () => {
  revoked = true;
  render(<WorkspacePage />);
  expect(await screen.findByRole('alert')).toHaveTextContent('no longer have access');
  expect(screen.queryByTestId('stat-Executions')).toBeNull();
});

test('L1-4 an emailed invitation link (#invite=<code>) pre-fills the join code; the code never goes into a query string', async () => {
  window.location.hash = '#invite=AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abc';
  try {
    render(<WorkspacePage />);
    expect(await screen.findByLabelText('Invite code')).toHaveValue('AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abc');
    expect(calls.every((c) => !c.path.includes('invite='))).toBe(true);
  } finally { window.location.hash = ''; }
});
