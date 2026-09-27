import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import BillingPage from './BillingPage';
import { storeWorkspaceId } from '../workflows/workflowsApi';

jest.mock('../firebase', () => ({ auth: { currentUser: { uid: 'u1', getIdToken: async () => 'tok-u1' } } }));
jest.mock('firebase/auth', () => ({ onAuthStateChanged: (_a, cb) => { cb({ uid: 'u1' }); return () => {}; } }));

const P = '11111111-1111-4111-8111-111111111111';
const T = '22222222-2222-4222-8222-222222222222';
let calls; let role; let summary; let revoked;

const baseSummary = () => ({
  billingEnabled: true, enforcement: 'enforced',
  plan: { id: 'pro', name: 'Pro', limits: {} },
  subscription: { status: 'active', effectiveStatus: 'active', source: 'subscription', provider: 'manual', cancelAtPeriodEnd: false, currentPeriodStart: '2026-09-01T00:00:00Z', currentPeriodEnd: '2026-10-01T00:00:00Z' },
  period: { start: '2026-09-01T00:00:00Z', end: '2026-10-01T00:00:00Z' },
  payments: { provider: 'none', configured: false, checkoutAvailable: false },
  meters: [
    { capability: 'executions', kind: 'metered', limit: 2000, used: 1900, remaining: 100, unlimited: false },
    { capability: 'workflow_runs', kind: 'metered', limit: 1000, used: 10, remaining: 990, unlimited: false },
    { capability: 'api_calls', kind: 'metered', limit: null, used: 42, remaining: null, unlimited: true },
    { capability: 'members', kind: 'count', limit: 10, used: 3, remaining: 7, unlimited: false },
  ],
  totals: { agent_execution: 1900 },
});
const dashboard = {
  window: { from: '2026-08-26', to: '2026-09-25', days: 30 },
  executions: 1900, workflowRuns: 10, steps: 5000, connectorCalls: 77, apiCalls: 42,
  outcomes: { completed: 1800, failed: 90, cancelled: 10 }, successRate: 94.7, failureRate: 4.7,
  trend: Array.from({ length: 30 }, (_, i) => ({ day: `2026-09-${String(i + 1).padStart(2, '0')}`, executions: i, workflowRuns: 0, steps: i * 2 })),
};
const plans = [
  { id: 'free', name: 'Free', description: 'Try it', limits: { executions_per_month: 100, max_members: 3 }, price: null },
  { id: 'pro', name: 'Pro', description: 'Grow', limits: { executions_per_month: 2000, max_members: 10 }, price: null },
  { id: 'enterprise', name: 'Enterprise', description: 'Custom', limits: { executions_per_month: null, max_members: null }, price: null },
];

const reply = (status, data, code) => Promise.resolve({ ok: status < 400, status, json: async () => (status < 400 ? { success: true, data } : { success: false, error: code === 'PAYMENTS_UNAVAILABLE' ? 'Online payment is not set up on this server yet.' : 'Not found', code: code || 'NOT_FOUND' }) });
function backend(url, opts = {}) {
  const u = new URL(url);
  calls.push({ path: u.pathname, method: opts.method || 'GET', body: opts.body ? JSON.parse(opts.body) : undefined });
  if (u.pathname === '/api/workspaces') return reply(200, [{ id: P, name: 'Personal', is_personal: true, role: 'owner' }, { id: T, name: 'Acme', is_personal: false, role }]);
  if (revoked) return reply(404);
  const b = `/api/workspaces/${T}/billing`;
  if (u.pathname === b) return reply(200, summary);
  if (u.pathname === `${b}/dashboard`) return reply(200, dashboard);
  if (u.pathname === `${b}/plans`) return reply(200, plans);
  if (u.pathname === `${b}/subscription/checkout`) return reply(501, null, 'PAYMENTS_UNAVAILABLE');
  return reply(404);
}

beforeEach(() => {
  calls = []; role = 'member'; summary = baseSummary(); revoked = false;
  window.localStorage.clear();
  storeWorkspaceId('u1', T);
  global.fetch = jest.fn(backend);
});

