/**
 * Security tests for the routes that sit OUTSIDE the global Firebase
 * middleware because the local voice client authenticates with
 * X-Device-Token:
 *
 *   POST /api/permissions/grant
 *   POST /api/emergency/stop | /resume
 *   GET  /api/command/goal/:planId/status
 *   POST /api/command/goal/:planId/answer
 *   (+ POST /api/command as the plan creator / PERMISSIONS_ENFORCED path)
 *
 * Drives the REAL server wiring (express.json → sanitizer →
 * middleware/auth.js → routers) and the REAL taskPlanner, riskModel,
 * taskContext, callerIdentity and security-engine/permissions over HTTP.
 * Only external services are replaced: Firebase token verification,
 * Gemini, the Nexus executor, the laptop agent socket, audit/memory
 * writes, and Supabase (a tiny in-memory table store).
 *
 * Plain Node + assert, same convention as the other suites.
 * Run: node __tests__/voiceSurface.security.test.js
 */
'use strict';

const assert = require('assert');
const Module = require('module');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const R = (...p) => require.resolve(path.join(ROOT, ...p));

// ---- environment (set BEFORE any module under test is loaded) --------
const DEVICE_SECRET = 'test-voice-device-secret';
process.env.NEXUS_VOICE_DEVICE_TOKEN = DEVICE_SECRET;
process.env.SUPABASE_URL = 'http://127.0.0.1:9';
process.env.SUPABASE_KEY = 'unused-in-tests';
process.env.NODE_ENV = 'production';
delete process.env.ALLOW_UNAUTHENTICATED_API;
delete process.env.PERMISSIONS_ENFORCED;

function fakeModule(resolvedPath, exportsObj) {
  const m = new Module(resolvedPath, null);
  m.exports = exportsObj;
  m.loaded = true;
  require.cache[resolvedPath] = m;
}

// ---- fake Supabase (in-memory tables, only the calls these modules use)
const tables = { user_permissions: [], device_tokens: [] };
let dbQueries = 0;
let dbFailNext = false;
function builder(table) {
  const state = { filters: [], op: 'select', row: null, patch: null, onConflict: null };
  const rows = () => tables[table] || (tables[table] = []);
  const match = (r) => state.filters.every(([k, v]) => r[k] === v);
  const run = () => {
    dbQueries++;
    if (dbFailNext) { dbFailNext = false; return { data: null, error: { message: 'simulated db failure' } }; }
    if (state.op === 'upsert') {
      const keys = (state.onConflict || '').split(',').filter(Boolean);
      const existing = rows().find((r) => keys.every((k) => r[k] === state.row[k]));
      if (existing) Object.assign(existing, state.row); else rows().push({ ...state.row });
      return { data: null, error: null };
    }
    if (state.op === 'update') {
      rows().filter(match).forEach((r) => Object.assign(r, state.patch));
      return { data: null, error: null };
    }
    return { data: rows().filter(match).map((r) => ({ ...r })), error: null };
  };
  const b = {
    select() { return b; },
    eq(k, v) { state.filters.push([k, v]); return b; },
    upsert(row, opts = {}) { state.op = 'upsert'; state.row = row; state.onConflict = opts.onConflict; return b; },
    update(patch) { state.op = 'update'; state.patch = patch; return b; },
    async single() {
      const r = run(); if (r.error) return r;
      return r.data.length === 1 ? { data: r.data[0], error: null } : { data: null, error: { message: 'no rows' } };
    },
    async maybeSingle() {
      const r = run(); if (r.error) return r;
      return { data: r.data[0] || null, error: null };
    },
    then(resolve, reject) { try { resolve(run()); } catch (e) { reject(e); } },
  };
  return b;
}
fakeModule(require.resolve('@supabase/supabase-js'), { createClient: () => ({ from: (t) => builder(t) }) });

