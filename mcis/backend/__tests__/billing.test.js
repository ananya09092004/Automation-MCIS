/**
 * Layer 7 — usage metering, plans, entitlements, subscriptions, billing API (tests A–V).
 *
 * Real: HTTP stack (Firebase-auth middleware → Layer 1 workspaceContext →
 * routes), entitlement/usage service, subscription service + webhook
 * verification, billing views, Layer 1 workspace service (member limits),
 * Layer 3 executions, Layer 4 workflows + durable runner, Layer 5 gateway
 * (HTTP connector) with the Layer 6 Agent Firewall, Layer 6 API keys +
 * automation API.
 * Doubles (external only): Firebase token verification, Gemini (scripted
 * planner), the Nexus bridge, one local HTTP API double.
 *
 * Run: node __tests__/billing.test.js   (WORKSPACE_TEST_STORE=supabase for real Postgres; ANON_KEY for V)
 */
'use strict';

const assert = require('assert');
const Module = require('module');
const path = require('path');
const crypto = require('crypto');
const http = require('http');

const ROOT = path.join(__dirname, '..');
const R = (...p) => require.resolve(path.join(ROOT, ...p));
const SUPA = process.env.WORKSPACE_TEST_STORE === 'supabase';
if (!SUPA) {
  process.env.SUPABASE_URL = 'http://127.0.0.1:9';
  process.env.SUPABASE_KEY = 'unused-in-tests';
}
process.env.NODE_ENV = 'production';
delete process.env.ALLOW_UNAUTHENTICATED_API;
delete process.env.PERMISSIONS_ENFORCED;

function fakeModule(resolvedPath, exportsObj) {
  const m = new Module(resolvedPath, null);
  m.exports = exportsObj;
  m.loaded = true;
  require.cache[resolvedPath] = m;
}
if (!SUPA) {
  fakeModule(require.resolve('@supabase/supabase-js'), {
    createClient: () => ({ from() { const b = { select() { return b; }, eq() { return b; }, async maybeSingle() { return { data: null, error: null }; }, async insert() { return { data: null, error: null }; } }; return b; } }),
  });
}
fakeModule(R('config', 'firebaseAdmin.js'), () => ({
  auth: () => ({
    async verifyIdToken(token) {
      const [kind, uid] = String(token).split('|');
      if (kind !== 'tok' || !uid) throw new Error('invalid token');
      return { uid, email: `${uid}@example.com`, email_verified: true };
    },
  }),
}));
fakeModule(R('services', 'logger.js'), { info() {}, warn() {}, error() {}, debug() {} });
const SCRIPTS = {};
fakeModule(R('backend-routing', 'geminiClient.js'), {
  generateContent: async (prompt) => {
    const goal = (prompt.match(/The user's goal: "([\s\S]*?)"\n/) || [])[1] || '';
    const tag = goal.split(/\s+/)[0];
    const section = prompt.split('Steps executed so far:\n')[1].split('\n\nClarifications')[0];
    const n = (section.match(/^\d+\. /gm) || []).length;
    const script = SCRIPTS[tag];
    return { response: { text: () => JSON.stringify(script ? script(n, goal) : { done: true, reason: 'nothing to do' }) } };
  },
});
const nexusCalls = [];
let NEXUS = () => ({ success: true, data: 'ok', evidence: { verified: true } });
fakeModule(R('backend-routing', 'nexusBridge.js'), { sendCommandToNexus: async (req) => { nexusCalls.push(req); return NEXUS(req); } });

const express = require('express');
const authenticateFirebaseUser = require(R('middleware', 'auth.js'));
const sanitizeInput = require(R('middleware', 'sanitizer.js'));
const { createWorkspaceService } = require(R('services', 'workspaceService.js'));
const { createWorkspacesRouter } = require(R('routes', 'workspaces.js'));
const { createAgentExecutionService } = require(R('services', 'agentExecution', 'executionService.js'));
const { createExecutionsRouter } = require(R('routes', 'executions.js'));
const { createWorkflowService } = require(R('services', 'workflows', 'workflowService.js'));
const { createWorkflowRunner } = require(R('services', 'workflows', 'workflowRunner.js'));
const { createWorkflowRouters } = require(R('routes', 'workflows.js'));
const { createIntegrationsRouter } = require(R('routes', 'integrations.js'));
const { createIntegrationService } = require(R('services', 'integrations', 'integrationService.js'));
const { createCredentialService, loadKeyRing } = require(R('services', 'integrations', 'credentialService.js'));
const { createSafeHttpClient, isPublicAddress } = require(R('services', 'integrations', 'safeHttp.js'));
const { createConnectorRegistry } = require(R('services', 'integrations', 'connectorRegistry.js'));
const { createHttpApiConnector } = require(R('services', 'integrations', 'connectors', 'httpApiConnector.js'));
const { SAFE_TO_REPEAT_ACTIONS } = require(R('backend-routing', 'intentRouter.js'));
const { createAgentFirewall } = require(R('services', 'security', 'agentFirewall.js'));
const { createSecurityEvents, createDbRateLimiter } = require(R('services', 'security', 'securityEvents.js'));
const { createApiKeyService } = require(R('services', 'security', 'apiKeyService.js'));
const { createSecurityService } = require(R('services', 'security', 'securityService.js'));
const { createSecurityRouter } = require(R('routes', 'security.js'));
const { createAutomationRouter } = require(R('routes', 'automation.js'));
const { createEntitlementService, createBillingAudit, QuotaError } = require(R('services', 'billing', 'entitlementService.js'));
const { createSubscriptionService } = require(R('services', 'billing', 'subscriptionService.js'));
const { createBillingService } = require(R('services', 'billing', 'billingService.js'));
const { createGenericProvider, createNoProvider, signGenericPayload } = require(R('services', 'billing', 'providers.js'));
const { resolveEffective, limitOf } = require(R('services', 'billing', 'plans.js'));
const { createBillingRouter, createBillingWebhookRouter, createCounters, billingFlag } = require(R('routes', 'billing.js'));
const { createMemoryWorkspaceStore } = require(path.join(__dirname, 'support', 'memoryWorkspaceStore.js'));
const { createMemoryExecutionStore } = require(path.join(__dirname, 'support', 'memoryExecutionStore.js'));
const { createMemoryWorkspaceDataStore } = require(path.join(__dirname, 'support', 'memoryWorkspaceDataStore.js'));
const { createMemoryWorkflowStore } = require(path.join(__dirname, 'support', 'memoryWorkflowStore.js'));
const { createMemoryIntegrationStore } = require(path.join(__dirname, 'support', 'memoryIntegrationStore.js'));
const { createMemorySecurityStore } = require(path.join(__dirname, 'support', 'memorySecurityStore.js'));
const { createMemoryBillingStore } = require(path.join(__dirname, 'support', 'memoryBillingStore.js'));

let passed = 0;
let failed = 0;
const ONLY = process.env.BILLING_TEST_ONLY ? new RegExp(process.env.BILLING_TEST_ONLY) : null;
async function test(name, fn) {
  if (ONLY && !ONLY.test(name)) return;
  try { await fn(); console.log(`PASS: ${name}`); passed++; } catch (err) { console.error(`FAIL: ${name}`); console.error(`  ${err.stack || err.message}`); failed++; }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const RUN = crypto.randomBytes(3).toString('hex');
const step = (action, payload = {}) => ({ done: false, action, payload: { platform: 'browser', parameters: {}, target: {}, value: null, ...payload } });
const DONE = (reason = 'goal complete') => ({ done: true, reason });
const WEBHOOK_SECRET = crypto.randomBytes(32).toString('hex');
const KEY_B64 = crypto.randomBytes(32).toString('base64');

// ---------------------------------------------------------------------
// Local "approved REST API" double (for connector calls)
// ---------------------------------------------------------------------
const apiLog = [];
let apiPort;
const apiServer = new Promise((resolve) => {
  const s = http.createServer((req, res) => { apiLog.push(req.url); res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true })); });
  s.listen(0, '127.0.0.1', () => resolve(s));
});