test('W billing: plan, status, period, meters (used / limit / remaining, unlimited) come from the server', async () => {
  render(<BillingPage />);
  expect(await screen.findByTestId('plan-name')).toHaveTextContent('Pro');
  expect(screen.getByTestId('sub-status')).toHaveTextContent('Active');
  expect(screen.getByTestId('period')).toHaveTextContent('Usage period');
  expect(screen.getByTestId('meter-executions')).toHaveTextContent('1,900 / 2,000 · 100 left');
  expect(screen.getByTestId('meter-api_calls')).toHaveTextContent('42 used · Unlimited');
  expect(screen.getByTestId('meter-members')).toHaveTextContent('3 / 10 · 7 left');
  expect(screen.getByRole('progressbar', { name: 'Agent executions / month' })).toHaveAttribute('aria-valuenow', '95');
  expect(calls.every((c) => c.method === 'GET')).toBe(true);
});

test('W billing: no payment provider → clearly labelled, upgrade buttons disabled even for owners (no fake payment)', async () => {
  role = 'owner';
  render(<BillingPage />);
  expect(await screen.findByTestId('payments-unavailable')).toBeInTheDocument();
  const btn = within(screen.getByTestId('plan-enterprise')).getByRole('button');
  expect(btn).toBeDisabled();
  expect(btn).toHaveTextContent('(unavailable)');
  expect(screen.getByTestId('plan-pro')).toHaveTextContent('(current)');
  fireEvent.click(btn);
  expect(calls.some((c) => c.path.endsWith('/subscription/checkout'))).toBe(false);
});

test('W billing: BILLING_ENABLED off and lapsed subscriptions are stated plainly', async () => {
  summary = { ...baseSummary(), billingEnabled: false, enforcement: 'not_enforced', plan: { id: 'free', name: 'Free', limits: {} },
    subscription: { ...baseSummary().subscription, status: 'expired', source: 'default', effectivePlanReason: 'EXPIRED' } };
  render(<BillingPage />);
  expect(await screen.findByTestId('not-enforced')).toBeInTheDocument();
  expect(screen.getByTestId('sub-status')).toHaveTextContent('Expired');
  expect(screen.getByText(/Free plan limits apply/)).toBeInTheDocument();
});

test('W billing: a checkout that the server refuses shows the server message', async () => {
  role = 'admin';
  summary = { ...baseSummary(), payments: { provider: 'stripe', configured: true, checkoutAvailable: true } };
  render(<BillingPage />);
  const btn = await waitFor(() => within(screen.getByTestId('plan-enterprise')).getByRole('button'));
  expect(btn).not.toBeDisabled();
  fireEvent.click(btn);
  expect(await screen.findByRole('alert')).toHaveTextContent('Online payment is not set up');
  expect(calls.find((c) => c.path.endsWith('/subscription/checkout')).body).toEqual({ planId: 'enterprise' });
});

test('X usage dashboard: executions, runs, success/failure rate, steps, connector + API calls and a 30-day trend', async () => {
  render(<BillingPage />);
  expect(await screen.findByTestId('stat-Executions')).toHaveTextContent('1,900');
  expect(screen.getByTestId('stat-Workflow runs')).toHaveTextContent('10');
  expect(screen.getByTestId('stat-Success rate')).toHaveTextContent('94.7%');
  expect(screen.getByTestId('stat-Failure rate')).toHaveTextContent('4.7%');
  expect(screen.getByTestId('stat-Steps')).toHaveTextContent('5,000');
  expect(screen.getByTestId('stat-Connector calls')).toHaveTextContent('77');
  expect(screen.getByTestId('stat-API calls')).toHaveTextContent('42');
  expect(screen.getAllByTestId('trend-bar')).toHaveLength(30);
});

test('X lost access to a workspace → a clear message, no stale numbers', async () => {
  revoked = true;
  render(<BillingPage />);
  expect(await screen.findByRole('alert')).toHaveTextContent('no longer have access');
  expect(screen.queryByTestId('plan-name')).toBeNull();
});
