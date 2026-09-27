/**
 * Layer 4 — Workflows + Durable Execution tests.
 *
 * Drives the REAL HTTP stack (express.json → sanitizer → middleware/auth.js
 * → Layer 1 workspaceContext → routes/workflows.js), the REAL workflow
 * service + durable runner, the REAL Layer 3 executionService (planner
 * primitives, riskModel, approvals, evidence), Layer 2 task store
 * semantics and sensitiveDataFilter.
 *
 * Replaced (external services only): Firebase token verification, the
 * Gemini client (scripted planner), the Nexus HTTP bridge (scripted
 * executor), and storage (in-memory stores mirroring the SQL constraints;
 * WORKSPACE_TEST_STORE=supabase runs the same suite against a real
 * Postgres + PostgREST with the Layer 1–4 migrations applied).
 *
 * Run: node __tests__/workflows.test.js
 */
'use strict';

const assert = require('assert');
const Module = require('module');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const R = (...p) => require.resolve(path.join(ROOT, ...p));
const STORE_MODE = process.env.WORKSPACE_TEST_STORE === 'supabase' ? 'supabase' : 'memory';
const SUPA = STORE_MODE === 'supabase';

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
    createClient: () => ({
      from() {
        const b = { select() { return b; }, eq() { return b; }, async maybeSingle() { return { data: null, error: null }; }, async insert() { return { data: null, error: null }; } };
        return b;
      },
    }),
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

