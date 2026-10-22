// Task lifecycle: user-facing states, live refresh while active, honest verification wording.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { screen, act } from '@testing-library/react';
import { renderApp, fakeApi, overviewFixture, WS_TEAM, WS_PERSONAL, wsPath } from './helpers.jsx';
import { taskState } from '../lib/format.js';

const W = wsPath();
const base = (exec) => {
  let n = 0;
  const api = fakeApi([
    ['GET', /^\/api\/workspaces$/, [WS_PERSONAL, WS_TEAM]],
    ['GET', /\/overview$/, overviewFixture()],
    ['GET', /\/agents$/, []],
    ['GET', new RegExp(`^${W}/executions/x1$`), () => { n += 1; return typeof exec === 'function' ? exec(n) : exec; }],
    ['GET', new RegExp(`^${W}/executions/x1/evidence$`), { steps: [], approvals: [] }],
  ]);
  api.reads = () => n;
  return api;
};

afterEach(() => { vi.useRealTimers(); });

describe('task lifecycle', () => {
  it('maps backend statuses to clear states', () => {
    expect(taskState('created')).toBe('Queued');
    expect(taskState('executing')).toBe('Running');
    expect(taskState('waiting_approval')).toBe('Awaiting approval');
    expect(taskState('cancelled')).toBe('Cancelled');
  });

  it('a running task refreshes itself and stops once it finishes', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const api = base((n) => ({ id: 'x1', goal: 'Reconcile', status: n < 3 ? 'executing' : 'completed', createdAt: new Date().toISOString(), progress: { stepsExecuted: n, maxSteps: 8 }, verification: n < 3 ? null : { status: 'verified' } }));
    renderApp({ api, path: '/tasks/x1' });
    expect(await screen.findByText(/Live — this page updates/)).toBeInTheDocument();
    expect(screen.getByRole('list', { name: /Task lifecycle: Running/ })).toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(4100); });
    await act(async () => { await vi.advanceTimersByTimeAsync(4100); });
    expect(await screen.findByText(/Result verification: Verified/)).toBeInTheDocument();
    const after = api.reads();
    await act(async () => { await vi.advanceTimersByTimeAsync(12000); });
    expect(api.reads()).toBe(after); // no polling once terminal
  });

  it('completion without verification says so instead of implying it was verified', async () => {
    renderApp({ api: base({ id: 'x1', goal: 'Export', status: 'completed', createdAt: new Date().toISOString(), finishedAt: new Date().toISOString(), verification: null }), path: '/tasks/x1' });
    expect(await screen.findByText(/no independent verification was recorded/)).toBeInTheDocument();
  });

  it('a task paused for approval shows the approval stage as current', async () => {
    renderApp({ api: base({ id: 'x1', goal: 'Email', status: 'waiting_approval', createdAt: new Date().toISOString(), waitingForApproval: { id: 'a1', action: 'send_email', riskTier: 'yellow', requiredRole: 'member', status: 'pending', expiresAt: new Date(Date.now() + 6e5).toISOString() } }), path: '/tasks/x1' });
    const current = await screen.findByText('Approval');
    expect(current.closest('li')).toHaveAttribute('aria-current', 'step');
  });
});

describe('paired devices show real presence', () => {
  it('online and offline devices are labelled from the server presence fields', async () => {
    const api = fakeApi([
      ['GET', /^\/api\/workspaces$/, [WS_PERSONAL, WS_TEAM]],
      ['GET', /\/security$/, { firewall: { enabled: true, policyVersion: 1, isDefault: true }, policy: { emergencyStop: false }, approvalPolicy: { maxRisk: 'red' }, blockedActions: [] }],
      ['GET', /^\/api\/device\/list$/, { success: true, devices: [
        { device_id: 'DESK-ON', created_at: '2026-10-01T00:00:00Z', online: true, lastSeenAt: new Date().toISOString() },
        { device_id: 'DESK-OFF', created_at: '2026-10-01T00:00:00Z', online: false, lastSeenAt: null },
      ] }],
    ]);
    renderApp({ api, path: '/settings' });
    const on = await screen.findByText('DESK-ON');
    expect(on.closest('tr')).toHaveTextContent('Online');
    expect(screen.getByText('DESK-OFF').closest('tr')).toHaveTextContent('Offline');
  });
});