// ---------------------------------------------------------------------
// Stores
// ---------------------------------------------------------------------
let wsStore; let execStore; let dataStore; let wfStore; let intStore; let secStore; let billStore;
const auditRows = [];
const realAudit = SUPA ? require(R('security-engine', 'auditLog.js')).appendAuditLog : null;
const appendAuditLog = async (userId, action, payload, result, workspaceId) => {
  auditRows.push({ user_id: userId, action, payload, success: !!(result && result.success), error: result && result.error, workspace_id: workspaceId || null });
  if (realAudit) await realAudit(userId, action, payload, result, workspaceId);
};
let clockOffset = 0;
const now = () => new Date(Date.now() + clockOffset);
let db = null;
if (SUPA) {
  wsStore = require(R('services', 'workspaceStore.js')).createSupabaseWorkspaceStore();
  execStore = require(R('services', 'agentExecution', 'executionStore.js')).createSupabaseExecutionStore();
  dataStore = require(R('services', 'workspaceData', 'workspaceDataStore.js')).createSupabaseWorkspaceDataStore();
  wfStore = require(R('services', 'workflows', 'workflowStore.js')).createSupabaseWorkflowStore();
  intStore = require(R('services', 'integrations', 'integrationStore.js')).createSupabaseIntegrationStore();
  secStore = require(R('services', 'security', 'securityStore.js')).createSupabaseSecurityStore();
  billStore = require(R('services', 'billing', 'billingStore.js')).createSupabaseBillingStore();
  db = require('@supabase/supabase-js').createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
} else {
  wsStore = createMemoryWorkspaceStore();
  execStore = createMemoryExecutionStore();
  dataStore = createMemoryWorkspaceDataStore();
  wfStore = createMemoryWorkflowStore({ taskExists: async (ws, id) => !!(await dataStore.getTask(ws, id)) });
  intStore = createMemoryIntegrationStore();
  secStore = createMemorySecurityStore({ now, auditRows });
  billStore = createMemoryBillingStore({ now, workspaceExists: async (id) => !!(await wsStore.getWorkspace(id)) });
}
const quiet = { error() {}, warn() {}, info() {} };
const getMemberRole = async (ws, uid) => { if (!uid) return null; const m = await wsStore.getMember(ws, uid); return m ? m.role : null; };

/** Test plans with small limits (inserted like an operator would). */
async function createPlan(id, limits) {
  const row = { id, name: `Test ${id}`, description: 'test plan', limits, price: null, is_public: false, sort_order: 99 };
  if (SUPA) {
    const { error } = await db.from('billing_plans').insert(row);
    if (error) throw new Error(error.message);
  } else billStore._plans.set(id, { ...row, updated_at: new Date().toISOString() });
}
async function ledger(ws) {
  if (!SUPA) return billStore._events.filter((e) => e.workspace_id === ws);
  const { data, error } = await db.from('usage_events').select('*').eq('workspace_id', ws);
  if (error) throw new Error(error.message);
  return data;
}
const count = (rows, metric) => rows.filter((e) => e.metric === metric).reduce((a, e) => a + e.quantity, 0);

const U = Object.fromEntries(['alice', 'bob', 'carol', 'dave', 'erin', 'mallory'].map((n) => [n, { uid: `${n}_${RUN}`, email: `${n}_${RUN}@example.com`, emailVerified: true }]));
const auth = (u) => ({ authorization: `Bearer tok|${u.uid}` });