// ---- fake Firebase (tokens look like `tok|<uid>`) ---------------------
let firebaseVerifyCalls = 0;
fakeModule(R('config', 'firebaseAdmin.js'), () => ({
  auth: () => ({
    async verifyIdToken(token) {
      firebaseVerifyCalls++;
      const [kind, uid] = String(token).split('|');
      if (kind !== 'tok' || !uid) throw new Error('invalid token');
      return { uid };
    },
  }),
}));

const logged = [];
const quiet = { info() {}, warn() {}, error() {}, debug() {} };
fakeModule(R('services', 'logger.js'), quiet);
fakeModule(R('middleware', 'logger.js'), (req, res, next) => next());
fakeModule(R('memory-hooks', 'memoryHooks.js'), { logAction: async (userId, action) => { logged.push({ userId, action }); } });
fakeModule(R('security-engine', 'auditLog.js'), { appendAuditLog: async () => {} });
fakeModule(R('agentSocket.js'), { sendCommandToAgent: async () => ({ success: true }), attachAgentSocket() {} });
fakeModule(R('ai-tasks', 'aiTasks.js'), {});
fakeModule(R('productivity', 'productivity.js'), {});
fakeModule(R('productivity', 'calendar.js'), {});
fakeModule(R('services', 'ai.js'), { askAI: async () => 'chat' });
fakeModule(R('backend-routing', 'fastPath.js'), { tryFastPath: () => null });

let nexusCalls = 0;
fakeModule(R('backend-routing', 'nexusBridge.js'), {
  sendCommandToNexus: async () => { nexusCalls++; return { success: true, evidence: { verified: true }, data: null }; },
});

// intent: "run:<goal>" → run_goal ; "open:<app>" → open_app action
fakeModule(R('backend-routing', 'intentRouter.js'), {
  NEXUS_ACTIONS: ['open_app', 'delete_file', 'click'],
  SAFE_TO_REPEAT_ACTIONS: [],
  classifyIntent: async (message) => {
    if (message.startsWith('run:')) return { type: 'action', action: 'run_goal', payload: { goal: message.slice(4) } };
    if (message.startsWith('open:')) {
      return { type: 'action', action: 'open_app', payload: { platform: 'desktop', parameters: { app: message.slice(5) }, target: {}, value: null } };
    }
    return { type: 'chat' };
  },
});

// Planner brain. Goal keyword decides the next step:
//   goal-pause   → RED step (delete_file) → plan pauses for approval
//   goal-slow    → never answers until released → plan stays 'running'
//   goal-clarify → asks a question until an answer is present
let generateCalls = 0;
let releaseSlow;
const slowGate = new Promise((r) => { releaseSlow = r; });
const reply = (obj) => ({ response: { text: () => JSON.stringify(obj) } });
fakeModule(R('backend-routing', 'geminiClient.js'), {
  generateContent: async (prompt) => {
    generateCalls++;
    if (prompt.includes('goal-slow')) { await slowGate; return reply({ done: true, reason: 'ok' }); }
    if (prompt.includes('goal-pause')) {
      return reply({ done: false, action: 'delete_file', payload: { platform: 'desktop', parameters: { path: 'C:/x.txt' } }, reason: 'r' });
    }
    if (prompt.includes('goal-clarify')) {
      if (prompt.includes('blue folder')) return reply({ done: true, reason: 'answered' });
      return reply({ done: false, needs_clarification: true, question: 'Which folder?' });
    }
    return reply({ done: true, reason: 'ok' });
  },
});

// ---- real modules under test ------------------------------------------
const express = require('express');
const authenticateFirebaseUser = require(R('middleware', 'auth.js'));
const sanitizeInput = require(R('middleware', 'sanitizer.js'));
const commandRoute = require(R('backend-routing', 'commandRoute.js'));
const permissionsRoute = require(R('routes', 'permissions.js'));
const emergencyStopRoute = require(R('routes', 'emergencyStop.js'));
const taskPlanner = require(R('backend-routing', 'taskPlanner.js'));
const permissions = require(R('security-engine', 'permissions.js'));

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(sanitizeInput);
  app.use('/api', authenticateFirebaseUser); // same order as server.js
  app.use('/api/command', commandRoute);
  app.use('/api/permissions', permissionsRoute);
  app.use('/api/emergency', emergencyStopRoute);
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

