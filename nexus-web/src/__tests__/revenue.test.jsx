// Plans / upgrade (only what the server says is possible) and the Insights view.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent, waitFor } from '@testing-library/react';
import { renderApp, fakeApi, overviewFixture, WS_TEAM, WS_PERSONAL, wsPath } from './helpers.jsx';

vi.mock('../lib/redirect.js', () => ({ redirectTo: vi.fn() }));
import { redirectTo } from '../lib/redirect.js';

const W = wsPath();
const PLANS = [
  { id: 'free', name: 'Free', limits: { executions_per_month: 100, max_members: 3 }, features: { support: 'community' }, purchasable: false },
  { id: 'starter', name: 'Starter', limits: { executions_per_month: 500, max_members: 5 }, features: { support: 'email' }, purchasable: true },
  { id: 'pro', name: 'Pro', limits: { executions_per_month: 2000, max_members: 10 }, features: { support: 'email' }, purchasable: true },
  { id: 'enterprise', name: 'Enterprise', limits: { executions_per_month: null, max_members: null }, features: { support: 'dedicated', manual_activation: true }, purchasable: false },
];
function summary(payment) {
  return {
    billingEnabled: true, plan: { id: 'free', name: 'Free' }, customLimits: false, period: { start: '2026-10-01T00:00:00Z', end: '2026-11-01T00:00:00Z' },
    subscription: { status: 'none', effectiveStatus: 'none' }, payments: { provider: payment.configured ? 'stripe' : 'none', configured: !!payment.configured, checkoutAvailable: !!payment.checkoutAvailable },
    paymentStatus: { configured: false, checkoutAvailable: false, portalAvailable: false, cancelAvailable: false, ...payment }, meters: [],
  };
}
const routes = (payment, extra = [], list = [WS_PERSONAL, WS_TEAM]) => fakeApi([
  ...extra,
  ['GET', /^\/api\/workspaces$/, list],
  ['GET', new RegExp(`^${W}/billing$`), summary(payment)],
  ['GET', new RegExp(`^${W}/billing/plans$`), PLANS],
  ['GET', /\/overview$/, overviewFixture()],
  ['GET', /\/agents$/, []],
]);

beforeEach(() => { redirectTo.mockClear(); });

describe('plans and upgrade', () => {
  it('without a payment provider no purchase is offered and limits are shown from the server', async () => {
    const api = routes({ configured: false });
    renderApp({ api, path: '/billing' });
    expect(await screen.findByLabelText('Starter plan')).toHaveTextContent('500');
    expect(screen.getByText(/Online purchase is not available on this deployment/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Choose / })).not.toBeInTheDocument();
    expect(screen.getByLabelText('Enterprise plan')).toHaveTextContent('Unlimited');
    expect(screen.getByLabelText('Enterprise plan')).toHaveTextContent('Arranged with the Nexus team.');
  });

  it('with checkout available, choosing a plan starts a server checkout and follows only its https URL', async () => {
    const api = routes({ configured: true, checkoutAvailable: true }, [
      ['POST', new RegExp(`^${W}/billing/subscription/checkout$`), (m, opts) => ({ url: `https://checkout.stripe.com/c/${opts.body.planId}`, provider: 'stripe' })],
    ]);
    renderApp({ api, path: '/billing' });
    fireEvent.click(await screen.findByRole('button', { name: 'Choose Starter' }));
    await waitFor(() => expect(redirectTo).toHaveBeenCalledWith('https://checkout.stripe.com/c/starter'));
    expect(screen.queryByRole('button', { name: 'Choose Enterprise' })).not.toBeInTheDocument();
  });

  it('a non-https or script URL from the server is never followed', async () => {
    const api = routes({ configured: true, checkoutAvailable: true }, [
      ['POST', new RegExp(`^${W}/billing/subscription/checkout$`), { url: 'javascript:alert(1)' }],
    ]);
    renderApp({ api, path: '/billing' });
    fireEvent.click(await screen.findByRole('button', { name: 'Choose Pro' }));
    await waitFor(() => expect(api.calls.some((c) => c.path.endsWith('/checkout'))).toBe(true));
    expect(redirectTo).not.toHaveBeenCalled();
  });

  it('server refusals are shown (e.g. plan cannot be bought online)', async () => {
    const { ApiError } = await import('../lib/api.js');
    const api = routes({ configured: true, checkoutAvailable: true }, [
      ['POST', new RegExp(`^${W}/billing/subscription/checkout$`), () => { throw new ApiError(400, 'PLAN_NOT_PURCHASABLE', 'This plan cannot be bought online.'); }],
    ]);
    renderApp({ api, path: '/billing' });
    fireEvent.click(await screen.findByRole('button', { name: 'Choose Pro' }));
    expect(await screen.findByText('This plan cannot be bought online.')).toBeInTheDocument();
  });

  it('members never get purchase buttons', async () => {
    renderApp({ api: routes({ configured: true, checkoutAvailable: true }, [], [WS_PERSONAL, { ...WS_TEAM, role: 'member' }]), path: '/billing' });
    expect(await screen.findByLabelText('Pro plan')).toHaveTextContent('Owners and admins change plans.');
    expect(screen.queryByRole('button', { name: /^Choose / })).not.toBeInTheDocument();
  });
});

describe('Insights', () => {
  const dash = {
    window: { from: '2026-09-21T00:00:00Z', to: '2026-10-21T00:00:00Z', days: 30 }, executions: 42, workflowRuns: 7, steps: 210, connectorCalls: 15, apiCalls: 3,
    outcomes: { completed: 30, failed: 4, cancelled: 0 }, successRate: 88.2, failureRate: 11.8,
    trend: Array.from({ length: 30 }, (_, i) => ({ day: `2026-10-${String(i + 1).padStart(2, '0')}`, executions: i % 3, workflowRuns: i % 2, steps: 1 })),
  };
  const api = () => fakeApi([
    ['GET', /^\/api\/workspaces$/, [WS_PERSONAL, WS_TEAM]],
    ['GET', new RegExp(`^${W}/billing/dashboard\\?days=\\d+$`), (m, o, path) => ({ ...dash, window: { ...dash.window, days: Number(path.split('=')[1]) > 30 ? 30 : Number(path.split('=')[1]) } })],
    ['GET', /\/overview$/, overviewFixture()],
  ]);

  it('shows ledger figures and charts; time saved appears only with the user\'s own assumption', async () => {
    renderApp({ api: api(), path: '/insights' });
    expect(await screen.findByTestId('ins-executions')).toHaveTextContent('42');
    expect(screen.getByTestId('ins-success')).toHaveTextContent('88.2%');
    expect(screen.getByRole('img', { name: /Agent executions per day/ })).toBeInTheDocument();
    expect(screen.getByText('Enter your own assumption to see an estimate.')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Minutes a person would spend per task'), { target: { value: '12' } });
    expect(await screen.findByText(/30 completed tasks × 12 min ÷ 60/)).toBeInTheDocument();
    expect(screen.getByText('6')).toBeInTheDocument(); // 30 × 12 / 60
  });

  it('says when plan retention shortens the requested range', async () => {
    const a = api();
    renderApp({ api: a, path: '/insights' });
    fireEvent.click(await screen.findByRole('tab', { name: '90 days' }));
    expect(await screen.findByText(/keeps usage history for 30 days/)).toBeInTheDocument();
    expect(a.calls.some((c) => c.path.endsWith('days=90'))).toBe(true);
  });
});