// ---- scripted planner: SCRIPTS[tag](historyLen, prompt) -----------------
const SCRIPTS = {};
const prompts = [];
fakeModule(R('backend-routing', 'geminiClient.js'), {
  generateContent: async (prompt) => {
    prompts.push(prompt);
    const goal = (prompt.match(/The user's goal: "([\s\S]*?)"\n/) || [])[1] || '';
    const tag = goal.split(/\s+/)[0];
    const section = prompt.split('Steps executed so far:\n')[1].split('\n\nClarifications')[0];
    const historyLen = (section.match(/^\d+\. /gm) || []).length;
    const script = SCRIPTS[tag];
    const reply = script ? script(historyLen, goal) : { done: true, reason: 'nothing to do' };
    return { response: { text: () => (typeof reply === 'string' ? reply : JSON.stringify(reply)) } };
  },
});

// ---- scripted executor ----------------------------------------------------
let NEXUS = () => ({ success: true, data: 'ok', evidence: { verified: true } });
const nexusCalls = [];
fakeModule(R('backend-routing', 'nexusBridge.js'), {
  sendCommandToNexus: async (req) => {
    nexusCalls.push(req);
    return NEXUS(req, nexusCalls.filter((c) => c.action === req.action).length);
  },
});

// ---- real modules ------------------------------------------------------------
const express = require('express');
const authenticateFirebaseUser = require(R('middleware', 'auth.js'));
const sanitizeInput = require(R('middleware', 'sanitizer.js'));
const taskPlanner = require(R('backend-routing', 'taskPlanner.js'));
const { createWorkspaceService } = require(R('services', 'workspaceService.js'));
const { createAgentExecutionService } = require(R('services', 'agentExecution', 'executionService.js'));
const { createExecutionsRouter } = require(R('routes', 'executions.js'));
const { createWorkflowService } = require(R('services', 'workflows', 'workflowService.js'));
const { createWorkflowRunner } = require(R('services', 'workflows', 'workflowRunner.js'));
const { createWorkflowRouters } = require(R('routes', 'workflows.js'));
const { render, normalizeDefinition, validateInputs } = require(R('services', 'workflows', 'definition.js'));
const { createMemoryWorkspaceStore } = require(path.join(__dirname, 'support', 'memoryWorkspaceStore.js'));
const { createMemoryExecutionStore } = require(path.join(__dirname, 'support', 'memoryExecutionStore.js'));
const { createMemoryWorkspaceDataStore } = require(path.join(__dirname, 'support', 'memoryWorkspaceDataStore.js'));
const { createMemoryWorkflowStore } = require(path.join(__dirname, 'support', 'memoryWorkflowStore.js'));

let clockOffset = 0;
const now = () => new Date(Date.now() + clockOffset);

let wsStore; let execStore; let dataStore; let wfStore; let realAudit = null;
if (SUPA) {
  wsStore = require(R('services', 'workspaceStore.js')).createSupabaseWorkspaceStore();
  execStore = require(R('services', 'agentExecution', 'executionStore.js')).createSupabaseExecutionStore();
  dataStore = require(R('services', 'workspaceData', 'workspaceDataStore.js')).createSupabaseWorkspaceDataStore();
  wfStore = require(R('services', 'workflows', 'workflowStore.js')).createSupabaseWorkflowStore();
  realAudit = require(R('security-engine', 'auditLog.js')).appendAuditLog;
} else {
  wsStore = createMemoryWorkspaceStore();
  execStore = createMemoryExecutionStore();
  dataStore = createMemoryWorkspaceDataStore();
  wfStore = createMemoryWorkflowStore({ now, taskExists: async (ws, id) => !!(await dataStore.getTask(ws, id)) });
}
const auditRows = [];
const appendAuditLog = async (userId, action, payload, result, workspaceId) => {
  auditRows.push({ userId, action, payload, result, workspaceId });
  if (realAudit) await realAudit(userId, action, payload, result, workspaceId);
};

const wsService = createWorkspaceService(wsStore, { requireVerifiedEmail: true });
const LEASE = SUPA ? 2 : 2;
const RUNNER_OPTS = {
  now, leaseSeconds: LEASE, heartbeatMs: 100, idlePollMs: 25, execPollMs: 5, busyRetryMs: 25,
  busyMaxWaitMs: 60000, schedulerIntervalMs: 0, stopTimeoutMs: 2000,
};

function makeExecService() {
  return createAgentExecutionService({ store: execStore, options: { retryDelayMs: 0, maxSteps: 8, now }, deps: { appendAuditLog }, logger: { error() {}, warn() {} } });
}
function makeSystem(execService, runnerOpts = {}) {
  const service = createWorkflowService({ store: wfStore, dataStore, executionService: execService, appendAuditLog, logger: { error() {}, warn() {} }, options: { now } });
  const runner = createWorkflowRunner({
    store: wfStore, service, dataStore, executionService: execService, execStore, appendAuditLog,
    getMemberRole: async (ws, uid) => { const m = await wsStore.getMember(ws, uid); return m ? m.role : null; },
    logger: { error() {}, warn() {} },
    options: { ...RUNNER_OPTS, ...runnerOpts },
  });
  service.attachRunner(runner);
  const routers = createWorkflowRouters({ workspaceService: wsService, workflowService: service });
  const execRouter = createExecutionsRouter({ workspaceService: wsService, executionService: execService });
  return { service, runner, routers, execService, execRouter };
}

let sys = makeSystem(makeExecService());
function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(sanitizeInput);
  app.use('/api', authenticateFirebaseUser);
  app.use('/api/workspaces/:workspaceId/workflows', (req, res, next) => sys.routers.workflows(req, res, next));
  app.use('/api/workspaces/:workspaceId/workflow-runs', (req, res, next) => sys.routers.runs(req, res, next));
  app.use('/api/workspaces/:workspaceId/executions', (req, res, next) => sys.execRouter(req, res, next));
  return app;
}

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log(`PASS: ${name}`);
    passed++;
  } catch (err) {
    console.error(`FAIL: ${name}`);
    console.error(`  ${err.stack || err.message}`);
    failed++;
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const RUN = crypto.randomBytes(3).toString('hex');
const U = Object.fromEntries(['alice', 'bob', 'carol', 'dave', 'mallory'].map((n) => [n, { uid: `${n}_${RUN}`, email: `${n}_${RUN}@example.com`, emailVerified: true }]));
const auth = (u) => ({ authorization: `Bearer tok|${u.uid}` });

const step = (action, payload = {}) => ({ done: false, action, payload: { platform: 'browser', parameters: {}, target: {}, value: null, ...payload } });
const DONE = (reason = 'goal complete') => ({ done: true, reason });

async function run() {
  console.log(`# workflow tests — store: ${STORE_MODE}`);
  const srv = await new Promise((resolve) => { const s = buildApp().listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${srv.address().port}`;
  const call = async (method, url, { as, headers = {}, body } = {}) => {
    const h = { 'content-type': 'application/json', ...headers, ...(as ? auth(as) : {}) };
    const res = await fetch(base + url, { method, headers: h, body: body !== undefined && method !== 'GET' ? JSON.stringify(body) : undefined });
    let json = null;
    try { json = await res.json(); } catch { /* none */ }
    return { status: res.status, body: json };
  };

  // workspaces: team (alice owner, carol admin, bob member, dave member); other (mallory); bobWs (bob owner)
  const team = await wsService.createWorkspace(U.alice, { name: 'Acme Tax' });
  const other = await wsService.createWorkspace(U.mallory, { name: 'Other Co' });
  const bobWs = await wsService.createWorkspace(U.bob, { name: 'Bob Solo' });
  for (const [u, role] of [[U.carol, 'admin'], [U.bob, 'member'], [U.dave, 'member']]) {
    const inv = await wsService.createInvitation({ workspace: team, role: 'owner', userId: U.alice.uid }, { email: u.email, role });
    await wsService.acceptInvitation(u, { token: inv.token });
  }
  const WF = (ws) => `/api/workspaces/${ws.id}/workflows`;
  const RUNS = (ws) => `/api/workspaces/${ws.id}/workflow-runs`;

  async function createWf(as, ws, body) {
    const r = await call('POST', WF(ws), { as, body });
    assert.strictEqual(r.status, 201, JSON.stringify(r.body));
    return r.body.data;
  }
  async function publish(as, ws, id) {
    const r = await call('POST', `${WF(ws)}/${id}/publish`, { as, body: {} });
    assert.ok([200, 201].includes(r.status), JSON.stringify(r.body));
    return r.body.data;
  }
  async function createPublished(as, ws, name, definition) {
    const w = await createWf(as, ws, { name, definition });
    await publish(as, ws, w.id);
    return w;
  }
  async function startRun(as, ws, wfId, body = {}, headers = {}) {
    const r = await call('POST', `${WF(ws)}/${wfId}/runs`, { as, body, headers });
    assert.ok([200, 201].includes(r.status), `start: ${r.status} ${JSON.stringify(r.body)}`);
    return r.body.data;
  }
  async function waitRun(as, ws, runId, statuses, tries = 800) {
    let last;
    for (let i = 0; i < tries; i++) {
      last = await call('GET', `${RUNS(ws)}/${runId}`, { as });
      if (last.status === 200 && statuses.includes(last.body.data.status)) return last.body.data;
      await sleep(10);
    }
    throw new Error(`run ${runId} never reached ${statuses} (last ${JSON.stringify(last && last.body && last.body.data && { status: last.body.data.status, failure: last.body.data.failure, steps: last.body.data.steps && last.body.data.steps.map((s) => [s.key, s.status, s.error]) })})`);
  }
  async function waitStepExec(as, ws, runId, pos, statuses, tries = 800) {
    let last = null;
    for (let i = 0; i < tries; i++) {
      const r = await call('GET', `${RUNS(ws)}/${runId}`, { as });
      last = r.body && r.body.data;
      const s = last && last.steps[pos];
      if (s && s.execution && statuses.includes(s.execution.status)) return r.body.data;
      await sleep(10);
    }
    const st = last && last.steps[pos];
    throw new Error(`step ${pos} of ${runId} never reached ${statuses} (run ${last && last.status}, step ${st && JSON.stringify({ status: st.status, error: st.error, execution: st.execution && { status: st.execution.status, failure: st.execution.failure } })})`);
  }
  const resetNexus = () => { NEXUS = () => ({ success: true, data: 'ok', evidence: { verified: true } }); nexusCalls.length = 0; };
  const execsOfRun = async (ws, runId) => {
    const steps = await wfStore.listRunSteps(ws.id, runId);
    const ids = new Set();
    for (const s of steps) { (s.attempts || []).forEach((a) => ids.add(a.executionId)); if (s.execution_id) ids.add(s.execution_id); }
    return [...ids];
  };
  // Advance time for leases: memory clock in small hops (heartbeats keep up); real DB → real wait.
  async function advance(ms) {
    if (SUPA) { await sleep(ms); return; }
    const hops = 10;
    for (let i = 0; i < hops; i++) { clockOffset += ms / hops; await sleep(RUNNER_OPTS.heartbeatMs * 1.5); }
  }
  async function expireLeases() {
    if (SUPA) { await sleep(LEASE * 1000 + 700); return; }
    clockOffset += LEASE * 1000 + 1000;
  }

  sys.runner.start();

  // A simple 1-step read-only workflow used by several tests
  const readDef = (tag, extra = {}) => ({
    variables: [{ name: 'product_name', type: 'string' }],
    steps: [{ key: 'read', name: 'Read', instruction: `${tag} read the price of {{input.product_name}}`, ...extra }],
  });

  // ==================================================================
  // AUTH / VALIDATION
  // ==================================================================
  await test('auth: no token → 401 on workflow and run routes; non-member → 404; bad ids → 404', async () => {
    const id = crypto.randomUUID();
    for (const [m, u] of [['GET', WF(team)], ['POST', WF(team)], ['GET', `${WF(team)}/${id}`], ['POST', `${WF(team)}/${id}/runs`],
      ['GET', RUNS(team)], ['GET', `${RUNS(team)}/${id}`], ['POST', `${RUNS(team)}/${id}/cancel`]]) {
      assert.strictEqual((await call(m, u, { body: {} })).status, 401, `${m} ${u}`);
      assert.strictEqual((await call(m, u, { as: U.mallory, body: {} })).status, 404, `non-member ${m} ${u}`);
    }
    assert.strictEqual((await call('GET', `${WF(team)}/not-a-uuid`, { as: U.alice })).status, 404);
    assert.strictEqual((await call('GET', `${RUNS(team)}/not-a-uuid`, { as: U.alice })).status, 404);
    assert.strictEqual((await call('GET', '/api/workspaces/not-a-uuid/workflows', { as: U.alice })).status, 404);
  });

  await test('validation: bad names, undeclared/forward references, unsafe templates, limits → 400', async () => {
    const bad = [
      { name: '' },
      { name: 'x'.repeat(121) },
      { name: 'ok', definition: { variables: [{ name: 'Bad-Name' }] } },
      { name: 'ok', definition: { variables: [{ name: 'a' }, { name: 'a' }] } },
      { name: 'ok', definition: { steps: [{ key: 's1', name: 'S', instruction: 'use {{input.nope}}' }] } },
      { name: 'ok', definition: { steps: [{ key: 's1', name: 'S', instruction: 'use {{steps.s2.output}}' }, { key: 's2', name: 'T', instruction: 'x' }] } },
      { name: 'ok', definition: { steps: [{ key: 's1', name: 'S', instruction: 'use {{steps.s1.output}}' }] } },
      { name: 'ok', definition: { variables: [{ name: 'a' }], steps: [{ key: 's1', name: 'S', instruction: '{{input.a.constructor}}' }] } },
      { name: 'ok', definition: { variables: [{ name: 'a' }], steps: [{ key: 's1', name: 'S', instruction: '{{ input.a | upper }}' }] } },
      { name: 'ok', definition: { steps: [{ key: 's1', name: 'S', instruction: '{{#each x}}hi{{/each}}' }] } },
      { name: 'ok', definition: { steps: [{ key: 's1', name: 'S', instruction: '{{ this.constructor.constructor("return process")() }}' }] } },
      { name: 'ok', definition: { variables: [{ name: 'a' }], steps: [{ key: 's1', name: 'S', instruction: '{{input.__proto__}}' }] } },
      { name: 'ok', definition: { steps: [{ key: 's1', name: 'S', instruction: 'x', approval: 'sometimes' }] } },
      { name: 'ok', definition: { steps: [{ key: 's1', name: 'S', instruction: 'x', retry: { maxAttempts: 9 } }] } },
      { name: 'ok', definition: { steps: Array.from({ length: 21 }, (_, i) => ({ key: `s${i}`, name: 'S', instruction: 'x' })) } },
      { name: 'ok', definition: { variables: [{ name: 'e', type: 'enum' }] } },
    ];
    for (const body of bad) {
      const r = await call('POST', WF(team), { as: U.bob, body });
      assert.strictEqual(r.status, 400, `${JSON.stringify(body).slice(0, 120)} → ${r.status}`);
    }
  });

  // ==================================================================
  // WORKFLOW LIFECYCLE + VERSIONING
  // ==================================================================
  let wfA;
  await test('workflow: member creates a draft; list/get are workspace-scoped; client workspace/user ids ignored', async () => {
    wfA = await createWf(U.bob, team, {
      name: 'Price check', description: 'Check a price', workspace_id: other.id, created_by: U.mallory.uid, definition: readDef('wfprice'),
    });
    assert.strictEqual(wfA.status, 'draft');
    assert.strictEqual(wfA.workspaceId, team.id);
    assert.strictEqual(wfA.createdBy, U.bob.uid);
    assert.strictEqual(wfA.revision, 0);
    const l = await call('GET', WF(team), { as: U.dave });
    assert.ok(l.body.data.some((w) => w.id === wfA.id));
    assert.strictEqual((await call('GET', WF(other), { as: U.mallory })).body.data.length, 0);
  });

  await test('workflow: running a draft is refused (409); edit requires the current revision', async () => {
    assert.strictEqual((await call('POST', `${WF(team)}/${wfA.id}/runs`, { as: U.bob, body: { inputs: { product_name: 'x' } } })).status, 409);
    assert.strictEqual((await call('PATCH', `${WF(team)}/${wfA.id}`, { as: U.bob, body: { name: 'New' } })).status, 400);
    const stale = await call('PATCH', `${WF(team)}/${wfA.id}`, { as: U.bob, body: { name: 'New', revision: 7 } });
    assert.strictEqual(stale.status, 409);
    assert.strictEqual(stale.body.code, 'WORKFLOW_CONFLICT');
  });

  await test('workflow: concurrent edits with the same revision → exactly one wins, the other 409', async () => {
    const rs = await Promise.all(['Edit A', 'Edit B', 'Edit C'].map((name) => call('PATCH', `${WF(team)}/${wfA.id}`, { as: U.bob, body: { name, revision: 0 } })));
    assert.strictEqual(rs.filter((r) => r.status === 200).length, 1, rs.map((r) => r.status).join(','));
    assert.ok(rs.filter((r) => r.status !== 200).every((r) => r.status === 409));
    const g = await call('GET', `${WF(team)}/${wfA.id}`, { as: U.bob });
    assert.strictEqual(g.body.data.revision, 1);
  });

  await test('workflow roles: another member cannot edit/publish/archive (403); an admin can edit', async () => {
    const g = (await call('GET', `${WF(team)}/${wfA.id}`, { as: U.bob })).body.data;
    assert.strictEqual((await call('PATCH', `${WF(team)}/${wfA.id}`, { as: U.dave, body: { name: 'Dave', revision: g.revision } })).status, 403);
    assert.strictEqual((await call('POST', `${WF(team)}/${wfA.id}/publish`, { as: U.dave, body: {} })).status, 403);
    assert.strictEqual((await call('POST', `${WF(team)}/${wfA.id}/archive`, { as: U.dave, body: {} })).status, 403);
    const r = await call('PATCH', `${WF(team)}/${wfA.id}`, { as: U.carol, body: { name: 'Price check', revision: g.revision } });
    assert.strictEqual(r.status, 200);
  });

  await test('versioning: publish → v1 (201, active); re-publish unchanged → same v1 (200); edit + publish → v2', async () => {
    const p1 = await call('POST', `${WF(team)}/${wfA.id}/publish`, { as: U.bob, body: {} });
    assert.strictEqual(p1.status, 201);
    assert.strictEqual(p1.body.data.version.version, 1);
    assert.strictEqual(p1.body.data.workflow.status, 'active');
    const p1b = await call('POST', `${WF(team)}/${wfA.id}/publish`, { as: U.bob, body: {} });
    assert.strictEqual(p1b.status, 200);
    assert.strictEqual(p1b.body.data.version.id, p1.body.data.version.id);
    const g = (await call('GET', `${WF(team)}/${wfA.id}`, { as: U.bob })).body.data;
    const edited = await call('PATCH', `${WF(team)}/${wfA.id}`, { as: U.bob, body: { revision: g.revision, definition: readDef('wfprice', { name: 'Read v2' }) } });
    assert.strictEqual(edited.status, 200);
    const v1 = (await call('GET', `${WF(team)}/${wfA.id}/versions/1`, { as: U.dave })).body.data;
    assert.strictEqual(v1.definition.steps[0].name, 'Read', 'editing the draft never changes a published version');
    const p2 = await call('POST', `${WF(team)}/${wfA.id}/publish`, { as: U.bob, body: {} });
    assert.strictEqual(p2.status, 201);
    assert.strictEqual(p2.body.data.version.version, 2);
    const v1again = (await call('GET', `${WF(team)}/${wfA.id}/versions/1`, { as: U.dave })).body.data;
    assert.strictEqual(v1again.definition.steps[0].name, 'Read');
    assert.strictEqual((await call('GET', `${WF(team)}/${wfA.id}/versions/9`, { as: U.dave })).status, 404);
    const full = (await call('GET', `${WF(team)}/${wfA.id}`, { as: U.dave })).body.data;
    assert.deepStrictEqual(full.versions.map((v) => v.version), [2, 1]);
  });

  await test('versioning: concurrent publishes of the same edit create exactly one new version', async () => {
    const g = (await call('GET', `${WF(team)}/${wfA.id}`, { as: U.bob })).body.data;
    await call('PATCH', `${WF(team)}/${wfA.id}`, { as: U.bob, body: { revision: g.revision, definition: readDef('wfprice', { name: 'Read v3' }) } });
    const rs = await Promise.all(Array.from({ length: 4 }, () => call('POST', `${WF(team)}/${wfA.id}/publish`, { as: U.bob, body: {} })));
    assert.ok(rs.every((r) => [200, 201, 409].includes(r.status)), rs.map((r) => r.status).join(','));
    assert.strictEqual(rs.filter((r) => r.status === 201).length, 1);
    const full = (await call('GET', `${WF(team)}/${wfA.id}`, { as: U.bob })).body.data;
    assert.deepStrictEqual(full.versions.map((v) => v.version), [3, 2, 1]);
    assert.strictEqual(full.latestVersion, 3);
  });

  await test('archive: blocks new runs (409) and edits; re-activate restores; archive by creator only', async () => {
    const a = await call('POST', `${WF(team)}/${wfA.id}/archive`, { as: U.bob, body: {} });
    assert.strictEqual(a.status, 200);
    assert.strictEqual(a.body.data.status, 'archived');
    const r = await call('POST', `${WF(team)}/${wfA.id}/runs`, { as: U.bob, body: { inputs: { product_name: 'x' } } });
    assert.strictEqual(r.status, 409);
    assert.strictEqual(r.body.code, 'WORKFLOW_NOT_ACTIVE');
    const g = (await call('GET', `${WF(team)}/${wfA.id}`, { as: U.bob })).body.data;
    assert.strictEqual((await call('PATCH', `${WF(team)}/${wfA.id}`, { as: U.bob, body: { name: 'z', revision: g.revision } })).status, 409);
    const act = await call('POST', `${WF(team)}/${wfA.id}/activate`, { as: U.bob, body: {} });
    assert.strictEqual(act.body.data.status, 'active');
  });

  // ==================================================================
  // VARIABLES
  // ==================================================================
  await test('variables: typed coercion, defaults, missing required, unknown input, wrong type', async () => {
    const def = normalizeDefinition({
      variables: [
        { name: 'customer_name', type: 'string' },
        { name: 'qty', type: 'number' },
        { name: 'date_range', type: 'date', required: false },
        { name: 'report_format', type: 'enum', options: ['pdf', 'xlsx'], default: 'pdf' },
      ],
      steps: [{ key: 'a', name: 'A', instruction: 'x {{input.customer_name}} {{input.qty}} {{input.report_format}} {{input.date_range}}' }],
    });
    const ok = validateInputs(def, { customer_name: '  Ravi Traders ', qty: '12' });
    assert.deepStrictEqual(ok, { customer_name: 'Ravi Traders', qty: 12, report_format: 'pdf' });
    assert.strictEqual(render(def.steps[0].instruction, { inputs: ok }), 'x Ravi Traders 12 pdf (not provided)');
    assert.throws(() => validateInputs(def, { qty: 1 }), /Missing required input\(s\): customer_name/);
    assert.throws(() => validateInputs(def, { customer_name: 'a', qty: 1, extra: 1 }), /unknown input/);
    assert.throws(() => validateInputs(def, { customer_name: 'a', qty: 'many' }), /must be a number/);
    assert.throws(() => validateInputs(def, { customer_name: 'a', qty: 1, report_format: 'docx' }), /must be one of/);
    assert.throws(() => validateInputs(def, { customer_name: 'a', qty: 1, date_range: '2026-13-45x' }), /date/);
    const r = await call('POST', `${WF(team)}/${wfA.id}/runs`, { as: U.bob, body: { inputs: {} } });
    assert.strictEqual(r.status, 400);
    assert.deepStrictEqual(r.body.details.missing, ['product_name']);
  });

  await test('variables: template injection — a value containing {{…}} is rendered literally (single pass)', async () => {
    const def = normalizeDefinition({ variables: [{ name: 'a' }, { name: 'b' }], steps: [{ key: 's', name: 'S', instruction: 'A={{input.a}} B={{input.b}}' }] });
    const inputs = validateInputs(def, { a: '{{input.b}}', b: 'secret-ish' });
    assert.strictEqual(render(def.steps[0].instruction, { inputs }), 'A={{input.b}} B=secret-ish');
    // prototype keys never resolve
    assert.strictEqual(render('{{input.constructor}}', { inputs: {} }), '(not provided)');
  });

  // ==================================================================
  // EXECUTION
  // ==================================================================
  let multiRun;
  let multiWf;
  await test('execution: 3-step workflow with variables + step-output chaining → COMPLETED, verified, task linked', async () => {
    resetNexus();
    NEXUS = (req) => ({ success: true, data: req.action === 'read_text' ? 'Price: 499' : 'ok', evidence: { verified: true } });
    SCRIPTS.wfopen = (n) => (n === 0 ? step('navigate', { parameters: { url: 'https://shop.example/p' } }) : DONE('opened product page'));
    SCRIPTS.wfreadprice = (n) => (n === 0 ? step('read_text') : DONE('price is 499'));
    SCRIPTS.wfsummary = (n) => (n === 0 ? step('read_text') : DONE('summary ready'));
    multiWf = await createPublished(U.bob, team, 'Competitor price report', {
      variables: [{ name: 'product_name' }, { name: 'report_format', type: 'enum', options: ['pdf', 'xlsx'], default: 'xlsx' }],
      steps: [
        { key: 'open', name: 'Open product', instruction: 'wfopen open the page for {{input.product_name}}', expectedOutput: 'product page open' },
        { key: 'price', name: 'Read price', instruction: 'wfreadprice read the price after: {{steps.open.output}}', verification: 'best_effort' },
        { key: 'summary', name: 'Summarize', instruction: 'wfsummary write a {{input.report_format}} summary using {{steps.price.output}}' },
      ],
    });
    const started = await startRun(U.bob, team, multiWf.id, { inputs: { product_name: 'Tally Prime' } });
    assert.strictEqual(started.status, 'queued');
    assert.strictEqual(started.initiatedBy, U.bob.uid);
    assert.strictEqual(started.version, 1);
    multiRun = await waitRun(U.bob, team, started.id, ['completed', 'failed', 'cancelled', 'needs_review']);
    assert.strictEqual(multiRun.status, 'completed', JSON.stringify(multiRun.failure));
    assert.deepStrictEqual(multiRun.steps.map((s) => s.status), ['succeeded', 'succeeded', 'succeeded']);
    assert.strictEqual(multiRun.steps[0].output.message, 'opened product page');
    assert.strictEqual(multiRun.verification.status, 'not_applicable', 'read-only steps: Layer 3 reports not_applicable');
    // chaining: the rendered goal of step 2 contains step 1's output; step 3 has the enum default + step 2 output
    const goals = prompts.map((p) => (p.match(/The user's goal: "([\s\S]*?)"\n/) || [])[1]).filter(Boolean);
    assert.ok(goals.some((g) => g.startsWith('wfopen open the page for Tally Prime\n\nExpected result: product page open')));
    assert.ok(goals.some((g) => g === 'wfreadprice read the price after: opened product page'));
    assert.ok(goals.some((g) => g === 'wfsummary write a xlsx summary using price is 499'));
    // task integration
    assert.ok(multiRun.taskId);
    const task = await dataStore.getTask(team.id, multiRun.taskId);
    assert.strictEqual(task.status, 'done');
    assert.strictEqual(task.assignee_type, 'agent');
    const ex = await execsOfRun(team, multiRun.id);
    assert.strictEqual(ex.length, 3, 'exactly one execution per step');
    for (const id of ex) {
      const e = await execStore.getExecution(team.id, id);
      assert.strictEqual(e.task_id, multiRun.taskId, 'every step execution is linked to the run task');
      assert.strictEqual(e.created_by, U.bob.uid);
    }
    const acts = await dataStore.listActivity(team.id, multiRun.taskId, { limit: 50 });
    assert.strictEqual(acts.filter((a) => a.kind === 'execution_started').length, 3);
  });

  await test('execution: evidence endpoint returns redacted Layer 3 evidence for every step', async () => {
    const r = await call('GET', `${RUNS(team)}/${multiRun.id}/evidence`, { as: U.dave });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.data.steps.length, 3);
    for (const s of r.body.data.steps) {
      assert.strictEqual(s.executions.length, 1);
      assert.ok(s.executions[0].steps.length >= 1);
      assert.strictEqual(s.executions[0].execution.workspaceId, team.id);
    }
    assert.strictEqual(r.body.data.steps[1].executions[0].steps[0].output.data, 'Price: 499');
  });

  await test('immutability: a run keeps executing its own version after the workflow is edited and re-published', async () => {
    resetNexus();
    let release;
    const gate = new Promise((r) => { release = r; });
    NEXUS = async (req) => { if (req.action === 'read_text') await gate; return { success: true, data: 'v', evidence: { verified: true } }; };
    SCRIPTS.wfimmv1 = (n) => (n === 0 ? step('read_text') : DONE('v1 done'));
    SCRIPTS.wfimmv2 = (n) => (n === 0 ? step('read_text') : DONE('v2 done'));
    const w = await createPublished(U.bob, team, 'Immutable', { steps: [{ key: 's', name: 'S', instruction: 'wfimmv1 do it' }] });
    const r1 = await startRun(U.bob, team, w.id);
    await waitStepExec(U.bob, team, r1.id, 0, ['executing']);
    const g = (await call('GET', `${WF(team)}/${w.id}`, { as: U.bob })).body.data;
    await call('PATCH', `${WF(team)}/${w.id}`, { as: U.bob, body: { revision: g.revision, definition: { steps: [{ key: 's', name: 'S', instruction: 'wfimmv2 do it' }] } } });
    await publish(U.bob, team, w.id);
    release();
    const done1 = await waitRun(U.bob, team, r1.id, ['completed', 'failed']);
    assert.strictEqual(done1.status, 'completed');
    assert.strictEqual(done1.version, 1);
    assert.strictEqual(done1.steps[0].output.message, 'v1 done');
    const r2 = await startRun(U.bob, team, w.id);
    const done2 = await waitRun(U.bob, team, r2.id, ['completed', 'failed']);
    assert.strictEqual(done2.version, 2);
    assert.strictEqual(done2.steps[0].output.message, 'v2 done');
  });

  await test('execution: non-retryable step failure (planner needs input) → run FAILED, task blocked, later steps never run', async () => {
    resetNexus();
    SCRIPTS.wfneeds = () => ({ needs_clarification: true, question: 'Which GSTIN?' });
    SCRIPTS.wfnever = () => step('read_text');
    const w = await createPublished(U.bob, team, 'Needs input', { steps: [{ key: 'a', name: 'A', instruction: 'wfneeds file return' }, { key: 'b', name: 'B', instruction: 'wfnever x' }] });
    const r = await waitRun(U.bob, team, (await startRun(U.bob, team, w.id)).id, ['failed', 'completed']);
    assert.strictEqual(r.status, 'failed');
    assert.strictEqual(r.failure.code, 'NEEDS_INPUT');
    assert.deepStrictEqual(r.steps.map((s) => s.status), ['failed', 'cancelled']);
    assert.strictEqual((await dataStore.getTask(team.id, r.taskId)).status, 'blocked');
    assert.ok(!prompts.some((p) => p.includes('"wfnever')));
  });

  await test('retry: transient failure of a read-only step is retried (bounded) and then succeeds', async () => {
    resetNexus();
    let calls = 0;
    NEXUS = (req) => { calls++; return calls <= 6 ? { success: false, error: 'element not found' } : { success: true, data: 'row', evidence: { verified: true } }; };
    SCRIPTS.wfflaky = (n, goal) => (n < 3 ? step('read_tables') : DONE('read the table'));
    const w = await createPublished(U.bob, team, 'Flaky', { steps: [{ key: 'a', name: 'A', instruction: 'wfflaky read the GST table', retry: { maxAttempts: 2 } }] });
    const r = await waitRun(U.bob, team, (await startRun(U.bob, team, w.id)).id, ['completed', 'failed', 'needs_review']);
    assert.strictEqual(r.status, 'completed', JSON.stringify(r.failure));
    assert.strictEqual(r.steps[0].attempt, 2);
    assert.strictEqual(r.steps[0].attempts.length, 2);
    assert.strictEqual(r.steps[0].attempts[0].status, 'failed');
    assert.strictEqual(r.steps[0].attempts[0].failureCode, 'BROWSER_FAILURE');
    const e1 = await execStore.getExecution(team.id, r.steps[0].attempts[0].executionId);
    assert.strictEqual(e1.status, 'failed', 'evidence of the failed attempt is preserved');
  });

  await test('retry limit: attempts are bounded (maxAttempts 0 → no retry) → FAILED', async () => {
    resetNexus();
    NEXUS = () => ({ success: false, error: 'boom' });
    SCRIPTS.wfalwaysfail = () => step('read_text');
    const w = await createPublished(U.bob, team, 'Always fails', { steps: [{ key: 'a', name: 'A', instruction: 'wfalwaysfail x', retry: { maxAttempts: 0 } }] });
    const r = await waitRun(U.bob, team, (await startRun(U.bob, team, w.id)).id, ['completed', 'failed', 'needs_review']);
    assert.strictEqual(r.status, 'failed');
    assert.strictEqual(r.steps[0].attempts.length, 1);
    assert.strictEqual(r.failure.code, 'BROWSER_FAILURE');
  });

  let reviewRun;
  await test('recovery: failure after a state-changing action is NOT blindly retried → NEEDS_REVIEW', async () => {
    resetNexus();
    NEXUS = (req) => (req.action === 'click' ? { success: true, data: null, evidence: { verified: true } } : { success: false, error: 'form missing' });
    SCRIPTS.wfclickfail = (n) => (n === 0 ? step('click', { target: { text: 'Next' } }) : step('read_text'));
    SCRIPTS.wfafter = (n) => (n === 0 ? step('read_text') : DONE('after'));
    const w = await createPublished(U.bob, team, 'Click then fail', { steps: [
      { key: 'a', name: 'A', instruction: 'wfclickfail click next then read', retry: { maxAttempts: 3 } },
      { key: 'b', name: 'B', instruction: 'wfafter read' },
    ] });
    reviewRun = await waitRun(U.bob, team, (await startRun(U.bob, team, w.id)).id, ['needs_review', 'failed', 'completed']);
    assert.strictEqual(reviewRun.status, 'needs_review');
    assert.match(reviewRun.reviewReason, /click/);
    assert.strictEqual(reviewRun.steps[0].status, 'needs_review');
    assert.strictEqual(nexusCalls.filter((c) => c.action === 'click').length, 1, 'the click is never repeated automatically');
    const job = await wfStore.getJobByRun(team.id, reviewRun.id);
    assert.strictEqual(job.status, 'paused');
  });

  await test('review: only initiator/admin may resolve; retry_step runs ONE more attempt; skip continues', async () => {
    assert.strictEqual((await call('POST', `${RUNS(team)}/${reviewRun.id}/resolve`, { as: U.dave, body: { action: 'retry_step' } })).status, 403);
    assert.strictEqual((await call('POST', `${RUNS(team)}/${reviewRun.id}/resolve`, { as: U.bob, body: { action: 'explode' } })).status, 400);
    assert.strictEqual((await call('POST', `${RUNS(other)}/${reviewRun.id}/resolve`, { as: U.mallory, body: { action: 'skip_step' } })).status, 404);
    // retry → fails again after clicking → back to review
    const rr = await call('POST', `${RUNS(team)}/${reviewRun.id}/resolve`, { as: U.bob, body: { action: 'retry_step' } });
    assert.strictEqual(rr.status, 200, JSON.stringify(rr.body));
    let r = await waitRun(U.bob, team, reviewRun.id, ['needs_review', 'failed', 'completed'], 800);
    for (let i = 0; i < 200 && r.steps[0].attempts.length < 3; i++) { await sleep(10); r = (await call('GET', `${RUNS(team)}/${reviewRun.id}`, { as: U.bob })).body.data; }
    assert.strictEqual(r.status, 'needs_review');
    assert.strictEqual(nexusCalls.filter((c) => c.action === 'click').length, 2, 'exactly one extra, human-authorized attempt');
    // skip → step b runs → completed (partially verified)
    const sk = await call('POST', `${RUNS(team)}/${reviewRun.id}/resolve`, { as: U.carol, body: { action: 'skip_step' } });
    assert.strictEqual(sk.status, 200);
    r = await waitRun(U.bob, team, reviewRun.id, ['completed', 'failed']);
    assert.strictEqual(r.status, 'completed');
    assert.deepStrictEqual(r.steps.map((s) => s.status), ['skipped', 'succeeded']);
    assert.strictEqual(r.verification.status, 'partially_verified');
    assert.strictEqual((await call('POST', `${RUNS(team)}/${reviewRun.id}/resolve`, { as: U.bob, body: { action: 'fail' } })).status, 409);
  });

  await test('verification: step with verification "required" fails when evidence is not verified', async () => {
    resetNexus();
    NEXUS = () => ({ success: true, data: 'x' }); // no evidence → read-only → not_applicable
    SCRIPTS.wfverify = (n) => (n === 0 ? step('read_text') : DONE('done'));
    const w = await createPublished(U.bob, team, 'Must verify', { steps: [{ key: 'a', name: 'A', instruction: 'wfverify x', verification: 'required' }] });
    const r = await waitRun(U.bob, team, (await startRun(U.bob, team, w.id)).id, ['failed', 'completed']);
    assert.strictEqual(r.status, 'failed');
    assert.strictEqual(r.failure.code, 'VERIFICATION_REQUIRED');
  });

  await test('verification: Layer 3 VERIFICATION_FAILED (state change reported verified=false) fails the run, no retry', async () => {
    resetNexus();
    NEXUS = (req) => (req.action === 'write_file' ? { success: true, data: null, evidence: { verified: false } } : { success: true, data: 'x', evidence: { verified: true } });
    SCRIPTS.wfbadwrite = (n) => (n === 0 ? step('write_file', { platform: 'desktop', parameters: { path: 'C:/r.txt' } }) : DONE('wrote'));
    const w = await createPublished(U.bob, team, 'Bad write', { steps: [{ key: 'a', name: 'A', instruction: 'wfbadwrite x', retry: { maxAttempts: 3 } }] });
    const started = await startRun(U.bob, team, w.id);
    const waiting = await waitStepExec(U.bob, team, started.id, 0, ['waiting_approval']);
    const appr = waiting.steps[0].execution.waitingForApproval;
    assert.strictEqual((await call('POST', `${RUNS(team)}/${started.id}/steps/0/approvals/${appr.id}/approve`, { as: U.bob, body: {} })).status, 200);
    const r = await waitRun(U.bob, team, started.id, ['failed', 'completed', 'needs_review']);
    assert.strictEqual(r.status, 'failed');
    assert.strictEqual(r.failure.code, 'VERIFICATION_FAILED');
    assert.strictEqual(r.steps[0].attempts.length, 1);
  });

  let apprRun;
  let apprId;
  await test('approval: step policy "required" — read-only actions run freely, a click waits for approval', async () => {
    resetNexus();
    SCRIPTS.wfapprove = (n) => (n === 0 ? step('read_text') : n === 1 ? step('click', { target: { text: 'Download' } }) : DONE('downloaded'));
    const w = await createPublished(U.bob, team, 'Needs approval', { steps: [{ key: 'a', name: 'A', instruction: 'wfapprove get report', approval: 'required' }] });
    apprRun = await startRun(U.bob, team, w.id);
    const r = await waitRun(U.bob, team, apprRun.id, ['waiting_approval']);
    const s = r.steps[0];
    assert.strictEqual(s.status, 'waiting_approval');
    apprId = s.execution.waitingForApproval.id;
    assert.strictEqual(s.execution.waitingForApproval.action, 'click');
    assert.strictEqual(s.execution.waitingForApproval.reason, 'workflow_approval_policy');
    assert.strictEqual(s.execution.waitingForApproval.requiredRole, 'creator_or_admin');
    assert.strictEqual(nexusCalls.filter((c) => c.action === 'read_text').length, 1);
    assert.strictEqual(nexusCalls.filter((c) => c.action === 'click').length, 0, 'nothing state-changing ran before approval');
  });

  await test('approval security: wrong workspace, wrong step, bogus id, other member → rejected; replay → exactly one', async () => {
    const A = (ws, pos, id, d = 'approve') => `${RUNS(ws)}/${apprRun.id}/steps/${pos}/approvals/${id}/${d}`;
    assert.strictEqual((await call('POST', A(other, 0, apprId), { as: U.mallory, body: {} })).status, 404);
    assert.strictEqual((await call('POST', A(bobWs, 0, apprId), { as: U.bob, body: {} })).status, 404, 'member of both workspaces, wrong workspace URL');
    assert.strictEqual((await call('POST', A(team, 1, apprId), { as: U.bob, body: {} })).status, 404, 'wrong step');
    assert.strictEqual((await call('POST', A(team, 'x', apprId), { as: U.bob, body: {} })).status, 404);
    assert.strictEqual((await call('POST', A(team, 0, crypto.randomUUID()), { as: U.bob, body: {} })).status, 404);
    assert.strictEqual((await call('POST', A(team, 0, apprId), { as: U.dave, body: {} })).status, 403, 'another plain member');
    // Layer 3 direct route for the same execution through another workspace → 404
    const execId = (await call('GET', `${RUNS(team)}/${apprRun.id}`, { as: U.bob })).body.data.steps[0].executionId;
    assert.strictEqual((await call('POST', `/api/workspaces/${other.id}/executions/${execId}/approvals/${apprId}/approve`, { as: U.mallory, body: {} })).status, 404);
    const rs = await Promise.all(Array.from({ length: 5 }, () => call('POST', A(team, 0, apprId), { as: U.bob, body: {} })));
    assert.strictEqual(rs.filter((r) => r.status === 200).length, 1, rs.map((r) => r.status).join(','));
    assert.ok(rs.filter((r) => r.status !== 200).every((r) => r.status === 409));
    const done = await waitRun(U.bob, team, apprRun.id, ['completed', 'failed']);
    assert.strictEqual(done.status, 'completed');
    assert.strictEqual(nexusCalls.filter((c) => c.action === 'click').length, 1);
    assert.ok(nexusCalls.find((c) => c.action === 'click').approval_token, 'approved action carries the Layer 3 approval token');
    // replay after completion
    assert.strictEqual((await call('POST', A(team, 0, apprId), { as: U.bob, body: {} })).status, 409);
  });

  await test('approval: policy "admin" → only owner/admin may approve; rejection fails the run', async () => {
    resetNexus();
    SCRIPTS.wfadmin = (n) => (n === 0 ? step('click', { target: { text: 'Submit' } }) : DONE('submitted'));
    const w = await createPublished(U.bob, team, 'Admin approval', { steps: [{ key: 'a', name: 'A', instruction: 'wfadmin submit', approval: 'admin' }] });
    const run1 = await startRun(U.bob, team, w.id);
    const r = await waitRun(U.bob, team, run1.id, ['waiting_approval']);
    const a = r.steps[0].execution.waitingForApproval;
    assert.strictEqual(a.requiredRole, 'admin');
    assert.strictEqual(a.riskTier, 'red');
    assert.strictEqual((await call('POST', `${RUNS(team)}/${run1.id}/steps/0/approvals/${a.id}/approve`, { as: U.bob, body: {} })).status, 403, 'initiator is a plain member');
    const rej = await call('POST', `${RUNS(team)}/${run1.id}/steps/0/approvals/${a.id}/reject`, { as: U.carol, body: { note: 'not now' } });
    assert.strictEqual(rej.status, 200);
    const done = await waitRun(U.bob, team, run1.id, ['failed', 'completed']);
    assert.strictEqual(done.status, 'failed');
    assert.strictEqual(done.failure.code, 'APPROVAL_REJECTED');
    assert.strictEqual(nexusCalls.filter((c) => c.action === 'click').length, 0);
  });

  await test('approval: an earlier step\'s approval cannot be replayed against the current step (STALE_APPROVAL / 404)', async () => {
    resetNexus();
    SCRIPTS.wftwoappra = (n) => (n === 0 ? step('click', { target: { text: 'One' } }) : DONE('one'));
    SCRIPTS.wftwoapprb = (n) => (n === 0 ? step('click', { target: { text: 'Two' } }) : DONE('two'));
    const w = await createPublished(U.bob, team, 'Two approvals', { steps: [
      { key: 'a', name: 'A', instruction: 'wftwoappra x', approval: 'required' },
      { key: 'b', name: 'B', instruction: 'wftwoapprb y', approval: 'required' },
    ] });
    const run1 = await startRun(U.bob, team, w.id);
    const r0 = await waitRun(U.bob, team, run1.id, ['waiting_approval']);
    const a0 = r0.steps[0].execution.waitingForApproval.id;
    assert.strictEqual((await call('POST', `${RUNS(team)}/${run1.id}/steps/0/approvals/${a0}/approve`, { as: U.bob, body: {} })).status, 200);
    let r1 = r0;
    for (let i = 0; i < 500 && !(r1.steps[1].execution && r1.steps[1].execution.waitingForApproval); i++) {
      await sleep(10);
      r1 = (await call('GET', `${RUNS(team)}/${run1.id}`, { as: U.bob })).body.data;
    }
    const a1 = r1.steps[1].execution.waitingForApproval.id;
    const replayOld = await call('POST', `${RUNS(team)}/${run1.id}/steps/0/approvals/${a0}/approve`, { as: U.bob, body: {} });
    assert.strictEqual(replayOld.status, 409);
    assert.strictEqual(replayOld.body.code, 'STALE_APPROVAL', 'rejected by the run/step binding, not only by Layer 3');
    assert.strictEqual((await call('POST', `${RUNS(team)}/${run1.id}/steps/1/approvals/${a0}/approve`, { as: U.bob, body: {} })).status, 404, 'approval of another step\'s execution');
    assert.strictEqual((await call('POST', `${RUNS(team)}/${run1.id}/steps/1/approvals/${a1}/approve`, { as: U.bob, body: {} })).status, 200);
    assert.strictEqual((await waitRun(U.bob, team, run1.id, ['completed', 'failed'])).status, 'completed');
    assert.strictEqual(nexusCalls.filter((c) => c.action === 'click').length, 2);
  });

  await test('recovery safety rules (unit): approved / non-idempotent recorded / non-idempotent in-flight → unsafe', async () => {
    const mk = async ({ steps = [], approvals = [], inflight = null }) => {
      const id = crypto.randomUUID();
      await execStore.insertExecution({ id, workspace_id: bobWs.id, created_by: U.bob.uid, goal: 'unit', goal_hash: 'a'.repeat(64), status: 'failed', max_steps: 5 });
      if (inflight) await execStore.setInflight(bobWs.id, id, inflight);
      for (const [i, st] of steps.entries()) {
        await execStore.insertStep({ id: crypto.randomUUID(), execution_id: id, workspace_id: bobWs.id, step_index: i, action: st.action, risk_tier: 'green', status: st.ok ? 'succeeded' : 'failed',
          attempts: 1, verification: { status: 'not_applicable' }, error_code: st.code || null, started_at: now().toISOString(), finished_at: now().toISOString() });
      }
      for (const a of approvals) {
        await execStore.insertApproval({ id: crypto.randomUUID(), execution_id: id, workspace_id: bobWs.id, step_index: 0, action: 'click', risk_tier: 'yellow', reason: 'x',
          step_hash: 'b'.repeat(64), required_role: 'creator_or_admin', status: a, expires_at: now().toISOString() });
      }
      return execStore.getExecution(bobWs.id, id);
    };
    const safe = async (o) => (await sys.runner._isSafeToRetry(bobWs.id, await mk(o))).safe;
    assert.strictEqual(await safe({ steps: [{ action: 'read_text', ok: true }] }), true);
    assert.strictEqual(await safe({ steps: [{ action: 'none', code: 'INVALID_STEP' }] }), true, 'never-executed evidence is ignored');
    assert.strictEqual(await safe({ steps: [{ action: 'read_text', ok: true }], inflight: { stepIndex: 0, action: 'read_text', tier: 'green' } }), true);
    assert.strictEqual(await safe({ steps: [{ action: 'click', ok: true }] }), false);
    assert.strictEqual(await safe({ steps: [{ action: 'click', ok: false, code: 'TOOL_FAILURE' }] }), false, 'a failed non-idempotent action may have partly happened');
    assert.strictEqual(await safe({ steps: [{ action: 'read_text', ok: true }], inflight: { stepIndex: 1, action: 'click', tier: 'green' } }), false);
    assert.strictEqual(await safe({ approvals: ['approved'] }), false, 'an approved action counts as attempted');
    assert.strictEqual(await safe({ approvals: ['superseded'] }), true);
  });

  await test('approval: an expired approval fails the step (APPROVAL_EXPIRED) and cannot be used afterwards', async () => {
    resetNexus();
    SCRIPTS.wfexpire = (n) => (n === 0 ? step('click') : DONE('x'));
    const w = await createPublished(U.bob, team, 'Expiring approval', { steps: [{ key: 'a', name: 'A', instruction: 'wfexpire x', approval: 'required' }] });
    const run1 = await startRun(U.bob, team, w.id);
    const r = await waitRun(U.bob, team, run1.id, ['waiting_approval']);
    const a = r.steps[0].execution.waitingForApproval;
    clockOffset += 16 * 60 * 1000; // past the 15 min approval TTL (app clock)
    const done = await waitRun(U.bob, team, run1.id, ['failed', 'completed']);
    assert.strictEqual(done.failure.code, 'APPROVAL_EXPIRED');
    const late = await call('POST', `${RUNS(team)}/${run1.id}/steps/0/approvals/${a.id}/approve`, { as: U.bob, body: {} });
    assert.strictEqual(late.status, 409);
    assert.strictEqual(nexusCalls.filter((c) => c.action === 'click').length, 0);
  });

  await test('cancellation: cancel a running run → execution cancelled, run + task cancelled; roles enforced', async () => {
    resetNexus();
    let release;
    const gate = new Promise((res) => { release = res; });
    NEXUS = async () => { await gate; return { success: true, data: 'x', evidence: { verified: true } }; };
    SCRIPTS.wfcancel = (n) => (n === 0 ? step('read_text') : DONE('x'));
    const w = await createPublished(U.bob, team, 'Cancel me', { steps: [{ key: 'a', name: 'A', instruction: 'wfcancel x' }, { key: 'b', name: 'B', instruction: 'wfcancel y' }] });
    const run1 = await startRun(U.bob, team, w.id);
    await waitStepExec(U.bob, team, run1.id, 0, ['executing']);
    assert.strictEqual((await call('POST', `${RUNS(team)}/${run1.id}/cancel`, { as: U.dave, body: {} })).status, 403);
    assert.strictEqual((await call('POST', `${RUNS(other)}/${run1.id}/cancel`, { as: U.mallory, body: {} })).status, 404);
    const c = await call('POST', `${RUNS(team)}/${run1.id}/cancel`, { as: U.bob, body: {} });
    assert.strictEqual(c.status, 200);
    assert.strictEqual(c.body.data.cancelRequested, true);
    await waitStepExec(U.bob, team, run1.id, 0, ['cancelled']);
    release(); // the executor call returns AFTER the cancel — nothing further runs
    const done = await waitRun(U.bob, team, run1.id, ['cancelled', 'failed', 'completed']);
    assert.strictEqual(done.status, 'cancelled');
    assert.deepStrictEqual(done.steps.map((s) => s.status), ['cancelled', 'cancelled']);
    const e = await execStore.getExecution(team.id, done.steps[0].executionId);
    assert.strictEqual(e.status, 'cancelled');
    assert.strictEqual((await dataStore.getTask(team.id, done.taskId)).status, 'cancelled');
    assert.strictEqual((await call('POST', `${RUNS(team)}/${run1.id}/cancel`, { as: U.bob, body: {} })).status, 409);
  });

  await test('cancellation: a queued run (no worker) is cancelled immediately and never executes', async () => {
    resetNexus();
    await sys.runner.stop();
    SCRIPTS.wfqueued = () => step('read_text');
    const w = await createPublished(U.bob, team, 'Queued cancel', { steps: [{ key: 'a', name: 'A', instruction: 'wfqueued x' }] });
    const run1 = await startRun(U.bob, team, w.id);
    const c = await call('POST', `${RUNS(team)}/${run1.id}/cancel`, { as: U.carol, body: {} });
    assert.strictEqual(c.status, 200);
    assert.strictEqual(c.body.data.status, 'cancelled');
    assert.strictEqual((await wfStore.getJobByRun(team.id, run1.id)).status, 'cancelled');
    sys.runner.start();
    await sleep(150);
    assert.strictEqual(nexusCalls.length, 0);
    assert.strictEqual((await call('GET', `${RUNS(team)}/${run1.id}`, { as: U.bob })).body.data.status, 'cancelled');
  });

  await test('emergency stop: blocks the step from starting → run cancelled (EMERGENCY_STOP)', async () => {
    resetNexus();
    SCRIPTS.wfestop = () => step('read_text');
    const w = await createPublished(U.bob, team, 'E-stop', { steps: [{ key: 'a', name: 'A', instruction: 'wfestop x' }] });
    taskPlanner.triggerEmergencyStop();
    try {
      const r = await waitRun(U.bob, team, (await startRun(U.bob, team, w.id)).id, ['cancelled', 'failed', 'completed']);
      assert.strictEqual(r.status, 'cancelled');
      assert.strictEqual(r.failure.code, 'EMERGENCY_STOP');
    } finally {
      taskPlanner.clearEmergencyStop();
    }
    assert.strictEqual(nexusCalls.length, 0);
  });

  // ==================================================================
  // TENANCY
  // ==================================================================
  await test('tenancy: other workspace cannot read/edit/publish/run/archive a workflow (404 via either URL)', async () => {
    for (const ws of [other, team]) {
      for (const [m, suffix, body] of [['GET', '', undefined], ['PATCH', '', { name: 'x', revision: 0 }], ['POST', '/publish', {}], ['POST', '/archive', {}],
        ['POST', '/runs', { inputs: { product_name: 'x' } }], ['GET', '/runs', undefined], ['GET', '/versions/1', undefined], ['PUT', '/trigger', { type: 'manual' }]]) {
        const r = await call(m, `${WF(ws)}/${multiWf.id}${suffix}`, { as: U.mallory, body });
        assert.strictEqual(r.status, 404, `${ws.name} ${m} ${suffix} → ${r.status}`);
      }
    }
    assert.strictEqual((await call('GET', `${WF(bobWs)}/${multiWf.id}`, { as: U.bob })).status, 404, 'member of both, wrong workspace URL');
  });

  await test('tenancy: other workspace cannot read runs, evidence, or executions of a run (404)', async () => {
    for (const [as, ws] of [[U.mallory, other], [U.bob, bobWs], [U.mallory, team]]) {
      for (const suffix of ['', '/evidence']) {
        assert.strictEqual((await call('GET', `${RUNS(ws)}/${multiRun.id}${suffix}`, { as })).status, 404, `${ws.name} ${suffix}`);
      }
      const l = await call('GET', RUNS(ws), { as });
      if (l.status === 200) assert.ok(l.body.data.every((x) => x.workspaceId === ws.id));
    }
    const execId = multiRun.steps[0].executionId;
    assert.strictEqual((await call('GET', `/api/workspaces/${other.id}/executions/${execId}/evidence`, { as: U.mallory })).status, 404);
    assert.strictEqual((await call('GET', `/api/workspaces/${bobWs.id}/executions/${execId}`, { as: U.bob })).status, 404);
  });

  await test('tenancy: a task from another workspace cannot be attached to a run; body workspace/user ids are ignored', async () => {
    const foreignTask = await dataStore.insertTask({ id: crypto.randomUUID(), workspace_id: other.id, title: 'x', created_by: U.mallory.uid, status: 'todo' });
    const r = await call('POST', `${WF(team)}/${multiWf.id}/runs`, { as: U.bob, body: { inputs: { product_name: 'x' }, taskId: foreignTask.id } });
    assert.strictEqual(r.status, 404);
    SCRIPTS.wfopen = () => DONE('ok'); SCRIPTS.wfreadprice = () => DONE('ok'); SCRIPTS.wfsummary = () => DONE('ok');
    const s = await startRun(U.dave, team, multiWf.id, { inputs: { product_name: 'x' }, workspaceId: other.id, initiatedBy: U.mallory.uid, workflowVersionId: crypto.randomUUID() });
    assert.strictEqual(s.workspaceId, team.id);
    assert.strictEqual(s.initiatedBy, U.dave.uid);
    await waitRun(U.dave, team, s.id, ['completed', 'failed']);
  });

  await test('tenancy (store level): a run can never reference another workspace\'s workflow/version/task', async () => {
    const v = (await wfStore.listVersions(team.id, multiWf.id))[0];
    await assert.rejects(wfStore.insertRun({ id: crypto.randomUUID(), workspace_id: other.id, workflow_id: multiWf.id, workflow_version_id: v.id, version_number: 1, initiated_by: U.mallory.uid, trigger: 'manual' }), (e) => e.code === '23503');
    const w2 = await wfStore.insertWorkflow({ id: crypto.randomUUID(), workspace_id: team.id, name: 'x', created_by: U.alice.uid });
    await assert.rejects(wfStore.insertRun({ id: crypto.randomUUID(), workspace_id: team.id, workflow_id: w2.id, workflow_version_id: v.id, version_number: 1, initiated_by: U.alice.uid, trigger: 'manual' }), (e) => e.code === '23503', 'version must belong to the workflow');
    const foreignTask = await dataStore.insertTask({ id: crypto.randomUUID(), workspace_id: other.id, title: 'y', created_by: U.mallory.uid, status: 'todo' });
    await assert.rejects(wfStore.insertRun({ id: crypto.randomUUID(), workspace_id: team.id, workflow_id: multiWf.id, workflow_version_id: v.id, version_number: 1, initiated_by: U.alice.uid, trigger: 'manual', task_id: foreignTask.id }), (e) => e.code === '23503');
  });

  // ==================================================================
  // IDEMPOTENCY / DUPLICATES
  // ==================================================================
  await test('idempotency: 5 concurrent starts with one Idempotency-Key → one run; different body → 409; bad key → 400', async () => {
    resetNexus();
    SCRIPTS.wfprice = (n) => (n === 0 ? step('read_text') : DONE('price'));
    const key = `run-${RUN}-0001`;
    const rs = await Promise.all(Array.from({ length: 5 }, () => call('POST', `${WF(team)}/${wfA.id}/runs`, { as: U.bob, body: { inputs: { product_name: 'Busy' } }, headers: { 'idempotency-key': key } })));
    const ids = new Set(rs.map((r) => r.body.data && r.body.data.id));
    assert.strictEqual(ids.size, 1, rs.map((r) => `${r.status}:${r.body.data && r.body.data.id}`).join(','));
    assert.strictEqual(rs.filter((r) => r.status === 201).length, 1);
    assert.ok(rs.filter((r) => r.status !== 201).every((r) => r.status === 200 && r.body.data.replayed));
    const diff = await call('POST', `${WF(team)}/${wfA.id}/runs`, { as: U.bob, body: { inputs: { product_name: 'Other' } }, headers: { 'idempotency-key': key } });
    assert.strictEqual(diff.status, 409);
    assert.strictEqual((await call('POST', `${WF(team)}/${wfA.id}/runs`, { as: U.bob, body: { inputs: { product_name: 'x' } }, headers: { 'idempotency-key': 'bad key!' } })).status, 400);
    await waitRun(U.bob, team, [...ids][0], ['completed', 'failed']);
    assert.strictEqual((await execsOfRun(team, [...ids][0])).length, 1);
  });

  await test('api trigger: requires the workflow to allow it and an Idempotency-Key', async () => {
    const r1 = await call('POST', `${WF(team)}/${wfA.id}/runs`, { as: U.bob, body: { trigger: 'api', inputs: { product_name: 'x' } }, headers: { 'idempotency-key': `api-${RUN}-1` } });
    assert.strictEqual(r1.status, 409);
    assert.strictEqual(r1.body.code, 'TRIGGER_NOT_ENABLED');
    assert.strictEqual((await call('PUT', `${WF(team)}/${wfA.id}/trigger`, { as: U.bob, body: { type: 'api' } })).status, 403, 'member cannot configure triggers');
    assert.strictEqual((await call('PUT', `${WF(team)}/${wfA.id}/trigger`, { as: U.carol, body: { type: 'api' } })).status, 200);
    assert.strictEqual((await call('POST', `${WF(team)}/${wfA.id}/runs`, { as: U.bob, body: { trigger: 'api', inputs: { product_name: 'x' } } })).status, 400);
    const ok = await call('POST', `${WF(team)}/${wfA.id}/runs`, { as: U.bob, body: { trigger: 'api', inputs: { product_name: 'x' } }, headers: { 'idempotency-key': `api-${RUN}-2` } });
    assert.strictEqual(ok.status, 201);
    assert.strictEqual(ok.body.data.trigger, 'api');
    await waitRun(U.bob, team, ok.body.data.id, ['completed', 'failed']);
    await call('PUT', `${WF(team)}/${wfA.id}/trigger`, { as: U.carol, body: { type: 'manual' } });
  });

  // ==================================================================
  // DURABILITY
  // ==================================================================
  await test('durability: concurrent claims of one queued job → exactly one worker gets it', async () => {
    await sys.runner.stop();
    SCRIPTS.wfclaim = (n) => (n === 0 ? step('read_text') : DONE('claimed'));
    const w = await createPublished(U.bob, team, 'Claim race', { steps: [{ key: 'a', name: 'A', instruction: 'wfclaim x' }] });
    const run1 = await startRun(U.bob, team, w.id);
    const claims = await Promise.all(Array.from({ length: 8 }, (_, i) => wfStore.claimJob(`racer_${i}_${RUN}`, 30)));
    const got = claims.filter(Boolean);
    assert.strictEqual(got.length, 1, `claims: ${got.length}`);
    assert.strictEqual(got[0].run_id, run1.id);
    // the winner's lease blocks everyone else; release it for the real worker
    assert.strictEqual(await wfStore.claimJob(`late_${RUN}`, 30), null);
    assert.strictEqual(await wfStore.heartbeatJob(got[0].id, `someone_else_${RUN}`, 30, got[0].lease_fence), false, 'only the lease owner can heartbeat');
    assert.strictEqual(await wfStore.releaseJob(got[0].id, `someone_else_${RUN}`, { status: 'completed', fence: got[0].lease_fence }), false, 'only the lease owner can release');
    // Layer 6 fencing: the owner with a stale fence token is rejected too.
    assert.strictEqual(await wfStore.heartbeatJob(got[0].id, got[0].lease_owner, 30, Number(got[0].lease_fence) - 1), false, 'stale fence cannot heartbeat');
    assert.strictEqual(await wfStore.releaseJob(got[0].id, got[0].lease_owner, { status: 'completed', fence: Number(got[0].lease_fence) - 1 }), false, 'stale fence cannot release');
    assert.strictEqual(await wfStore.releaseJob(got[0].id, got[0].lease_owner, { status: 'queued', delaySeconds: 0, fence: got[0].lease_fence }), true);
    sys.runner.start();
    const done = await waitRun(U.bob, team, run1.id, ['completed', 'failed']);
    assert.strictEqual(done.status, 'completed');
  });

  await test('durability: two worker loops over many runs in two workspaces → every step executes exactly once', async () => {
    resetNexus();
    const second = createWorkflowRunner({
      store: wfStore, service: sys.service, dataStore, executionService: sys.execService, execStore, appendAuditLog,
      getMemberRole: async () => 'owner', logger: { error() {}, warn() {} }, options: { ...RUNNER_OPTS, workerId: `second_${RUN}` },
    });
    second.start();
    try {
      SCRIPTS.wfmany = (n) => (n === 0 ? step('read_text') : DONE('many'));
      const wTeam = await createPublished(U.bob, team, 'Many T', { steps: [{ key: 'a', name: 'A', instruction: 'wfmany a' }, { key: 'b', name: 'B', instruction: 'wfmany b' }] });
      const wBob = await createPublished(U.bob, bobWs, 'Many B', { steps: [{ key: 'a', name: 'A', instruction: 'wfmany a' }, { key: 'b', name: 'B', instruction: 'wfmany b' }] });
      const runs = [];
      for (let i = 0; i < 3; i++) {
        runs.push([team, await startRun(U.bob, team, wTeam.id)]);
        runs.push([bobWs, await startRun(U.bob, bobWs, wBob.id)]);
      }
      for (const [ws, r] of runs) {
        const d = await waitRun(U.bob, ws, r.id, ['completed', 'failed'], 3000);
        assert.strictEqual(d.status, 'completed', JSON.stringify(d.failure));
        assert.strictEqual((await execsOfRun(ws, r.id)).length, 2, 'one execution per step, no duplicates');
        assert.deepStrictEqual(d.steps.map((s) => s.attempt), [1, 1]);
      }
      assert.strictEqual(nexusCalls.filter((c) => c.action === 'read_text').length, 12);
    } finally {
      await second.stop();
    }
  });

  await test('durability: heartbeats keep the lease alive during a long step; no other worker can claim it', async () => {
    resetNexus();
    let release;
    const gate = new Promise((res) => { release = res; });
    NEXUS = async () => { await gate; return { success: true, data: 'x', evidence: { verified: true } }; };
    SCRIPTS.wflong = (n) => (n === 0 ? step('read_text') : DONE('long'));
    const w = await createPublished(U.bob, team, 'Long step', { steps: [{ key: 'a', name: 'A', instruction: 'wflong x' }] });
    const run1 = await startRun(U.bob, team, w.id);
    await waitStepExec(U.bob, team, run1.id, 0, ['executing']);
    const before = await wfStore.getJobByRun(team.id, run1.id);
    await advance(LEASE * 1000 * 1.5);
    const after = await wfStore.getJobByRun(team.id, run1.id);
    assert.strictEqual(after.status, 'running');
    assert.ok(Date.parse(after.lease_expires_at) > Date.parse(before.lease_expires_at), 'heartbeat extended the lease');
    assert.strictEqual(after.lease_owner, before.lease_owner);
    assert.strictEqual(await wfStore.claimJob(`thief_${RUN}`, 30), null, 'a live lease cannot be claimed');
    release();
    assert.strictEqual((await waitRun(U.bob, team, run1.id, ['completed', 'failed'])).status, 'completed');
  });

  // crash + recover helper: the current system "crashes" (abandons its lease;
  // its in-flight executor call never returns) and a fresh process takes over.
  async function crashAndRecover() {
    await sys.runner.stop({ abandon: true });
    sys = makeSystem(makeExecService());
    await expireLeases();
    sys.runner.start();
  }

  await test('restart recovery: interrupted read-only step → lease expires → new worker retries it safely → COMPLETED', async () => {
    resetNexus();
    let first = true;
    NEXUS = (req) => {
      if (req.action === 'read_text' && first) { first = false; return new Promise(() => {}); } // dies with the "old process"
      return { success: true, data: 'report rows', evidence: { verified: true } };
    };
    SCRIPTS.wfcrashsafe = (n) => (n === 0 ? step('read_text') : DONE('read after restart'));
    const w = await createPublished(U.bob, team, 'Crash safe', { steps: [{ key: 'a', name: 'A', instruction: 'wfcrashsafe x' }] });
    const run1 = await startRun(U.bob, team, w.id);
    await waitStepExec(U.bob, team, run1.id, 0, ['executing']);
    const job0 = await wfStore.getJobByRun(team.id, run1.id);
    await crashAndRecover();
    const done = await waitRun(U.bob, team, run1.id, ['completed', 'failed', 'needs_review'], 1500);
    assert.strictEqual(done.status, 'completed', JSON.stringify(done.failure || done.reviewReason));
    assert.strictEqual(done.steps[0].attempts.length, 2);
    assert.strictEqual(done.steps[0].attempts[0].failureCode, 'SERVER_RESTART');
    const e1 = await execStore.getExecution(team.id, done.steps[0].attempts[0].executionId);
    assert.strictEqual(e1.failure_code, 'SERVER_RESTART', 'interrupted attempt evidence preserved');
    assert.strictEqual(e1.inflight.action, 'read_text', 'in-flight marker recorded before the executor call');
    let job1 = await wfStore.getJobByRun(team.id, run1.id);
    for (let i = 0; i < 200 && job1.status === 'running'; i++) { await sleep(10); job1 = await wfStore.getJobByRun(team.id, run1.id); } // release follows the run update
    assert.strictEqual(job1.recoveries, 1);
    assert.notStrictEqual(job1.lease_owner || 'released', job0.lease_owner);
    assert.strictEqual(job1.status, 'completed');
    assert.ok(auditRows.some((a) => a.action === 'workflow_run_recovered' && a.payload.runId === run1.id));
  });

  await test('restart recovery: interrupted NON-idempotent action is never repeated → NEEDS_REVIEW → reviewer fails it', async () => {
    resetNexus();
    let first = true;
    NEXUS = (req) => {
      if (req.action === 'click' && first) { first = false; return new Promise(() => {}); }
      return { success: true, data: 'x', evidence: { verified: true } };
    };
    SCRIPTS.wfcrashunsafe = (n) => (n === 0 ? step('click', { target: { text: 'File return' } }) : DONE('filed'));
    const w = await createPublished(U.bob, team, 'Crash unsafe', { steps: [{ key: 'a', name: 'A', instruction: 'wfcrashunsafe x', retry: { maxAttempts: 3 } }] });
    const run1 = await startRun(U.bob, team, w.id);
    await waitStepExec(U.bob, team, run1.id, 0, ['executing']);
    await crashAndRecover();
    const r = await waitRun(U.bob, team, run1.id, ['needs_review', 'completed', 'failed'], 1500);
    assert.strictEqual(r.status, 'needs_review');
    assert.match(r.reviewReason, /click.*in flight/);
    assert.strictEqual(nexusCalls.filter((c) => c.action === 'click').length, 1, 'the click was NOT sent again');
    const f = await call('POST', `${RUNS(team)}/${run1.id}/resolve`, { as: U.alice, body: { action: 'fail' } });
    assert.strictEqual(f.status, 200, JSON.stringify(f.body));
    const done = await waitRun(U.bob, team, run1.id, ['failed']);
    assert.strictEqual(done.failure.code, 'REVIEW_FAILED');
  });

  await test('restart recovery: waiting-for-approval step interrupted → approval dies (never replayable) → safe retry', async () => {
    resetNexus();
    SCRIPTS.wfcrashappr = (n) => (n === 0 ? step('click') : DONE('ok'));
    const w = await createPublished(U.bob, team, 'Crash while waiting', { steps: [{ key: 'a', name: 'A', instruction: 'wfcrashappr x', approval: 'required', retry: { maxAttempts: 1 } }] });
    const run1 = await startRun(U.bob, team, w.id);
    const waiting = await waitRun(U.bob, team, run1.id, ['waiting_approval']);
    const oldAppr = waiting.steps[0].execution.waitingForApproval.id;
    await crashAndRecover();
    const again = await waitRun(U.bob, team, run1.id, ['waiting_approval', 'needs_review', 'failed'], 1500);
    let s = again.steps[0];
    for (let i = 0; i < 300 && !(s.execution && s.execution.waitingForApproval && s.execution.waitingForApproval.id !== oldAppr); i++) {
      await sleep(10);
      s = (await call('GET', `${RUNS(team)}/${run1.id}`, { as: U.bob })).body.data.steps[0];
    }
    assert.strictEqual(s.attempt, 2, 'nothing was executed before the crash → safe to retry');
    const stale = await call('POST', `${RUNS(team)}/${run1.id}/steps/0/approvals/${oldAppr}/approve`, { as: U.bob, body: {} });
    assert.ok([404, 409].includes(stale.status), `stale approval from the dead execution → ${stale.status}`);
    const ok = await call('POST', `${RUNS(team)}/${run1.id}/steps/0/approvals/${s.execution.waitingForApproval.id}/approve`, { as: U.bob, body: {} });
    assert.strictEqual(ok.status, 200);
    assert.strictEqual((await waitRun(U.bob, team, run1.id, ['completed', 'failed'])).status, 'completed');
    assert.strictEqual(nexusCalls.filter((c) => c.action === 'click').length, 1);
  });

  await test('restart recovery: recovery limit — a run interrupted more than max_recoveries times FAILS', async () => {
    resetNexus();
    NEXUS = () => new Promise(() => {}); // every attempt hangs forever
    SCRIPTS.wfcrashloop = (n) => (n === 0 ? step('read_text') : DONE('x'));
    const w = await createPublished(U.bob, team, 'Crash loop', { steps: [{ key: 'a', name: 'A', instruction: 'wfcrashloop x', retry: { maxAttempts: 3 } }] });
    const run1 = await startRun(U.bob, team, w.id);
    const job = await wfStore.getJobByRun(team.id, run1.id);
    if (!SUPA) wfStore._jobs.get(job.id).max_recoveries = 1;
    else await require('@supabase/supabase-js').createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY).from('workflow_jobs').update({ max_recoveries: 1 }).eq('id', job.id);
    await waitStepExec(U.bob, team, run1.id, 0, ['executing']);
    await crashAndRecover();
    await waitStepExec(U.bob, team, run1.id, 0, ['executing'], 1500);
    await crashAndRecover();
    const done = await waitRun(U.bob, team, run1.id, ['failed', 'completed', 'needs_review'], 1500);
    assert.strictEqual(done.status, 'failed');
    assert.strictEqual(done.failure.code, 'RECOVERY_EXHAUSTED');
    assert.strictEqual((await wfStore.getJobByRun(team.id, run1.id)).status, 'failed');
  });

  await test('durability: an orphan run (process died before its job was written) is swept and executed', async () => {
    resetNexus();
    SCRIPTS.wforphan = (n) => (n === 0 ? step('read_text') : DONE('orphan done'));
    const w = await createPublished(U.bob, team, 'Orphan', { steps: [{ key: 'a', name: 'A', instruction: 'wforphan x' }] });
    const wf = await wfStore.getWorkflow(team.id, w.id);
    const orphan = await wfStore.insertRun({
      id: crypto.randomUUID(), workspace_id: team.id, workflow_id: w.id, workflow_version_id: wf.active_version_id, version_number: 1,
      initiated_by: U.bob.uid, trigger: 'manual', inputs: {},
    });
    if (SUPA) await sleep(1200);
    else clockOffset += 2 * 60 * 1000;
    await sys.runner.schedulerTick();
    const done = await waitRun(U.bob, team, orphan.id, ['completed', 'failed']);
    assert.strictEqual(done.status, 'completed');
  });

  // ==================================================================
  // SCHEDULING
  // ==================================================================
  await test('scheduling: admin-only; concurrent scheduler ticks create exactly ONE run per slot; missed slots not back-filled', async () => {
    resetNexus();
    SCRIPTS.wfsched = (n) => (n === 0 ? step('read_text') : DONE('scheduled ok'));
    const w = await createPublished(U.bob, team, 'Nightly', { variables: [{ name: 'date_range', type: 'date' }], steps: [{ key: 'a', name: 'A', instruction: 'wfsched report for {{input.date_range}}' }] });
    assert.strictEqual((await call('PUT', `${WF(team)}/${w.id}/trigger`, { as: U.bob, body: { type: 'scheduled', intervalMinutes: 60, inputs: { date_range: '2026-09-01' } } })).status, 403);
    assert.strictEqual((await call('PUT', `${WF(team)}/${w.id}/trigger`, { as: U.carol, body: { type: 'scheduled', intervalMinutes: 5, inputs: {} } })).status, 400);
    assert.strictEqual((await call('PUT', `${WF(team)}/${w.id}/trigger`, { as: U.carol, body: { type: 'scheduled', intervalMinutes: 60, inputs: {} } })).status, 400, 'inputs validated against the active version');
    const s = await call('PUT', `${WF(team)}/${w.id}/trigger`, { as: U.carol, body: { type: 'scheduled', intervalMinutes: 60, inputs: { date_range: '2026-09-01' } } });
    assert.strictEqual(s.status, 200);
    assert.strictEqual(s.body.data.trigger.owner, U.carol.uid);
    // make the slot due (3.5 intervals late) and race three schedulers
    const wf = await wfStore.getWorkflow(team.id, w.id);
    const slot = new Date(now().getTime() - 210 * 60000).toISOString();
    await wfStore.updateWorkflow(team.id, w.id, wf.revision, { next_run_at: slot });
    const other1 = createWorkflowRunner({ store: wfStore, service: sys.service, dataStore, executionService: sys.execService, execStore, appendAuditLog, getMemberRole: async (ws, uid) => { const m = await wsStore.getMember(ws, uid); return m ? m.role : null; }, logger: { error() {}, warn() {} }, options: RUNNER_OPTS });
    await Promise.all([sys.runner.schedulerTick(), other1.schedulerTick(), sys.runner.schedulerTick()]);
    const runs = (await wfStore.listRuns(team.id, { workflowId: w.id, limit: 50 }));
    assert.strictEqual(runs.length, 1, `runs for slot: ${runs.length}`);
    assert.strictEqual(runs[0].trigger, 'scheduled');
    assert.strictEqual(runs[0].initiated_by, U.carol.uid);
    assert.strictEqual(Date.parse(runs[0].scheduled_for), Date.parse(slot));
    const after = await wfStore.getWorkflow(team.id, w.id);
    assert.ok(Date.parse(after.next_run_at) > now().getTime(), 'next slot is in the future (no back-fill storm)');
    // DB-level duplicate protection for the same slot
    await assert.rejects(wfStore.insertRun({ id: crypto.randomUUID(), workspace_id: team.id, workflow_id: w.id, workflow_version_id: after.active_version_id, version_number: 1, initiated_by: U.carol.uid, trigger: 'scheduled', scheduled_for: slot }), (e) => e.code === '23505');
    const done = await waitRun(U.carol, team, runs[0].id, ['completed', 'failed']);
    assert.strictEqual(done.status, 'completed');
    assert.ok(prompts.some((p) => p.includes('wfsched report for 2026-09-01')));
  });

  await test('scheduling: a schedule whose owner lost admin rights is disabled instead of running', async () => {
    const w = await createPublished(U.alice, team, 'Owner demoted', { steps: [{ key: 'a', name: 'A', instruction: 'wfsched x' }] });
    const s = await call('PUT', `${WF(team)}/${w.id}/trigger`, { as: U.carol, body: { type: 'scheduled', intervalMinutes: 60, inputs: {} } });
    assert.strictEqual(s.status, 200);
    await wsService.changeMemberRole({ workspace: team, role: 'owner', userId: U.alice.uid }, U.carol.uid, { role: 'member' });
    try {
      const wf = await wfStore.getWorkflow(team.id, w.id);
      await wfStore.updateWorkflow(team.id, w.id, wf.revision, { next_run_at: new Date(now().getTime() - 60000).toISOString() });
      await sys.runner.schedulerTick();
      assert.strictEqual((await wfStore.listRuns(team.id, { workflowId: w.id })).length, 0);
      const after = await wfStore.getWorkflow(team.id, w.id);
      assert.strictEqual(after.trigger_type, 'manual');
      assert.ok(auditRows.some((a) => a.action === 'workflow_schedule_disabled' && a.payload.workflowId === w.id));
    } finally {
      await wsService.changeMemberRole({ workspace: team, role: 'owner', userId: U.alice.uid }, U.carol.uid, { role: 'admin' });
    }
  });

  // ==================================================================
  // SECRETS
  // ==================================================================
  await test('secrets: inputs are redacted before storage, rendering, the planner, evidence and audit', async () => {
    resetNexus();
    prompts.length = 0;
    SCRIPTS.wfsecret = (n) => (n === 0 ? step('read_text') : DONE('done for client'));
    const w = await createPublished(U.bob, team, 'Secret input', { variables: [{ name: 'note', maxLength: 500 }], steps: [{ key: 'a', name: 'A', instruction: 'wfsecret handle {{input.note}}' }] });
    const run1 = await startRun(U.bob, team, w.id, { inputs: { note: 'client PAN ABCDE1234F and portal password: hunter2 token=sk-live-abcdefghijklmnopqrstuvwxyz' } });
    assert.ok(!JSON.stringify(run1).includes('hunter2'));
    assert.ok(!JSON.stringify(run1).includes('ABCDE1234F'));
    const done = await waitRun(U.bob, team, run1.id, ['completed', 'failed']);
    const ev = await call('GET', `${RUNS(team)}/${run1.id}/evidence`, { as: U.bob });
    const everything = JSON.stringify([done, ev.body, prompts, auditRows, await wfStore.getRun(team.id, run1.id), await execStore.getExecution(team.id, done.steps[0].executionId)]);
    for (const secret of ['hunter2', 'ABCDE1234F', 'sk-live-abcdefghijklmnopqrstuvwxyz']) {
      assert.ok(!everything.includes(secret), `leaked ${secret}`);
    }
    assert.ok(prompts.some((p) => p.includes('[REDACTED]')));
  });

  await test('secrets: a secret typed into a step template is redacted at save time', async () => {
    const w = await createWf(U.bob, team, { name: 'Template secret', definition: { steps: [{ key: 'a', name: 'A', instruction: 'log in with password: hunter2 and continue' }] } });
    assert.ok(!JSON.stringify(w).includes('hunter2'));
  });

  // ==================================================================
  // AUDIT
  // ==================================================================
  await test('audit: lifecycle events are attributed to the right workspace and never carry raw inputs', async () => {
    const mine = auditRows.filter((a) => a.action.startsWith('workflow_'));
    for (const action of ['workflow_created', 'workflow_updated', 'workflow_published', 'workflow_archived', 'workflow_activated', 'workflow_run_started',
      'workflow_run_completed', 'workflow_run_failed', 'workflow_run_cancelled', 'workflow_run_needs_review', 'workflow_run_resolved', 'workflow_trigger_set']) {
      assert.ok(mine.some((a) => a.action === action), `missing ${action}`);
    }
    assert.ok(mine.every((a) => a.workspaceId), 'every workflow audit row has a workspace');
    assert.ok(mine.filter((a) => a.payload && a.payload.workflowId === multiWf.id).every((a) => a.workspaceId === team.id));
  });

  await sys.runner.stop();
  srv.close();
  console.log(`\n${passed} passed, ${failed} failed (store: ${STORE_MODE})`);
  process.exit(failed ? 1 : 0);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