async function run() {
  console.log(`# billing tests — store: ${SUPA ? 'supabase' : 'memory'}`);
  const api = await apiServer;
  apiPort = api.address().port;
  const testHttp = createSafeHttpClient({
    lookup: (host, o, cb) => (host === 'api.example.test' ? cb(null, [{ address: '127.0.0.1', family: 4 }]) : cb(Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' }))),
    isAddressAllowed: (ip, host) => (host === 'api.example.test' && ip === '127.0.0.1') || isPublicAddress(ip),
    allowInsecureHttp: true, allowedPorts: [apiPort],
  });
  const registry = createConnectorRegistry([createHttpApiConnector({ allowInsecureHttpForTests: true })]);
  const keyRing = loadKeyRing({ INTEGRATION_ENCRYPTION_KEY: KEY_B64, INTEGRATION_ENCRYPTION_KEY_ID: 'k1' });
  const integrationService = createIntegrationService({ store: intStore, registry, credentials: createCredentialService({ store: intStore, keyRing }), http: testHttp, getMemberRole, appendAuditLog, logger: quiet });
  const events = createSecurityEvents({ appendAuditLog, logger: quiet });
  const rateLimiter = createDbRateLimiter({ store: secStore, logger: quiet });
  const firewall = createAgentFirewall({ store: secStore, getMemberRole, events, rateLimiter, logger: quiet, options: { policyCacheMs: 0 } });
  integrationService.setFirewall(firewall);

  // ---- Layer 7 services ----
  const counters = createCounters({ wsStore, wfStore, execStore });
  const audit = createBillingAudit({ appendAuditLog, logger: quiet });
  const providers = { map: { none: createNoProvider(), generic: createGenericProvider({ secret: WEBHOOK_SECRET }) }, active: createNoProvider(), activeName: 'none' };
  const ent = createEntitlementService({ store: billStore, enabled: true, counters, audit, logger: quiet, options: { now, planCacheMs: 0 } });
  const subs = createSubscriptionService({ store: billStore, providers, entitlements: ent, audit, logger: quiet, options: { now } });
  const billing = createBillingService({ store: billStore, entitlements: ent, providers, counters, enabled: true, logger: quiet, options: { now } });

  const wsService = createWorkspaceService(wsStore, { requireVerifiedEmail: true });
  wsService.setEntitlements(ent);
  const execService = createAgentExecutionService({ store: execStore, options: { retryDelayMs: 0, maxSteps: 8 }, deps: { appendAuditLog }, logger: quiet });
  execService.setConnectorGateway(integrationService.gateway);
  execService.setFirewall(firewall);
  execService.setUsageMeter(ent);
  const wfService = createWorkflowService({ store: wfStore, dataStore, executionService: execService, appendAuditLog, integrationResolver: integrationService, usage: ent, logger: quiet });
  const runner = createWorkflowRunner({
    store: wfStore, service: wfService, dataStore, executionService: execService, execStore, appendAuditLog,
    safeToRepeatActions: [...SAFE_TO_REPEAT_ACTIONS, ...registry.staticallySafeActionNames()], getMemberRole, logger: quiet, securityEvents: events,
    options: { leaseSeconds: 2, heartbeatMs: 100, idlePollMs: 25, execPollMs: 5, busyRetryMs: 25, schedulerIntervalMs: 0, stopTimeoutMs: 2000 },
  });
  wfService.attachRunner(runner);
  const apiKeys = createApiKeyService({ store: secStore, getMemberRole, events, rateLimiter, logger: quiet });
  const securityService = createSecurityService({ store: secStore, firewall, firewallEnabled: true, apiKeys, integrations: integrationService, events, logger: quiet });

  const app = express();
  app.use('/api/billing/webhooks', createBillingWebhookRouter({ subscriptionService: subs, logger: quiet }));
  app.use(express.json());
  app.use(sanitizeInput);
  app.use('/api/automation/v1', createAutomationRouter({ apiKeyService: apiKeys, workflowService: wfService, executionService: execService, usage: ent, logger: quiet, ipLimit: { limit: 1000, windowSeconds: 300 } }));
  app.use('/api', authenticateFirebaseUser);
  app.use('/api/workspaces/:workspaceId/billing', createBillingRouter({ workspaceService: wsService, billingService: billing, subscriptionService: subs, logger: quiet }));
  app.use('/api/workspaces/:workspaceId/security', createSecurityRouter({ workspaceService: wsService, securityService, apiKeyService: apiKeys }));
  app.use('/api/workspaces/:workspaceId/integrations', createIntegrationsRouter({ workspaceService: wsService, integrationService }));
  const wfr = createWorkflowRouters({ workspaceService: wsService, workflowService: wfService });
  app.use('/api/workspaces/:workspaceId/workflows', wfr.workflows);
  app.use('/api/workspaces/:workspaceId/workflow-runs', wfr.runs);
  app.use('/api/workspaces/:workspaceId/executions', createExecutionsRouter({ workspaceService: wsService, executionService: execService }));
  app.use('/api/workspaces', createWorkspacesRouter({ service: wsService }));
  const srv = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${srv.address().port}`;
  const responses = [];
  const call = async (method, url, { as, body, headers = {}, raw = null } = {}) => {
    const res = await fetch(base + url, { method, headers: { 'content-type': 'application/json', ...headers, ...(as ? auth(as) : {}) }, body: raw !== null ? raw : (body !== undefined && method !== 'GET' ? JSON.stringify(body) : undefined) });
    const text = await res.text();
    responses.push(text);
    let j = null;
    try { j = JSON.parse(text); } catch { /* none */ }
    return { status: res.status, body: j, text };
  };

  // Workspaces
  const team = await wsService.createWorkspace(U.alice, { name: 'Acme Books' });
  const other = await wsService.createWorkspace(U.mallory, { name: 'Other Co' });
  for (const [u, role] of [[U.carol, 'admin'], [U.bob, 'member']]) {
    const inv = await wsService.createInvitation({ workspace: team, role: 'owner', userId: U.alice.uid }, { email: u.email, role });
    await wsService.acceptInvitation(u, { token: inv.token });
  }
  const B = (ws) => `/api/workspaces/${ws.id}/billing`;
  const EX = (ws) => `/api/workspaces/${ws.id}/executions`;
  const WF = (ws) => `/api/workspaces/${ws.id}/workflows`;
  const RUNS = (ws) => `/api/workspaces/${ws.id}/workflow-runs`;
  runner.start();

  const planSmall = `ts_${RUN}`;
  const planBig = `tb_${RUN}`;
  await createPlan(planSmall, { executions_per_month: 3, workflow_runs_per_month: 2, api_calls_per_month: 6, connector_calls_per_month: 1, max_members: 4, max_active_workflows: 2, max_concurrent_executions: 1, usage_retention_days: 30 });
  await createPlan(planBig, { executions_per_month: 1000, workflow_runs_per_month: 1000, api_calls_per_month: 1000, connector_calls_per_month: 1000, max_members: 50, max_active_workflows: 100, max_concurrent_executions: 1, usage_retention_days: 90 });
  const setPlan = (ws, planId, extra = {}) => subs.assignPlanManually(ws.id, { planId, operator: 'test-operator', ...extra });

  async function waitExec(as, ws, id, statuses, tries = 800) {
    let last;
    for (let i = 0; i < tries; i++) { last = await call('GET', `${EX(ws)}/${id}`, { as }); if (last.status === 200 && statuses.includes(last.body.data.status)) return last.body.data; await sleep(10); }
    throw new Error(`execution ${id} never reached ${statuses}: ${JSON.stringify(last && last.body)}`);
  }
  async function waitRun(as, ws, id, statuses, tries = 1500) {
    let last;
    for (let i = 0; i < tries; i++) { last = await call('GET', `${RUNS(ws)}/${id}`, { as }); if (last.status === 200 && statuses.includes(last.body.data.status)) return last.body.data; await sleep(10); }
    throw new Error(`run ${id} never reached ${statuses}: ${JSON.stringify(last && last.body && last.body.data && last.body.data.status)}`);
  }
  async function exec(as, ws, goal, headers = {}) { return call('POST', EX(ws), { as, body: { goal }, headers }); }
  async function publish(as, ws, name, definition) {
    const c = await call('POST', WF(ws), { as, body: { name, definition } });
    assert.strictEqual(c.status, 201, JSON.stringify(c.body));
    const p = await call('POST', `${WF(ws)}/${c.body.data.id}/publish`, { as, body: {} });
    return { wf: c.body.data, publish: p };
  }
  const meter = (sum, cap) => sum.meters.find((m) => m.capability === cap);

  SCRIPTS.bread = (n) => (n === 0 ? step('read_text') : DONE('read done'));

  // ==================================================================
  await test('A usage events: an execution records agent_execution, its executed steps and its outcome — server-side, workspace-scoped', async () => {
    await setPlan(team, planBig);
    const before = await ledger(team.id);
    const r = await exec(U.bob, team, 'bread the page');
    assert.strictEqual(r.status, 201, JSON.stringify(r.body));
    await waitExec(U.bob, team, r.body.data.id, ['completed']);
    await sleep(30);
    const after = await ledger(team.id);
    assert.strictEqual(count(after, 'agent_execution') - count(before, 'agent_execution'), 1);
    assert.strictEqual(count(after, 'execution_step') - count(before, 'execution_step'), 1);
    assert.strictEqual(count(after, 'execution_completed') - count(before, 'execution_completed'), 1);
    const ev = after.find((e) => e.metric === 'agent_execution' && e.source_id === r.body.data.id);
    assert.ok(ev && ev.actor_id === U.bob.uid && ev.workspace_id === team.id);
    // a failing execution still counts once, with a failed outcome
    NEXUS = () => ({ success: false, error: 'boom' });
    SCRIPTS.bfail = (n) => (n < 3 ? step('click', { target: { name: 'Go' } }) : DONE());
    try {
      const f = await exec(U.bob, team, 'bfail click');
      await waitExec(U.bob, team, f.body.data.id, ['failed']);
      await sleep(30);
      const l = await ledger(team.id);
      assert.strictEqual(l.filter((e) => e.metric === 'agent_execution' && e.source_id === f.body.data.id).length, 1);
      assert.ok(l.some((e) => e.metric === 'execution_failed' && e.source_id === f.body.data.id));
    } finally { NEXUS = () => ({ success: true, data: 'ok', evidence: { verified: true } }); }
  });

  await test('B idempotency: replayed execution / run requests and repeated records never create a second usage event', async () => {
    const key = `bill-idem-${RUN}`;
    const a = await exec(U.bob, team, 'bread again', { 'idempotency-key': key });
    await waitExec(U.bob, team, a.body.data.id, ['completed']);
    const b = await exec(U.bob, team, 'bread again', { 'idempotency-key': key });
    assert.strictEqual(b.status, 200);
    assert.strictEqual(b.body.data.id, a.body.data.id);
    const l = await ledger(team.id);
    assert.strictEqual(l.filter((e) => e.idempotency_key === `exec:${key}`).length, 1);
    assert.strictEqual(await ent.record(team.id, 'api_call', 1, `manual-${RUN}`), true);
    assert.strictEqual(await ent.record(team.id, 'api_call', 1, `manual-${RUN}`), false, 'second record is a no-op');
    const { wf } = await publish(U.alice, team, `Idem ${RUN}`, { steps: [{ key: 'a', name: 'A', instruction: 'bread x' }] });
    const r1 = await call('POST', `${WF(team)}/${wf.id}/runs`, { as: U.bob, body: { inputs: {} }, headers: { 'idempotency-key': `run-idem-${RUN}` } });
    const r2 = await call('POST', `${WF(team)}/${wf.id}/runs`, { as: U.bob, body: { inputs: {} }, headers: { 'idempotency-key': `run-idem-${RUN}` } });
    assert.deepStrictEqual([r1.status, r2.status, r2.body.data.id], [201, 200, r1.body.data.id]);
    await waitRun(U.bob, team, r1.body.data.id, ['completed', 'failed']);
    const l2 = await ledger(team.id);
    assert.strictEqual(l2.filter((e) => e.idempotency_key === `wfrun:key:run-idem-${RUN}`).length, 1);
  });

  await test('C isolation: usage is workspace-scoped; non-members get 404; another workspace sees none of it', async () => {
    const mine = await call('GET', B(team), { as: U.bob });
    assert.strictEqual(mine.status, 200);
    assert.ok(mine.body.data.totals.agent_execution >= 1);
    assert.strictEqual((await call('GET', B(team), { as: U.mallory })).status, 404);
    for (const p of ['/usage', '/dashboard', '/plans']) assert.strictEqual((await call('GET', `${B(team)}${p}`, { as: U.mallory })).status, 404);
    const theirs = await call('GET', B(other), { as: U.mallory });
    assert.deepStrictEqual(theirs.body.data.totals, {});
    assert.strictEqual((await ledger(other.id)).length, 0);
  });

  await test('D quota calculation: meters show used / limit / remaining from the ledger for the current period', async () => {
    const s = (await call('GET', B(team), { as: U.bob })).body.data;
    assert.strictEqual(s.plan.id, planBig);
    const l = await ledger(team.id);
    const m = meter(s, 'executions');
    assert.deepStrictEqual([m.used, m.limit, m.remaining], [count(l, 'agent_execution'), 1000, 1000 - count(l, 'agent_execution')]);
    const mem = meter(s, 'members');
    assert.strictEqual(mem.used, 3, 'alice, carol, bob');
    assert.strictEqual(s.subscription.effectiveStatus, 'active');
    assert.strictEqual(s.billingEnabled, true);
    const dash = (await call('GET', `${B(team)}/dashboard`, { as: U.bob })).body.data;
    assert.ok(dash.executions >= 3 && dash.steps >= 2 && dash.workflowRuns >= 1);
    assert.ok(dash.successRate > 0 && dash.successRate < 100, 'one failure recorded');
    assert.ok(Array.isArray(dash.trend) && dash.trend.length === 30);
    const hist = (await call('GET', `${B(team)}/usage?days=400`, { as: U.bob })).body.data;
    assert.strictEqual(hist.days, 90, 'history bounded by the plan retention');
  });

  await test('E concurrency: 20 simultaneous reservations against a limit of 6 → exactly 6 succeed (atomic)', async () => {
    const ws = await wsService.createWorkspace(U.erin, { name: `Race ${RUN}` });
    await setPlan(ws, planSmall);
    const results = await Promise.allSettled(Array.from({ length: 20 }, (_, i) => ent.begin(ws.id, 'api_calls', `race-${RUN}-${i}`)));
    const ok = results.filter((r) => r.status === 'fulfilled');
    assert.strictEqual(ok.length, 6);
    assert.ok(results.filter((r) => r.status === 'rejected').every((r) => r.reason instanceof QuotaError && r.reason.code === 'QUOTA_EXCEEDED'));
    await Promise.all(ok.map((r) => ent.commit(r.value)));
    // concurrent workflow-run starts against limit 2
    const { wf } = await publish(U.erin, ws, `RaceWf ${RUN}`, { steps: [{ key: 'a', name: 'A', instruction: 'bread x' }] });
    const starts = await Promise.all(Array.from({ length: 6 }, () => call('POST', `${WF(ws)}/${wf.id}/runs`, { as: U.erin, body: { inputs: {} } })));
    assert.strictEqual(starts.filter((r) => r.status === 201).length, 2, JSON.stringify(starts.map((r) => r.status)));
    assert.ok(starts.filter((r) => r.status !== 201).every((r) => r.status === 402 && r.body.code === 'QUOTA_EXCEEDED'));
    for (const r of starts.filter((x) => x.status === 201)) await waitRun(U.erin, ws, r.body.data.id, ['completed', 'failed']);
    assert.strictEqual(count(await ledger(ws.id), 'workflow_run'), 2);
  });

  await test('F plan limits: executions, members, active workflows and connector calls are capped; admins cannot bypass', async () => {
    const ws = await wsService.createWorkspace(U.dave, { name: `Limits ${RUN}` });
    await setPlan(ws, planSmall);
    for (let i = 0; i < 3; i++) {
      const r = await exec(U.dave, ws, 'bread limit');
      assert.strictEqual(r.status, 201, JSON.stringify(r.body));
      await waitExec(U.dave, ws, r.body.data.id, ['completed']);
    }
    const n0 = nexusCalls.length;
    const over = await exec(U.dave, ws, 'bread limit');
    assert.strictEqual(over.status, 402);
    assert.strictEqual(over.body.code, 'QUOTA_EXCEEDED');
    assert.strictEqual(nexusCalls.length, n0, 'nothing executed');
    // members: limit 4 (dave + 3 seats, pending invitations count)
    const invs = [];
    for (const u of ['m1', 'm2', 'm3']) {
      const r = await call('POST', `/api/workspaces/${ws.id}/invitations`, { as: U.dave, body: { email: `${u}_${RUN}@example.com`, role: 'member' } });
      assert.strictEqual(r.status, 201, JSON.stringify(r.body));
      invs.push(r.body.data);
    }
    const fifth = await call('POST', `/api/workspaces/${ws.id}/invitations`, { as: U.dave, body: { email: `m4_${RUN}@example.com`, role: 'member' } });
    assert.deepStrictEqual([fifth.status, fifth.body.code], [402, 'QUOTA_EXCEEDED']);
    // active workflows: limit 2
    for (let i = 0; i < 2; i++) assert.ok([200, 201].includes((await publish(U.dave, ws, `W${i} ${RUN}`, { steps: [{ key: 'a', name: 'A', instruction: 'bread x' }] })).publish.status));
    const third = await publish(U.dave, ws, `W3 ${RUN}`, { steps: [{ key: 'a', name: 'A', instruction: 'bread x' }] });
    assert.deepStrictEqual([third.publish.status, third.publish.body.code], [402, 'QUOTA_EXCEEDED']);
    // connector calls: limit 1 → the second connector step is refused before any request
    await setPlan(ws, planBig);
    const integ = await call('POST', `/api/workspaces/${ws.id}/integrations`, { as: U.dave, body: { provider: 'http', name: 'Data', config: { baseUrl: `http://api.example.test:${apiPort}/v1/`, authType: 'none' } } });
    assert.strictEqual(integ.status, 201, JSON.stringify(integ.body));
    await setPlan(ws, planSmall);
    await createPlan(`tc_${RUN}`, { executions_per_month: 100, workflow_runs_per_month: 100, api_calls_per_month: 100, connector_calls_per_month: 1, max_members: 10, max_active_workflows: 10, max_concurrent_executions: 1, usage_retention_days: 30 });
    await setPlan(ws, `tc_${RUN}`);
    const { wf } = await publish(U.dave, ws, `Conn ${RUN}`, { steps: [
      { key: 'c1', name: 'c1', connector: { integrationId: integ.body.data.id, action: 'get', input: { path: '/v1/one' } } },
      { key: 'c2', name: 'c2', connector: { integrationId: integ.body.data.id, action: 'get', input: { path: '/v1/two' } } },
    ] });
    const r = await call('POST', `${WF(ws)}/${wf.id}/runs`, { as: U.dave, body: { inputs: {} } });
    const done = await waitRun(U.dave, ws, r.body.data.id, ['completed', 'failed']);
    assert.strictEqual(done.status, 'failed');
    assert.strictEqual(done.steps[1].error.code, 'QUOTA_EXCEEDED');
    assert.ok(apiLog.includes('/v1/one') && !apiLog.includes('/v1/two'), 'the second call was never sent');
    assert.strictEqual(count(await ledger(ws.id), 'connector_call'), 1);
  });

  await test('G unlimited: null limits mean unlimited — no reservation cap, reported as unlimited', async () => {
    const ws = await wsService.createWorkspace(U.erin, { name: `Ent ${RUN}` });
    await setPlan(ws, 'enterprise');
    const r = await ent.checkEntitlement(ws.id, 'executions', 1000000);
    assert.deepStrictEqual([r.allowed, r.limit, r.reason], [true, null, 'UNLIMITED']);
    const hs = await Promise.all(Array.from({ length: 30 }, (_, i) => ent.begin(ws.id, 'api_calls', `ent-${RUN}-${i}`)));
    assert.strictEqual(hs.length, 30);
    const s = (await call('GET', B(ws), { as: U.erin })).body.data;
    assert.ok(meter(s, 'executions').unlimited && meter(s, 'executions').remaining === null);
    assert.strictEqual(limitOf({ limits: { a: null } }, 'a'), null);
    assert.strictEqual(limitOf({ limits: { a: '5' } }, 'a'), 0, 'malformed limit → 0 (fail closed)');
    assert.strictEqual(limitOf({ limits: {} }, 'missing'), 0, 'missing limit → 0');
  });

  await test('H expired / lapsed subscriptions fall back to the Free plan limits', async () => {
    const t = new Date('2026-09-15T00:00:00Z');
    const past = (d) => new Date(t.getTime() - d * 86400000).toISOString();
    const fut = (d) => new Date(t.getTime() + d * 86400000).toISOString();
    const sub = (x) => ({ plan_id: 'pro', current_period_start: past(20), current_period_end: fut(10), ...x });
    assert.strictEqual(resolveEffective(sub({ status: 'expired' }), t).planId, 'free');
    assert.strictEqual(resolveEffective(sub({ status: 'active' }), t).planId, 'pro');
    assert.strictEqual(resolveEffective(sub({ status: 'active', current_period_end: past(5) }), t).planId, 'free', 'not renewed + grace over');
    assert.strictEqual(resolveEffective(sub({ status: 'past_due', current_period_end: past(2) }), t).planId, 'pro', 'past_due inside grace');
    assert.strictEqual(resolveEffective(sub({ status: 'past_due', current_period_end: past(8) }), t).planId, 'free', 'past_due after grace');
    assert.strictEqual(resolveEffective(sub({ status: 'trialing', trial_ends_at: past(1) }), t).planId, 'free');
    assert.strictEqual(resolveEffective(sub({ status: 'trialing', trial_ends_at: fut(1) }), t).planId, 'pro');
    assert.strictEqual(resolveEffective(null, t).planId, 'free');
    const ws = await wsService.createWorkspace(U.erin, { name: `Exp ${RUN}` });
    await setPlan(ws, 'enterprise', { status: 'expired' });
    const s = (await call('GET', B(ws), { as: U.erin })).body.data;
    assert.deepStrictEqual([s.plan.id, s.subscription.status, s.subscription.effectivePlanReason], ['free', 'expired', 'EXPIRED']);
    assert.strictEqual(meter(s, 'executions').limit, 100);
  });

  await test('I cancelled subscriptions keep the plan until the paid period ends, then fall back', async () => {
    const ws = await wsService.createWorkspace(U.erin, { name: `Canc ${RUN}` });
    const start = new Date(Date.now() - 5 * 86400000).toISOString();
    const end = new Date(Date.now() + 5 * 86400000).toISOString();
    await setPlan(ws, planBig, { status: 'cancelled', periodStart: start, periodEnd: end });
    let s = (await call('GET', B(ws), { as: U.erin })).body.data;
    assert.deepStrictEqual([s.plan.id, s.subscription.effectivePlanReason], [planBig, 'CANCELLED_UNTIL_PERIOD_END']);
    await setPlan(ws, planBig, { status: 'cancelled', periodStart: new Date(Date.now() - 40 * 86400000).toISOString(), periodEnd: new Date(Date.now() - 10 * 86400000).toISOString() });
    s = (await call('GET', B(ws), { as: U.erin })).body.data;
    assert.deepStrictEqual([s.plan.id, s.subscription.effectivePlanReason], ['free', 'CANCELLED']);
  });

  // Webhooks ----------------------------------------------------------
  const whBody = (o) => JSON.stringify(o);
  const sign = (raw, ts = Math.floor(Date.now() / 1000)) => signGenericPayload(WEBHOOK_SECRET, Buffer.from(raw), ts);
  const post = (raw, sig, provider = 'generic') => call('POST', `/api/billing/webhooks/${provider}`, { raw, headers: sig ? { 'nexus-signature': sig } : {} });
  const evt = (id, ws, data = {}, created = Math.floor(Date.now() / 1000)) => ({ id, type: 'subscription.updated', created, data: { workspace_id: ws, plan_id: 'pro', status: 'active', customer_id: `cus_${RUN}`, subscription_id: `sub_${RUN}`, current_period_start: created - 86400, current_period_end: created + 29 * 86400, ...data } });
  const whWs = await wsService.createWorkspace(U.erin, { name: `Hook ${RUN}` });

  await test('J webhook replay: a delivery is applied once; re-deliveries and older events never re-apply', async () => {
    const raw = whBody(evt(`evt_1_${RUN}`, whWs.id));
    const r1 = await post(raw, sign(raw));
    assert.deepStrictEqual([r1.status, r1.body.status], [200, 'processed']);
    let s = (await call('GET', B(whWs), { as: U.erin })).body.data;
    assert.deepStrictEqual([s.plan.id, s.subscription.status, s.subscription.provider], ['pro', 'active', 'generic']);
    assert.ok(!JSON.stringify(s).includes(`cus_${RUN}`) && !JSON.stringify(s).includes(`sub_${RUN}`), 'external ids are not exposed');
    const r2 = await post(raw, sign(raw));
    assert.deepStrictEqual([r2.status, r2.body.status], [200, 'duplicate']);
    // same event id with a different (downgrade) payload → still a duplicate
    const raw3 = whBody(evt(`evt_1_${RUN}`, whWs.id, { status: 'expired' }));
    assert.strictEqual((await post(raw3, sign(raw3))).body.status, 'duplicate');
    // an OLDER event with a new id → ignored (out of order)
    const raw4 = whBody(evt(`evt_0_${RUN}`, whWs.id, { status: 'cancelled' }, Math.floor(Date.now() / 1000) - 3600));
    assert.strictEqual((await post(raw4, sign(raw4))).body.status, 'ignored');
    s = (await call('GET', B(whWs), { as: U.erin })).body.data;
    assert.deepStrictEqual([s.plan.id, s.subscription.status], ['pro', 'active']);
    // a newer event applies
    const raw5 = whBody(evt(`evt_2_${RUN}`, whWs.id, { status: 'past_due' }, Math.floor(Date.now() / 1000) + 5));
    assert.strictEqual((await post(raw5, sign(raw5, Math.floor(Date.now() / 1000)))).body.status, 'processed');
    s = (await call('GET', B(whWs), { as: U.erin })).body.data;
    assert.strictEqual(s.subscription.status, 'past_due');
  });

  await test('K webhook authentication + binding: bad / missing / stale signatures, tampering, unknown provider, workspace re-binding all rejected', async () => {
    const raw = whBody(evt(`evt_k_${RUN}`, whWs.id, { plan_id: 'enterprise' }));
    assert.strictEqual((await post(raw, null)).status, 400);
    assert.strictEqual((await post(raw, `t=${Math.floor(Date.now() / 1000)},v1=${'0'.repeat(64)}`)).body.code, 'SIGNATURE_INVALID');
    assert.strictEqual((await post(raw, sign(raw, Math.floor(Date.now() / 1000) - 3600))).body.code, 'SIGNATURE_EXPIRED');
    const tampered = raw.replace('enterprise', 'business');
    assert.strictEqual((await post(tampered, sign(raw))).body.code, 'SIGNATURE_INVALID');
    assert.strictEqual((await post(raw, signGenericPayload('x'.repeat(40), Buffer.from(raw), Math.floor(Date.now() / 1000)))).body.code, 'SIGNATURE_INVALID', 'wrong secret');
    assert.strictEqual((await post(raw, sign(raw), 'stripe')).status, 404, 'unknown provider');
    assert.strictEqual((await post(raw, sign(raw), 'none')).status, 404);
    // binding: the subscription bound to whWs cannot move to another workspace
    const ws2 = await wsService.createWorkspace(U.erin, { name: `Hook2 ${RUN}` });
    const hijack = whBody(evt(`evt_h_${RUN}`, ws2.id, { plan_id: 'enterprise' }, Math.floor(Date.now() / 1000) + 10));
    assert.strictEqual((await post(hijack, sign(hijack))).body.status, 'rejected');
    assert.strictEqual((await call('GET', B(ws2), { as: U.erin })).body.data.plan.id, 'free');
    // a workspace bound to one customer cannot be re-bound to another
    const rebind = whBody(evt(`evt_r_${RUN}`, whWs.id, { customer_id: `cus_evil_${RUN}`, subscription_id: `sub_evil_${RUN}`, plan_id: 'enterprise' }, Math.floor(Date.now() / 1000) + 20));
    assert.strictEqual((await post(rebind, sign(rebind))).body.status, 'rejected');
    // unknown workspace / unknown plan
    const ghost = whBody(evt(`evt_g_${RUN}`, crypto.randomUUID(), { subscription_id: `sub_g_${RUN}`, customer_id: `cus_g_${RUN}` }));
    assert.strictEqual((await post(ghost, sign(ghost))).body.status, 'rejected');
    const noPlan = whBody(evt(`evt_p_${RUN}`, whWs.id, { plan_id: 'platinum' }, Math.floor(Date.now() / 1000) + 30));
    assert.strictEqual((await post(noPlan, sign(noPlan))).body.status, 'rejected');
    assert.strictEqual((await call('GET', B(whWs), { as: U.erin })).body.data.plan.id, 'pro', 'nothing changed');
    const notConfigured = createSubscriptionService({ store: billStore, providers: { map: { generic: createGenericProvider({ secret: 'short' }) }, active: createNoProvider(), activeName: 'none' } });
    await assert.rejects(notConfigured.applyWebhook('generic', Buffer.from(raw), { 'nexus-signature': sign(raw) }), (e) => e.status === 503);
  });

  // API keys (Layer 6 reuse) ---------------------------------------
  await setPlan(team, planBig);
  const mkKey = async (ws, as, scopes) => {
    const r = await call('POST', `/api/workspaces/${ws.id}/security/api-keys`, { as, body: { name: `k ${crypto.randomBytes(2).toString('hex')}`, scopes } });
    assert.strictEqual(r.status, 201, JSON.stringify(r.body));
    return r.body.data;
  };
  const AUTO = '/api/automation/v1';
  let teamKey;

  await test('L API key: executions submitted with a Layer 6 key run through Layer 3 + the firewall and are metered (api_call + execution)', async () => {
    teamKey = await mkKey(team, U.alice, ['executions:run', 'runs:read']);
    const before = await ledger(team.id);
    const r = await call('POST', `${AUTO}/executions`, { headers: { authorization: `Bearer ${teamKey.key}`, 'idempotency-key': `api-exec-${RUN}` }, body: { goal: 'bread via api' } });
    assert.strictEqual(r.status, 201, JSON.stringify(r.body));
    let e;
    for (let i = 0; i < 300; i++) { e = await call('GET', `${AUTO}/executions/${r.body.data.id}`, { headers: { authorization: `Bearer ${teamKey.key}` } }); if (e.body.data && e.body.data.status === 'completed') break; await sleep(10); }
    assert.strictEqual(e.body.data.status, 'completed');
    const after = await ledger(team.id);
    assert.strictEqual(count(after, 'agent_execution') - count(before, 'agent_execution'), 1);
    assert.ok(count(after, 'api_call') - count(before, 'api_call') >= 2);
    assert.ok(after.some((x) => x.metric === 'api_call' && x.source_id === teamKey.apiKey.id));
    // firewall still applies to key-submitted work: a denied action is never executed
    const pol = await call('PUT', `/api/workspaces/${team.id}/security/policy`, { as: U.alice, body: { version: 0, policy: { executionTypes: { browser: false } } } });
    assert.strictEqual(pol.status, 200, JSON.stringify(pol.body));
    const n0 = nexusCalls.length;
    const d = await call('POST', `${AUTO}/executions`, { headers: { authorization: `Bearer ${teamKey.key}`, 'idempotency-key': `api-exec2-${RUN}` }, body: { goal: 'bread denied' } });
    assert.strictEqual(d.status, 201);
    for (let i = 0; i < 300; i++) { e = await call('GET', `${AUTO}/executions/${d.body.data.id}`, { headers: { authorization: `Bearer ${teamKey.key}` } }); if (e.body.data.status === 'failed') break; await sleep(10); }
    assert.strictEqual(e.body.data.failure.code, 'POLICY_DENIED');
    assert.strictEqual(nexusCalls.length, n0);
    await call('PUT', `/api/workspaces/${team.id}/security/policy`, { as: U.alice, body: { version: pol.body.data.version, policy: {} } });
    assert.strictEqual((await call('POST', `${AUTO}/executions`, { headers: { authorization: `Bearer ${teamKey.key}` }, body: { goal: 'x' } })).status, 400, 'Idempotency-Key required');
    const scoped = await mkKey(team, U.alice, ['runs:read']);
    assert.strictEqual((await call('POST', `${AUTO}/executions`, { headers: { authorization: `Bearer ${scoped.key}`, 'idempotency-key': `api-exec3-${RUN}` }, body: { goal: 'bread' } })).status, 403, 'scope');
  });

  await test('M/N API key revocation + rotation: revoked / rotated-away keys are rejected and no usage is recorded for them', async () => {
    const k = await mkKey(team, U.alice, ['runs:read']);
    const probe = (key) => call('GET', `${AUTO}/executions/00000000-0000-4000-8000-000000000000`, { headers: { authorization: `Bearer ${key}` } });
    assert.strictEqual((await probe(k.key)).status, 404);
    const rot = await call('POST', `/api/workspaces/${team.id}/security/api-keys/${k.apiKey.id}/rotate`, { as: U.alice, body: {} });
    assert.strictEqual((await probe(k.key)).status, 401);
    assert.strictEqual((await probe(rot.body.data.key)).status, 404);
    await call('POST', `/api/workspaces/${team.id}/security/api-keys/${rot.body.data.apiKey.id}/revoke`, { as: U.alice, body: {} });
    const before = count(await ledger(team.id), 'api_call');
    assert.strictEqual((await probe(rot.body.data.key)).status, 401);
    assert.strictEqual(count(await ledger(team.id), 'api_call'), before, 'rejected calls are not metered');
    const list = await call('GET', `/api/workspaces/${team.id}/security/api-keys`, { as: U.alice });
    assert.ok(!list.text.includes(rot.body.data.key.slice(17)), 'raw keys never listed');
  });

  await test('O cross-workspace API keys: a key only ever sees its own workspace', async () => {
    const otherKey = await mkKey(other, U.mallory, ['executions:run', 'runs:read']);
    const teamExec = (await ledger(team.id)).find((e) => e.metric === 'agent_execution').source_id;
    assert.strictEqual((await call('GET', `${AUTO}/executions/${teamExec}`, { headers: { authorization: `Bearer ${otherKey.key}` } })).status, 404);
    const r = await call('POST', `${AUTO}/executions`, { headers: { authorization: `Bearer ${otherKey.key}`, 'idempotency-key': `x-${RUN}`, 'x-workspace-id': team.id }, body: { goal: 'bread', workspaceId: team.id } });
    assert.strictEqual(r.status, 201);
    assert.strictEqual(r.body.data.workspaceId, other.id, 'body/header workspace ignored');
    await sleep(50);
  });

  await test('P billing authorization: members read; only owner/admin may request plan changes; no provider → 501, never a fake success', async () => {
    assert.strictEqual((await call('GET', B(team), { as: U.bob })).status, 200);
    assert.strictEqual((await call('POST', `${B(team)}/subscription/checkout`, { as: U.bob, body: { planId: 'pro' } })).status, 403);
    assert.strictEqual((await call('POST', `${B(team)}/subscription/cancel`, { as: U.bob, body: {} })).status, 403);
    const c = await call('POST', `${B(team)}/subscription/checkout`, { as: U.carol, body: { planId: 'pro' } });
    assert.deepStrictEqual([c.status, c.body.code], [501, 'PAYMENTS_UNAVAILABLE']);
    assert.strictEqual((await call('POST', `${B(team)}/subscription/cancel`, { as: U.alice, body: {} })).status, 501);
    assert.strictEqual((await call('POST', `${B(team)}/subscription/checkout`, { as: U.alice, body: { planId: 'nope' } })).status, 400);
    assert.strictEqual((await call('GET', B(team), { headers: { authorization: `Bearer ${teamKey.key}` } })).status, 401, 'API keys cannot use the billing API');
    const s = (await call('GET', B(team), { as: U.alice })).body.data;
    assert.strictEqual(s.plan.id, planBig, 'plan unchanged');
    assert.deepStrictEqual(s.payments, { provider: 'none', configured: false, checkoutAvailable: false });
  });

  await test('Q client spoofing: usage numbers, plans, workspaces and quantities from the client are ignored', async () => {
    const before = await ledger(team.id);
    const r = await call('POST', EX(team), { as: U.bob, body: { goal: 'bread spoof', quantity: -100, usage: { agent_execution: 0 }, planId: 'enterprise', workspaceId: other.id }, headers: { 'x-workspace-id': other.id, 'x-plan': 'enterprise' } });
    assert.strictEqual(r.status, 201);
    assert.strictEqual(r.body.data.workspaceId, team.id);
    await waitExec(U.bob, team, r.body.data.id, ['completed']);
    const after = await ledger(team.id);
    assert.strictEqual(count(after, 'agent_execution') - count(before, 'agent_execution'), 1);
    const s = await call('GET', `${B(team)}?plan=enterprise&limit=999`, { as: U.bob });
    assert.strictEqual(s.body.data.plan.id, planBig);
    assert.strictEqual((await call('POST', B(team), { as: U.alice, body: { planId: 'enterprise' } })).status, 404, 'no write endpoint for plans');
  });

  await test('R negative / invalid quantities are rejected everywhere (service, store, database)', async () => {
    for (const q of [-1, 1.5, '2', NaN, 2e6]) {
      await assert.rejects(ent.checkEntitlement(team.id, 'executions', q), (e) => e.status === 400, String(q));
      await assert.rejects(ent.record(team.id, 'api_call', q, `neg-${RUN}-${q}`), (e) => e.status === 400, String(q));
    }
    await assert.rejects(ent.record(team.id, 'api_call', 0, `zero-${RUN}`), (e) => e.status === 400);
    await assert.rejects(ent.record(team.id, 'made_up', 1, `mu-${RUN}`), (e) => e.status === 400);
    await assert.rejects(ent.checkEntitlement(team.id, 'teleports', 1), (e) => e.status === 400);
    await assert.rejects(ent.checkEntitlement('not-a-uuid', 'executions', 1), (e) => e.status === 400);
    await assert.rejects(billStore.recordUsage({ workspaceId: team.id, metric: 'api_call', quantity: -3, key: `db-neg-${RUN}` }));
    await assert.rejects(billStore.reserveUsage({ workspaceId: team.id, metric: 'api_call', quantity: -3, limit: 10, periodStart: new Date(Date.now() - 1000).toISOString(), periodEnd: new Date(Date.now() + 1e6).toISOString(), key: `db-neg2-${RUN}`, ttlSeconds: 60 }));
  });

  await test('S no double charging: a retried workflow step, a replayed API call and a raced duplicate are charged once', async () => {
    let first = true;
    NEXUS = (req) => { if (req.action === 'read_text' && first) { first = false; return { success: false, error: 'transient' }; } return { success: true, data: 'ok', evidence: { verified: true } }; };
    try {
      SCRIPTS.bretry = (n, goal) => (n === 0 ? step('read_text') : DONE());
      const { wf } = await publish(U.alice, team, `Retry ${RUN}`, { steps: [{ key: 'a', name: 'A', instruction: 'bretry read', retry: { maxAttempts: 2 } }] });
      const r = await call('POST', `${WF(team)}/${wf.id}/runs`, { as: U.bob, body: { inputs: {} } });
      const done = await waitRun(U.bob, team, r.body.data.id, ['completed', 'failed']);
      const attempts = done.steps[0].attempts.length;
      const l = await ledger(team.id);
      const charged = l.filter((e) => e.metric === 'agent_execution' && e.idempotency_key === `exec:wf:${r.body.data.id}:0`).length;
      assert.strictEqual(charged, 1, `attempts=${attempts}`);
      assert.strictEqual(l.filter((e) => e.metric === 'workflow_run' && e.source_id === r.body.data.id).length, 1);
    } finally { NEXUS = () => ({ success: true, data: 'ok', evidence: { verified: true } }); }
    // raced duplicate API submissions with one idempotency key
    const key = `race-dup-${RUN}`;
    const res = await Promise.all(Array.from({ length: 4 }, () => call('POST', `${AUTO}/executions`, { headers: { authorization: `Bearer ${teamKey.key}`, 'idempotency-key': key }, body: { goal: 'bread dup' } })));
    const ids = new Set(res.filter((x) => [200, 201].includes(x.status)).map((x) => x.body.data.id));
    assert.strictEqual(ids.size, 1, JSON.stringify(res.map((x) => x.status)));
    await sleep(100);
    assert.strictEqual((await ledger(team.id)).filter((e) => e.idempotency_key === `exec:${key}`).length, 1);
  });

  await test('T audit: plan assignment, webhooks, quota denials and payment requests are audited, workspace-scoped, without secrets', async () => {
    const types = (ws) => auditRows.filter((a) => a.workspace_id === ws && String(a.action).startsWith('billing.')).map((a) => a.action);
    assert.ok(types(team.id).includes('billing.plan_assigned'));
    assert.ok(types(team.id).includes('billing.checkout_requested'));
    assert.ok(auditRows.some((a) => a.action === 'billing.quota_exceeded'));
    assert.ok(types(whWs.id).includes('billing.subscription_changed'));
    assert.ok(types(whWs.id).includes('billing.webhook_duplicate'));
    assert.ok(types(whWs.id).includes('billing.webhook_rejected'));
    const pa = auditRows.find((a) => a.action === 'billing.plan_assigned' && a.workspace_id === team.id);
    assert.strictEqual(pa.user_id, 'operator:test-operator');
    const blob = JSON.stringify(auditRows) + responses.join('\n');
    assert.ok(!blob.includes(WEBHOOK_SECRET), 'webhook secret never logged or returned');
    assert.ok(!blob.includes(teamKey.key.slice(17)) || responses.filter((x) => x.includes(teamKey.key.slice(17))).length === 1, 'API key plaintext only in its create response');
    assert.ok(!auditRows.some((a) => a.workspace_id === other.id && JSON.stringify(a).includes(team.id)), 'no cross-workspace audit');
  });

  await test('BILLING_ENABLED=false: nothing is enforced, usage is still metered, payment status is not faked', async () => {
    assert.strictEqual(billingFlag({}), false);
    assert.strictEqual(billingFlag({ BILLING_ENABLED: 'true' }), true);
    assert.strictEqual(billingFlag({ BILLING_ENABLED: 'yes' }), false);
    const off = createEntitlementService({ store: billStore, enabled: false, counters, logger: quiet });
    const ws = await wsService.createWorkspace(U.dave, { name: `Off ${RUN}` });
    await setPlan(ws, planSmall);
    const r = await off.checkEntitlement(ws.id, 'executions', 50);
    assert.deepStrictEqual([r.allowed, r.enforced, r.reason], [true, false, 'BILLING_DISABLED']);
    const svc = createAgentExecutionService({ store: execStore, options: { retryDelayMs: 0 }, deps: { appendAuditLog }, logger: quiet });
    svc.setUsageMeter(off);
    const ctx = { workspace: { id: ws.id }, role: 'owner', userId: U.dave.uid };
    for (let i = 0; i < 4; i++) {
      const { execution } = await svc.createExecution(ctx, { goal: 'bread off' });
      let e;
      for (let j = 0; j < 300; j++) { e = await svc.getExecution(ctx, execution.id); if (e.status === 'completed') break; await sleep(10); }
    }
    assert.strictEqual(count(await ledger(ws.id), 'agent_execution'), 4, 'beyond the limit of 3, still metered');
    const offBilling = createBillingService({ store: billStore, entitlements: off, providers, counters, enabled: false });
    const s = await offBilling.summary({ workspace: { id: ws.id }, userId: U.dave.uid, role: 'owner' });
    assert.deepStrictEqual([s.billingEnabled, s.enforcement, s.payments.configured], [false, 'not_enforced', false]);
  });

  await test('fail closed: when enforcement is on and plan/usage storage fails, limited operations are refused', async () => {
    const broken = { ...billStore, listPlans: async () => { throw new Error('relation "billing_plans" does not exist'); } };
    const e2 = createEntitlementService({ store: broken, enabled: true, counters, logger: quiet, options: { planCacheMs: 0 } });
    const r = await e2.checkEntitlement(team.id, 'executions', 1);
    assert.deepStrictEqual([r.allowed, r.reason], [false, 'ENTITLEMENT_UNAVAILABLE']);
    await assert.rejects(e2.begin(team.id, 'executions', `fc-${RUN}`), (e) => e.status === 503);
  });

  await test('U/V database: immutable ledger, idempotency constraint, and anon cannot touch billing tables or RPCs (real Postgres)', async () => {
    if (!SUPA) {
      // memory store mirrors the constraints; the SQL-level checks run against real Postgres
      assert.strictEqual(await billStore.recordUsage({ workspaceId: team.id, metric: 'api_call', quantity: 1, key: `dup-${RUN}` }), true);
      assert.strictEqual(await billStore.recordUsage({ workspaceId: team.id, metric: 'api_call', quantity: 1, key: `dup-${RUN}` }), false);
      return;
    }
    const { error: upd } = await db.from('usage_events').update({ quantity: 999 }).eq('workspace_id', team.id);
    assert.ok(upd && /immutable/.test(upd.message), `update: ${upd && upd.message}`);
    const { error: del } = await db.from('usage_events').delete().eq('workspace_id', team.id);
    assert.ok(del && /immutable/.test(del.message), `delete: ${del && del.message}`);
    const { error: dup } = await db.from('usage_events').insert({ workspace_id: team.id, metric: 'api_call', quantity: 1, idempotency_key: `dup-${RUN}` });
    const { error: dup2 } = await db.from('usage_events').insert({ workspace_id: team.id, metric: 'api_call', quantity: 1, idempotency_key: `dup-${RUN}` });
    assert.ok(!dup && dup2 && dup2.code === '23505');
    // deleting a workspace still cascades through the immutable ledger
    const tmp = await wsService.createWorkspace(U.erin, { name: `Del ${RUN}` });
    await ent.record(tmp.id, 'api_call', 1, `del-${RUN}`);
    await wsService.deleteWorkspace({ workspace: tmp, role: 'owner', userId: U.erin.uid });
    assert.strictEqual((await ledger(tmp.id)).length, 0);
    if (!process.env.ANON_KEY) { console.log('  (anon checks skipped: set ANON_KEY)'); return; }
    const anon = require('@supabase/supabase-js').createClient(process.env.SUPABASE_URL, process.env.ANON_KEY);
    for (const t of ['billing_plans', 'workspace_subscriptions', 'usage_events', 'usage_reservations', 'billing_webhook_events']) {
      const { error } = await anon.from(t).select('*').limit(1);
      assert.ok(error, `${t} readable by anon`);
    }
    const { error: ins } = await anon.from('usage_events').insert({ workspace_id: team.id, metric: 'api_call', quantity: 1, idempotency_key: `anon-${RUN}` });
    assert.ok(ins, 'anon insert');
    for (const [fn, args] of [['billing_reserve_usage', { p_workspace: team.id, p_metric: 'api_call', p_quantity: 1, p_limit: null, p_period_start: new Date().toISOString(), p_period_end: new Date(Date.now() + 1e6).toISOString(), p_key: 'x', p_ttl_seconds: 60 }], ['billing_record_usage', { p_workspace: team.id, p_metric: 'api_call', p_quantity: 1, p_key: 'y', p_source: null, p_source_id: null, p_actor: null, p_reservation: null }], ['billing_usage_totals', { p_workspace: team.id, p_from: new Date(0).toISOString(), p_to: new Date().toISOString() }]]) {
      const { error } = await anon.rpc(fn, args);
      assert.ok(error, `${fn} callable by anon`);
    }
  });

  await runner.stop();
  srv.close();
  api.close();
  console.log(`\n${passed} passed, ${failed} failed (store: ${SUPA ? 'supabase' : 'memory'})`);
  process.exit(failed ? 1 : 0);
}

run().catch((err) => { console.error(err); process.exit(1); });
