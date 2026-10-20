// Launch-readiness UI: account creation / reset, workspace create & join,
// Agent Firewall page, emergency-stop confirmation, configuration errors.
import { describe, it, expect, afterEach } from 'vitest';
import { screen, fireEvent, waitFor, render } from '@testing-library/react';
import { ApiError } from '../lib/api.js';
import NotConfigured from '../pages/NotConfigured.jsx';
import { renderApp, fakeApi, fakeAuth, overviewFixture, WS_TEAM, WS_PERSONAL, USER, wsPath } from './helpers.jsx';

const W = wsPath();
const MEMBER_TEAM = { ...WS_TEAM, role: 'member' };
const base = (extra = [], list = [WS_PERSONAL, WS_TEAM]) => [
  ...extra,
  ['GET', /^\/api\/workspaces$/, list],
  ['GET', /\/overview$/, overviewFixture()],
  ['GET', /\/agents$/, []],
];

function securityFixture(over = {}) {
  return {
    firewall: { enabled: true, policyVersion: 3, isDefault: false, corrupt: false },
    policy: {
      maxRisk: 'red', emergencyStop: false,
      executionTypes: { connector: true, browser: true, desktop: false },
      domains: { allow: [], deny: ['evil.test'] }, repositories: { allow: [], deny: [] },
      files: { read: 'allow', write: 'allow', delete: 'deny', protectedPaths: ['/etc'], roots: [] },
      sensitiveData: { blockSecretsInInput: true }, approval: { ttlMinutes: 15, taintedRequiresApproval: true }, schedule: null,
    },
    builtIn: { dangerousActionsDeniedByDefault: ['format_disk'], alwaysDenied: ['cloud metadata endpoints'], taintedExecutionsNeedApproval: true },
    approvalPolicy: { ttlMinutes: 15, maxRisk: 'red' },
    integrations: [{ id: 'i1', name: 'Team Slack', provider: 'slack', status: 'connected', hasCredential: true, lastUsedAt: null, connectorPermissions: [{ action: 'slack.post', enabled: true }] }],
    blockedActions: [{ id: 'e1', type: 'ssrf_blocked', at: new Date().toISOString() }],
    recentEvents: [],
    ...over,
  };
}

afterEach(() => { delete window.confirm; });

