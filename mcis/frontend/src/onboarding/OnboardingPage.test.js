import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import OnboardingPage from './OnboardingPage';

jest.mock('../firebase', () => ({ auth: { currentUser: { uid: 'u1', getIdToken: async () => 'tok-u1' } } }));
jest.mock('firebase/auth', () => ({ onAuthStateChanged: (_a, cb) => { cb({ uid: 'u1' }); return () => {}; } }));

const P = '11111111-1111-4111-8111-111111111111';
const C = '33333333-3333-4333-8333-333333333333';
let calls; let state; let templates;

const S = (over = {}) => ({
  enabled: true, started: true, step: 'workspace', completed: false, personalWorkspaceId: P, workspaceId: P, companyWorkspaceId: null,
  invitesSent: 0, invitesSkipped: false, useCase: null, templateId: null, firstWorkflowId: null, firstRunId: null,
  steps: ['workspace', 'team', 'use_case', 'template', 'first_run', 'done'],
  useCases: [{ id: 'research', label: 'Research & analysis' }, { id: 'documents', label: 'Documents & data entry' }], ...over,
});
const reply = (status, data, code, error) => Promise.resolve({ ok: status < 400, status, json: async () => (status < 400 ? { success: true, data } : { success: false, error: error || 'err', code }) });
function backend(url, opts = {}) {
  const u = new URL(url);
  const body = opts.body ? JSON.parse(opts.body) : undefined;
  calls.push({ path: u.pathname, method: opts.method || 'GET', body });
  if (u.pathname === '/api/workspaces') return reply(200, [{ id: P, name: 'Personal', is_personal: true, role: 'owner' }]);
  if (u.pathname === '/api/onboarding') return reply(200, state);
  if (u.pathname === '/api/onboarding/start') { state = S(); return reply(200, state); }
  if (u.pathname === '/api/onboarding/workspace') { state = S({ step: 'team', companyWorkspaceId: body.mode === 'create' ? C : null, workspaceId: body.mode === 'create' ? C : P }); return reply(200, state); }
  if (u.pathname === '/api/onboarding/team') {
    if (body.skip) { state = S({ ...state, step: 'use_case', invitesSkipped: true }); return reply(200, { ...state, invitations: [] }); }
    return reply(200, { ...state, invitesSent: 1, invitations: [{ email: 'a@x.co', role: 'member', status: 'invited', token: 'tok-invite-1' }, { email: 'b@x.co', role: 'member', status: 'failed', code: 'QUOTA_EXCEEDED', error: "Your plan's limit for members has been reached." }] });
  }
  if (u.pathname === '/api/onboarding/use-case') { state = S({ ...state, step: 'template', useCase: body.useCase }); return reply(200, { ...state, recommendedTemplates: templates }); }
  if (u.pathname === `/api/workspaces/${C}/templates`) return reply(200, templates);
  if (u.pathname === '/api/onboarding/template') { state = S({ ...state, step: 'first_run', templateId: body.templateId, firstWorkflowId: 'w1' }); return reply(200, state); }
  if (u.pathname === '/api/onboarding/first-run') { state = S({ ...state, step: 'done', completed: true, firstRunId: 'r1' }); return reply(200, { ...state, run: { id: 'r1', status: 'queued' } }); }
  if (u.pathname === '/api/onboarding/complete') { state = S({ ...state, step: 'done', completed: true }); return reply(200, state); }
  return reply(404, null, 'NOT_FOUND');
}
const tpl = (id, extra = {}) => ({ id, name: `T ${id}`, description: `desc ${id}`, category: 'research', riskLevel: 'low', expectedOutput: 'a report', onboarding: true, available: true, requiresApproval: false, requiredIntegrations: [], steps: [{ key: 'a' }], inputs: [{ name: 'topic', label: 'Topic', type: 'string', required: true }], ...extra });

beforeEach(() => {
  calls = []; state = S({ started: false, step: null, required: true }); templates = [tpl('research_comparison'), tpl('report_generation', { requiresApproval: true })];
  global.fetch = jest.fn(backend);
  delete window.location;
  window.location = { assign: jest.fn(), search: '', pathname: '/onboarding' };
});

test('A/B onboarding: start → create a company workspace → invite results (incl. plan-limit refusals) → use case', async () => {
  render(<OnboardingPage />);
  fireEvent.click(await screen.findByRole('button', { name: 'Get started' }));
  const name = await screen.findByLabelText('Company workspace name');
  fireEvent.change(name, { target: { value: 'Sharma & Co' } });
  fireEvent.click(screen.getByRole('button', { name: 'Create company workspace' }));
  const email = await screen.findByLabelText('Teammate 1 email');
  fireEvent.change(email, { target: { value: 'a@x.co' } });
  fireEvent.click(screen.getByRole('button', { name: 'Send invitations' }));
  const results = await screen.findByRole('list', { name: 'Invitation results' });
  expect(results).toHaveTextContent('tok-invite-1');
  expect(results).toHaveTextContent("limit for members has been reached");
  expect(calls.find((c) => c.path === '/api/onboarding/workspace').body).toEqual({ mode: 'create', name: 'Sharma & Co' });
  expect(calls.find((c) => c.path === '/api/onboarding/team').body).toEqual({ invites: [{ email: 'a@x.co', role: 'member' }] });
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
  expect(await screen.findByRole('button', { name: 'Research & analysis' })).toBeInTheDocument();
});

