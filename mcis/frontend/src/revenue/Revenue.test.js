import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import CompetitorPage from './CompetitorPage';
import MonitoringPage from './MonitoringPage';
import ReliabilityPage from './ReliabilityPage';
import WorkforcePage from './WorkforcePage';
import WebhooksPanel from './WebhooksPanel';
import { storeWorkspaceId } from '../workflows/workflowsApi';

jest.mock('../firebase', () => ({ auth: { currentUser: { uid: 'u1', getIdToken: async () => 'tok-u1' } } }));
jest.mock('firebase/auth', () => ({ onAuthStateChanged: (_a, cb) => { cb({ uid: 'u1' }); return () => {}; } }));

const T = '22222222-2222-4222-8222-222222222222';
const P1 = '33333333-3333-4333-8333-333333333333';
const C1 = '44444444-4444-4444-8444-444444444444';
const C2 = '55555555-5555-4555-8555-555555555555';
const M1 = '66666666-6666-4666-8666-666666666666';
const R1 = '77777777-7777-4777-8777-777777777777';
const A1 = '88888888-8888-4888-8888-888888888888';
const D1 = '99999999-9999-4999-8999-999999999999';
let calls; let role; let routes;

const reply = (status, data, code) => Promise.resolve({ ok: status < 400, status, json: async () => (status < 400 ? { success: true, data } : { success: false, error: 'Not found', code: code || 'NOT_FOUND' }) });
function backend(url, opts = {}) {
  const u = new URL(url);
  const key = `${opts.method || 'GET'} ${u.pathname}`;
  calls.push({ key, body: opts.body ? JSON.parse(opts.body) : undefined, headers: opts.headers || {} });
  if (u.pathname === '/api/workspaces') return reply(200, [{ id: T, name: 'Shop', is_personal: false, role }]);
  const r = routes[key];
  if (r) return reply(200, typeof r === 'function' ? r(opts) : r);
  return reply(404);
}
const W = `/api/workspaces/${T}`;

const monitor = (over) => ({ id: M1, name: 'Rival kettle', kind: 'product', sourceType: 'web_page', health: 'VERIFIED', currentIsFresh: true, current: { present: true, price: 1149, currency: 'INR', availability: 'IN_STOCK' }, lastSuccessAt: '2026-09-25T10:00:00Z', ...over });
const dashboard = () => ({
  totals: { products: 1, competitors: 2, verifiedMatches: 1, unverifiedMatches: 1, rejectedMatches: 0, sources: { verified: 1, unverified: 0, stale: 1, unavailable: 0, pending: 0 }, openRecommendations: 1, undercutBy: 1 },
  products: [{
    product: { id: P1, name: 'Acme Kettle', sku: 'AK-15', currency: 'INR' }, ownPrice: { value: 1249, source: 'configured' },
    competitors: [
      { id: C1, competitorName: 'Rival Store', marketplace: 'website', match: { status: 'VERIFIED', method: 'gtin', confidence: 0.99 }, version: 1, monitor: monitor() },
      { id: C2, competitorName: 'Old seller', marketplace: 'amazon', match: { status: 'UNVERIFIED', method: 'brand_model', confidence: 0.85 }, version: 0, monitor: monitor({ id: C2, health: 'STALE', currentIsFresh: false, current: { present: true, price: 900, currency: 'INR', availability: 'IN_STOCK' } }) },
    ],
    marginImpact: { lowestCompetitor: { name: 'Rival Store', price: 1149 }, priceGap: 100, priceGapPct: 8.7, marginAtOwnPrice: { complete: false, missing: ['cost'] }, marginIfMatchLowest: { complete: true, marginPct: 12.5, profit: 143, price: 1149 }, matchWouldBreachMinimum: true, minMarginPct: 20, floorPrice: 1300, excludedCompetitors: 1 },
    openRecommendations: 1,
  }],
  recentChanges: [],
});

