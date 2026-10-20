import { describe, it, expect, beforeAll } from 'vitest';
import { render, screen, fireEvent, within, waitFor, cleanup } from '@testing-library/react';
import App from '../src/App.jsx';
import { createApi } from '../src/lib/api.js';
import { endpoints } from '../src/lib/endpoints.js';

const API = process.env.NEXUS_E2E_API_URL;
const OWNER = process.env.NEXUS_E2E_OWNER_TOKEN;
const MEMBER = process.env.NEXUS_E2E_MEMBER_TOKEN;
const run = API && OWNER && MEMBER ? describe : describe.skip;

const claims = (t) => JSON.parse(Buffer.from(t.split('.')[1], 'base64url').toString());
const uidOf = (t) => { const p = claims(t); return p.user_id || p.sub; };
const authFor = (token) => {
  const user = { uid: uidOf(token), email: 'e2e@test', emailVerified: true };
  return { onChange: (cb) => { cb(user); return () => {}; }, signInWithEmail: async () => {}, signInWithGoogle: async () => {}, signOut: async () => {}, getToken: async () => token };
};
const apiFor = (token) => createApi({ baseUrl: API, getToken: async () => token });

function renderAs(token, path, workspaceId) {
  cleanup();
  window.history.replaceState({}, '', path);
  window.localStorage.setItem(`nexus.workspace.${uidOf(token)}`, workspaceId);
  return render(<App authClient={authFor(token)} initialPath={path} api={apiFor(token)} />);
}
const go = (label) => fireEvent.click(screen.getByRole('link', { name: label }));

run('Nexus web ↔ real backend', () => {
  const owner = () => apiFor(OWNER);
  let team;
  let invitation;

  beforeAll(async () => {
    team = await endpoints.listWorkspaces(owner()).then(() => owner().request('/api/workspaces', { method: 'POST', body: { name: `E2E Ops ${Date.now().toString(36)}` } }));
  });

  it('owner: dashboard loads real data for the new team workspace', async () => {
    renderAs(OWNER, '/', team.id);
    expect(await screen.findByTestId('stat-succeeded', {}, { timeout: 20000 })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Workspace' })).toHaveValue(team.id);
    expect(screen.getByText('No activity in this workspace yet')).toBeInTheDocument();
  });

  it('owner: Ask Nexus starts a real execution and shows its live status', async () => {
    renderAs(OWNER, '/', team.id);
    fireEvent.click((await screen.findAllByRole('button', { name: /Ask Nexus/ }, { timeout: 20000 }))[0]);
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: 'E2E: read the status page and summarize it' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Start task' }));
    expect(await screen.findByRole('heading', { name: 'E2E: read the status page and summarize it' }, { timeout: 20000 })).toBeInTheDocument();
    const id = window.location.pathname.split('/').pop();
    const exec = await endpoints.getExecution(owner(), team.id, id);
    expect(exec.goal).toBe('E2E: read the status page and summarize it');
    expect(exec.workspaceId).toBe(team.id);
  });

  it('owner: every section loads from the real API without errors', async () => {
    renderAs(OWNER, '/', team.id);
    await screen.findByTestId('stat-succeeded', {}, { timeout: 20000 });
    for (const [label, expected] of [
      ['Tasks', /E2E: read the status page/],
      ['Approvals', /Nothing waiting for approval|Approve/],
      ['Workflows', /No workflows yet/],
      ['AI Agents', /No agents yet|Research/],
      ['Integrations', /No integrations connected|not enabled on this server/],
      ['Activity', /Audit log/],
      ['Usage & Billing', /Metered usage this period/],
      ['Team', /Members/],
      ['Settings', /Safety controls/],
    ]) {
      go(label);
      expect((await screen.findAllByText(expected, {}, { timeout: 20000 })).length).toBeGreaterThan(0);
      expect(screen.queryByText(/Could not load/)).toBeNull();
    }
  });

  it('owner: billing shows the server truth (no payment provider configured here)', async () => {
    renderAs(OWNER, '/billing', team.id);
    expect(await screen.findByText(/Metered usage this period/, {}, { timeout: 20000 })).toBeInTheDocument();
    const s = await endpoints.billingSummary(owner(), team.id);
    if (!s.payments.configured) expect(screen.getByText('Not configured')).toBeInTheDocument();
  });

  it('owner: invites the member; without email delivery the one-time code is shown', async () => {
    renderAs(OWNER, '/team', team.id);
    // Invitations are bound to the invitee's verified email: invite the member's own address.
    fireEvent.change(await screen.findByLabelText('Email', {}, { timeout: 20000 }), { target: { value: claims(MEMBER).email } });
    fireEvent.click(screen.getByRole('button', { name: 'Invite' }));
    expect(await screen.findByText(/Invitation for/, {}, { timeout: 20000 })).toBeInTheDocument();
    const code = document.querySelector('code.token');
    invitation = code ? code.textContent : null;
    expect(invitation, 'email delivery not configured → one-time code').toBeTruthy();
  });

  it('owner: emergency stop can be switched on and off from Settings', async () => {
    renderAs(OWNER, '/settings', team.id);
    window.confirm = () => true; // turning the stop ON asks for confirmation
    fireEvent.click(await screen.findByRole('button', { name: 'Emergency stop' }, { timeout: 20000 }));
    expect(await screen.findByText(/ON — all agent actions blocked/, {}, { timeout: 20000 })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Release emergency stop' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Emergency stop' })).toBeInTheDocument(), { timeout: 20000 });
  });

  it('member: joins via the code, sees member-level UI, and cannot reach admin data', async () => {
    const member = apiFor(MEMBER);
    await member.request('/api/workspaces/invitations/accept', { method: 'POST', body: { token: invitation } });
    renderAs(MEMBER, '/activity', team.id);
    expect(await screen.findByText('Admins only', {}, { timeout: 20000 })).toBeInTheDocument();
    go('AI Agents');
    await screen.findByRole('heading', { name: 'AI Agents' });
    expect(screen.queryByRole('button', { name: 'New agent' })).toBeNull();
    // Server-side enforcement, not just hidden buttons:
    await expect(endpoints.listAudit(member, team.id)).rejects.toMatchObject({ status: 403 });
    await expect(endpoints.setEmergencyStop(member, team.id, true)).rejects.toMatchObject({ status: 403 });
  });

  it('isolation: a user cannot read a workspace they do not belong to (404)', async () => {
    const ownerWorkspaces = await endpoints.listWorkspaces(owner());
    const ownerPersonal = ownerWorkspaces.find((w) => w.is_personal);
    const member = apiFor(MEMBER);
    await expect(endpoints.overview(member, ownerPersonal.id)).rejects.toMatchObject({ status: 404 });
    await expect(endpoints.listExecutions(member, ownerPersonal.id)).rejects.toMatchObject({ status: 404 });
  });
});