test('C/E onboarding resumes where the user left off: template choice → first run with inputs → done', async () => {
  state = S({ step: 'template', companyWorkspaceId: C, workspaceId: C, useCase: 'research' });
  render(<OnboardingPage />);
  expect(await screen.findByTestId('tpl-report_generation')).toHaveTextContent('asks for approval before sensitive actions');
  fireEvent.click(screen.getAllByRole('button', { name: 'Use this template' })[0]);
  const topic = await screen.findByLabelText(/Topic/);
  fireEvent.change(topic, { target: { value: 'GST software' } });
  fireEvent.click(screen.getByRole('button', { name: 'Run it' }));
  expect(await screen.findByRole('region', { name: 'All set' })).toHaveTextContent('Your first run is queued');
  expect(calls.find((c) => c.path === '/api/onboarding/first-run').body).toEqual({ inputs: { topic: 'GST software' } });
  expect(calls.find((c) => c.path === '/api/onboarding/template').body).toEqual({ templateId: 'research_comparison' });
});

test('onboarding: personal workspace has no invite form; skipping completes onboarding and opens the workspace', async () => {
  state = S({ step: 'team' });
  render(<OnboardingPage />);
  expect(await screen.findByText(/personal workspace, which is just for you/)).toBeInTheDocument();
  expect(screen.queryByLabelText('Teammate 1 email')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Skip for now' }));
  await waitFor(() => expect(window.location.assign).toHaveBeenCalledWith('/workspace'));
  expect(calls.some((c) => c.path === '/api/onboarding/complete')).toBe(true);
});

test('commercial pass: the "Monitoring & alerts" use case gets a real competitor-intelligence quick start at "done" — product, competitor, a real check result, and a free in-app alert', async () => {
  state = S({ step: 'done', completed: true, companyWorkspaceId: C, workspaceId: C, useCase: 'monitoring' });
  const PID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'; const MID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'; const CID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  global.fetch = jest.fn((url, opts = {}) => {
    const u = new URL(url); const body = opts.body ? JSON.parse(opts.body) : undefined;
    calls.push({ path: u.pathname, method: opts.method || 'GET', body });
    if (u.pathname === `/api/workspaces/${C}/competitors/products` && opts.method === 'POST') return reply(200, { id: PID, name: body.name });
    if (u.pathname === `/api/workspaces/${C}/competitors/products/${PID}/competitors` && opts.method === 'POST') return reply(200, { id: CID, competitorName: body.competitorName, monitorId: MID });
    if (u.pathname === `/api/workspaces/${C}/monitoring/monitors/${MID}/check` && opts.method === 'POST') return reply(200, { monitor: { id: MID, health: 'VERIFIED' } });
    if (u.pathname === `/api/workspaces/${C}/monitoring/rules` && opts.method === 'POST') return reply(200, { id: 'rule1', name: body.name });
    return backend(url, opts);
  });
  render(<OnboardingPage />);
  const quick = await screen.findByTestId('ci-quickstart');
  fireEvent.change(await screen.findByLabelText('Your product name'), { target: { value: 'Acme Kettle' } });
  fireEvent.click(within(quick).getByRole('button', { name: 'Add product' }));
  fireEvent.change(await screen.findByLabelText('Competitor name'), { target: { value: 'Rival Store' } });
  fireEvent.click(screen.getByRole('button', { name: 'Add competitor' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Check now' }));
  expect(await screen.findByTestId('ci-check-result')).toHaveTextContent('VERIFIED');
  fireEvent.click(screen.getByRole('button', { name: /Enable a free in-app price-drop alert/ }));
  await screen.findByRole('link', { name: 'Competitor intelligence' });
  expect(calls.find((c) => c.path === `/api/workspaces/${C}/competitors/products`).body).toEqual({ name: 'Acme Kettle' });
  expect(calls.find((c) => c.path === `/api/workspaces/${C}/monitoring/rules`).body).toMatchObject({ ruleType: 'price_drop_pct', channels: [{ type: 'in_app' }] });
});

test('launch-readiness fix: competitor quick-start with a URL creates/reuses a "Web pages" integration first, so the monitor is actually creatable instead of failing with "integrationId is required"', async () => {
  state = S({ step: 'done', completed: true, companyWorkspaceId: C, workspaceId: C, useCase: 'monitoring' });
  const PID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'; const MID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const CID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'; const IID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
  global.fetch = jest.fn((url, opts = {}) => {
    const u = new URL(url); const body = opts.body ? JSON.parse(opts.body) : undefined;
    calls.push({ path: u.pathname, method: opts.method || 'GET', body });
    if (u.pathname === `/api/workspaces/${C}/competitors/products` && opts.method === 'POST') return reply(200, { id: PID, name: body.name });
    if (u.pathname === `/api/workspaces/${C}/integrations` && opts.method === 'GET') return reply(200, []);
    if (u.pathname === `/api/workspaces/${C}/integrations` && opts.method === 'POST') return reply(200, { id: IID, provider: body.provider, name: body.name, status: 'connected', config: body.config });
    if (u.pathname === `/api/workspaces/${C}/competitors/products/${PID}/competitors` && opts.method === 'POST') return reply(200, { id: CID, competitorName: body.competitorName, monitorId: MID });
    if (u.pathname === `/api/workspaces/${C}/monitoring/monitors/${MID}/check` && opts.method === 'POST') return reply(200, { monitor: { id: MID, health: 'VERIFIED' } });
    if (u.pathname === `/api/workspaces/${C}/monitoring/rules` && opts.method === 'POST') return reply(200, { id: 'rule1', name: body.name });
    return backend(url, opts);
  });
  render(<OnboardingPage />);
  const quick = await screen.findByTestId('ci-quickstart');
  fireEvent.change(await screen.findByLabelText('Your product name'), { target: { value: 'Acme Kettle' } });
  fireEvent.click(within(quick).getByRole('button', { name: 'Add product' }));
  fireEvent.change(await screen.findByLabelText('Competitor name'), { target: { value: 'Rival Store' } });
  fireEvent.change(await screen.findByLabelText('Competitor product page URL (optional)'), { target: { value: 'https://rival.example.com/products/kettle' } });
  fireEvent.click(screen.getByRole('button', { name: 'Add competitor' }));
  await screen.findByRole('button', { name: 'Check now' });
  const integrationCreate = calls.find((c) => c.path === `/api/workspaces/${C}/integrations` && c.method === 'POST');
  expect(integrationCreate.body).toMatchObject({ provider: 'web_page', config: { allowedHosts: ['rival.example.com'] } });
  const competitorCreate = calls.find((c) => c.path === `/api/workspaces/${C}/competitors/products/${PID}/competitors`);
  expect(competitorCreate.body.monitor).toEqual({ sourceType: 'web_page', integrationId: IID, source: { url: 'https://rival.example.com/products/kettle' } });
});

test('launch-readiness fix: when integrations are not enabled on the server, the URL path falls back honestly to a manual monitor instead of showing a raw backend error', async () => {
  state = S({ step: 'done', completed: true, companyWorkspaceId: C, workspaceId: C, useCase: 'monitoring' });
  const PID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'; const MID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'; const CID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  global.fetch = jest.fn((url, opts = {}) => {
    const u = new URL(url); const body = opts.body ? JSON.parse(opts.body) : undefined;
    calls.push({ path: u.pathname, method: opts.method || 'GET', body });
    if (u.pathname === `/api/workspaces/${C}/competitors/products` && opts.method === 'POST') return reply(200, { id: PID, name: body.name });
    if (u.pathname === `/api/workspaces/${C}/integrations`) return reply(404, null, 'NOT_FOUND');
    if (u.pathname === `/api/workspaces/${C}/competitors/products/${PID}/competitors` && opts.method === 'POST') return reply(200, { id: CID, competitorName: body.competitorName, monitorId: MID });
    return backend(url, opts);
  });
  render(<OnboardingPage />);
  const quick = await screen.findByTestId('ci-quickstart');
  fireEvent.change(await screen.findByLabelText('Your product name'), { target: { value: 'Acme Kettle' } });
  fireEvent.click(within(quick).getByRole('button', { name: 'Add product' }));
  fireEvent.change(await screen.findByLabelText('Competitor name'), { target: { value: 'Rival Store' } });
  fireEvent.change(await screen.findByLabelText('Competitor product page URL (optional)'), { target: { value: 'https://rival.example.com/products/kettle' } });
  fireEvent.click(screen.getByRole('button', { name: 'Add competitor' }));
  await screen.findByText(/Automated page checks aren't enabled on this server yet/);
  const competitorCreate = calls.find((c) => c.path === `/api/workspaces/${C}/competitors/products/${PID}/competitors`);
  expect(competitorCreate.body.monitor).toEqual({ sourceType: 'api_submission' });
});

test('onboarding: server errors are shown, not hidden', async () => {
  state = S({ step: 'workspace' });
  global.fetch = jest.fn((url, opts) => (new URL(url).pathname === '/api/onboarding/workspace' ? reply(404, null, 'WORKSPACE_NOT_FOUND', 'Workspace not found') : backend(url, opts)));
  render(<OnboardingPage />);
  fireEvent.click(await screen.findByRole('button', { name: /Just me for now/ }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Workspace not found');
});
