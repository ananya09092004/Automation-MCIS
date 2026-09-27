/**
 * Layer 3 — Agent Execution & Verification tests.
 *
 * Drives the REAL HTTP stack (express.json → sanitizer → middleware/auth.js
 * → Layer 1 workspaceContext → routes/executions.js) and the REAL
 * executionService, taskPlanner primitives (decideNextStep,
 * callNexusWithTimeout, diagnoseFailure, emergency stop), riskModel,
 * intentRouter action vocabulary, permissions and sensitiveDataFilter.
 *
 * Replaced (external services only): Firebase token verification, the
 * Gemini client (scripted planner replies), the Nexus HTTP bridge
 * (scripted executor results), Supabase (tiny in-memory tables for
 * permissions/audit), and storage (in-memory stores that mirror the SQL
 * constraints; WORKSPACE_TEST_STORE=supabase runs against a real DB).
 *
 * Run: node __tests__/agentExecution.test.js
 */
'use strict';

const assert = require('assert');
const Module = require('module');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const R = (...p) => require.resolve(path.join(ROOT, ...p));
const STORE_MODE = process.env.WORKSPACE_TEST_STORE === 'supabase' ? 'supabase' : 'memory';

if (STORE_MODE === 'memory') {
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

// ---- Supabase (memory mode only): user_permissions + audit_log -------
const auditRows = [];
const permRows = [];
if (STORE_MODE === 'memory') {
  fakeModule(require.resolve('@supabase/supabase-js'), {
    createClient: () => ({
      from(table) {
        const filters = [];
        const b = {
          select() { return b; },
          eq(k, v) { filters.push([k, v]); return b; },
          async maybeSingle() {
            const rows = table === 'user_permissions' ? permRows : [];
            return { data: rows.find((r) => filters.every(([k, v]) => r[k] === v)) || null, error: null };
          },
          async insert(row) { if (table === 'audit_log') auditRows.push(row); return { data: null, error: null }; },
        };
        return b;
      },
    }),
  });
}

// ---- Firebase: tokens are `tok|<uid>` -----------------------------------
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

// ---- Scripted planner (via the real decideNextStep prompt) ------------
// SCRIPTS[tag] = (historyLen, prompt) => planner JSON reply
const SCRIPTS = {};
let plannerCalls = 0;
let plannerThrows = false;
const lastPrompts = [];
fakeModule(R('backend-routing', 'geminiClient.js'), {
  generateContent: async (prompt) => {
    plannerCalls++;
    lastPrompts.push(prompt);
    if (plannerThrows) throw new Error('gemini down');
    const goal = (prompt.match(/The user's goal: "([\s\S]*?)"\n/) || [])[1] || '';
    const tag = goal.split(/\s+/)[0];
    const section = prompt.split('Steps executed so far:\n')[1].split('\n\nClarifications')[0];
    const historyLen = (section.match(/^\d+\. /gm) || []).length;
    const script = SCRIPTS[tag];
    const reply = script ? script(historyLen, prompt) : { done: true, reason: 'nothing to do' };
    const text = typeof reply === 'string' ? reply : JSON.stringify(reply);
    return { response: { text: () => text } };
  },
});

// ---- Scripted Nexus executor ------------------------------------------
let NEXUS = () => ({ success: true, data: null, evidence: { verified: true } });
const nexusCalls = [];
let nexusGate = null; // promise to hold executor calls (in-flight cancel tests)
fakeModule(R('backend-routing', 'nexusBridge.js'), {
  sendCommandToNexus: async (req) => {
    nexusCalls.push(req);
    if (nexusGate) await nexusGate;
    return NEXUS(req, nexusCalls.filter((c) => c.action === req.action).length);
  },
});

// ---- real modules -------------------------------------------------------
const express = require('express');
const authenticateFirebaseUser = require(R('middleware', 'auth.js'));
const sanitizeInput = require(R('middleware', 'sanitizer.js'));
const taskPlanner = require(R('backend-routing', 'taskPlanner.js'));
const { createWorkspaceService } = require(R('services', 'workspaceService.js'));
const { createAgentExecutionService } = require(R('services', 'agentExecution', 'executionService.js'));
const { createExecutionsRouter } = require(R('routes', 'executions.js'));
const { redact, redactString } = require(R('backend-routing', 'sensitiveDataFilter.js'));
const { createMemoryWorkspaceStore } = require(path.join(__dirname, 'support', 'memoryWorkspaceStore.js'));
const { createMemoryExecutionStore } = require(path.join(__dirname, 'support', 'memoryExecutionStore.js'));

let wsStore;
let execStore;
if (STORE_MODE === 'supabase') {
  wsStore = require(R('services', 'workspaceStore.js')).createSupabaseWorkspaceStore();
  execStore = require(R('services', 'agentExecution', 'executionStore.js')).createSupabaseExecutionStore();
} else {
  wsStore = createMemoryWorkspaceStore();
  execStore = createMemoryExecutionStore();
}

let clockOffset = 0;
const now = () => new Date(Date.now() + clockOffset);
const wsService = createWorkspaceService(wsStore, { requireVerifiedEmail: true });
const OPTIONS = { retryDelayMs: 0, maxSteps: 6, now };
let execService = createAgentExecutionService({ store: execStore, options: OPTIONS, logger: { error() {} } });

let currentRouterService = execService;
function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(sanitizeInput);
  app.use('/api', authenticateFirebaseUser);
  // indirection so a "restarted" service instance can be swapped in
  app.use('/api/workspaces/:workspaceId/executions', (req, res, next) => currentRouterApp(req, res, next));
  return app;
}
let currentRouterApp = createExecutionsRouter({ workspaceService: wsService, executionService: execService });
function swapService(svc) {
  currentRouterService = svc;
  currentRouterApp = createExecutionsRouter({ workspaceService: wsService, executionService: svc });
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

async function run() {
  console.log(`# agent execution tests — store: ${STORE_MODE}`);
  const srv = await new Promise((resolve) => { const s = buildApp().listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${srv.address().port}`;
  const call = async (method, url, { as, headers = {}, body } = {}) => {
    const h = { 'content-type': 'application/json', ...headers, ...(as ? auth(as) : {}) };
    const res = await fetch(base + url, { method, headers: h, body: body && method !== 'GET' ? JSON.stringify(body) : undefined });
    let json = null;
    try { json = await res.json(); } catch { /* none */ }
    return { status: res.status, body: json };
  };

  // ---- workspaces: team (alice owner, carol admin, bob member, dave member); other (mallory)
  const team = await wsService.createWorkspace(U.alice, { name: 'Acme Tax' });
  const other = await wsService.createWorkspace(U.mallory, { name: 'Other Co' });
  const bobWs = await wsService.createWorkspace(U.bob, { name: 'Bob Solo' });
  for (const [u, role] of [[U.carol, 'admin'], [U.bob, 'member'], [U.dave, 'member']]) {
    const inv = await wsService.createInvitation({ workspace: team, role: 'owner', userId: U.alice.uid }, { email: u.email, role: role === 'admin' ? 'admin' : 'member' });
    await wsService.acceptInvitation(u, { token: inv.token });
  }
  const E = (ws) => `/api/workspaces/${ws.id}/executions`;

  async function start(as, goal, ws = team, extra = {}) {
    const r = await call('POST', E(ws), { as, body: { goal, ...extra.body }, headers: extra.headers });
    assert.ok([200, 201].includes(r.status), `create ${goal}: ${r.status} ${JSON.stringify(r.body)}`);
    return r.body.data;
  }
  async function waitFor(as, ws, id, statuses, tries = 300) {
    let last;
    for (let i = 0; i < tries; i++) {
      last = await call('GET', `${E(ws)}/${id}`, { as });
      if (last.status === 200 && statuses.includes(last.body.data.status)) return last.body.data;
      await sleep(5);
    }
    throw new Error(`execution ${id} never reached ${statuses} (last ${JSON.stringify(last && last.body)})`);
  }
  const evidence = async (as, ws, id) => (await call('GET', `${E(ws)}/${id}/evidence`, { as })).body.data;
  const approve = (as, ws, id, apprId, body) => call('POST', `${E(ws)}/${id}/approvals/${apprId}/approve`, { as, body });
  const reject = (as, ws, id, apprId, body) => call('POST', `${E(ws)}/${id}/approvals/${apprId}/reject`, { as, body });
  const resetNexus = () => { NEXUS = () => ({ success: true, data: 'ok', evidence: { verified: true } }); nexusCalls.length = 0; };
  resetNexus();

  const step = (action, payload = {}) => ({ done: false, action, payload: { platform: 'desktop', parameters: {}, target: {}, value: null, ...payload } });
  const DONE = { done: true, reason: 'goal complete' };

  // ==================================================================
  // Unauthorized access / isolation basics
  // ==================================================================
  await test('auth: no token → 401 on every execution route', async () => {
    const id = crypto.randomUUID();
    for (const [m, u] of [['POST', E(team)], ['GET', E(team)], ['GET', `${E(team)}/${id}`], ['GET', `${E(team)}/${id}/evidence`],
      ['POST', `${E(team)}/${id}/approvals/${id}/approve`], ['POST', `${E(team)}/${id}/approvals/${id}/reject`], ['POST', `${E(team)}/${id}/cancel`]]) {
      const r = await call(m, u, { body: { goal: 'x' } });
      assert.strictEqual(r.status, 401, `${m} ${u}`);
    }
  });
  await test('auth: non-member of the workspace → 404 on every execution route (no enumeration)', async () => {
    const id = crypto.randomUUID();
    for (const [m, u] of [['POST', E(team)], ['GET', E(team)], ['GET', `${E(team)}/${id}`], ['POST', `${E(team)}/${id}/cancel`]]) {
      const r = await call(m, u, { as: U.mallory, body: { goal: 'x' } });
      assert.strictEqual(r.status, 404, `${m} ${u}`);
    }
    assert.strictEqual((await call('GET', `/api/workspaces/not-a-uuid/executions`, { as: U.alice })).status, 404);
  });
  await test('validation: missing / oversized goal and bad idempotency key → 400', async () => {
    for (const body of [{}, { goal: '   ' }, { goal: 'x'.repeat(2001) }, { goal: 'ok', idempotencyKey: 'short' }, { goal: 'ok', idempotencyKey: 'bad key with spaces!' }]) {
      assert.strictEqual((await call('POST', E(team), { as: U.alice, body })).status, 400, JSON.stringify(body).slice(0, 60));
    }
  });

  // ==================================================================
  // Successful execution + evidence
  // ==================================================================
  let okExec;
  await test('success: plan → execute → observe → verify → COMPLETED with evidence', async () => {
    resetNexus();
    NEXUS = () => ({ success: true, data: 'Invoice total: 1,234', evidence: { verified: true } });
    SCRIPTS.readinvoice = (n) => (n === 0 ? step('read_text', { platform: 'browser' }) : DONE);
    const created = await start(U.alice, 'readinvoice read the total from the open invoice');
    assert.ok(['created', 'planning', 'executing', 'verifying', 'completed'].includes(created.status));
    okExec = await waitFor(U.alice, team, created.id, ['completed', 'failed']);
    assert.strictEqual(okExec.status, 'completed', JSON.stringify(okExec.failure));
    assert.strictEqual(okExec.verification.status, 'not_applicable');
    assert.strictEqual(okExec.progress.stepsExecuted, 1);
    assert.strictEqual(okExec.result.message, 'goal complete');
    const ev = await evidence(U.alice, team, created.id);
    assert.strictEqual(ev.steps.length, 1);
    const s0 = ev.steps[0];
    assert.strictEqual(s0.action, 'read_text');
    assert.strictEqual(s0.tool, 'browser');
    assert.strictEqual(s0.status, 'succeeded');
    assert.strictEqual(s0.verification.status, 'verified');
    assert.strictEqual(s0.output.data, 'Invoice total: 1,234');
    assert.ok(s0.startedAt && s0.finishedAt);
    assert.strictEqual(ev.execution.id, created.id);
    assert.strictEqual(ev.execution.evidenceSummary.succeeded, 1);
    assert.strictEqual(nexusCalls[0].approval_token, null, 'GREEN step runs without an approval token');
  });
  await test('visibility: list shows only this workspace; another member of the same workspace can view', async () => {
    const l = await call('GET', E(team), { as: U.bob });
    assert.strictEqual(l.status, 200);
    assert.ok(l.body.data.some((x) => x.id === okExec.id));
    assert.ok(l.body.data.every((x) => x.workspaceId === team.id));
    assert.strictEqual((await call('GET', E(other), { as: U.mallory })).body.data.length, 0);
  });

  // ==================================================================
  // Workspace isolation
  // ==================================================================
  await test('isolation: another workspace cannot read status/evidence, cancel, or approve — via either URL', async () => {
    for (const ws of [other, team]) {
      for (const [m, suffix] of [['GET', ''], ['GET', '/evidence'], ['POST', '/cancel'], ['POST', `/approvals/${crypto.randomUUID()}/approve`]]) {
        const r = await call(m, `${E(ws)}/${okExec.id}${suffix}`, { as: U.mallory });
        assert.strictEqual(r.status, 404, `${ws.name} ${m} ${suffix} → ${r.status}`);
      }
    }
  });
  await test('isolation: a member of BOTH workspaces cannot reach an execution through the wrong workspace URL', async () => {
    const r = await call('GET', `${E(bobWs)}/${okExec.id}`, { as: U.bob });
    assert.strictEqual(r.status, 404);
  });

  // ==================================================================
  // Approval gates
  // ==================================================================
  let yExec;
  let yAppr;
  await test('approval: YELLOW action pauses in WAITING_APPROVAL; nothing executes before approval', async () => {
    resetNexus();
    SCRIPTS.writereport = (n) => (n === 0 ? step('write_file', { parameters: { path: 'C:/reports/q3.txt' }, value: 'Q3 summary' }) : DONE);
    const created = await start(U.bob, 'writereport save the q3 summary');
    yExec = await waitFor(U.bob, team, created.id, ['waiting_approval']);
    yAppr = yExec.waitingForApproval;
    assert.strictEqual(yAppr.action, 'write_file');
    assert.strictEqual(yAppr.riskTier, 'yellow');
    assert.strictEqual(yAppr.requiredRole, 'creator_or_admin');
    assert.strictEqual(yAppr.status, 'pending');
    assert.strictEqual(yAppr.step.parameters.path, 'C:/reports/q3.txt');
    assert.strictEqual(nexusCalls.length, 0);
  });
  await test('approval authorization: a different plain member cannot approve (403); invalid approval id → 404', async () => {
    assert.strictEqual((await approve(U.dave, team, yExec.id, yAppr.id)).status, 403);
    assert.strictEqual((await approve(U.bob, team, yExec.id, crypto.randomUUID())).status, 404);
    assert.strictEqual((await approve(U.bob, team, yExec.id, 'nope')).status, 404);
    assert.strictEqual((await waitFor(U.bob, team, yExec.id, ['waiting_approval'])).status, 'waiting_approval');
  });
  await test('approval: concurrent double-approve (replay) → exactly one succeeds; step runs once with a token', async () => {
    const rs = await Promise.all(Array.from({ length: 5 }, () => approve(U.bob, team, yExec.id, yAppr.id)));
    assert.strictEqual(rs.filter((r) => r.status === 200).length, 1, rs.map((r) => r.status).join(','));
    assert.ok(rs.filter((r) => r.status !== 200).every((r) => r.status === 409));
    const done = await waitFor(U.bob, team, yExec.id, ['completed', 'failed']);
    assert.strictEqual(done.status, 'completed', JSON.stringify(done.failure));
    assert.strictEqual(done.verification.status, 'verified');
    const writes = nexusCalls.filter((c) => c.action === 'write_file');
    assert.strictEqual(writes.length, 1);
    assert.match(writes[0].approval_token, /^appr_[0-9a-f]{48}$/);
    const ev = await evidence(U.bob, team, yExec.id);
    assert.strictEqual(ev.approvals[0].status, 'approved');
    assert.strictEqual(ev.approvals[0].decidedBy, U.bob.uid);
    assert.strictEqual(ev.steps[0].approvalId, yAppr.id);
  });
  await test('stale approval: approving an already-decided approval again → 409', async () => {
    const r = await approve(U.bob, team, yExec.id, yAppr.id);
    assert.strictEqual(r.status, 409);
    assert.strictEqual(r.body.code, 'APPROVAL_NOT_PENDING');
  });

  await test('approval: RED action requires owner/admin — the creating member cannot approve; admin can', async () => {
    resetNexus();
    SCRIPTS.cleanup = (n) => (n === 0 ? step('delete_file', { parameters: { path: 'C:/tmp/old.log' } }) : DONE);
    const created = await start(U.bob, 'cleanup remove the old log');
    const w = await waitFor(U.bob, team, created.id, ['waiting_approval']);
    assert.strictEqual(w.waitingForApproval.riskTier, 'red');
    assert.strictEqual(w.waitingForApproval.requiredRole, 'admin');
    const denied = await approve(U.bob, team, created.id, w.waitingForApproval.id);
    assert.strictEqual(denied.status, 403);
    assert.strictEqual(nexusCalls.length, 0);
    assert.strictEqual((await approve(U.carol, team, created.id, w.waitingForApproval.id)).status, 200);
    const done = await waitFor(U.bob, team, created.id, ['completed', 'failed']);
    assert.strictEqual(done.status, 'completed');
    assert.strictEqual(nexusCalls.filter((c) => c.action === 'delete_file').length, 1);
  });

  await test('approval: approval from one execution cannot authorize another execution (same workspace) → 404', async () => {
    resetNexus();
    SCRIPTS.writeA = (n) => (n === 0 ? step('write_file', { parameters: { path: 'C:/a.txt' } }) : DONE);
    const a = await start(U.alice, 'writeA first');
    const wa = await waitFor(U.alice, team, a.id, ['waiting_approval']);
    await call('POST', `${E(team)}/${a.id}/cancel`, { as: U.alice });
    SCRIPTS.writeB = (n) => (n === 0 ? step('write_file', { parameters: { path: 'C:/b.txt' } }) : DONE);
    const b = await start(U.alice, 'writeB second');
    await waitFor(U.alice, team, b.id, ['waiting_approval']);
    const r = await approve(U.alice, team, b.id, wa.waitingForApproval.id);
    assert.strictEqual(r.status, 404);
    await call('POST', `${E(team)}/${b.id}/cancel`, { as: U.alice });
    assert.strictEqual(nexusCalls.length, 0);
  });

  await test('approval: approval of another workspace cannot be used (cross-workspace) → 404', async () => {
    resetNexus();
    SCRIPTS.writeM = (n) => (n === 0 ? step('write_file', { parameters: { path: 'C:/m.txt' } }) : DONE);
    const m = await start(U.mallory, 'writeM other tenant', other);
    const wm = await waitFor(U.mallory, other, m.id, ['waiting_approval']);
    // alice (owner of team) tries mallory's approval via her own workspace path and via mallory's
    assert.strictEqual((await approve(U.alice, team, m.id, wm.waitingForApproval.id)).status, 404);
    assert.strictEqual((await approve(U.alice, other, m.id, wm.waitingForApproval.id)).status, 404);
    assert.strictEqual((await waitFor(U.mallory, other, m.id, ['waiting_approval'])).status, 'waiting_approval');
    await call('POST', `${E(other)}/${m.id}/cancel`, { as: U.mallory });
  });

  await test('stale approval (defence in depth): a still-"pending" approval whose execution moved on is refused (409 STALE_APPROVAL)', async () => {
    if (STORE_MODE !== 'memory') return; // needs direct store manipulation
    resetNexus();
    SCRIPTS.writeS = (n) => (n === 0 ? step('write_file', { parameters: { path: 'C:/stale.txt' } }) : DONE);
    const x = await start(U.alice, 'writeS stale');
    const w = await waitFor(U.alice, team, x.id, ['waiting_approval']);
    await call('POST', `${E(team)}/${x.id}/cancel`, { as: U.alice });
    // simulate a lost "supersede" write: approval row left pending
    await execStore.transitionApproval(team.id, w.waitingForApproval.id, 'superseded', { status: 'pending' });
    const r = await approve(U.alice, team, x.id, w.waitingForApproval.id);
    assert.strictEqual(r.status, 409);
    assert.strictEqual(r.body.code, 'STALE_APPROVAL');
    assert.strictEqual(nexusCalls.length, 0);
  });
  await test('stale approval: expired approval → 410 and execution FAILED(APPROVAL_EXPIRED); nothing executed', async () => {
    resetNexus();
    SCRIPTS.writeX = (n) => (n === 0 ? step('write_file', { parameters: { path: 'C:/x.txt' } }) : DONE);
    const x = await start(U.alice, 'writeX expiring');
    const wx = await waitFor(U.alice, team, x.id, ['waiting_approval']);
    clockOffset = 16 * 60 * 1000;
    try {
      const r = await approve(U.alice, team, x.id, wx.waitingForApproval.id);
      assert.strictEqual(r.status, 410);
    } finally { clockOffset = 0; }
    const f = await waitFor(U.alice, team, x.id, ['failed']);
    assert.strictEqual(f.failure.code, 'APPROVAL_EXPIRED');
    assert.strictEqual(nexusCalls.length, 0);
  });

  await test('reject: rejected approval → FAILED(APPROVAL_REJECTED), step never executed', async () => {
    resetNexus();
    SCRIPTS.writeR = (n) => (n === 0 ? step('write_file', { parameters: { path: 'C:/r.txt' } }) : DONE);
    const x = await start(U.alice, 'writeR reject me');
    const wx = await waitFor(U.alice, team, x.id, ['waiting_approval']);
    const r = await reject(U.carol, team, x.id, wx.waitingForApproval.id, { note: 'no' });
    assert.strictEqual(r.status, 200);
    const f = await waitFor(U.alice, team, x.id, ['failed']);
    assert.strictEqual(f.failure.code, 'APPROVAL_REJECTED');
    assert.strictEqual(nexusCalls.length, 0);
  });

  await test('executor approval gate: a GREEN step refused by Nexus ApprovalGate escalates to human approval, then runs with a token', async () => {
    resetNexus();
    NEXUS = (req) => (req.approval_token
      ? { success: true, data: null, evidence: { verified: true } }
      : { success: false, error: "Approval is required before 'close_app'.", message: 'Action blocked pending user approval.' });
    SCRIPTS.closeapp = (n) => (n === 0 ? step('close_app', { parameters: { app: 'notepad' } }) : DONE);
    const x = await start(U.alice, 'closeapp close notepad');
    const w = await waitFor(U.alice, team, x.id, ['waiting_approval']);
    assert.strictEqual(w.waitingForApproval.reason, 'executor_approval_gate');
    assert.strictEqual((await approve(U.alice, team, x.id, w.waitingForApproval.id)).status, 200);
    const done = await waitFor(U.alice, team, x.id, ['completed', 'failed']);
    assert.strictEqual(done.status, 'completed', JSON.stringify(done.failure));
    const ev = await evidence(U.alice, team, x.id);
    assert.strictEqual(ev.steps[0].error.code, 'APPROVAL_REQUIRED');
    assert.strictEqual(ev.steps[1].status, 'succeeded');
  });

  await test('permission denial: executor refuses even after approval → FAILED(PERMISSION_DENIED)', async () => {
    resetNexus();
    NEXUS = () => ({ success: false, error: 'Action blocked pending user approval.' });
    SCRIPTS.writeP = (n) => (n === 0 ? step('write_file', { parameters: { path: 'C:/p.txt' } }) : DONE);
    const x = await start(U.alice, 'writeP denied');
    const w = await waitFor(U.alice, team, x.id, ['waiting_approval']);
    await approve(U.alice, team, x.id, w.waitingForApproval.id);
    const f = await waitFor(U.alice, team, x.id, ['failed']);
    assert.strictEqual(f.failure.code, 'PERMISSION_DENIED');
  });

  await test('permission system: PERMISSIONS_ENFORCED=true turns an ungranted GREEN resource into an approval gate', async () => {
    resetNexus();
    process.env.PERMISSIONS_ENFORCED = 'true';
    try {
      SCRIPTS.openps = (n) => (n === 0 ? step('open_app', { parameters: { app: 'photoshop' } }) : DONE);
      const x = await start(U.alice, 'openps open photoshop');
      const w = await waitFor(U.alice, team, x.id, ['waiting_approval']);
      assert.strictEqual(w.waitingForApproval.reason, 'permission_required');
      assert.strictEqual(w.waitingForApproval.riskTier, 'green');
      await reject(U.alice, team, x.id, w.waitingForApproval.id);
      assert.strictEqual((await waitFor(U.alice, team, x.id, ['failed'])).failure.code, 'APPROVAL_REJECTED');
      // SAFE_LIST app needs no approval
      SCRIPTS.opennp = (n) => (n === 0 ? step('open_app', { parameters: { app: 'notepad' } }) : DONE);
      const y = await start(U.alice, 'opennp open notepad');
      assert.strictEqual((await waitFor(U.alice, team, y.id, ['completed', 'failed'])).status, 'completed');
    } finally { delete process.env.PERMISSIONS_ENFORCED; }
  });

  // ==================================================================
  // Failure handling, retry, recovery, verification
  // ==================================================================
  await test('retry/recovery: idempotent step fails once, is retried once, and recovers', async () => {
    resetNexus();
    NEXUS = (req, n) => (req.action === 'open_app' && n === 1 ? { success: false, error: 'app busy' } : { success: true, data: null, evidence: { verified: true } });
    SCRIPTS.openx = (n) => (n === 0 ? step('open_app', { parameters: { app: 'excel' } }) : DONE);
    const x = await start(U.alice, 'openx open excel');
    const done = await waitFor(U.alice, team, x.id, ['completed', 'failed']);
    assert.strictEqual(done.status, 'completed');
    const ev = await evidence(U.alice, team, x.id);
    assert.strictEqual(ev.steps[0].attempts, 2);
    assert.deepStrictEqual(ev.steps[0].recovery, { strategy: 'retry_idempotent', recovered: true });
  });
  await test('recovery/replan: non-idempotent failure is NOT blindly retried — diagnosed, then the planner adapts', async () => {
    resetNexus();
    NEXUS = (req) => {
      if (req.action === 'click' && req.target.name === 'Submit') return { success: false, error: 'element not found' };
      if (req.action === 'inspect_screen_state') return { success: true, data: { dialog: 'Save changes?' } };
      return { success: true, data: null, evidence: { verified: true } };
    };
    SCRIPTS.submitform = (n, prompt) => {
      if (n === 0) return step('click', { target: { name: 'Submit' } });
      if (n === 1) {
        assert.ok(prompt.includes('state after failure'), 'planner must receive the diagnosis');
        return step('click', { target: { name: 'Submit form' } });
      }
      return DONE;
    };
    const x = await start(U.alice, 'submitform click submit');
    const done = await waitFor(U.alice, team, x.id, ['completed', 'failed']);
    assert.strictEqual(done.status, 'completed', JSON.stringify(done.failure));
    assert.strictEqual(nexusCalls.filter((c) => c.action === 'click' && c.target.name === 'Submit').length, 1, 'failed click must not be re-sent');
    const ev = await evidence(U.alice, team, x.id);
    assert.strictEqual(ev.steps[0].status, 'failed');
    assert.strictEqual(ev.steps[0].error.code, 'TOOL_FAILURE');
    assert.deepStrictEqual(ev.steps[0].recovery, { strategy: 'diagnose_then_replan', diagnosisCaptured: true });
    assert.strictEqual(ev.steps[1].status, 'succeeded');
  });
  await test('failure: bounded — 3 consecutive failures → FAILED (no infinite loop)', async () => {
    resetNexus();
    NEXUS = () => ({ success: false, error: 'element not found' });
    SCRIPTS.alwaysfail = () => step('click', { target: { name: 'Nope' } });
    const x = await start(U.alice, 'alwaysfail click forever');
    const f = await waitFor(U.alice, team, x.id, ['failed']);
    assert.strictEqual(f.failure.code, 'TOOL_FAILURE');
    assert.match(f.failure.message, /3 consecutive failures/);
    assert.strictEqual(nexusCalls.filter((c) => c.action === 'click').length, 3);
  });
  await test('failure codes: timeout, browser failure, invalid result, invalid planner step, missing data', async () => {
    const cases = [
      ['timeoutgoal', () => ({ success: false, error: 'Timed out after 30s' }), step('click', { target: { name: 'a' } }), 'TIMEOUT'],
      ['browsergoal', () => ({ success: false, error: 'page crashed' }), step('click', { platform: 'browser', target: { name: 'a' } }), 'BROWSER_FAILURE'],
      ['invalidres', () => 'garbage', step('click', { target: { name: 'a' } }), 'INVALID_RESULT'],
      ['invalidstep', () => ({ success: true }), { done: false, action: 'launch_rockets', payload: {} }, 'INVALID_STEP'],
      ['missingdata', () => ({ success: true, data: '' }), step('read_text', { platform: 'browser' }), 'MISSING_DATA'],
    ];
    for (const [tag, nexus, plannerStep, code] of cases) {
      resetNexus();
      NEXUS = nexus;
      SCRIPTS[tag] = () => plannerStep;
      const x = await start(U.alice, `${tag} case`);
      const f = await waitFor(U.alice, team, x.id, ['failed']);
      assert.strictEqual(f.failure.code, code, `${tag}: ${JSON.stringify(f.failure)}`);
    }
  });
  await test('failure: planner outage → bounded PLANNER_ERROR; clarification needed → NEEDS_INPUT', async () => {
    resetNexus();
    plannerThrows = true;
    try {
      const x = await start(U.alice, 'anything at all');
      assert.strictEqual((await waitFor(U.alice, team, x.id, ['failed'])).failure.code, 'PLANNER_ERROR');
    } finally { plannerThrows = false; }
    SCRIPTS.ask = () => ({ done: false, needs_clarification: true, question: 'Which client?' });
    const y = await start(U.alice, 'ask file the return');
    const f = await waitFor(U.alice, team, y.id, ['failed']);
    assert.strictEqual(f.failure.code, 'NEEDS_INPUT');
    assert.strictEqual(f.result.question, 'Which client?');
  });
  await test('verification failure: state-changing step reports verified=false → recorded, and completion is refused', async () => {
    resetNexus();
    NEXUS = () => ({ success: true, data: null, evidence: { verified: false } });
    SCRIPTS.writeV = (n) => (n === 0 ? step('write_file', { parameters: { path: 'C:/v.txt' } }) : DONE);
    const x = await start(U.alice, 'writeV unverifiable write');
    const w = await waitFor(U.alice, team, x.id, ['waiting_approval']);
    await approve(U.alice, team, x.id, w.waitingForApproval.id);
    const f = await waitFor(U.alice, team, x.id, ['failed', 'completed']);
    assert.strictEqual(f.status, 'failed');
    assert.strictEqual(f.failure.code, 'VERIFICATION_FAILED');
    assert.strictEqual(f.verification.status, 'failed');
    const ev = await evidence(U.alice, team, x.id);
    assert.strictEqual(ev.steps[0].verification.status, 'failed');
  });
  await test('max steps: a planner that never finishes stops at the step bound (MAX_STEPS)', async () => {
    resetNexus();
    SCRIPTS.forever = () => step('read_text', { platform: 'browser' });
    NEXUS = () => ({ success: true, data: 'x', evidence: { verified: true } });
    const x = await start(U.alice, 'forever keep reading');
    const f = await waitFor(U.alice, team, x.id, ['failed']);
    assert.strictEqual(f.failure.code, 'MAX_STEPS');
    assert.strictEqual(f.progress.stepsExecuted, OPTIONS.maxSteps);
  });

  // ==================================================================
  // Cancellation + emergency stop
  // ==================================================================
  await test('cancel: another plain member cannot cancel (403); creator can; cancelling twice → 409', async () => {
    resetNexus();
    SCRIPTS.writeC = (n) => (n === 0 ? step('write_file', { parameters: { path: 'C:/c.txt' } }) : DONE);
    const x = await start(U.bob, 'writeC cancel me');
    const w = await waitFor(U.bob, team, x.id, ['waiting_approval']);
    assert.strictEqual((await call('POST', `${E(team)}/${x.id}/cancel`, { as: U.dave })).status, 403);
    const c = await call('POST', `${E(team)}/${x.id}/cancel`, { as: U.bob });
    assert.strictEqual(c.status, 200);
    assert.strictEqual(c.body.data.status, 'cancelled');
    assert.strictEqual((await call('POST', `${E(team)}/${x.id}/cancel`, { as: U.bob })).status, 409);
    // the stale approval can no longer be used
    const a = await approve(U.bob, team, x.id, w.waitingForApproval.id);
    assert.strictEqual(a.status, 409);
    assert.strictEqual(nexusCalls.length, 0);
  });
  await test('cancel: admin can cancel a member\'s execution while a step is in flight; no further steps run', async () => {
    resetNexus();
    let release;
    nexusGate = new Promise((r) => { release = r; });
    SCRIPTS.slowtwo = (n) => (n < 2 ? step('read_text', { platform: 'browser' }) : DONE);
    NEXUS = () => ({ success: true, data: 'x', evidence: { verified: true } });
    try {
      const x = await start(U.bob, 'slowtwo two reads');
      await waitFor(U.bob, team, x.id, ['executing']);
      const c = await call('POST', `${E(team)}/${x.id}/cancel`, { as: U.carol });
      assert.strictEqual(c.status, 200);
      release();
      nexusGate = null;
      await sleep(50);
      const after = await waitFor(U.bob, team, x.id, ['cancelled']);
      assert.strictEqual(after.failure.code, 'CANCELLED');
      assert.strictEqual(nexusCalls.length, 1, 'no step may start after cancellation');
      const ev = await evidence(U.bob, team, x.id);
      assert.strictEqual(ev.steps.length, 1, 'the in-flight step is still recorded as evidence');
    } finally { nexusGate = null; }
  });
  await test('emergency stop: cancels running executions and blocks new ones until cleared', async () => {
    resetNexus();
    let release;
    nexusGate = new Promise((r) => { release = r; });
    SCRIPTS.estop = (n) => (n < 3 ? step('read_text', { platform: 'browser' }) : DONE);
    NEXUS = () => ({ success: true, data: 'x', evidence: { verified: true } });
    try {
      const x = await start(U.alice, 'estop long task');
      await waitFor(U.alice, team, x.id, ['executing']);
      taskPlanner.triggerEmergencyStop();
      release();
      nexusGate = null;
      const f = await waitFor(U.alice, team, x.id, ['cancelled']);
      assert.strictEqual(f.failure.code, 'EMERGENCY_STOP');
      const blocked = await call('POST', E(team), { as: U.alice, body: { goal: 'estop again' } });
      assert.strictEqual(blocked.status, 409);
      assert.strictEqual(blocked.body.code, 'EMERGENCY_STOP_ACTIVE');
    } finally {
      nexusGate = null;
      taskPlanner.clearEmergencyStop();
    }
  });

  // ==================================================================
  // Idempotency & concurrency
  // ==================================================================
  await test('idempotency: same key + same goal → same execution (200 replay); same key + different goal → 409', async () => {
    resetNexus();
    SCRIPTS.idem = () => DONE;
    const key = `key-${RUN}-1`;
    const a = await call('POST', E(team), { as: U.alice, body: { goal: 'idem once' }, headers: { 'idempotency-key': key } });
    assert.strictEqual(a.status, 201);
    await waitFor(U.alice, team, a.body.data.id, ['completed', 'failed']);
    const b = await call('POST', E(team), { as: U.alice, body: { goal: 'idem once' }, headers: { 'idempotency-key': key } });
    assert.strictEqual(b.status, 200);
    assert.strictEqual(b.body.data.id, a.body.data.id);
    assert.strictEqual(b.body.data.replayed, true);
    const c = await call('POST', E(team), { as: U.alice, body: { goal: 'idem DIFFERENT' }, headers: { 'idempotency-key': key } });
    assert.strictEqual(c.status, 409);
    assert.strictEqual(c.body.code, 'IDEMPOTENCY_CONFLICT');
    // the same key in ANOTHER workspace is independent
    const d = await call('POST', E(bobWs), { as: U.bob, body: { goal: 'idem once' }, headers: { 'idempotency-key': key } });
    assert.strictEqual(d.status, 201);
    assert.notStrictEqual(d.body.data.id, a.body.data.id);
    await waitFor(U.bob, bobWs, d.body.data.id, ['completed', 'failed']);
  });
  await test('duplicate requests: 6 concurrent creates with one idempotency key → exactly one execution', async () => {
    SCRIPTS.dup = () => DONE;
    const key = `key-${RUN}-2`;
    const rs = await Promise.all(Array.from({ length: 6 }, () => call('POST', E(team), { as: U.alice, body: { goal: 'dup run' }, headers: { 'idempotency-key': key } })));
    const ids = new Set(rs.filter((r) => r.status === 200 || r.status === 201).map((r) => r.body.data.id));
    assert.strictEqual(ids.size, 1, rs.map((r) => `${r.status}:${r.body.code || ''}`).join(','));
    assert.ok(rs.every((r) => [200, 201, 409].includes(r.status)));
    assert.ok(rs.filter((r) => r.status === 409).every((r) => r.body.code === 'EXECUTION_IN_PROGRESS'));
    await waitFor(U.alice, team, [...ids][0], ['completed', 'failed']);
  });
  await test('concurrency: only one active execution per workspace; other workspaces unaffected', async () => {
    resetNexus();
    SCRIPTS.hold = (n) => (n === 0 ? step('write_file', { parameters: { path: 'C:/h.txt' } }) : DONE);
    const first = await start(U.alice, 'hold the workspace');
    await waitFor(U.alice, team, first.id, ['waiting_approval']);
    const rs = await Promise.all([1, 2, 3].map((i) => call('POST', E(team), { as: U.carol, body: { goal: `hold another ${i}` } })));
    assert.ok(rs.every((r) => r.status === 409 && r.body.code === 'EXECUTION_IN_PROGRESS'));
    assert.strictEqual(rs[0].body.activeExecutionId, first.id);
    SCRIPTS.elsewhere = () => DONE;
    const e = await start(U.mallory, 'elsewhere runs fine', other);
    assert.strictEqual((await waitFor(U.mallory, other, e.id, ['completed', 'failed'])).status, 'completed');
    await call('POST', `${E(team)}/${first.id}/cancel`, { as: U.alice });
  });
  await test('server restart: an interrupted execution is failed (SERVER_RESTART), its approval is dead, the workspace is unblocked', async () => {
    resetNexus();
    SCRIPTS.restart = (n) => (n === 0 ? step('write_file', { parameters: { path: 'C:/s.txt' } }) : DONE);
    const x = await start(U.alice, 'restart pending work');
    const w = await waitFor(U.alice, team, x.id, ['waiting_approval']);
    const restarted = createAgentExecutionService({ store: execStore, options: OPTIONS, logger: { error() {} } });
    swapService(restarted);
    const r = await approve(U.alice, team, x.id, w.waitingForApproval.id);
    assert.strictEqual(r.status, 409);
    const f = await waitFor(U.alice, team, x.id, ['failed']);
    assert.strictEqual(f.failure.code, 'SERVER_RESTART');
    assert.strictEqual(nexusCalls.length, 0);
    SCRIPTS.after = () => DONE;
    const y = await start(U.alice, 'after restart works');
    assert.strictEqual((await waitFor(U.alice, team, y.id, ['completed', 'failed'])).status, 'completed');
  });

  // ==================================================================
  // Sensitive-data redaction
  // ==================================================================
  await test('redaction: secrets in goal, step payload, tool output and errors never reach storage or API responses', async () => {
    resetNexus();
    const SECRETS = ['hunter2', '4111111111111111', 'sk_live_abcdefghijklmnop1234', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NSJ9.c2lnbmF0dXJlLXZhbHVl', 'ABCDE1234F', 'S3cr3tT0k3n'];
    NEXUS = (req) => (req.action === 'read_text'
      ? { success: true, data: { page: 'Welcome', api_key: 'S3cr3tT0k3n', note: 'token=S3cr3tT0k3n card 4111 1111 1111 1111' }, evidence: { verified: true } }
      : { success: true, data: null, evidence: { verified: true } });
    SCRIPTS.gstlogin = (n) => {
      if (n === 0) return step('fill', { platform: 'browser', target: { name: 'password' }, value: 'hunter2', parameters: { password: 'hunter2', pan: 'ABCDE1234F' } });
      if (n === 1) return step('read_text', { platform: 'browser' });
      return { done: true, reason: 'Logged in; bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NSJ9.c2lnbmF0dXJlLXZhbHVl stored' };
    };
    const x = await start(U.alice, 'gstlogin portal with password: hunter2 and card 4111 1111 1111 1111 key sk_live_abcdefghijklmnop1234 PAN ABCDE1234F');
    const w = await waitFor(U.alice, team, x.id, ['waiting_approval']); // 'password' keyword → RED
    await approve(U.carol, team, x.id, w.waitingForApproval.id);
    const done = await waitFor(U.alice, team, x.id, ['completed', 'failed']);
    assert.strictEqual(done.status, 'completed', JSON.stringify(done.failure));
    const ev = await evidence(U.alice, team, x.id);
    const everything = JSON.stringify({ created: x, done, ev, list: (await call('GET', E(team), { as: U.alice })).body });
    for (const s of SECRETS) assert.ok(!everything.includes(s), `API leaked ${s}`);
    const stored = STORE_MODE === 'memory' ? JSON.stringify(execStore._dump()) : '';
    for (const s of SECRETS) assert.ok(!stored.includes(s), `storage leaked ${s}`);
    const audits = JSON.stringify(auditRows);
    for (const s of SECRETS) assert.ok(!audits.includes(s), `audit log leaked ${s}`);
    assert.ok(everything.includes('[REDACTED]'));
    // Layer 9 (stricter than Layer 3): the planner model never sees secrets,
    // firewall on or off — the goal and tool output are sanitized first.
    assert.ok(lastPrompts.length > 0);
    for (const s of SECRETS) assert.ok(!lastPrompts.some((p) => p.includes(s)), `planner prompt leaked ${s}`);
    // and the executor got the real value for the approved step
    assert.strictEqual(nexusCalls.find((c) => c.action === 'fill').value, 'hunter2');
  });
  await test('redaction unit: patterns and keys', async () => {
    const r = redact({ password: 'x', nested: { apiKey: 'y', ok: 'hello' }, text: 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz', aadhaar: '2345 6789 0123', list: ['otp=123456'] });
    assert.strictEqual(r.password, '[REDACTED]');
    assert.strictEqual(r.nested.apiKey, '[REDACTED]');
    assert.strictEqual(r.nested.ok, 'hello');
    assert.ok(!r.text.includes('abcdefghijklmnopqrstuvwxyz'));
    assert.strictEqual(r.aadhaar, '[REDACTED]');
    assert.strictEqual(r.list[0], 'otp=[REDACTED]');
    assert.strictEqual(redactString('card 4111-1111-1111-1111 ok'), 'card [REDACTED] ok');
    assert.strictEqual(redactString('order 1234567890123 id'), 'order 1234567890123 id', 'non-Luhn long numbers are kept');
    assert.ok(redactString('x'.repeat(5000)).length < 2100);
  });

  // ==================================================================
  // Voice path compatibility (frozen): taskPlanner primitives unchanged
  // ==================================================================
  await test('compat: callNexusWithTimeout without a token still sends approval_token=null (voice/run_goal path)', async () => {
    resetNexus();
    await taskPlanner.callNexusWithTimeout('open_app', { platform: 'desktop', parameters: { app: 'notepad' } });
    assert.strictEqual(nexusCalls[0].approval_token, null);
  });

  srv.close();
  console.log(`\n${passed} passed, ${failed} failed (store: ${STORE_MODE})`);
  process.exit(failed ? 1 : 0);
}

run().catch((err) => { console.error(err); process.exit(1); });
