import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import BillingPage from './BillingPage';
import { storeWorkspaceId } from '../workflows/workflowsApi';

jest.mock('../firebase', () => ({ auth: { currentUser: { uid: 'u1', getIdToken: async () => 'tok-u1' } } }));
jest.mock('firebase/auth', () => ({ onAuthStateChanged: (_a, cb) => { cb({ uid: 'u1' }); return () => {}; } }));

const T = '22222222-2222-4222-8222-222222222222';
let calls; let role; let summary; let assigned;

const base = (over = {}) => ({
  billingEnabled: true, enforcement: 'enforced', customLimits: false,
  plan: { id: 'pro', name: 'Pro', limits: {}, features: {} },
  subscription: { status: 'active', effectiveStatus: 'active', source: 'subscription', provider: 'stripe', cancelAtPeriodEnd: false, currentPeriodStart: '2026-09-01T00:00:00Z', currentPeriodEnd: '2026-10-01T00:00:00Z' },
  period: { start: '2026-09-01T00:00:00Z', end: '2026-10-01T00:00:00Z' },
  payments: { provider: 'stripe', configured: true, checkoutAvailable: true },
  paymentStatus: { provider: 'stripe', configured: true, status: 'configured', checkoutAvailable: true, portalAvailable: true, cancelAvailable: true, hasBillingAccount: true, canManage: true },
  meters: [], totals: {}, ...over,
});
const plans = [
  { id: 'free', name: 'Free', description: 'Try', limits: { executions_per_month: 100, max_members: 3 }, price: null, purchasable: false, features: {} },
  { id: 'pro', name: 'Pro', description: 'Grow', limits: { executions_per_month: 2000, max_members: 10 }, price: { amount: 2999, currency: 'INR', interval: 'month' }, purchasable: true, features: {} },
  { id: 'business', name: 'Business', description: 'Teams', limits: { executions_per_month: 20000, max_members: 50 }, price: null, purchasable: true, features: {} },
  { id: 'enterprise', name: 'Enterprise', description: 'Custom', limits: { executions_per_month: null, max_members: null }, price: null, purchasable: false, features: { manual_activation: true } },
];
const reply = (status, data, code, error) => Promise.resolve({ ok: status < 400, status, json: async () => (status < 400 ? { success: true, data } : { success: false, error: error || 'err', code }) });
function backend(url, opts = {}) {
  const u = new URL(url);
  calls.push({ path: u.pathname, method: opts.method || 'GET', body: opts.body ? JSON.parse(opts.body) : undefined });
  if (u.pathname === '/api/workspaces') return reply(200, [{ id: T, name: 'Acme', is_personal: false, role }]);
  const b = `/api/workspaces/${T}/billing`;
  if (u.pathname === b) return reply(200, summary);
  if (u.pathname === `${b}/dashboard`) return reply(200, { window: { days: 30 }, executions: 0, workflowRuns: 0, steps: 0, connectorCalls: 0, apiCalls: 0, outcomes: {}, successRate: null, failureRate: null, trend: [] });
  if (u.pathname === `${b}/plans`) return reply(200, plans);
  if (u.pathname === `${b}/subscription/portal`) return reply(200, { url: 'https://billing.stripe.test/p/1' });
  if (u.pathname === `${b}/subscription/cancel`) return reply(200, { status: 'cancel_requested', effective: 'period_end' });
  if (u.pathname === `${b}/subscription/checkout`) return reply(200, { url: 'https://checkout.stripe.test/pay/1' });
  return reply(404, null, 'NOT_FOUND');
}

beforeEach(() => {
  calls = []; role = 'owner'; summary = base(); assigned = [];
  window.localStorage.clear();
  storeWorkspaceId('u1', T);
  global.fetch = jest.fn(backend);
  delete window.location;
  window.location = { search: '', assign: (x) => assigned.push(x), pathname: '/billing' };
});

test('M billing (Stripe configured): price shown, Upgrade only for purchasable plans, Enterprise is manual, no fake success', async () => {
  summary = base({ plan: { id: 'free', name: 'Free', limits: {}, features: {} }, subscription: { ...base().subscription, status: 'none', provider: 'none' }, paymentStatus: { ...base().paymentStatus, cancelAvailable: false, portalAvailable: false, hasBillingAccount: false } });
  render(<BillingPage />);
  expect(await screen.findByTestId('provider-status')).toHaveTextContent('Stripe (configured)');
  expect(screen.getByTestId('price-pro')).toHaveTextContent(/2,999.*month/);
  expect(screen.getByTestId('price-business')).toHaveTextContent('contact the Nexus team');
  expect(within(screen.getByTestId('plan-enterprise')).queryByRole('button')).toBeNull();
  expect(screen.getByTestId('plan-enterprise')).toHaveTextContent('activated manually');
  fireEvent.click(within(screen.getByTestId('plan-business')).getByRole('button', { name: 'Switch to Business' }));
  await waitFor(() => expect(assigned).toEqual(['https://checkout.stripe.test/pay/1']));
  expect(calls.find((c) => c.path.endsWith('/checkout')).body).toEqual({ planId: 'business' });
  expect(screen.getByRole('button', { name: 'Manage subscription' })).toBeDisabled();
});

test('M billing: Manage opens the provider portal; Cancel needs a confirmation and does not claim the plan changed', async () => {
  render(<BillingPage />);
  fireEvent.click(await screen.findByRole('button', { name: 'Manage subscription' }));
  await waitFor(() => expect(assigned).toEqual(['https://billing.stripe.test/p/1']));
  fireEvent.click(screen.getByRole('button', { name: 'Cancel subscription' }));
  expect(calls.some((c) => c.path.endsWith('/cancel'))).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: /Confirm: cancel at the end of the period/ }));
  expect(await screen.findByRole('status')).toHaveTextContent('stays active until the end of the paid period');
  expect(calls.filter((c) => c.path.endsWith('/cancel'))).toHaveLength(1);
});

test('M billing: not configured → "Payments are not configured for this deployment." and owners see which settings are missing', async () => {
  summary = base({
    payments: { provider: 'stripe', configured: false, checkoutAvailable: false },
    paymentStatus: { provider: 'stripe', configured: false, status: 'not_configured', message: 'Payments are not configured for this deployment.', checkoutAvailable: false, portalAvailable: false, cancelAvailable: false, canManage: true, missingConfiguration: ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET'] },
  });
  render(<BillingPage />);
  expect(await screen.findByTestId('payments-unavailable')).toHaveTextContent('Payments are not configured for this deployment.');
  expect(screen.getByTestId('provider-status')).toHaveTextContent('missing server settings: STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET');
  expect(screen.queryByRole('button', { name: 'Manage subscription' })).toBeNull();
  expect(within(screen.getByTestId('plan-business')).getByRole('button')).toBeDisabled();
});

test('M billing: members see status but no subscription actions; a checkout return never claims success', async () => {
  role = 'member';
  summary = base({ paymentStatus: { ...base().paymentStatus, checkoutAvailable: false, portalAvailable: false, cancelAvailable: false, canManage: false } });
  window.location.search = '?checkout=success';
  render(<BillingPage />);
  expect(await screen.findByRole('status')).toHaveTextContent('confirming your payment');
  expect(screen.getByRole('status')).not.toHaveTextContent(/succeeded|successful|paid/i);
  const biz = await screen.findByTestId('plan-business');
  expect(within(biz).getByRole('button')).toBeDisabled();
  expect(screen.queryByRole('button', { name: 'Manage subscription' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Cancel subscription' })).toBeNull();
});