describe('account creation and password reset', () => {
  it('creates an account (client-side validation first) and lands in the app with a verify banner', async () => {
    const auth = fakeAuth({ user: null });
    renderApp({ api: fakeApi(base()), auth });
    fireEvent.click(await screen.findByRole('button', { name: 'Create an account' }));
    expect(screen.getByRole('heading', { name: 'Create your account' })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'new@acme.test' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'short' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create account' }));
    expect(await screen.findByText('Use at least 8 characters for your password.')).toBeInTheDocument();
    expect(auth.calls).toHaveLength(0);
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'long-enough-pw' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create account' }));
    expect(await screen.findByText(/to accept workspace invitations/)).toBeInTheDocument();
    expect(auth.calls[0]).toEqual(['signUp', 'new@acme.test', 'long-enough-pw']);
    fireEvent.click(screen.getByRole('button', { name: 'Resend email' }));
    await waitFor(() => expect(auth.calls).toContainEqual(['verify']));
  });

  it('maps "email already in use" to a readable message', async () => {
    const auth = fakeAuth({ user: null, signUpError: Object.assign(new Error('x'), { code: 'auth/email-already-in-use' }) });
    renderApp({ api: fakeApi(base()), auth });
    fireEvent.click(await screen.findByRole('button', { name: 'Create an account' }));
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'a@acme.test' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'long-enough-pw' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create account' }));
    expect(await screen.findByText('An account with this email already exists. Sign in instead.')).toBeInTheDocument();
  });

  it('password reset shows the same message whether or not the account exists', async () => {
    const auth = fakeAuth({ user: null });
    renderApp({ api: fakeApi(base()), auth });
    fireEvent.click(await screen.findByRole('button', { name: 'Forgot password?' }));
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'who@acme.test' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send reset link' }));
    expect(await screen.findByText('If an account exists for who@acme.test, a password reset link is on its way.')).toBeInTheDocument();
    expect(auth.calls).toEqual([['reset', 'who@acme.test']]);
  });

  it('the password field can be revealed without changing its value', async () => {
    renderApp({ api: fakeApi(base()), auth: fakeAuth({ user: null }) });
    const pw = await screen.findByLabelText('Password');
    fireEvent.change(pw, { target: { value: 'secret-pw' } });
    expect(pw).toHaveAttribute('type', 'password');
    fireEvent.click(screen.getByRole('button', { name: 'Show password' }));
    expect(pw).toHaveAttribute('type', 'text');
    expect(pw).toHaveValue('secret-pw');
  });
});

describe('workspaces: create and join', () => {
  it('creates a team workspace and switches to it', async () => {
    const NEW = { id: '33333333-3333-4333-8333-333333333333', name: 'Launch Team', is_personal: false, role: 'owner' };
    let list = [WS_PERSONAL, WS_TEAM];
    const api = fakeApi([
      ['POST', /^\/api\/workspaces$/, (m, opts) => { list = [...list, { ...NEW, name: opts.body.name }]; return { ...NEW, name: opts.body.name }; }],
      ['GET', /^\/api\/workspaces$/, () => list],
      ['GET', /\/overview$/, (m, o, path) => overviewFixture({ workspace: { id: path.split('/')[3], name: path.includes(NEW.id) ? 'Launch Team' : WS_TEAM.name, isPersonal: false, role: 'owner' } })],
      ['GET', /\/agents$/, []],
    ]);
    renderApp({ api });
    fireEvent.click(await screen.findByRole('button', { name: 'Create or join a workspace' }));
    fireEvent.click(screen.getByRole('button', { name: 'Create workspace' }));
    expect(await screen.findByText('Give the workspace a name.')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Workspace name'), { target: { value: '  Launch Team ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create workspace' }));
    await waitFor(() => expect(screen.getByLabelText('Workspace')).toHaveValue(NEW.id));
    expect(api.calls.find((c) => c.method === 'POST').body).toEqual({ name: 'Launch Team' });
    await waitFor(() => expect(api.calls.some((c) => c.path === `/api/workspaces/${NEW.id}/overview`)).toBe(true));
  });

  it('an invitation link (#invite=…) pre-fills the code, removes it from the address bar, and joins on confirm', async () => {
    let list = [WS_PERSONAL];
    const api = fakeApi([
      ['POST', /\/invitations\/accept$/, () => { list = [WS_PERSONAL, MEMBER_TEAM]; return { workspace: MEMBER_TEAM }; }],
      ['GET', /^\/api\/workspaces$/, () => list],
      ['GET', /\/overview$/, overviewFixture()],
      ['GET', /\/agents$/, []],
    ]);
    renderApp({ api, path: '/workspace#invite=tok-123_abc' });
    const input = await screen.findByLabelText('Invitation code');
    expect(input).toHaveValue('tok-123_abc');
    expect(window.location.hash).toBe('');
    expect(api.calls.some((c) => c.method === 'POST')).toBe(false); // nothing happens without an explicit click
    fireEvent.click(screen.getByRole('button', { name: 'Join workspace' }));
    await waitFor(() => expect(screen.getByLabelText('Workspace')).toHaveValue(MEMBER_TEAM.id));
    expect(api.calls.find((c) => c.method === 'POST').body).toEqual({ token: 'tok-123_abc' });
  });

  it('shows the server refusal when an invitation cannot be accepted', async () => {
    const api = fakeApi(base([
      ['POST', /\/invitations\/accept$/, () => { throw new ApiError(403, 'FORBIDDEN', 'Verify your email address before accepting invitations'); }],
    ]));
    renderApp({ api });
    fireEvent.click(await screen.findByRole('button', { name: 'Create or join a workspace' }));
    fireEvent.click(screen.getByRole('tab', { name: 'Join with code' }));
    fireEvent.change(screen.getByLabelText('Invitation code'), { target: { value: 'abc' } });
    fireEvent.click(screen.getByRole('button', { name: 'Join workspace' }));
    expect(await screen.findByText('Verify your email address before accepting invitations')).toBeInTheDocument();
  });
});

describe('Agent Firewall page', () => {
  it('admins see the live policy, blocked actions and connected systems — never credentials', async () => {
    const api = fakeApi(base([['GET', new RegExp(`^${W}/security$`), securityFixture()]]));
    renderApp({ api, path: '/security' });
    expect(await screen.findByText('Enforcing policy')).toBeInTheDocument();
    expect(screen.getByText('Ssrf blocked')).toBeInTheDocument();
    expect(screen.getByText('Team Slack')).toBeInTheDocument();
    expect(screen.getByText('Stored encrypted')).toBeInTheDocument();
    expect(screen.getByText('Cloud metadata endpoints')).toBeInTheDocument();
    expect(screen.getByText(/Requests expire after 15 min/)).toBeInTheDocument();
  });

  it('a maximum risk of yellow marks RED actions as blocked in this workspace', async () => {
    const api = fakeApi(base([['GET', new RegExp(`^${W}/security$`), securityFixture({ policy: { ...securityFixture().policy, maxRisk: 'yellow' } })]]));
    renderApp({ api, path: '/security' });
    expect(await screen.findByText('Blocked in this workspace')).toBeInTheDocument();
  });

  it('shows the emergency stop state and requires confirmation before turning it on', async () => {
    const api = fakeApi(base([
      ['GET', new RegExp(`^${W}/security$`), securityFixture()],
      ['POST', new RegExp(`^${W}/security/emergency-stop$`), { emergencyStop: true, version: 4 }],
    ]));
    renderApp({ api, path: '/security' });
    window.confirm = () => false;
    fireEvent.click(await screen.findByRole('button', { name: 'Emergency stop' }));
    expect(api.calls.some((c) => c.method === 'POST')).toBe(false);
    window.confirm = () => true;
    fireEvent.click(screen.getByRole('button', { name: 'Emergency stop' }));
    await waitFor(() => expect(api.calls.find((c) => c.method === 'POST').body).toEqual({ active: true }));
  });

  it('a stopped workspace shows the halted state', async () => {
    const api = fakeApi(base([['GET', new RegExp(`^${W}/security$`), securityFixture({ policy: { ...securityFixture().policy, emergencyStop: true } })]]));
    renderApp({ api, path: '/security' });
    expect(await screen.findByText('Emergency stop — all actions denied')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Release emergency stop' })).toBeInTheDocument();
  });

  it('members get an explanation and the admin-only security API is never called', async () => {
    const api = fakeApi(base([], [WS_PERSONAL, MEMBER_TEAM]));
    renderApp({ api, path: '/security' });
    expect(await screen.findByText('Owners and admins manage the firewall')).toBeInTheDocument();
    expect(api.calls.some((c) => c.path.endsWith('/security'))).toBe(false);
  });
});

describe('dashboard callouts', () => {
  it('pending approvals get a prominent call to action', async () => {
    renderApp({ api: fakeApi(base()) });
    expect(await screen.findByText('1 action waiting for a human decision')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Review approvals' })).toHaveAttribute('href', '/approvals');
  });
});

describe('configuration errors', () => {
  it('lists missing variable names only', () => {
    render(<NotConfigured missing={['VITE_FIREBASE_API_KEY']} />);
    expect(screen.getByText('VITE_FIREBASE_API_KEY')).toBeInTheDocument();
  });
  it('shows the Firebase error code (never values) when Firebase rejects the configuration', () => {
    render(<NotConfigured reason="auth/invalid-api-key" />);
    expect(screen.getByText('auth/invalid-api-key')).toBeInTheDocument();
    expect(screen.getByText(/Firebase rejected this deployment/)).toBeInTheDocument();
  });
});

describe('signed-in user without a verified email', () => {
  it('is not shown the banner when verified', async () => {
    renderApp({ api: fakeApi(base()), auth: fakeAuth({ user: USER }) });
    await screen.findByTestId('stat-succeeded');
    expect(screen.queryByText(/to accept workspace invitations/)).not.toBeInTheDocument();
  });
});
