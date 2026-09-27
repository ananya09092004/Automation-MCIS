/**
 * Layer 2 — workspace data scoping & collaboration: tenant-isolation tests.
 *
 * Drives the REAL routes (chat, memory, goals, notifications, executions,
 * tasks, permissions, audit, workspaces) behind the REAL middleware chain
 * (express.json → sanitizer → auth.js → workspaceDataScope / Layer 1
 * workspaceContext), and the REAL data-access modules (services/database.js,
 * services/memory.js, memoryManager, goalBreakdownService, permissions,
 * auditLog, workspace/execution/task services).
 *
 * Replaced (external services only): Firebase token verification, the
 * embedding HTTP API (deterministic local embeddings), Groq / chat AI /
 * welcome-message LLM calls, the Nexus executor + Gemini planner (Layer 3),
 * and — in the default memory mode — Supabase (a small PostgREST emulator,
 * __tests__/support/fakeSupabase.js).
 *
 *   WORKSPACE_TEST_STORE=supabase  runs the same suite against a real
 *   Postgres (+pgvector) behind PostgREST with all migrations applied
 *   (SUPABASE_URL / SUPABASE_KEY = service_role). NEVER point it at production.
 *
 * Run: node __tests__/workspaceDataScoping.test.js
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
process.env.GROQ_API_KEY = process.env.GROQ_API_KEY || 'test-not-real';
process.env.GEMINI_API_KEY = process.env.GEMINI_API_KEY || 'test-not-real';
delete process.env.COHERE_API_KEY;
delete process.env.ALLOW_UNAUTHENTICATED_API;
delete process.env.PERMISSIONS_ENFORCED;
delete process.env.WORKSPACE_DATA_SCOPING;

function fakeModule(resolvedPath, exportsObj) {
  const m = new Module(resolvedPath, null);
  m.exports = exportsObj;
  m.loaded = true;
  require.cache[resolvedPath] = m;
}

// ---- storage -------------------------------------------------------------
const { createFakeSupabase } = require('./support/fakeSupabase');
let fake = null;
if (STORE_MODE === 'memory') {
  fake = createFakeSupabase({
    unique: { chats: ['id'], user_permissions: ['user_id,resource_name'] },
    serialTables: ['conversations', 'user_memories', 'memory_vectors', 'goal_updates', 'notifications', 'goal_reviews', 'daily_execution_plan'],
  });
  fakeModule(require.resolve('@supabase/supabase-js'), { createClient: () => fake.client });
}

// ---- deterministic embeddings (replaces the Pinecone/Cohere HTTP API) -----
const DIMS = 16;
function embed(text) {
  const v = new Array(DIMS).fill(0);
  for (const w of String(text).toLowerCase().match(/[a-z0-9]+/g) || []) {
    const h = crypto.createHash('md5').update(w).digest();
    v[h[0] % DIMS] += 1;
  }
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / n);
}
const realAxios = require('axios');
fakeModule(require.resolve('axios'), Object.assign(Object.create(realAxios), {
  post: async (url, body) => {
    if (String(url).includes('pinecone.io/embed')) return { data: { data: [{ values: embed(body.inputs[0].text) }] } };
    throw new Error(`unexpected outbound HTTP in test: ${url}`);
  },
}));

// chat.js applies an existing 20 req/min per-IP limiter; every test request
// comes from 127.0.0.1, so it is replaced with a pass-through here only.
fakeModule(require.resolve('express-rate-limit'), Object.assign(() => (req, res, next) => next(), { rateLimit: () => (req, res, next) => next() }));

// ---- LLMs --------------------------------------------------------------
class FakeGroq {
  constructor() {
    this.chat = { completions: { create: async () => ({ choices: [{ message: { content: '{"phases":[],"weekly_tasks":[],"daily_tasks_sample":[],"milestones":[]}' } }] }) } };
  }
}
fakeModule(require.resolve('groq-sdk'), FakeGroq);
fakeModule(R('services', 'ai.js'), { askAI: async () => 'ok', askAIStream: async () => (async function* () {})() });
fakeModule(R('services', 'summaryManager.js'), { generateWelcomeMessage: async () => 'Welcome back', generateChatSummary: async () => null });
fakeModule(R('services', 'logger.js'), { info() {}, warn() {}, error() {}, debug() {} });
fakeModule(R('config', 'firebaseAdmin.js'), () => ({
  auth: () => ({
    async verifyIdToken(token) {
      const [kind, uid] = String(token).split('|');
      if (kind !== 'tok' || !uid) throw new Error('invalid token');
      return { uid, email: `${uid}@example.com`, email_verified: true };
    },
  }),
}));
// Layer 3 externals
let NEXUS = () => ({ success: true, data: 'ok', evidence: { verified: true } });
fakeModule(R('backend-routing', 'nexusBridge.js'), { sendCommandToNexus: async (req) => NEXUS(req) });
const PLAN = {};
fakeModule(R('backend-routing', 'geminiClient.js'), {
  generateContent: async (prompt) => {
    const goal = (prompt.match(/The user's goal: "([\s\S]*?)"\n/) || [])[1] || '';
    const tag = goal.split(/\s+/)[0];
    const section = prompt.split('Steps executed so far:\n')[1].split('\n\nClarifications')[0];
    const n = (section.match(/^\d+\. /gm) || []).length;
    const reply = PLAN[tag] ? PLAN[tag](n) : { done: true, reason: 'done' };
    return { response: { text: () => JSON.stringify(reply) } };
  },
});

// ---- real modules --------------------------------------------------------
const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const authenticateFirebaseUser = require(R('middleware', 'auth.js'));
const sanitizeInput = require(R('middleware', 'sanitizer.js'));
const { workspaceDataScope } = require(R('middleware', 'workspaceDataScope.js'));
const { runWithScope } = require(R('services', 'workspaceScope.js'));
const memorySvc = require(R('services', 'memory.js'));
const memoryManager = require(R('services', 'memoryManager.js'));
const permissions = require(R('security-engine', 'permissions.js'));
const auditLog = require(R('security-engine', 'auditLog.js'));
const { createWorkspaceService } = require(R('services', 'workspaceService.js'));
const { createAgentExecutionService } = require(R('services', 'agentExecution', 'executionService.js'));
const { createExecutionsRouter } = require(R('routes', 'executions.js'));
const { createWorkspaceDataRouters } = require(R('routes', 'workspaceData.js'));
const { createWorkspaceDataService } = require(R('services', 'workspaceData', 'workspaceDataService.js'));
const { createWorkspacesRouter } = require(R('routes', 'workspaces.js'));
const chatRoute = require(R('routes', 'chat.js'));
const memoryRoute = require(R('routes', 'memory.js'));
const goalsRoute = require(R('routes', 'goals.js'));
const notificationsRoute = require(R('routes', 'notifications.js'));

let wsStore; let execStore; let dataStore;
if (STORE_MODE === 'supabase') {
  wsStore = require(R('services', 'workspaceStore.js')).createSupabaseWorkspaceStore();
  execStore = require(R('services', 'agentExecution', 'executionStore.js')).createSupabaseExecutionStore();
  dataStore = require(R('services', 'workspaceData', 'workspaceDataStore.js')).createSupabaseWorkspaceDataStore();
} else {
  wsStore = require('./support/memoryWorkspaceStore').createMemoryWorkspaceStore();
  execStore = require('./support/memoryExecutionStore').createMemoryExecutionStore();
  dataStore = require('./support/memoryWorkspaceDataStore').createMemoryWorkspaceDataStore({
    taskHasExecutions: async (ws, taskId) => (await execStore.listExecutionsForTask(ws, taskId)).length > 0,
  });
  // permissions.isPermitted(…, workspaceId) reads workspace_permission_grants via supabase:
  Object.defineProperty(fake.tables, 'workspace_permission_grants', { get: () => dataStore._dump().grants });
}
const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY); // raw access for seeding/asserts

const wsService = createWorkspaceService(wsStore, { requireVerifiedEmail: true });
const execService = createAgentExecutionService({ store: execStore, options: { retryDelayMs: 0, maxSteps: 5 }, logger: { error() {} } });
const dataService = createWorkspaceDataService({
  store: dataStore, workspaceService: wsService, executionService: execService,
  appendAuditLog: auditLog.appendAuditLog, getWorkspaceAuditLog: auditLog.getWorkspaceAuditLog,
});
const l2Routers = createWorkspaceDataRouters({ workspaceService: wsService, executionService: execService, dataService });

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(sanitizeInput);
  app.use('/api', authenticateFirebaseUser);
  app.use(['/api/chat', '/api/memory', '/api/goals'], workspaceDataScope(wsService));
  app.use('/api/chat', chatRoute);
  app.use('/api/memory', memoryRoute);
  app.use('/api/goals', goalsRoute);
  app.use('/api/notifications', notificationsRoute);
  app.use('/api/workspaces/:workspaceId/executions', createExecutionsRouter({ workspaceService: wsService, executionService: execService }));
  app.use('/api/workspaces/:workspaceId/tasks', l2Routers.tasks);
  app.use('/api/workspaces/:workspaceId/permissions', l2Routers.permissions);
  app.use('/api/workspaces/:workspaceId/audit', l2Routers.audit);
  app.use('/api/workspaces', createWorkspacesRouter({ service: wsService }));
  return app;
}

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`PASS: ${name}`); passed++; } catch (err) { console.error(`FAIL: ${name}`); console.error(`  ${err.stack || err.message}`); failed++; }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const RUN = crypto.randomBytes(3).toString('hex');
const U = Object.fromEntries(['alice', 'bob', 'carol', 'dave', 'mallory'].map((n) => [n, { uid: `${n}_${RUN}`, email: `${n}_${RUN}@example.com`, emailVerified: true }]));

async function run() {
  console.log(`# workspace data scoping tests — store: ${STORE_MODE}`);
  const srv = await new Promise((resolve) => { const s = buildApp().listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${srv.address().port}`;
  const call = async (method, url, { as, ws, headers = {}, body, raw = false } = {}) => {
    const h = { 'content-type': 'application/json', ...headers };
    if (as) h.authorization = `Bearer tok|${as.uid}`;
    if (ws) h['x-workspace-id'] = ws.id;
    const res = await fetch(base + url, { method, headers: h, body: body && method !== 'GET' ? JSON.stringify(body) : undefined });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* SSE / text */ }
    return { status: res.status, body: json, text };
  };

  // ---- workspaces: A (alice owner, carol admin, bob + dave members), B (mallory owner, dave member)
  const A = await wsService.createWorkspace(U.alice, { name: 'Acme Tax' });
  const B = await wsService.createWorkspace(U.mallory, { name: 'Other Co' });
  const invite = async (ws, owner, u, role) => {
    const inv = await wsService.createInvitation({ workspace: ws, role: 'owner', userId: owner.uid }, { email: u.email, role });
    await wsService.acceptInvitation(u, { token: inv.token });
  };
  await invite(A, U.alice, U.carol, 'admin');
  await invite(A, U.alice, U.bob, 'member');
  await invite(A, U.alice, U.dave, 'member');
  await invite(B, U.mallory, U.dave, 'member');
  const alicePersonal = await wsService.ensurePersonalWorkspace(U.alice.uid);

  // ---- legacy (pre-Layer-2) rows: workspace_id NULL, as the migration leaves orphan-free rows
  // before backfill and as the voice pipeline keeps writing them.
  const legacyChat = `legacy-${RUN}`;
  await db.from('chats').insert([{ id: legacyChat, user_id: U.alice.uid, title: 'Old chat', created_at: new Date().toISOString() }]);
  await db.from('conversations').insert([{ user_id: U.alice.uid, message: 'legacy hello', response: 'legacy reply', chat_id: legacyChat }]);
  await db.from('goals').insert([{ user_id: U.alice.uid, title: 'Legacy goal', status: 'active', progress: 0 }]);

  // ================================================================
  // Chat sessions & messages
  // ================================================================
  await test('personal compat: existing (legacy, unscoped) chats & messages still work with no workspace header', async () => {
    const list = await call('GET', `/api/chat/chats/${U.alice.uid}`, { as: U.alice });
    assert.strictEqual(list.status, 200);
    assert.ok(list.body.chats.some((c) => c.id === legacyChat));
    const msgs = await call('GET', `/api/chat/messages/${U.alice.uid}/${legacyChat}`, { as: U.alice });
    assert.strictEqual(msgs.status, 200);
    assert.strictEqual(msgs.body.messages[0].message, 'legacy hello');
  });

  const chatA = `chatA-${RUN}`;
  const chatB = `chatB-${RUN}`;
  await test('sessions: a chat created in workspace A belongs to A (not personal, not B)', async () => {
    const c = await call('POST', '/api/chat/chats', { as: U.dave, ws: A, body: { chatId: chatA, userId: U.dave.uid, title: 'A chat' } });
    assert.strictEqual(c.status, 200);
    const c2 = await call('POST', '/api/chat/chats', { as: U.dave, ws: B, body: { chatId: chatB, userId: U.dave.uid, title: 'B chat' } });
    assert.strictEqual(c2.status, 200);
    const inA = await call('GET', `/api/chat/chats/${U.dave.uid}`, { as: U.dave, ws: A });
    const inB = await call('GET', `/api/chat/chats/${U.dave.uid}`, { as: U.dave, ws: B });
    const inP = await call('GET', `/api/chat/chats/${U.dave.uid}`, { as: U.dave });
    assert.deepStrictEqual(inA.body.chats.map((c) => c.id), [chatA]);
    assert.deepStrictEqual(inB.body.chats.map((c) => c.id), [chatB]);
    assert.deepStrictEqual(inP.body.chats.map((c) => c.id), []);
  });
  await test('messages: stored with the session workspace; cross-workspace session id → 404 (read/rename/delete/welcome)', async () => {
    await runWithScope({ userId: U.dave.uid, workspaceId: A.id, isPersonal: false }, () =>
      require(R('services', 'database.js')).saveConversation(U.dave.uid, 'Q3 GST numbers for Acme', 'Here they are', chatA));
    const ok = await call('GET', `/api/chat/messages/${U.dave.uid}/${chatA}`, { as: U.dave, ws: A });
    assert.strictEqual(ok.status, 200);
    assert.strictEqual(ok.body.messages.length, 1);
    for (const [m, u, body] of [
      ['GET', `/api/chat/messages/${U.dave.uid}/${chatA}`],
      ['GET', `/api/chat/welcome/${U.dave.uid}/${chatA}`],
      ['PATCH', `/api/chat/chats/${chatA}/rename`, { title: 'pwned' }],
      ['DELETE', `/api/chat/chats/${chatA}`],
    ]) {
      const r = await call(m, u, { as: U.dave, ws: B, body });
      assert.strictEqual(r.status, 404, `${m} ${u} via B → ${r.status}`);
      const p = await call(m, u, { as: U.dave, body }); // personal workspace
      assert.strictEqual(p.status, 404, `${m} ${u} via personal → ${p.status}`);
    }
    const still = await call('GET', `/api/chat/messages/${U.dave.uid}/${chatA}`, { as: U.dave, ws: A });
    assert.strictEqual(still.body.messages.length, 1);
    const listed = await call('GET', `/api/chat/chats/${U.dave.uid}`, { as: U.dave, ws: A });
    assert.strictEqual(listed.body.chats[0].title, 'A chat');
  });
  await test('sessions are creator-private: another member of the SAME workspace cannot read/rename/delete them (IDOR fixed)', async () => {
    for (const [m, u, body] of [
      ['GET', `/api/chat/messages/${U.bob.uid}/${chatA}`],
      ['PATCH', `/api/chat/chats/${chatA}/rename`, { title: 'x' }],
      ['DELETE', `/api/chat/chats/${chatA}`],
    ]) {
      const r = await call(m, u, { as: U.bob, ws: A, body });
      assert.strictEqual(r.status, 404, `${m} ${u} → ${r.status}`);
    }
  });
  await test('non-member selecting workspace A → 404; bad/unauthenticated header → 404/401', async () => {
    assert.strictEqual((await call('GET', `/api/chat/chats/${U.mallory.uid}`, { as: U.mallory, ws: A })).status, 404);
    assert.strictEqual((await call('GET', `/api/chat/chats/${U.mallory.uid}`, { as: U.mallory, headers: { 'x-workspace-id': 'not-a-uuid' } })).status, 404);
    assert.strictEqual((await call('GET', `/api/chat/chats/${U.mallory.uid}`, { ws: A })).status, 401);
  });
  await test('search: results limited to the selected workspace; filter-syntax characters cannot widen the query', async () => {
    const inA = await call('GET', `/api/chat/search/${U.dave.uid}?q=GST`, { as: U.dave, ws: A });
    assert.strictEqual(inA.body.results.length, 1);
    assert.strictEqual(inA.body.results[0].chat_title, 'A chat');
    const inB = await call('GET', `/api/chat/search/${U.dave.uid}?q=GST`, { as: U.dave, ws: B });
    assert.strictEqual(inB.body.results.length, 0);
    const inj = await call('GET', `/api/chat/search/${U.dave.uid}?q=${encodeURIComponent('x%,user_id.neq.nobody,message.ilike.*')}`, { as: U.dave, ws: B });
    assert.strictEqual(inj.status, 200);
    assert.strictEqual(inj.body.results.length, 0);
  });
  await test('edit: cannot overwrite another user\'s / another workspace\'s message (IDOR fixed)', async () => {
    const { data: msgs } = await db.from('conversations').select('*').eq('chat_id', chatA);
    const msg = msgs[0];
    const r = await call('POST', '/api/chat/edit', { as: U.bob, ws: A, body: { userId: U.bob.uid, chatId: chatA, messageId: msg.id, newMessage: 'hijacked' } });
    assert.ok(r.text.includes('Message not found'));
    const r2 = await call('POST', '/api/chat/edit', { as: U.dave, ws: B, body: { userId: U.dave.uid, chatId: chatA, messageId: msg.id, newMessage: 'hijacked' } });
    assert.ok(r2.text.includes('Message not found'));
    const { data: after } = await db.from('conversations').select('*').eq('id', msg.id);
    assert.strictEqual(after[0].message, 'Q3 GST numbers for Acme');
  });
  await test('stream: cannot post into an existing chat of another workspace (404); chat id reuse is refused (409)', async () => {
    const r = await call('POST', '/api/chat/stream', { as: U.dave, ws: B, body: { userId: U.dave.uid, chatId: chatA, message: 'hello there' } });
    assert.strictEqual(r.status, 404);
    const reuse = await call('POST', '/api/chat/chats', { as: U.bob, ws: A, body: { chatId: chatA, userId: U.bob.uid, title: 'steal' } });
    assert.strictEqual(reuse.status, 409);
  });

  // ================================================================
  // Memory
  // ================================================================
  await test('memory: vectors saved in A are retrievable only in A — not in B, not in personal', async () => {
    const fact = 'Acme GST filing deadline is March thirty one';
    await runWithScope({ userId: U.dave.uid, workspaceId: A.id, isPersonal: false }, () => memorySvc.saveMemory(U.dave.uid, fact));
    const inA = await runWithScope({ userId: U.dave.uid, workspaceId: A.id, isPersonal: false }, () => memorySvc.searchMemory(U.dave.uid, fact, { raw: true, similarityThreshold: 0.9 }));
    assert.deepStrictEqual(inA.map((m) => m.content), [fact]);
    const inB = await runWithScope({ userId: U.dave.uid, workspaceId: B.id, isPersonal: false }, () => memorySvc.searchMemory(U.dave.uid, fact, { raw: true }));
    assert.deepStrictEqual(inB, []);
    const pws = await wsService.ensurePersonalWorkspace(U.dave.uid);
    const inP = await runWithScope({ userId: U.dave.uid, workspaceId: pws.id, isPersonal: true }, () => memorySvc.searchMemory(U.dave.uid, fact, { raw: true }));
    assert.deepStrictEqual(inP, []);
    const dumpB = await runWithScope({ userId: U.dave.uid, workspaceId: B.id, isPersonal: false }, () => memoryManager.getFullMemoryDump(U.dave.uid));
    assert.strictEqual(dumpB, '');
  });
  await test('memory: unscoped writes (e.g. the frozen voice pipeline) stay visible in the personal workspace only', async () => {
    const fact = 'voice automation opened notepad successfully today';
    await memorySvc.saveMemory(U.alice.uid, fact); // no scope = exactly what memoryHooks.logAction does
    const inP = await runWithScope({ userId: U.alice.uid, workspaceId: alicePersonal.id, isPersonal: true }, () => memorySvc.searchMemory(U.alice.uid, fact, { raw: true, similarityThreshold: 0.9 }));
    assert.deepStrictEqual(inP.map((m) => m.content), [fact]);
    const inA = await runWithScope({ userId: U.alice.uid, workspaceId: A.id, isPersonal: false }, () => memorySvc.searchMemory(U.alice.uid, fact, { raw: true }));
    assert.deepStrictEqual(inA, []);
    const unscoped = await memorySvc.searchMemory(U.alice.uid, fact, { raw: true, similarityThreshold: 0.9 });
    assert.strictEqual(unscoped.length, 1, 'legacy unscoped search behaviour unchanged');
  });

  let daveMemA;
  await test('memory API: list is workspace-scoped; PATCH/DELETE require owner + same workspace (IDOR fixed)', async () => {
    await runWithScope({ userId: U.dave.uid, workspaceId: A.id, isPersonal: false }, () =>
      db.from('user_memories').insert([{ user_id: U.dave.uid, category: 'projects', content: '[projects] Acme client list', workspace_id: A.id }]));
    await db.from('user_memories').insert([{ user_id: U.dave.uid, category: 'projects', content: '[projects] Other Co roadmap', workspace_id: B.id }]);
    const inA = await call('GET', `/api/memory/${U.dave.uid}`, { as: U.dave, ws: A });
    const inB = await call('GET', `/api/memory/${U.dave.uid}`, { as: U.dave, ws: B });
    assert.deepStrictEqual(inA.body.memories.map((m) => m.content), ['[projects] Acme client list']);
    assert.deepStrictEqual(inB.body.memories.map((m) => m.content), ['[projects] Other Co roadmap']);
    daveMemA = inA.body.memories[0];
    assert.strictEqual((await call('PATCH', `/api/memory/${daveMemA.id}`, { as: U.dave, ws: B, body: { content: 'x' } })).status, 404);
    assert.strictEqual((await call('DELETE', `/api/memory/${daveMemA.id}`, { as: U.dave, ws: B })).status, 404);
    assert.strictEqual((await call('DELETE', `/api/memory/${daveMemA.id}`, { as: U.bob, ws: A })).status, 404);
    assert.strictEqual((await call('PATCH', `/api/memory/${daveMemA.id}`, { as: U.bob, ws: A, body: { content: 'x' } })).status, 404);
    const still = await call('GET', `/api/memory/${U.dave.uid}`, { as: U.dave, ws: A });
    assert.strictEqual(still.body.memories[0].content, '[projects] Acme client list');
  });
  await test('memory delete only removes the owner\'s vectors in that workspace (not other users\' identical content)', async () => {
    const shared = '[projects] Acme client list';
    await runWithScope({ userId: U.dave.uid, workspaceId: A.id, isPersonal: false }, () => memorySvc.saveMemory(U.dave.uid, shared));
    await runWithScope({ userId: U.bob.uid, workspaceId: A.id, isPersonal: false }, () => memorySvc.saveMemory(U.bob.uid, shared));
    const del = await call('DELETE', `/api/memory/${daveMemA.id}`, { as: U.dave, ws: A });
    assert.strictEqual(del.status, 200);
    const { data: left } = await db.from('memory_vectors').select('user_id, content').eq('content', shared).in('user_id', [U.dave.uid, U.bob.uid]);
    assert.deepStrictEqual(left.map((r) => r.user_id), [U.bob.uid]);
  });

  // ================================================================
  // Goals
  // ================================================================
  let aliceGoalA;
  await test('goals: workspace-scoped list/create; legacy goals stay in personal', async () => {
    const c = await call('POST', '/api/goals', { as: U.alice, ws: A, body: { userId: U.alice.uid, title: 'File Acme returns' } });
    assert.strictEqual(c.status, 200);
    aliceGoalA = c.body.goal;
    const inA = await call('GET', `/api/goals/${U.alice.uid}`, { as: U.alice, ws: A });
    const inP = await call('GET', `/api/goals/${U.alice.uid}`, { as: U.alice });
    assert.deepStrictEqual(inA.body.goals.map((g) => g.title), ['File Acme returns']);
    assert.deepStrictEqual(inP.body.goals.map((g) => g.title), ['Legacy goal']);
  });
  await test('goals: update/delete require owner + same workspace (IDOR fixed)', async () => {
    assert.strictEqual((await call('PATCH', `/api/goals/${aliceGoalA.id}/progress`, { as: U.alice, body: { userId: U.alice.uid, progress: 70 } })).status, 404, 'personal ws');
    assert.strictEqual((await call('PATCH', `/api/goals/${aliceGoalA.id}/progress`, { as: U.bob, ws: A, body: { userId: U.bob.uid, progress: 70 } })).status, 404, 'other member');
    assert.strictEqual((await call('DELETE', `/api/goals/${aliceGoalA.id}`, { as: U.mallory })).status, 404, 'other tenant');
    const ok = await call('PATCH', `/api/goals/${aliceGoalA.id}/progress`, { as: U.alice, ws: A, body: { userId: U.alice.uid, progress: 70 } });
    assert.strictEqual(ok.status, 200);
    assert.strictEqual(ok.body.goal.progress, 70);
  });
  await test('smart goals (goal_breakdowns): scoped create/list; breakdown/review/adapt of another workspace → 404', async () => {
    const c = await call('POST', `/api/goals/${U.dave.uid}/create-with-breakdown`, { as: U.dave, ws: A, body: { goalTitle: 'Automate Acme GST' } });
    assert.strictEqual(c.status, 200, JSON.stringify(c.body));
    const gid = c.body.goal.id;
    const inB = await call('GET', `/api/goals/${U.dave.uid}/all-with-breakdown`, { as: U.dave, ws: B });
    assert.strictEqual(inB.body.goals.length, 0);
    const inA = await call('GET', `/api/goals/${U.dave.uid}/all-with-breakdown`, { as: U.dave, ws: A });
    assert.strictEqual(inA.body.goals.length, 1);
    assert.strictEqual((await call('GET', `/api/goals/${U.dave.uid}/breakdown/${gid}`, { as: U.dave, ws: B })).status, 404);
    assert.strictEqual((await call('POST', `/api/goals/${U.dave.uid}/review-weekly/${gid}`, { as: U.dave, ws: B })).status, 404);
    assert.strictEqual((await call('POST', `/api/goals/${U.dave.uid}/adapt/${gid}`, { as: U.dave, ws: B, body: { performance: 10 } })).status, 404);
    assert.strictEqual((await call('GET', `/api/goals/${U.dave.uid}/reviews/${gid}`, { as: U.dave, ws: B })).status, 404);
    assert.strictEqual((await call('GET', `/api/goals/${U.dave.uid}/breakdown/${gid}`, { as: U.dave, ws: A })).status, 200);
  });
  await test('daily plan: completing another user\'s plan id → 404 (IDOR fixed)', async () => {
    const { data } = await db.from('daily_execution_plan').insert([{ user_id: U.alice.uid, plan_date: '2026-09-23', total_count: 4, completed_count: 0 }]).select();
    const planId = data[0].id;
    assert.strictEqual((await call('PATCH', `/api/goals/${U.bob.uid}/today-plan/complete-task`, { as: U.bob, body: { planId, completedCount: 4 } })).status, 404);
  });

  // ================================================================
  // Notifications (per-user inbox)
  // ================================================================
  await test('notifications: another user cannot mark read / delete someone else\'s notification', async () => {
    const { data } = await db.from('notifications').insert([{ user_id: U.alice.uid, title: 't', message: 'm', read: false }]).select();
    const id = data[0].id;
    // NOTE: middleware/auth.js already rejects these (403) because it reads
    // /notifications/:x as a user id for every method (pre-existing; see
    // docs). The route-level owner check added in Layer 2 is tested below
    // without that middleware.
    assert.ok([403, 404].includes((await call('PATCH', `/api/notifications/${id}/read`, { as: U.bob })).status));
    assert.ok([403, 404].includes((await call('DELETE', `/api/notifications/${id}`, { as: U.bob })).status));
    const { data: row } = await db.from('notifications').select('*').eq('id', id);
    assert.strictEqual(row.length, 1);
    assert.strictEqual(row[0].read, false);
    // route-level defence in depth (no auth.js path check in front):
    const app2 = express();
    app2.use(express.json());
    app2.use((req, _res, next) => { req.user = { uid: req.get('x-uid') }; next(); });
    app2.use('/n', notificationsRoute);
    const s2 = await new Promise((resolve) => { const s = app2.listen(0, '127.0.0.1', () => resolve(s)); });
    const b2 = `http://127.0.0.1:${s2.address().port}`;
    const r1 = await fetch(`${b2}/n/${id}/read`, { method: 'PATCH', headers: { 'x-uid': U.bob.uid } });
    const r2 = await fetch(`${b2}/n/${id}`, { method: 'DELETE', headers: { 'x-uid': U.bob.uid } });
    const r3 = await fetch(`${b2}/n/${id}/read`, { method: 'PATCH', headers: { 'x-uid': U.alice.uid } });
    s2.close();
    assert.deepStrictEqual([r1.status, r2.status, r3.status], [404, 404, 200]);
  });

  // ================================================================
  // Workspace permission grants
  // ================================================================
  await test('grants: member cannot grant (403), admin can; non-member cannot list (404)', async () => {
    assert.strictEqual((await call('POST', `/api/workspaces/${A.id}/permissions`, { as: U.bob, body: { resource: 'tally' } })).status, 403);
    const g = await call('POST', `/api/workspaces/${A.id}/permissions`, { as: U.carol, body: { resource: 'tally' } });
    assert.strictEqual(g.status, 201);
    assert.strictEqual((await call('POST', `/api/workspaces/${A.id}/permissions`, { as: U.carol, body: { resource: 'tally' } })).status, 409);
    assert.strictEqual((await call('GET', `/api/workspaces/${A.id}/permissions`, { as: U.bob })).body.data.length, 1);
    assert.strictEqual((await call('GET', `/api/workspaces/${A.id}/permissions`, { as: U.mallory })).status, 404);
    assert.strictEqual((await call('DELETE', `/api/workspaces/${B.id}/permissions/${g.body.data.id}`, { as: U.mallory })).status, 404, 'B admin cannot revoke A grant');
  });
  await test('grants: a grant in workspace A never authorizes workspace B; the legacy 2-arg (voice) path is unchanged', async () => {
    process.env.PERMISSIONS_ENFORCED = 'true';
    try {
      assert.strictEqual(await permissions.isPermitted(U.dave.uid, 'tally', A.id), true);
      assert.strictEqual(await permissions.isPermitted(U.dave.uid, 'tally', B.id), false);
      assert.strictEqual(await permissions.isPermitted(U.dave.uid, 'tally'), false, 'no personal user_permissions row');
      assert.strictEqual(await permissions.isPermitted(U.dave.uid, 'notepad', B.id), true, 'SAFE_LIST unchanged');
    } finally { delete process.env.PERMISSIONS_ENFORCED; }
  });

  // ================================================================
  // Tasks → executions → evidence
  // ================================================================
  let task;
  await test('tasks: members create & view; non-members and other-workspace URLs → 404', async () => {
    const c = await call('POST', `/api/workspaces/${A.id}/tasks`, { as: U.alice, body: { title: 'readpage Reconcile GSTR-2B', description: 'For client Sharma & Co', priority: 'high' } });
    assert.strictEqual(c.status, 201, JSON.stringify(c.body));
    task = c.body.data;
    assert.strictEqual(task.status, 'todo');
    assert.strictEqual(task.createdBy, U.alice.uid);
    assert.strictEqual((await call('GET', `/api/workspaces/${A.id}/tasks/${task.id}`, { as: U.bob })).status, 200);
    assert.strictEqual((await call('GET', `/api/workspaces/${A.id}/tasks/${task.id}`, { as: U.mallory })).status, 404);
    assert.strictEqual((await call('GET', `/api/workspaces/${B.id}/tasks/${task.id}`, { as: U.dave })).status, 404, 'member of both, wrong URL');
    assert.strictEqual((await call('GET', `/api/workspaces/${B.id}/tasks`, { as: U.dave })).body.data.length, 0);
    assert.strictEqual((await call('POST', `/api/workspaces/${B.id}/tasks/${task.id}/comments`, { as: U.mallory, body: { body: 'x' } })).status, 404);
  });
  await test('tasks: assignment rules (member cannot reassign others\' tasks; can claim unassigned; assignee must be a member)', async () => {
    const other = await call('POST', `/api/workspaces/${A.id}/tasks/${task.id}/assign`, { as: U.bob, body: { assignee: { type: 'human', userId: U.carol.uid } } });
    assert.strictEqual(other.status, 403);
    const claim = await call('POST', `/api/workspaces/${A.id}/tasks/${task.id}/assign`, { as: U.bob, body: { assignee: { type: 'human', userId: U.bob.uid } } });
    assert.strictEqual(claim.status, 200);
    assert.deepStrictEqual(claim.body.data.assignee, { type: 'human', userId: U.bob.uid });
    const nonMember = await call('POST', `/api/workspaces/${A.id}/tasks/${task.id}/assign`, { as: U.alice, body: { assignee: { type: 'human', userId: U.mallory.uid } } });
    assert.strictEqual(nonMember.status, 400);
    const steal = await call('POST', `/api/workspaces/${A.id}/tasks/${task.id}/assign`, { as: U.dave, body: { assignee: { type: 'human', userId: U.dave.uid } } });
    assert.strictEqual(steal.status, 403, 'cannot claim an already-assigned task');
  });
  await test('tasks: status/edit allowed for creator, assignee, admin — not other members', async () => {
    assert.strictEqual((await call('POST', `/api/workspaces/${A.id}/tasks/${task.id}/status`, { as: U.dave, body: { status: 'blocked' } })).status, 403);
    assert.strictEqual((await call('PATCH', `/api/workspaces/${A.id}/tasks/${task.id}`, { as: U.dave, body: { priority: 'low' } })).status, 403);
    assert.strictEqual((await call('POST', `/api/workspaces/${A.id}/tasks/${task.id}/status`, { as: U.bob, body: { status: 'blocked' } })).status, 200);
    assert.strictEqual((await call('PATCH', `/api/workspaces/${A.id}/tasks/${task.id}`, { as: U.carol, body: { priority: 'urgent' } })).body.data.priority, 'urgent');
    assert.strictEqual((await call('POST', `/api/workspaces/${A.id}/tasks/${task.id}/status`, { as: U.bob, body: { status: 'nonsense' } })).status, 400);
  });
  await test('tasks: comments + activity trail; secrets in comments/descriptions are redacted', async () => {
    const cm = await call('POST', `/api/workspaces/${A.id}/tasks/${task.id}/comments`, { as: U.dave, body: { body: 'portal password: hunter2, PAN ABCDE1234F' } });
    assert.strictEqual(cm.status, 201);
    assert.ok(!cm.body.data.body.includes('hunter2') && !cm.body.data.body.includes('ABCDE1234F'));
    const act = await call('GET', `/api/workspaces/${A.id}/tasks/${task.id}/activity`, { as: U.bob });
    const kinds = act.body.data.map((a) => a.kind);
    for (const k of ['created', 'assigned', 'status_changed', 'updated', 'comment']) assert.ok(kinds.includes(k), `missing ${k} in ${kinds}`);
  });

  let execId;
  await test('tasks → executions: only creator/assignee/admin can run; execution is linked, workspace-scoped and visible on the task', async () => {
    NEXUS = () => ({ success: true, data: 'GSTR-2B rows', evidence: { verified: true } });
    PLAN.readpage = (n) => (n === 0 ? { done: false, action: 'read_text', payload: { platform: 'browser', parameters: {}, target: {}, value: null } } : { done: true, reason: 'reconciled' });
    assert.strictEqual((await call('POST', `/api/workspaces/${A.id}/tasks/${task.id}/execute`, { as: U.dave })).status, 403);
    const ex = await call('POST', `/api/workspaces/${A.id}/tasks/${task.id}/execute`, { as: U.bob, headers: { 'idempotency-key': `task-run-${RUN}` } });
    assert.strictEqual(ex.status, 201, JSON.stringify(ex.body));
    execId = ex.body.data.id;
    assert.strictEqual(ex.body.data.taskId, task.id);
    let e;
    for (let i = 0; i < 200; i++) { e = await call('GET', `/api/workspaces/${A.id}/executions/${execId}`, { as: U.alice }); if (['completed', 'failed'].includes(e.body.data.status)) break; await sleep(5); }
    assert.strictEqual(e.body.data.status, 'completed', JSON.stringify(e.body.data.failure));
    const replay = await call('POST', `/api/workspaces/${A.id}/tasks/${task.id}/execute`, { as: U.bob, headers: { 'idempotency-key': `task-run-${RUN}` } });
    assert.strictEqual(replay.status, 200);
    assert.strictEqual(replay.body.data.id, execId);
    const t = await call('GET', `/api/workspaces/${A.id}/tasks/${task.id}`, { as: U.carol });
    assert.strictEqual(t.body.data.status, 'in_progress');
    assert.deepStrictEqual(t.body.data.executions.map((x) => x.id), [execId]);
    assert.ok(t.body.data.activity.some((a) => a.kind === 'execution_started' && a.data.executionId === execId));
    // Workspace B cannot see A's execution or its evidence
    assert.strictEqual((await call('GET', `/api/workspaces/${B.id}/executions/${execId}`, { as: U.dave })).status, 404);
    assert.strictEqual((await call('GET', `/api/workspaces/${B.id}/executions/${execId}/evidence`, { as: U.mallory })).status, 404);
    assert.strictEqual((await call('GET', `/api/workspaces/${A.id}/executions/${execId}/evidence`, { as: U.dave })).status, 200, 'members view evidence');
  });
  await test('tasks: delete is admin-only and refused while executions exist; closed tasks cannot be run', async () => {
    assert.strictEqual((await call('DELETE', `/api/workspaces/${A.id}/tasks/${task.id}`, { as: U.bob })).status, 403);
    assert.strictEqual((await call('DELETE', `/api/workspaces/${A.id}/tasks/${task.id}`, { as: U.carol })).status, 409);
    const t2 = (await call('POST', `/api/workspaces/${A.id}/tasks`, { as: U.bob, body: { title: 'Temp task' } })).body.data;
    await call('POST', `/api/workspaces/${A.id}/tasks/${t2.id}/status`, { as: U.bob, body: { status: 'done' } });
    assert.strictEqual((await call('POST', `/api/workspaces/${A.id}/tasks/${t2.id}/execute`, { as: U.bob })).status, 409);
    assert.strictEqual((await call('DELETE', `/api/workspaces/${B.id}/tasks/${t2.id}`, { as: U.mallory })).status, 404, 'B owner cannot delete A task');
    assert.strictEqual((await call('DELETE', `/api/workspaces/${A.id}/tasks/${t2.id}`, { as: U.carol })).status, 200);
  });
  await test('execution approvals stay workspace-bound when started from a task (B admin cannot approve A step)', async () => {
    PLAN.writerecon = (n) => (n === 0 ? { done: false, action: 'write_file', payload: { platform: 'desktop', parameters: { path: 'C:/recon.xlsx' }, target: {}, value: null } } : { done: true, reason: 'saved' });
    const t3 = (await call('POST', `/api/workspaces/${A.id}/tasks`, { as: U.alice, body: { title: 'writerecon save reconciliation' } })).body.data;
    const ex = await call('POST', `/api/workspaces/${A.id}/tasks/${t3.id}/execute`, { as: U.alice });
    let e;
    for (let i = 0; i < 200; i++) { e = await call('GET', `/api/workspaces/${A.id}/executions/${ex.body.data.id}`, { as: U.alice }); if (e.body.data.status === 'waiting_approval') break; await sleep(5); }
    const apprId = e.body.data.waitingForApproval.id;
    assert.strictEqual((await call('POST', `/api/workspaces/${B.id}/executions/${ex.body.data.id}/approvals/${apprId}/approve`, { as: U.mallory })).status, 404);
    assert.strictEqual((await call('POST', `/api/workspaces/${A.id}/executions/${ex.body.data.id}/approvals/${apprId}/approve`, { as: U.alice })).status, 200);
    for (let i = 0; i < 200; i++) { e = await call('GET', `/api/workspaces/${A.id}/executions/${ex.body.data.id}`, { as: U.alice }); if (['completed', 'failed'].includes(e.body.data.status)) break; await sleep(5); }
    assert.strictEqual(e.body.data.status, 'completed');
  });

  // ================================================================
  // Audit
  // ================================================================
  await test('audit: admin-only, workspace-scoped, covers task + approval events, no secrets', async () => {
    await sleep(30); // audit writes are fire-and-forget
    assert.strictEqual((await call('GET', `/api/workspaces/${A.id}/audit`, { as: U.bob })).status, 403);
    const a = await call('GET', `/api/workspaces/${A.id}/audit?limit=200`, { as: U.carol });
    assert.strictEqual(a.status, 200);
    const actions = new Set(a.body.data.map((r) => r.action));
    for (const k of ['task_created', 'task_assigned', 'task_status_changed', 'task_execution_started', 'agent_execution_approval_approve', 'workspace_grant_created', 'agent_execution_completed']) {
      assert.ok(actions.has(k), `missing audit action ${k}`);
    }
    const bAudit = await call('GET', `/api/workspaces/${B.id}/audit?limit=200`, { as: U.mallory });
    assert.ok(!JSON.stringify(bAudit.body.data).includes(task.id), 'B audit must not contain A events');
    assert.ok(!JSON.stringify(a.body.data).includes('hunter2'));
  });

  // ================================================================
  // Kill switch & compatibility
  // ================================================================
  await test('kill switch: WORKSPACE_DATA_SCOPING=off restores legacy (unscoped) behaviour', async () => {
    process.env.WORKSPACE_DATA_SCOPING = 'off';
    try {
      const r = await call('GET', `/api/chat/chats/${U.dave.uid}`, { as: U.dave, ws: B });
      assert.strictEqual(r.status, 200);
      assert.deepStrictEqual(r.body.chats.map((c) => c.id).sort(), [chatA, chatB].sort());
    } finally { delete process.env.WORKSPACE_DATA_SCOPING; }
  });

  srv.close();
  console.log(`\n${passed} passed, ${failed} failed (store: ${STORE_MODE})`);
  process.exit(failed ? 1 : 0);
}

run().catch((err) => { console.error(err); process.exit(1); });
