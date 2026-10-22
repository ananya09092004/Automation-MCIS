import { describe, it, expect } from 'vitest';
import { screen, fireEvent, waitFor, within } from '@testing-library/react';
import { ApiError } from '../lib/api.js';
import { pickWorkspace } from '../lib/workspace.jsx';
import { matchPath } from '../lib/router.jsx';
import { renderApp, fakeApi, fakeAuth, overviewFixture, WS_TEAM, WS_PERSONAL, wsPath } from './helpers.jsx';

const W = wsPath();
const base = (extra = []) => [
  ...extra,
  ['GET', /^\/api\/workspaces$/, [WS_PERSONAL, WS_TEAM]],
  ['GET', new RegExp(`^${W}/overview$`), overviewFixture()],
  ['GET', new RegExp(`^${W}/agents$`), [{ id: 'a1', name: 'Research', role: 'research', status: 'active', maxRisk: 'yellow', allowedIntegrationIds: [], createdAt: '2026-10-01T00:00:00Z' }, { id: 'a2', name: 'Old', role: 'data', status: 'archived', maxRisk: 'green', allowedIntegrationIds: [], createdAt: '2026-10-01T00:00:00Z' }]],
];

describe('authentication', () => {
  it('shows sign-in when signed out and never calls the API', async () => {
    const api = fakeApi(base());
    renderApp({ api, auth: fakeAuth({ user: null }) });
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
    expect(api.calls).toHaveLength(0);
  });

  it('maps Firebase errors to a readable message', async () => {
    const err = Object.assign(new Error('x'), { code: 'auth/invalid-credential' });
    renderApp({ api: fakeApi(base()), auth: fakeAuth({ user: null, signInError: err }) });
    fireEvent.change(await screen.findByLabelText('Email'), { target: { value: 'a@b.co' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'pw' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByText('Email or password is incorrect.')).toBeInTheDocument();
  });

  it('validates the sign-in form before calling Firebase', async () => {
    renderApp({ api: fakeApi(base()), auth: fakeAuth({ user: null }) });
    fireEvent.click(await screen.findByRole('button', { name: 'Sign in' }));
    expect(await screen.findByText('Enter your email and password.')).toBeInTheDocument();
  });
});

describe('dashboard', () => {
  it('shows real figures from the overview API and the selected team workspace', async () => {
    const api = fakeApi(base());
    renderApp({ api });
    const succeeded = await screen.findByTestId('stat-succeeded');
    expect(within(succeeded).getByText('9')).toBeInTheDocument();
    expect(within(screen.getByTestId('stat-failed')).getByText('2')).toBeInTheDocument();
    expect(within(screen.getByTestId('stat-agents')).getByText('1')).toBeInTheDocument(); // only "active" agents
    expect(within(screen.getByTestId('stat-running')).getByText('1')).toBeInTheDocument();
    expect(within(screen.getByTestId('stat-approvals')).getByText('1')).toBeInTheDocument();
    expect(screen.getByText('Summarize overdue GST filings')).toBeInTheDocument();
    // Team workspace is preferred over the personal one; data comes from its URL only.
    expect(api.calls.some((c) => c.path === `${W}/overview`)).toBe(true);
    expect(api.calls.some((c) => c.path.includes(WS_PERSONAL.id))).toBe(false);
  });

  it('treats a disabled agents module as "not enabled", not as an error', async () => {
    const api = fakeApi([['GET', new RegExp(`^${W}/agents$`), () => { throw new ApiError(404, 'NOT_FOUND', 'x'); }], ...base()]);
    renderApp({ api });
    expect(await screen.findByText('Agents module not enabled')).toBeInTheDocument();
  });

  it('shows an empty state for a workspace without activity', async () => {
    const empty = overviewFixture({ executions: { sample: 0, byStatus: {}, recent: [], successRate: null, latencyMs: {} }, workflowRuns: { sample: 0, byStatus: {} }, approvals: { waiting: 0, oldestWaitMinutes: null } });
    renderApp({ api: fakeApi([['GET', new RegExp(`^${W}/overview$`), empty], ...base()]) });
    expect(await screen.findByText('No activity in this workspace yet')).toBeInTheDocument();
  });

  it('shows an error state with retry when the overview fails', async () => {
    let fail = true;
    const api = fakeApi([['GET', new RegExp(`^${W}/overview$`), () => { if (fail) throw new ApiError(500, 'X', 'The server had a problem handling this request.'); return overviewFixture(); }], ...base()]);
    renderApp({ api });
    expect(await screen.findByText('Could not load the dashboard')).toBeInTheDocument();
    fail = false;
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByTestId('stat-succeeded')).toBeInTheDocument();
  });
});

describe('Ask Nexus (create task)', () => {
  it('validates, starts a real execution with an idempotency key, and opens it', async () => {
    const api = fakeApi([
      ['POST', new RegExp(`^${W}/executions$`), (m, opts) => ({ id: 'exec-new', status: 'created', goal: opts.body.goal })],
      ['GET', new RegExp(`^${W}/executions/exec-new$`), { id: 'exec-new', status: 'planning', goal: 'Check filings', createdAt: new Date().toISOString(), progress: { stepsExecuted: 0, maxSteps: 8 }, evidenceSummary: null }],
      ['GET', new RegExp(`^${W}/executions/exec-new/evidence$`), { steps: [], approvals: [] }],
      ...base(),
    ]);
    renderApp({ api });
    fireEvent.click((await screen.findAllByRole('button', { name: /Ask Nexus/ }))[0]);
    const dialog = await screen.findByRole('dialog', { name: 'Ask Nexus' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Start task' }));
    expect(await within(dialog).findByText('Describe what Nexus should do.')).toBeInTheDocument();
    expect(api.calls.some((c) => c.method === 'POST')).toBe(false);

    fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: '  Check filings  ' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Start task' }));
    expect(await screen.findByRole('heading', { name: 'Check filings' })).toBeInTheDocument();
    const post = api.calls.find((c) => c.method === 'POST');
    expect(post.path).toBe(`${W}/executions`);
    expect(post.body).toEqual({ goal: 'Check filings' });
    expect(post.headers['Idempotency-Key']).toMatch(/^nexus-/);
    expect(window.location.pathname).toBe('/tasks/exec-new');
  });

  it('shows the server reason when starting is refused (e.g. plan limit)', async () => {
    const api = fakeApi([['POST', new RegExp(`^${W}/executions$`), () => { throw new ApiError(402, 'QUOTA_EXCEEDED', 'Monthly execution limit reached for your plan.'); }], ...base()]);
    renderApp({ api });
    fireEvent.click((await screen.findAllByRole('button', { name: /Ask Nexus/ }))[0]);
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: 'do it' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Start task' }));
    expect(await within(dialog).findByText('Monthly execution limit reached for your plan.')).toBeInTheDocument();
  });
});

describe('approvals', () => {
  const approval = { id: 'appr-1', action: 'send_email', riskTier: 'red', reason: 'Sends an external email', requiredRole: 'admin', status: 'pending', expiresAt: '2026-10-20T00:00:00Z' };
  const runApproval = { ...approval, id: 'appr-2', action: 'submit_form', riskTier: 'yellow' };
  const routes = (decide) => [
    ['GET', new RegExp(`^${W}/executions\\?limit=100$`), [{ id: 'exec-w', status: 'waiting_approval', goal: 'Email the client' }, { id: 'exec-d', status: 'completed', goal: 'done' }]],
    ['GET', new RegExp(`^${W}/executions/exec-w$`), { id: 'exec-w', status: 'waiting_approval', goal: 'Email the client', waitingForApproval: approval }],
    ['GET', new RegExp(`^${W}/workflow-runs\\?limit=50$`), [{ id: 'run-1', status: 'waiting_approval' }]],
    ['GET', new RegExp(`^${W}/workflow-runs/run-1$`), { id: 'run-1', status: 'waiting_approval', steps: [{ position: 0, key: 'submit', name: 'Submit form', execution: { waitingForApproval: runApproval } }] }],
    ['POST', /\/approvals\/appr-1\/approve$/, decide],
    ['POST', /\/approvals\/appr-2\/reject$/, { ok: true }],
    ...base(),
  ];

  it('lists approvals from tasks and workflow runs and decides through the right endpoint', async () => {
    const api = fakeApi(routes({ ok: true }));
    renderApp({ api, path: '/approvals' });
    const cards = await screen.findAllByTestId('approval');
    expect(cards).toHaveLength(2);
    expect(screen.getByText('Email the client')).toBeInTheDocument();
    expect(screen.getByText('Workflow run step "Submit form"')).toBeInTheDocument();
    const taskCard = cards.find((c) => within(c).queryByText('Email the client'));
    fireEvent.change(within(taskCard).getByPlaceholderText(/Optional note/), { target: { value: 'checked' } });
    fireEvent.click(within(taskCard).getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(api.calls.some((c) => c.method === 'POST' && c.path === `${W}/executions/exec-w/approvals/appr-1/approve`)).toBe(true));
    expect(api.calls.find((c) => c.method === 'POST').body).toEqual({ note: 'checked' });
    const runCard = cards.find((c) => within(c).queryByText('Workflow run step "Submit form"'));
    fireEvent.click(within(runCard).getByRole('button', { name: 'Reject' }));
    await waitFor(() => expect(api.calls.some((c) => c.path === `${W}/workflow-runs/run-1/steps/0/approvals/appr-2/reject`)).toBe(true));
  });

  it('shows the server refusal (role / separation of duties) instead of pretending', async () => {
    const api = fakeApi(routes(() => { throw new ApiError(403, 'APPROVAL_FORBIDDEN', 'You cannot approve an action you requested.'); }));
    renderApp({ api, path: '/approvals' });
    const cards = await screen.findAllByTestId('approval');
    const taskCard = cards.find((c) => within(c).queryByText('Email the client'));
    fireEvent.click(within(taskCard).getByRole('button', { name: 'Approve' }));
    expect(await within(taskCard).findByText('You cannot approve an action you requested.')).toBeInTheDocument();
  });

  it('shows an empty state when nothing waits', async () => {
    const api = fakeApi([
      ['GET', new RegExp(`^${W}/executions\\?limit=100$`), []],
      ['GET', new RegExp(`^${W}/workflow-runs\\?limit=50$`), []],
      ...base(),
    ]);
    renderApp({ api, path: '/approvals' });
    expect(await screen.findByText('Nothing waiting for approval')).toBeInTheDocument();
  });
});

describe('roles and workspace isolation', () => {
  it('members see an admins-only notice for Activity and the audit API is never called', async () => {
    const member = { ...WS_TEAM, role: 'member' };
    const api = fakeApi([['GET', /^\/api\/workspaces$/, [member]], ...base()]);
    renderApp({ api, path: '/activity' });
    expect(await screen.findByText('Admins only')).toBeInTheDocument();
    expect(api.calls.some((c) => c.path.includes('/audit') || c.path.includes('/security'))).toBe(false);
  });

  it('admins see the audit log', async () => {
    const api = fakeApi([['GET', new RegExp(`^${W}/audit\\?limit=100$`), [{ id: 1, action: 'workspace.member_added', userId: 'uid_bob', success: true, createdAt: '2026-10-01T10:00:00Z' }]], ...base()]);
    renderApp({ api, path: '/activity' });
    expect(await screen.findByText('Workspace.member added')).toBeInTheDocument();
  });

  it('switching workspace reloads every request against the newly selected workspace only', async () => {
    const P = wsPath(WS_PERSONAL);
    const api = fakeApi([
      ['GET', new RegExp(`^${P}/overview$`), overviewFixture({ workspace: { id: WS_PERSONAL.id, name: 'Personal', isPersonal: true, role: 'owner' }, executions: { sample: 1, byStatus: { completed: 5 }, recent: [], successRate: 100, latencyMs: {} } })],
      ['GET', new RegExp(`^${P}/agents$`), []],
      ...base(),
    ]);
    renderApp({ api });
    await screen.findByTestId('stat-succeeded');
    const before = api.calls.length;
    fireEvent.change(screen.getByLabelText('Workspace'), { target: { value: WS_PERSONAL.id } });
    await waitFor(() => expect(within(screen.getByTestId('stat-succeeded')).getByText('5')).toBeInTheDocument());
    const ACCOUNT_LEVEL = ['/api/workspaces', '/api/onboarding']; // the caller's own account, not workspace data
    const all = api.calls.slice(before);
    const after = all.filter((c) => !ACCOUNT_LEVEL.includes(c.path));
    expect(after.length).toBeGreaterThan(0);
    expect(after.every((c) => c.path.startsWith(P))).toBe(true);
    expect(all.some((c) => c.path.startsWith(W))).toBe(false); // nothing from the previous workspace
    expect(window.localStorage.getItem('nexus.workspace.uid_alice')).toBe(WS_PERSONAL.id);
  });

  it('prefers a stored workspace, then a team workspace', () => {
    expect(pickWorkspace([WS_PERSONAL, WS_TEAM], WS_PERSONAL.id).id).toBe(WS_PERSONAL.id);
    expect(pickWorkspace([WS_PERSONAL, WS_TEAM], 'gone').id).toBe(WS_TEAM.id);
    expect(pickWorkspace([], null)).toBeNull();
  });

  it('shows an error state when workspaces cannot be loaded', async () => {
    const api = fakeApi([['GET', /^\/api\/workspaces$/, () => { throw new ApiError(0, 'NETWORK_ERROR', 'Cannot reach the Nexus API.'); }]]);
    renderApp({ api });
    expect(await screen.findByText('Could not load your workspaces')).toBeInTheDocument();
    expect(screen.getByText('Cannot reach the Nexus API.')).toBeInTheDocument();
  });
});

describe('billing is shown honestly', () => {
  it('says "Not configured" when no payment provider exists and shows server meters', async () => {
    const summary = {
      billingEnabled: false, plan: { id: 'free', name: 'Free' }, customLimits: false, period: { start: '2026-10-01T00:00:00Z', end: '2026-11-01T00:00:00Z' },
      subscription: { status: 'none', effectiveStatus: 'none', trialEndsAt: null, cancelAtPeriodEnd: false },
      payments: { provider: 'none', configured: false, checkoutAvailable: false },
      meters: [{ capability: 'executions_per_month', limit: 100, used: 80, unlimited: false }, { capability: 'members', limit: null, used: 3, unlimited: true }],
    };
    renderApp({ api: fakeApi([['GET', new RegExp(`^${W}/billing$`), summary], ...base()]), path: '/billing' });
    expect(await screen.findByText('Not configured')).toBeInTheDocument();
    expect(screen.getByText(/No payments are taken/)).toBeInTheDocument();
    expect(screen.getByText('Metering only')).toBeInTheDocument();
    expect(screen.getByRole('meter', { name: /Executions per month 80%/ })).toBeInTheDocument();
    expect(screen.getByText('Unlimited')).toBeInTheDocument();
    expect(screen.queryByText(/\$|₹|invoice #/i)).toBeNull();
  });
});

describe('other pages', () => {
  it('integrations: a 404 means "not enabled on this server"', async () => {
    renderApp({ api: fakeApi(base()), path: '/integrations' });
    expect(await screen.findByText('Integrations are not enabled on this server')).toBeInTheDocument();
  });

  it('team: an invitation without email delivery shows the one-time code', async () => {
    const api = fakeApi([
      ['GET', new RegExp(`^${W}/members$`), [{ user_id: 'uid_alice', role: 'owner', created_at: '2026-10-01T00:00:00Z' }]],
      ['GET', new RegExp(`^${W}/invitations$`), []],
      ['POST', new RegExp(`^${W}/invitations$`), { invitation: { id: 'i1' }, token: 'one-time-code-xyz', email: { status: 'not_configured' } }],
      ...base(),
    ]);
    renderApp({ api, path: '/team' });
    fireEvent.change(await screen.findByLabelText('Email'), { target: { value: 'not-an-email' } });
    fireEvent.click(screen.getByRole('button', { name: 'Invite' }));
    expect(await screen.findByText('Enter a valid email address.')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'Bob@Acme.test' } });
    fireEvent.click(screen.getByRole('button', { name: 'Invite' }));
    expect(await screen.findByText('one-time-code-xyz')).toBeInTheDocument();
    expect(api.calls.find((c) => c.method === 'POST').body).toEqual({ email: 'bob@acme.test', role: 'member' });
  });

  it('task detail: an approval can be decided inline and errors are shown', async () => {
    const api = fakeApi([
      ['GET', new RegExp(`^${W}/executions/e9$`), { id: 'e9', status: 'waiting_approval', goal: 'Pay vendor', createdAt: '2026-10-01T00:00:00Z', progress: { stepsExecuted: 2, maxSteps: 8 }, waitingForApproval: { id: 'ap9', action: 'payment', riskTier: 'red', requiredRole: 'owner', status: 'pending', expiresAt: '2026-10-02T00:00:00Z' }, evidenceSummary: { succeeded: 2, failed: 0, verified: 1, unverified: 1, retriesOrRecoveries: 0 } }],
      ['GET', new RegExp(`^${W}/executions/e9/evidence$`), { steps: [{ index: 0, action: 'open_page', riskTier: 'green', status: 'succeeded', verification: { status: 'verified' } }], approvals: [] }],
      ['POST', /\/approvals\/ap9\/reject$/, { ok: true }],
      ...base(),
    ]);
    renderApp({ api, path: '/tasks/e9' });
    expect(await screen.findByText('Approval required')).toBeInTheDocument();
    expect(screen.getByText('Open page')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Reject' }));
    await waitFor(() => expect(api.calls.some((c) => c.path === `${W}/executions/e9/approvals/ap9/reject`)).toBe(true));
  });

  it('sidebar links navigate client-side (no full page load) and mark the active page', async () => {
    const api = fakeApi([['GET', new RegExp(`^${W}/agents$`), []], ...base()]);
    renderApp({ api });
    await screen.findByTestId('stat-succeeded');
    const link = screen.getByRole('link', { name: 'AI Agents' });
    const notPrevented = fireEvent.click(link); // false when preventDefault() was called
    expect(notPrevented).toBe(false);
    expect(await screen.findByRole('heading', { name: 'AI Agents' })).toBeInTheDocument();
    expect(window.location.pathname).toBe('/agents');
    expect(screen.getByRole('link', { name: 'AI Agents' })).toHaveAttribute('aria-current', 'page');
  });

  it('settings: lists paired devices and revokes one', async () => {
    const devices = [{ device_id: 'LAPTOP-1', created_at: '2026-10-01T00:00:00Z' }];
    const api = fakeApi([
      ['GET', /^\/api\/device\/list$/, () => ({ success: true, devices: [...devices] })],
      ['DELETE', /^\/api\/device\/LAPTOP-1$/, () => { devices.length = 0; return { revoked: 'LAPTOP-1' }; }],
      ['GET', new RegExp(`^${W}/security$`), { firewall: { enabled: true, policyVersion: 1, isDefault: true }, policy: { emergencyStop: false }, approvalPolicy: { maxRisk: 'green' }, blockedActions: [] }],
      ...base(),
    ]);
    window.confirm = () => true;
    renderApp({ api, path: '/settings' });
    expect(await screen.findByText('LAPTOP-1')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Revoke' }));
    expect(await screen.findByText('No paired devices.')).toBeInTheDocument();
    expect(api.calls.some((c) => c.method === 'DELETE' && c.path === '/api/device/LAPTOP-1')).toBe(true);
  });

  it('unknown routes show a not-found page inside the app', async () => {
    renderApp({ api: fakeApi(base()), path: '/nope' });
    expect(await screen.findByText('Page not found')).toBeInTheDocument();
  });

  it('router matches parameters', () => {
    expect(matchPath('/tasks/:id', '/tasks/abc')).toEqual({ id: 'abc' });
    expect(matchPath('/tasks/:id', '/tasks')).toBeNull();
    expect(matchPath('/', '/')).toEqual({});
  });
});
