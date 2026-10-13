/**
 * Layer 9 — ownership transfer, verification email, data retention UI.
 */
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import WorkspacePage from '../workspace/WorkspacePage';
import { storeWorkspaceId } from '../workflows/workflowsApi';

const mockUser = { uid: 'u1', emailVerified: true, getIdToken: async () => 'tok-u1' };
const mockSend = jest.fn(async () => {});
jest.mock('../firebase', () => ({ auth: { get currentUser() { return mockUser; } } }));
jest.mock('firebase/auth', () => ({
  onAuthStateChanged: (_a, cb) => { cb({ uid: 'u1' }); return () => {}; },
  sendEmailVerification: (...a) => mockSend(...a),
}));

const T = '22222222-2222-4222-8222-222222222222';
let calls; let role; let personal; let retention;
const reply = (status, data, code) => Promise.resolve({ ok: status < 400, status, json: async () => (status < 400 ? { success: true, data } : { success: false, error: 'err', code: code || 'NOT_FOUND' }) });
function backend(url, opts = {}) {
  const u = new URL(url);
  const body = opts.body ? JSON.parse(opts.body) : undefined;
  const method = opts.method || 'GET';
  calls.push({ path: u.pathname, method, body });
  const w = `/api/workspaces/${T}`;
  if (u.pathname === '/api/workspaces') return reply(200, [{ id: T, name: 'Acme', is_personal: personal, role }]);
  if (u.pathname === `${w}/overview`) return reply(200, { workspace: { id: T }, usage: {}, executions: {}, workflowRuns: {}, approvals: {}, connectors: {}, tasks: {} });
  if (u.pathname === `${w}/members`) return reply(200, [{ user_id: 'u1', role }, { user_id: 'u2', role: 'admin' }, { user_id: 'u3', role: 'member' }]);
  if (u.pathname === `${w}/invitations`) return reply(200, []);
  if (u.pathname === `${w}/transfer-ownership`) return reply(200, { transferred: true });
  if (u.pathname === `${w}/retention` && method === 'GET') return reply(200, retention);
  if (u.pathname === `${w}/retention` && method === 'PUT') { retention = { ...retention, ...body }; return reply(200, retention); }
  if (u.pathname === `${w}/retention/purge`) return reply(200, { workspaceId: T, counts: { workflowRuns: 2, executions: 3, auditRows: 4, usageEvents: 0, reservations: 0 } });
  return reply(404);
}

beforeEach(() => {
  calls = []; role = 'owner'; personal = false; mockUser.emailVerified = true; mockSend.mockClear();
  retention = { executionsDays: null, auditDays: null, usageDays: null, floors: { usageDays: 35, executionsDays: 7, auditDays: 90 } };
  window.localStorage.clear();
  storeWorkspaceId('u1', T);
  global.fetch = jest.fn(backend);
  delete window.location;
  window.location = { search: '', reload: jest.fn(), pathname: '/workspace', hash: '' };
});

test('transfer ownership: owner only, needs an explicit confirmation, posts the chosen member', async () => {
  render(<WorkspacePage />);
  fireEvent.click(await screen.findByRole('tab', { name: 'Team' }));
  const region = await screen.findByRole('region', { name: 'Transfer ownership' });
  const btn = screen.getByRole('button', { name: 'Transfer' });
  expect(btn).toBeDisabled();
  fireEvent.change(screen.getByLabelText('New owner'), { target: { value: 'u2' } });
  expect(btn).toBeDisabled();
  fireEvent.click(screen.getByLabelText('Confirm transfer'));
  expect(btn).not.toBeDisabled();
  fireEvent.click(btn);
  await waitFor(() => expect(calls.some((c) => c.path.endsWith('/transfer-ownership'))).toBe(true));
  expect(calls.find((c) => c.path.endsWith('/transfer-ownership')).body).toEqual({ newOwnerId: 'u2' });
  expect(region).toBeInTheDocument();
});

test('transfer ownership: hidden for admins and for personal workspaces', async () => {
  role = 'admin';
  const { unmount } = render(<WorkspacePage />);
  fireEvent.click(await screen.findByRole('tab', { name: 'Team' }));
  await screen.findByRole('region', { name: 'Members' });
  expect(screen.queryByRole('region', { name: 'Transfer ownership' })).toBeNull();
  unmount();
  role = 'owner'; personal = true;
  render(<WorkspacePage />);
  fireEvent.click(await screen.findByRole('tab', { name: 'Team' }));
  await screen.findByRole('region', { name: 'Members' });
  expect(screen.queryByRole('region', { name: 'Transfer ownership' })).toBeNull();
});

test('verification email: an unverified user can (re)send it from the join section', async () => {
  mockUser.emailVerified = false;
  render(<WorkspacePage />);
  fireEvent.click(await screen.findByRole('tab', { name: 'Team' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Send verification email' }));
  expect(await screen.findByText(/Verification email sent/)).toBeInTheDocument();
  expect(mockSend).toHaveBeenCalledTimes(1);
});

test('verification email: not shown to verified users', async () => {
  render(<WorkspacePage />);
  fireEvent.click(await screen.findByRole('tab', { name: 'Team' }));
  await screen.findByRole('region', { name: 'Join a workspace' });
  expect(screen.queryByTestId('verify-email')).toBeNull();
});

test('data retention: the owner saves days (numbers or null) and can apply the purge now', async () => {
  render(<WorkspacePage />);
  fireEvent.click(await screen.findByRole('tab', { name: 'Data retention' }));
  fireEvent.change(await screen.findByLabelText('Execution retention days'), { target: { value: '30' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  expect(await screen.findByText('Saved.')).toBeInTheDocument();
  expect(calls.find((c) => c.method === 'PUT').body).toEqual({ executionsDays: 30, auditDays: null });
  fireEvent.click(screen.getByRole('button', { name: 'Apply now' }));
  expect(await screen.findByText(/Deleted 2 run\(s\), 3 execution\(s\), 4 audit record\(s\)/)).toBeInTheDocument();
});

test('data retention: admins can view but not change; members are not shown settings', async () => {
  role = 'admin';
  const { unmount } = render(<WorkspacePage />);
  fireEvent.click(await screen.findByRole('tab', { name: 'Data retention' }));
  expect(await screen.findByLabelText('Execution retention days')).toBeDisabled();
  expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
  unmount();
  role = 'member'; calls = [];
  render(<WorkspacePage />);
  fireEvent.click(await screen.findByRole('tab', { name: 'Data retention' }));
  expect(await screen.findByText(/managed by workspace owners and admins/)).toBeInTheDocument();
  expect(calls.some((c) => c.path.endsWith('/retention'))).toBe(false);
});