beforeEach(() => {
  calls = []; role = 'member';
  window.localStorage.clear();
  storeWorkspaceId('u1', T);
  routes = {
    [`GET ${W}/competitors/dashboard`]: dashboard(),
    [`GET ${W}/competitors/recommendations`]: [{ id: R1, type: 'review_pricing', priority: 'medium', status: 'open', createdAt: '2026-09-25T10:00:00Z', rationale: { note: 'A verified competitor dropped its price.', competitor: { name: 'Rival Store' }, change: { type: 'price_decrease', oldValue: 1299, newValue: 1149 } } }],
    [`POST ${W}/competitors/recommendations/${R1}/act`]: { task: { id: 't1' } },
    [`GET ${W}/integrations`]: [],
    [`GET ${W}/monitoring/monitors`]: [monitor(), monitor({ id: C2, name: 'Blocked page', health: 'UNAVAILABLE', currentIsFresh: false, healthReason: 'The site refused automated access (HTTP 403)' })],
    [`GET ${W}/monitoring/changes`]: [{ id: 'ch1', changeType: 'price_decrease', field: 'price', oldValue: 1299, newValue: 1149, verification: 'VERIFIED', detectedAt: '2026-09-25T10:00:00Z' }],
    [`GET ${W}/monitoring/alerts`]: [{ id: A1, title: 'Rival kettle: price dropped', severity: 'warning', createdAt: '2026-09-25T10:00:00Z', acknowledged: false, details: {}, deliveries: [{ id: D1, channel: 'slack', status: 'failed', errorCode: 'AUTH_FAILED' }, { id: 'd2', channel: 'in_app', status: 'delivered' }] }],
    [`GET ${W}/monitoring/rules`]: [],
    [`POST ${W}/monitoring/alerts/${A1}/acknowledge`]: { id: A1, acknowledged: true },
  };
  global.fetch = jest.fn(backend);
});

test('CI dashboard: totals, verified vs unverified matches, stale prices marked "not current" and excluded, incomplete margins say what is missing, breach warning', async () => {
  render(<CompetitorPage />);
  expect(await screen.findByTestId('total-Verified matches')).toHaveTextContent('1');
  const stale = screen.getByTestId(`competitor-${C2}`);
  expect(within(stale).getByTestId('health')).toHaveTextContent('Stale');
  expect(within(stale).getByText('UNVERIFIED')).toBeInTheDocument();
  expect(screen.getByTestId('margin-incomplete')).toHaveTextContent('needs cost');
  expect(screen.getByTestId('margin-impact')).toHaveTextContent('1 competitor price(s) excluded');
  expect(screen.getByRole('alert')).toHaveTextContent('breach your 20% minimum margin');
  expect(screen.queryByText('Confirm match')).toBeNull(); // members cannot decide matches
  expect(screen.queryByRole('form', { name: 'Add product' })).toBeNull();
});

test('CI recommendations are advice: "Create task" posts an action; nothing sends a price anywhere', async () => {
  render(<CompetitorPage />);
  const rec = await screen.findByTestId(`rec-${R1}`);
  expect(rec).toHaveTextContent('A verified competitor dropped its price.');
  fireEvent.click(within(rec).getByText('Create task'));
  await waitFor(() => expect(calls.some((c) => c.key === `POST ${W}/competitors/recommendations/${R1}/act` && c.body.action === 'task')).toBe(true));
  expect(calls.filter((c) => c.key.startsWith('POST')).every((c) => !/price/i.test(c.key))).toBe(true);
});

test('CI admins can confirm matches and add products', async () => {
  role = 'admin';
  routes[`POST ${W}/competitors/products/${P1}/competitors/${C2}/match`] = {};
  render(<CompetitorPage />);
  const row = await screen.findByTestId(`competitor-${C2}`);
  fireEvent.click(within(row).getByText('Confirm match'));
  await waitFor(() => expect(calls.find((c) => c.key.endsWith(`/competitors/${C2}/match`)).body).toEqual({ decision: 'confirm', version: 0 }));
  expect(screen.getByRole('form', { name: 'Add product' })).toBeInTheDocument();
});

test('Monitoring: health badges (verified / unavailable with reason), failed Slack delivery shown as failed (never "sent"), acknowledge', async () => {
  render(<MonitoringPage />);
  const blocked = await screen.findByTestId(`monitor-${C2}`);
  expect(within(blocked).getByTestId('health')).toHaveTextContent('Unavailable');
  expect(blocked).toHaveTextContent('HTTP 403');
  const alert = screen.getByTestId(`alert-${A1}`);
  expect(within(alert).getByTestId('delivery-slack')).toHaveTextContent('slack: failed (AUTH_FAILED)');
  expect(within(alert).getByTestId('delivery-in_app')).toHaveTextContent('delivered');
  expect(within(alert).queryByText('Retry')).toBeNull(); // members cannot retry sends
  fireEvent.click(within(alert).getByText('Acknowledge'));
  await waitFor(() => expect(calls.some((c) => c.key === `POST ${W}/monitoring/alerts/${A1}/acknowledge`)).toBe(true));
  expect(screen.getAllByTestId('change')[0]).toHaveTextContent('price decrease');
});