const VOICE = { 'x-device-token': DEVICE_SECRET };
const WRONG_DEVICE = { 'x-device-token': 'not-the-secret' };
const fb = (uid) => ({ authorization: `Bearer tok|${uid}` });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function run() {
  const srv = await new Promise((resolve) => { const s = buildApp().listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${srv.address().port}`;
  const call = async (method, url, { headers = {}, body } = {}) => {
    const res = await fetch(base + url, {
      method,
      headers: { 'content-type': 'application/json', ...headers },
      body: body && method !== 'GET' ? JSON.stringify(body) : undefined,
    });
    let json = null;
    try { json = await res.json(); } catch { /* none */ }
    return { status: res.status, body: json };
  };

  async function waitForStatus(planId, headers, wanted, tries = 100) {
    for (let i = 0; i < tries; i++) {
      const r = await call('GET', `/api/command/goal/${planId}/status`, { headers });
      if (r.status === 200 && r.body.status === wanted) return r.body;
      await sleep(10);
    }
    throw new Error(`plan ${planId} never reached ${wanted}`);
  }

  async function startPlan(headers, goal, deviceId) {
    const r = await call('POST', '/api/command', { headers, body: { message: `run:${goal}`, deviceId, commandId: `c-${Math.random()}` } });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.type, 'plan_started');
    return r.body.planId;
  }

  // Routes under test (planId filled in where needed)
  const routesFor = (planId) => [
    ['POST', '/api/permissions/grant', { resource: 'C:/secret.txt' }],
    ['POST', '/api/permissions/grant', { resource: `plan:${planId}` }],
    ['POST', '/api/emergency/stop'],
    ['POST', '/api/emergency/resume'],
    ['GET', `/api/command/goal/${planId}/status`],
    ['POST', `/api/command/goal/${planId}/answer`, { answer: 'x' }],
  ];

  // ------------------------------------------------------------------
  // Authentication on every changed route
  // ------------------------------------------------------------------
  let voicePaused = await startPlan(VOICE, 'goal-pause A', 'LAPTOP-1');
  await waitForStatus(voicePaused, VOICE, 'paused');

  await test('auth: every changed route → 401 with no credentials (production)', async () => {
    for (const [m, u, body] of routesFor(voicePaused)) {
      const r = await call(m, u, { body });
      assert.strictEqual(r.status, 401, `${m} ${u} → ${r.status}`);
    }
  });
  await test('auth: every changed route → 401 with a wrong device token', async () => {
    for (const [m, u, body] of routesFor(voicePaused)) {
      const r = await call(m, u, { headers: WRONG_DEVICE, body });
      assert.strictEqual(r.status, 401, `${m} ${u} → ${r.status}`);
    }
  });
  await test('auth: every changed route → 401 with an invalid bearer token', async () => {
    for (const [m, u, body] of routesFor(voicePaused)) {
      const r = await call(m, u, { headers: { authorization: 'Bearer garbage' }, body });
      assert.strictEqual(r.status, 401, `${m} ${u} → ${r.status}`);
    }
  });
  await test('auth: ALLOW_UNAUTHENTICATED_API=true is IGNORED when NODE_ENV=production', async () => {
    process.env.ALLOW_UNAUTHENTICATED_API = 'true';
    try {
      for (const [m, u, body] of routesFor(voicePaused)) {
        const r = await call(m, u, { body });
        assert.strictEqual(r.status, 401, `${m} ${u} → ${r.status}`);
      }
    } finally { delete process.env.ALLOW_UNAUTHENTICATED_API; }
  });
  await test('auth: rejected calls changed nothing (plan still paused, no stop active, no grant rows)', async () => {
    const s = await call('GET', `/api/command/goal/${voicePaused}/status`, { headers: VOICE });
    assert.strictEqual(s.body.status, 'paused');
    assert.strictEqual(tables.user_permissions.length, 0);
    const p = await startPlan(VOICE, 'plain goal', 'LAPTOP-1'); // would be refused if a stop had been triggered
    assert.ok(p);
  });
  await test('auth: dev bypass still works in development (unchanged dev behaviour) as test-user-123', async () => {
    process.env.NODE_ENV = 'development';
    process.env.ALLOW_UNAUTHENTICATED_API = 'true';
    try {
      const stop = await call('POST', '/api/emergency/stop');
      assert.strictEqual(stop.status, 200);
      const resume = await call('POST', '/api/emergency/resume');
      assert.strictEqual(resume.status, 200);
      const g = await call('POST', '/api/permissions/grant', { body: { resource: 'dev-resource' } });
      assert.strictEqual(g.status, 200);
      assert.strictEqual(g.body.userId, 'test-user-123');
      // the dev identity cannot touch the voice device's plan
      const s = await call('GET', `/api/command/goal/${voicePaused}/status`);
      assert.strictEqual(s.status, 404);
    } finally {
      process.env.NODE_ENV = 'production';
      delete process.env.ALLOW_UNAUTHENTICATED_API;
      tables.user_permissions.length = 0;
    }
  });
  // The dev-bypass test above triggered an emergency stop, which (by
  // existing design) clears every in-memory plan — start a fresh one.
  voicePaused = await startPlan(VOICE, 'goal-pause A2', 'LAPTOP-1');
  await waitForStatus(voicePaused, VOICE, 'paused');

  // ------------------------------------------------------------------
  // Valid voice-device flow (exactly what voice_controller.py sends)
  // ------------------------------------------------------------------
  await test('voice: device-token flow never calls Firebase (hot path unchanged)', async () => {
    const before = firebaseVerifyCalls;
    await call('GET', `/api/command/goal/${voicePaused}/status`, { headers: VOICE });
    await call('POST', '/api/command', { headers: VOICE, body: { message: 'hello', deviceId: 'LAPTOP-1' } });
    assert.strictEqual(firebaseVerifyCalls, before);
  });
  await test('voice: status poll WITHOUT deviceId sees the plan created WITH deviceId (same principal)', async () => {
    const s = await call('GET', `/api/command/goal/${voicePaused}/status`, { headers: VOICE });
    assert.strictEqual(s.status, 200);
    assert.strictEqual(s.body.status, 'paused');
    assert.strictEqual(s.body.pendingStep.action, 'delete_file');
  });

  // ------------------------------------------------------------------
  // Wrong user / wrong device-class access to plans
  // ------------------------------------------------------------------
  await test('ownership: another Firebase user gets 404 on status / answer / resume of the voice plan', async () => {
    const s = await call('GET', `/api/command/goal/${voicePaused}/status`, { headers: fb('bob') });
    assert.strictEqual(s.status, 404);
    const a = await call('POST', `/api/command/goal/${voicePaused}/answer`, { headers: fb('bob'), body: { answer: 'yes' } });
    assert.strictEqual(a.status, 404);
    const g = await call('POST', '/api/permissions/grant', { headers: fb('bob'), body: { resource: `plan:${voicePaused}` } });
    assert.strictEqual(g.status, 404);
    const still = await call('GET', `/api/command/goal/${voicePaused}/status`, { headers: VOICE });
    assert.strictEqual(still.body.status, 'paused', 'foreign approval must not resume the plan');
  });
  await test('ownership: foreign plan and unknown plan return the identical 404 body (no enumeration)', async () => {
    const foreign = await call('GET', `/api/command/goal/${voicePaused}/status`, { headers: fb('bob') });
    const unknown = await call('GET', '/api/command/goal/plan_0123456789abcdef0123456789abcdef/status', { headers: fb('bob') });
    assert.strictEqual(unknown.status, 404);
    assert.deepStrictEqual(foreign.body, unknown.body);
  });

  let alicePlan;
  await test('ownership: Firebase user\'s plan is invisible to other users AND to the voice device', async () => {
    alicePlan = await startPlan(fb('alice'), 'goal-clarify B');
    await waitForStatus(alicePlan, fb('alice'), 'awaiting_clarification');
    for (const h of [fb('bob'), VOICE]) {
      assert.strictEqual((await call('GET', `/api/command/goal/${alicePlan}/status`, { headers: h })).status, 404);
    }
  });
  await test('answer: non-owner answer rejected and does not steer the plan; owner answer works and is logged under the owner', async () => {
    const bad = await call('POST', `/api/command/goal/${alicePlan}/answer`, { headers: fb('bob'), body: { answer: 'the blue folder' } });
    assert.strictEqual(bad.status, 404);
    assert.strictEqual((await call('GET', `/api/command/goal/${alicePlan}/status`, { headers: fb('alice') })).body.status, 'awaiting_clarification');
    assert.ok(!logged.some((l) => l.action === 'goal_clarification_answer'), 'rejected answer must not be logged');
    const ok = await call('POST', `/api/command/goal/${alicePlan}/answer`, { headers: fb('alice'), body: { answer: 'the blue folder' } });
    assert.strictEqual(ok.status, 200);
    await waitForStatus(alicePlan, fb('alice'), 'completed');
    const entry = logged.find((l) => l.action === 'goal_clarification_answer');
    assert.strictEqual(entry.userId, 'alice');
    assert.ok(!logged.some((l) => l.userId === 'test-user-123'), 'no production log entry may use test-user-123');
  });
  await test('answer: userId in the request body cannot spoof the logged identity', async () => {
    const p = await startPlan(fb('carol'), 'goal-clarify C');
    await waitForStatus(p, fb('carol'), 'awaiting_clarification');
    await call('POST', `/api/command/goal/${p}/answer`, { headers: fb('carol'), body: { answer: 'the blue folder', userId: 'mallory' } });
    const entries = logged.filter((l) => l.action === 'goal_clarification_answer');
    assert.strictEqual(entries[entries.length - 1].userId, 'carol');
  });

  // ------------------------------------------------------------------
  // Paused vs running resume
  // ------------------------------------------------------------------
  await test('resume: owner (voice, no deviceId — as voice_controller.py sends it) resumes a PAUSED plan', async () => {
    const g = await call('POST', '/api/permissions/grant', { headers: VOICE, body: { resource: `plan:${voicePaused}` } });
    assert.strictEqual(g.status, 200);
    assert.strictEqual(g.body.type, 'plan_started');
    assert.strictEqual(g.body.planId, voicePaused);
  });
  await test('resume: a RUNNING plan cannot be "resumed" (409) and no second planner loop starts', async () => {
    const p = await startPlan(fb('dave'), 'goal-slow D');
    await sleep(30);
    const s = await call('GET', `/api/command/goal/${p}/status`, { headers: fb('dave') });
    assert.strictEqual(s.body.status, 'running');
    const callsBefore = generateCalls;
    const g = await call('POST', '/api/permissions/grant', { headers: fb('dave'), body: { resource: `plan:${p}` } });
    assert.strictEqual(g.status, 409);
    assert.strictEqual(g.body.code, 'PLAN_NOT_PAUSED');
    await sleep(30);
    assert.strictEqual(generateCalls, callsBefore, 'rejected resume must not start another runLoop');
    releaseSlow();
    await waitForStatus(p, fb('dave'), 'completed');
  });
  await test('resume: a COMPLETED plan cannot be resumed (409)', async () => {
    const p = await startPlan(fb('erin'), 'plain goal E');
    await waitForStatus(p, fb('erin'), 'completed');
    const g = await call('POST', '/api/permissions/grant', { headers: fb('erin'), body: { resource: `plan:${p}` } });
    assert.strictEqual(g.status, 409);
  });
  await test('resume: direct taskPlanner call without a caller id fails closed', async () => {
    const p = await startPlan(fb('frank'), 'goal-pause F');
    await waitForStatus(p, fb('frank'), 'paused');
    assert.strictEqual(taskPlanner.resumePlanAsync(p).code, 'PLAN_NOT_FOUND');
    assert.strictEqual(taskPlanner.getPlanStatus(p).code, 'PLAN_NOT_FOUND');
    assert.strictEqual(taskPlanner.submitClarification(p, 'x').code, 'PLAN_NOT_FOUND');
  });

  // ------------------------------------------------------------------
  // Secure plan ids
  // ------------------------------------------------------------------
  await test('plan ids: 128-bit hex from crypto (format + 200 unique + no Math.random in makePlanId)', async () => {
    const ids = new Set();
    for (let i = 0; i < 200; i++) {
      const id = await startPlan(fb('gina'), `plain goal ${i}`);
      assert.match(id, /^plan_[0-9a-f]{32}$/);
      ids.add(id);
    }
    assert.strictEqual(ids.size, 200);
    const src = require('fs').readFileSync(R('backend-routing', 'taskPlanner.js'), 'utf8');
    const fn = src.slice(src.indexOf('function makePlanId'), src.indexOf('}', src.indexOf('function makePlanId')));
    assert.ok(fn.includes('crypto.randomBytes(16)') && !fn.includes('Math.random'), fn);
  });

  // ------------------------------------------------------------------
  // Emergency stop / resume
  // ------------------------------------------------------------------
  await test('emergency: voice device can stop and resume (Ctrl+M / Ctrl+N flow)', async () => {
    const stop = await call('POST', '/api/emergency/stop', { headers: VOICE });
    assert.strictEqual(stop.status, 200);
    assert.strictEqual(stop.body.stopped, true);
    const blocked = await call('POST', '/api/command', { headers: VOICE, body: { message: 'run:plain goal', deviceId: 'LAPTOP-1' } });
    assert.strictEqual(blocked.body.type, 'plan_error', 'stop must still block new plans');
    const resume = await call('POST', '/api/emergency/resume', { headers: VOICE });
    assert.strictEqual(resume.status, 200);
    const ok = await call('POST', '/api/command', { headers: VOICE, body: { message: 'run:plain goal', deviceId: 'LAPTOP-1' } });
    assert.strictEqual(ok.body.type, 'plan_started');
  });
  await test('emergency: authenticated Firebase user can stop/resume', async () => {
    assert.strictEqual((await call('POST', '/api/emergency/stop', { headers: fb('alice') })).status, 200);
    assert.strictEqual((await call('POST', '/api/emergency/resume', { headers: fb('alice') })).status, 200);
  });
  await test('emergency: unauthenticated resume cannot clear an active stop', async () => {
    await call('POST', '/api/emergency/stop', { headers: VOICE });
    assert.strictEqual((await call('POST', '/api/emergency/resume')).status, 401);
    const blocked = await call('POST', '/api/command', { headers: VOICE, body: { message: 'run:plain goal', deviceId: 'LAPTOP-1' } });
    assert.strictEqual(blocked.body.type, 'plan_error');
    await call('POST', '/api/emergency/resume', { headers: VOICE });
  });

  // ------------------------------------------------------------------
  // Non-plan grants: real identity, never test-user-123 in production
  // ------------------------------------------------------------------
  await test('grant: voice grant is stored for the voice principal, Firebase grant for the uid; never test-user-123', async () => {
    tables.user_permissions.length = 0;
    const v = await call('POST', '/api/permissions/grant', { headers: VOICE, body: { resource: 'C:/reports' } });
    assert.strictEqual(v.status, 200);
    const f = await call('POST', '/api/permissions/grant', { headers: fb('alice'), body: { resource: 'https://example.com' } });
    assert.strictEqual(f.status, 200);
    const owners = tables.user_permissions.map((r) => `${r.user_id}=${r.resource_name}`).sort();
    assert.deepStrictEqual(owners, ['alice=https://example.com', 'voice-device=C:/reports']);
  });
  await test('grant: missing/invalid resource → 400', async () => {
    for (const body of [{}, { resource: '' }, { resource: 42 }]) {
      assert.strictEqual((await call('POST', '/api/permissions/grant', { headers: VOICE, body })).status, 400);
    }
  });

  // ------------------------------------------------------------------
  // PERMISSIONS_ENFORCED switch
  // ------------------------------------------------------------------
  await test('PERMISSIONS_ENFORCED unset: behaviour unchanged — any resource permitted, no DB lookup', async () => {
    const q = dbQueries;
    assert.strictEqual(await permissions.isPermitted('voice-device:LAPTOP-1', 'C:/anything'), true);
    assert.strictEqual(await permissions.isPermitted('bob', 'https://unknown.example'), true);
    assert.strictEqual(dbQueries, q, 'disabled gate must not add a DB round trip to the voice path');
    const before = nexusCalls;
    const r = await call('POST', '/api/command', { headers: VOICE, body: { message: 'open:photoshop', deviceId: 'LAPTOP-1' } });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.type, 'nexus_action');
    assert.strictEqual(nexusCalls, before + 1);
  });
  await test('PERMISSIONS_ENFORCED=true: gate works end-to-end with the voice grant flow', async () => {
    process.env.PERMISSIONS_ENFORCED = 'true';
    try {
      tables.user_permissions.length = 0;
      assert.strictEqual(await permissions.isPermitted('voice-device:LAPTOP-1', 'notepad'), true, 'SAFE_LIST');
      const before = nexusCalls;
      const denied = await call('POST', '/api/command', { headers: VOICE, body: { message: 'open:photoshop', deviceId: 'LAPTOP-1' } });
      assert.strictEqual(denied.status, 403);
      assert.strictEqual(denied.body.type, 'permission_required');
      assert.strictEqual(nexusCalls, before);
      // voice_controller.py grants WITHOUT deviceId
      const g = await call('POST', '/api/permissions/grant', { headers: VOICE, body: { resource: denied.body.resource } });
      assert.strictEqual(g.status, 200);
      const allowed = await call('POST', '/api/command', { headers: VOICE, body: { message: 'open:photoshop', deviceId: 'LAPTOP-1' } });
      assert.strictEqual(allowed.status, 200);
      assert.strictEqual(nexusCalls, before + 1);
      // a different principal does not inherit the voice device's grant
      assert.strictEqual(await permissions.isPermitted('bob', 'photoshop'), false);
    } finally { delete process.env.PERMISSIONS_ENFORCED; }
  });
  await test('PERMISSIONS_ENFORCED=true: DB failure fails closed', async () => {
    process.env.PERMISSIONS_ENFORCED = 'true';
    try {
      dbFailNext = true;
      assert.strictEqual(await permissions.isPermitted('alice', 'https://example.com'), false);
    } finally { delete process.env.PERMISSIONS_ENFORCED; dbFailNext = false; }
  });
  await test('PERMISSIONS_ENFORCED: production boot warns loudly when disabled, silent when enabled or not production', async () => {
    const probe = (env) => spawnSync(process.execPath, ['-e', "require('./security-engine/permissions')"], {
      cwd: ROOT, encoding: 'utf8',
      env: { PATH: process.env.PATH, SUPABASE_URL: 'http://127.0.0.1:9', SUPABASE_KEY: 'x', ...env },
    });
    const off = probe({ NODE_ENV: 'production' });
    assert.strictEqual(off.status, 0, off.stderr);
    assert.match(off.stdout + off.stderr, /SECURITY WARNING: PERMISSIONS_ENFORCED/);
    const on = probe({ NODE_ENV: 'production', PERMISSIONS_ENFORCED: 'true' });
    assert.doesNotMatch(on.stdout + on.stderr, /SECURITY WARNING/);
    const dev = probe({ NODE_ENV: 'development' });
    assert.doesNotMatch(dev.stdout + dev.stderr, /SECURITY WARNING/);
  });

  srv.close();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

run().catch((err) => { console.error(err); process.exit(1); });