test('Monitoring: "Check now" sends an Idempotency-Key (admin)', async () => {
  role = 'owner';
  routes[`POST ${W}/monitoring/monitors/${M1}/check`] = { replayed: false };
  render(<MonitoringPage />);
  const m = await screen.findByTestId(`monitor-${M1}`);
  fireEvent.click(within(m).getByText('Check now'));
  await waitFor(() => expect(calls.find((c) => c.key.endsWith('/check')).headers['Idempotency-Key']).toMatch(/^ui-/));
});

test('Reliability: a run shows verdicts, failure categories and server-computed metrics', async () => {
  role = 'admin';
  const PID = '12121212-1212-4121-8121-121212121212';
  const RUN = '13131313-1313-4131-8131-131313131313';
  routes[`GET ${W}/reliability/projects`] = [{ id: PID, name: 'Checkout agent' }];
  routes[`GET ${W}/reliability/projects/${PID}`] = { id: PID, name: 'Checkout agent', suites: [{ id: 's1' }], scenarios: [{ id: 'sc1', name: 'Places order', executor: 'nexus_agent', goal: 'Place order' }, { id: 'sc2', name: 'Creates record', executor: 'nexus_agent' }] };
  routes[`GET ${W}/reliability/projects/${PID}/metrics`] = { runs: 0, overall: null, flakyScenarios: [] };
  routes[`POST ${W}/reliability/projects/${PID}/runs`] = { id: RUN };
  routes[`GET ${W}/reliability/runs/${RUN}`] = {
    id: RUN, status: 'completed',
    report: { passRate: 50, passed: 1, failed: 1, errored: 0, pending: 0, verifiedRate: 50, evidenceCompleteRate: 100, policyDenials: 0, injectionDetections: 0, failureCategories: { FALSE_SUCCESS: 1 } },
    results: [{ id: 'r1', scenarioId: 'sc1', status: 'passed', verdict: { checks: [{ name: 'outcome', passed: true }] } }, { id: 'r2', scenarioId: 'sc2', status: 'failed', failureCategory: 'FALSE_SUCCESS', verdict: { checks: [{ name: 'independent_probe', passed: false }] } }],
  };
  render(<ReliabilityPage />);
  fireEvent.click(await screen.findByText('Checkout agent'));
  fireEvent.click(await screen.findByText('Run all scenarios'));
  expect(await screen.findByTestId('qa-report')).toHaveTextContent('Pass rate 50%');
  expect(screen.getByTestId('result-r2')).toHaveTextContent('FALSE_SUCCESS');
  expect(screen.getByTestId('result-r2')).toHaveTextContent('independent_probe');
  expect(calls.find((c) => c.key.endsWith('/runs') && c.key.startsWith('POST')).headers['Idempotency-Key']).toBeTruthy();
});

test('Workforce: agents with their limits; admins add the standard team', async () => {
  role = 'admin';
  routes[`GET ${W}/agents`] = [{ id: A1, name: 'Research Agent', role: 'research', status: 'active', maxRisk: 'green', allowedIntegrationIds: [], version: 0, description: 'Finds facts' }];
  routes[`GET ${W}/tasks`] = [{ id: 't1', title: 'Summarise pages', status: 'todo' }];
  routes[`POST ${W}/agents/defaults`] = [];
  render(<WorkforcePage />);
  const a = await screen.findByTestId(`agent-${A1}`);
  expect(a).toHaveTextContent('Read-only / low risk only');
  await waitFor(() => expect(a).toHaveTextContent('Summarise pages'));
  fireEvent.click(screen.getByText(/Add standard agents/));
  await waitFor(() => expect(calls.some((c) => c.key === `POST ${W}/agents/defaults`)).toBe(true));
});

test('Webhooks: the signing secret is shown once after create and is never part of the list', async () => {
  role = 'owner';
  routes[`GET ${W}/webhooks`] = [{ id: C1, url: 'https://hooks.example.com/n', events: ['execution.completed'], status: 'active', failureCount: 0 }];
  routes[`POST ${W}/webhooks`] = { id: C2, url: 'https://x.example.com/h', events: ['execution.completed'], secret: 'whsec_test_placeholder_value' };
  render(<WebhooksPanel />);
  expect(await screen.findByTestId(`webhook-${C1}`)).toHaveTextContent('hooks.example.com');
  expect(screen.queryByTestId('webhook-secret')).toBeNull();
  fireEvent.change(screen.getByLabelText('Endpoint URL'), { target: { value: 'https://x.example.com/h' } });
  fireEvent.click(screen.getByText('Add webhook'));
  expect(await screen.findByTestId('webhook-secret')).toHaveTextContent('whsec_test_placeholder_value');
  fireEvent.click(screen.getByText('I stored it'));
  expect(screen.queryByTestId('webhook-secret')).toBeNull();
});
