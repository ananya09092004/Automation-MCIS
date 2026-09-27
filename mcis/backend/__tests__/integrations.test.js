/**
 * Layer 5 — Integrations, credentials & connectors tests.
 *
 * Real: HTTP stack (auth → Layer 1 workspaceContext → routes), integration
 * service + gateway, credential service (AES-256-GCM), SSRF-safe client,
 * HTTP + GitHub connectors, Layer 3 executionService, Layer 4 workflow
 * service + durable runner, sensitiveDataFilter.
 *
 * Doubles (external services only): Firebase token verification, Gemini
 * (scripted planner), Nexus bridge, and two local HTTP servers standing in
 * for "an approved REST API" and "the GitHub REST API". The network path
 * reaches them through the SAME safe client via explicit test seams
 * (fake DNS name → 127.0.0.1, http allowed); every SSRF test uses the
 * production-default client with NO seams.
 *
 * Run: node __tests__/integrations.test.js   (WORKSPACE_TEST_STORE=supabase for real Postgres)
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
    return { response: { text: () => JSON.stringify(reply) } };
  },
});
const nexusCalls = [];
fakeModule(R('backend-routing', 'nexusBridge.js'), {
  sendCommandToNexus: async (req) => { nexusCalls.push(req); return { success: true, data: 'ok', evidence: { verified: true } }; },
});

const express = require('express');
const authenticateFirebaseUser = require(R('middleware', 'auth.js'));
const sanitizeInput = require(R('middleware', 'sanitizer.js'));
const { createWorkspaceService } = require(R('services', 'workspaceService.js'));
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
const { createGithubConnector } = require(R('services', 'integrations', 'connectors', 'githubConnector.js'));
const { SAFE_TO_REPEAT_ACTIONS } = require(R('backend-routing', 'intentRouter.js'));
const { createMemoryWorkspaceStore } = require(path.join(__dirname, 'support', 'memoryWorkspaceStore.js'));
const { createMemoryExecutionStore } = require(path.join(__dirname, 'support', 'memoryExecutionStore.js'));
const { createMemoryWorkspaceDataStore } = require(path.join(__dirname, 'support', 'memoryWorkspaceDataStore.js'));
const { createMemoryWorkflowStore } = require(path.join(__dirname, 'support', 'memoryWorkflowStore.js'));
const { createMemoryIntegrationStore } = require(path.join(__dirname, 'support', 'memoryIntegrationStore.js'));

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

// Secrets generated at runtime (never hardcoded, never real).
const GH_TOKEN = `ghp_${crypto.randomBytes(18).toString('hex')}`;
const GH_TOKEN_2 = `ghp_${crypto.randomBytes(18).toString('hex')}`;
const API_TOKEN = `sk-test-${crypto.randomBytes(16).toString('hex')}`;
// A secret with NO recognizable shape: only the explicit scrubber can catch it.
const PLAIN_TOKEN = crypto.randomBytes(20).toString('hex');
const KEY_B64 = crypto.randomBytes(32).toString('base64');
const SECRETS = [GH_TOKEN, GH_TOKEN_2, API_TOKEN, KEY_B64, PLAIN_TOKEN];

// ---------------------------------------------------------------------
// Local API doubles
// ---------------------------------------------------------------------
const apiLog = [];
let failOnceCount = 0;
function startServer(handler) {
  return new Promise((resolve) => { const s = http.createServer(handler); s.listen(0, '127.0.0.1', () => resolve(s)); });
}
const json = (res, status, body, headers = {}) => { res.writeHead(status, { 'content-type': 'application/json', ...headers }); res.end(JSON.stringify(body)); };

async function readBody(req) {
  let b = '';
  for await (const c of req) b += c;
  return b;
}

let apiPort;
const apiServer = startServer(async (req, res) => {
  const body = await readBody(req);
  const u = new URL(req.url, 'http://x');
  apiLog.push({ method: req.method, path: u.pathname, query: Object.fromEntries(u.searchParams), headers: req.headers, body, host: req.headers.host });
  const p = u.pathname;
  if (p === '/v1/' || p === '/v1') return json(res, 200, { ok: true });
  if (p === '/v1/prices') return json(res, 200, { sku: u.searchParams.get('sku'), price: 499, currency: 'INR' });
  if (p === '/v1/echo') return json(res, 200, { youSent: req.headers.authorization || req.headers['x-api-key'] || null, note: `token=${req.headers['x-api-key'] || ''}` });
  if (p === '/v1/big') { res.writeHead(200, { 'content-type': 'application/json' }); res.write('['); for (let i = 0; i < 3000; i++) res.write(`"${'x'.repeat(1000)}",`); res.end('"end"]'); return undefined; }
  if (p === '/v1/slow') { setTimeout(() => json(res, 200, { late: true }), 4000); return undefined; }
  if (p === '/v1/binary') { res.writeHead(200, { 'content-type': 'application/octet-stream' }); res.end(Buffer.from([1, 2, 3])); return undefined; }
  if (p === '/v1/redirect-internal') { res.writeHead(302, { location: `http://internal.example.test:${apiPort}/v1/prices` }); res.end(); return undefined; }
  if (p === '/v1/redirect-offlist') { res.writeHead(302, { location: 'https://evil.example.org/steal' }); res.end(); return undefined; }
  if (p === '/v1/redirect-ok') { res.writeHead(302, { location: '/v1/prices?sku=redirected' }); res.end(); return undefined; }
  if (p === '/v1/redirect-cross') { res.writeHead(302, { location: `http://cdn.example.test:${apiPort}/v1/prices?sku=cdn` }); res.end(); return undefined; }
  if (p === '/v1/loop') { res.writeHead(302, { location: '/v1/loop' }); res.end(); return undefined; }
  if (p === '/v1/fail-once') { failOnceCount += 1; return failOnceCount === 1 ? json(res, 503, { e: 1 }) : json(res, 200, { ok: 'second try' }); }
  if (p === '/v1/unauth') return json(res, 401, { error: 'bad token' });
  if (p === '/v1/unauth-slow') { setTimeout(() => json(res, 401, { error: 'bad token' }), 400); return undefined; }
  if (p === '/v1/orders' && req.method === 'POST') return json(res, 201, { id: `ord_${apiLog.filter((l) => l.path === '/v1/orders').length}` });
  if (p === '/v1/orders-fail' && req.method === 'POST') return json(res, 500, { error: 'boom' });
  if (p === '/v1/orders-slow' && req.method === 'POST') return undefined; // hangs forever
  return json(res, 404, { error: 'nope' });
});

const ghLog = [];
let ghPort;
const ISSUES = [
  { number: 1, title: 'Invoice totals wrong', state: 'open', html_url: 'https://github.com/acme/books/issues/1', user: { login: 'ravi' }, created_at: '2026-09-01T00:00:00Z' },
  { number: 2, title: 'A pull request', state: 'open', html_url: 'https://github.com/acme/books/pull/2', user: { login: 'dev' }, created_at: '2026-09-02T00:00:00Z', pull_request: {} },
];
const ghServer = startServer(async (req, res) => {
  const body = await readBody(req);
  const u = new URL(req.url, 'http://x');
  ghLog.push({ method: req.method, path: u.pathname, auth: req.headers.authorization, body });
  const okToken = [`Bearer ${GH_TOKEN}`, `Bearer ${GH_TOKEN_2}`].includes(req.headers.authorization);
  if (!okToken) return json(res, 401, { message: 'Bad credentials' });
  if (req.headers['x-github-api-version'] !== '2022-11-28') return json(res, 400, { message: 'version header missing' });
  const p = u.pathname;
  if (p === '/user') return json(res, 200, { login: 'nexus-bot' });
  if (p === '/repos/acme/books') return json(res, 200, { full_name: 'acme/books', private: true, default_branch: 'main', description: 'Books', open_issues_count: 1, html_url: 'https://github.com/acme/books', updated_at: '2026-09-20T00:00:00Z', secret_field: 'x' });
  if (p === '/repos/acme/books/issues' && req.method === 'GET') return json(res, 200, ISSUES);
  if (p === '/repos/acme/books/issues' && req.method === 'POST') { const b = JSON.parse(body); return json(res, 201, { number: 40 + ghLog.filter((l) => l.method === 'POST' && l.path.endsWith('/issues')).length, title: b.title, html_url: 'https://github.com/acme/books/issues/41' }); }
  if (p === '/repos/acme/books/pulls') return json(res, 200, [{ number: 2, title: 'A pull request', state: 'open', draft: false, html_url: 'https://github.com/acme/books/pull/2', user: { login: 'dev' }, created_at: '2026-09-02T00:00:00Z' }]);
  if (p === '/repos/acme/books/contents/docs/README.md') return json(res, 200, { type: 'file', path: 'docs/README.md', size: 27, sha: 'abc', encoding: 'base64', content: Buffer.from('# Books\nGST filing helper.\n').toString('base64') });
  if (p === '/repos/acme/books/contents/docs') return json(res, 200, [{ type: 'file', path: 'docs/README.md' }]);
  if (/^\/repos\/acme\/books\/issues\/\d+\/comments$/.test(p) && req.method === 'POST') return json(res, 201, { id: 777, html_url: 'https://github.com/acme/books/issues/1#issuecomment-777' });
  return json(res, 404, { message: 'Not Found' });
});

// ---------------------------------------------------------------------
// Stores + services
// ---------------------------------------------------------------------
let wsStore; let execStore; let dataStore; let wfStore; let intStore;
if (SUPA) {
  wsStore = require(R('services', 'workspaceStore.js')).createSupabaseWorkspaceStore();
  execStore = require(R('services', 'agentExecution', 'executionStore.js')).createSupabaseExecutionStore();
  dataStore = require(R('services', 'workspaceData', 'workspaceDataStore.js')).createSupabaseWorkspaceDataStore();
  wfStore = require(R('services', 'workflows', 'workflowStore.js')).createSupabaseWorkflowStore();
  intStore = require(R('services', 'integrations', 'integrationStore.js')).createSupabaseIntegrationStore();
} else {
  wsStore = createMemoryWorkspaceStore();
  execStore = createMemoryExecutionStore();
  dataStore = createMemoryWorkspaceDataStore();
  wfStore = createMemoryWorkflowStore({ taskExists: async (ws, id) => !!(await dataStore.getTask(ws, id)) });
  intStore = createMemoryIntegrationStore();
}
const auditRows = [];
const realAudit = SUPA ? require(R('security-engine', 'auditLog.js')).appendAuditLog : null;
const appendAuditLog = async (userId, action, payload, result, workspaceId) => {
  auditRows.push({ userId, action, payload, result, workspaceId });
  if (realAudit) await realAudit(userId, action, payload, result, workspaceId);
};

let lookupCalls = [];
const FAKE_DNS = {
  'api.example.test': ['127.0.0.1'],
  'cdn.example.test': ['127.0.0.1'],
  'api.github.test': ['127.0.0.1'],
  'internal.example.test': ['10.0.0.7'],
};
let flipCount = 0;
function fakeLookup(host, opts, cb) {
  lookupCalls.push(host);
  if (host === 'flip.example.test') { flipCount += 1; const a = flipCount === 1 ? '127.0.0.1' : '10.0.0.9'; cb(null, [{ address: a, family: 4 }]); return; }
  const addrs = FAKE_DNS[host];
  if (!addrs) { cb(Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' })); return; }
  cb(null, addrs.map((a) => ({ address: a, family: 4 })));
}

const wsService = createWorkspaceService(wsStore, { requireVerifiedEmail: true });
const keyRing = loadKeyRing({ INTEGRATION_ENCRYPTION_KEY: KEY_B64, INTEGRATION_ENCRYPTION_KEY_ID: 'test-k1' });
const credentials = createCredentialService({ store: intStore, keyRing });
let testHttp;
let registry;
let integrationService;

function makeSystem() {
  const execService = createAgentExecutionService({ store: execStore, options: { retryDelayMs: 0, maxSteps: 8 }, deps: { appendAuditLog }, logger: { error() {}, warn() {} } });
  execService.setConnectorGateway(integrationService.gateway);
  const service = createWorkflowService({ store: wfStore, dataStore, executionService: execService, appendAuditLog, integrationResolver: integrationService, logger: { error() {}, warn() {} } });
  const runner = createWorkflowRunner({
    store: wfStore, service, dataStore, executionService: execService, execStore, appendAuditLog,
    safeToRepeatActions: [...SAFE_TO_REPEAT_ACTIONS, ...registry.staticallySafeActionNames()],
    getMemberRole: async (ws, uid) => { const m = await wsStore.getMember(ws, uid); return m ? m.role : null; },
    logger: { error() {}, warn() {} },
    options: { leaseSeconds: 2, heartbeatMs: 100, idlePollMs: 25, execPollMs: 5, busyRetryMs: 25, schedulerIntervalMs: 0, stopTimeoutMs: 2000 },
  });
  service.attachRunner(runner);
  return {
    execService, service, runner,
    wf: createWorkflowRouters({ workspaceService: wsService, workflowService: service }),
    exec: createExecutionsRouter({ workspaceService: wsService, executionService: execService }),
    int: createIntegrationsRouter({ workspaceService: wsService, integrationService }),
  };
}

const U = Object.fromEntries(['alice', 'bob', 'carol', 'dave', 'mallory'].map((n) => [n, { uid: `${n}_${RUN}`, email: `${n}_${RUN}@example.com`, emailVerified: true }]));
const auth = (u) => ({ authorization: `Bearer tok|${u.uid}` });
const allResponses = [];

async function run() {
  console.log(`# integration tests — store: ${SUPA ? 'supabase' : 'memory'}`);
  const [api, gh] = await Promise.all([apiServer, ghServer]);
  apiPort = api.address().port;
  ghPort = gh.address().port;
  testHttp = createSafeHttpClient({
    lookup: fakeLookup,
    // Test seam: ONLY the fake *.example.test / api.github.test names may
    // reach 127.0.0.1 (the local doubles); everything else uses the real rule.
    isAddressAllowed: (ip, host) => ((/\.example\.test$|^api\.github\.test$/.test(host) && ip === '127.0.0.1') || isPublicAddress(ip)),
    allowInsecureHttp: true,
    allowedPorts: [apiPort, ghPort],
  });
  registry = createConnectorRegistry([
    createHttpApiConnector({ allowInsecureHttpForTests: true }),
    createGithubConnector({ apiBase: `http://api.github.test:${ghPort}` }),
  ]);
  integrationService = createIntegrationService({
    store: intStore, registry, credentials, http: testHttp,
    getMemberRole: async (ws, uid) => { const m = await wsStore.getMember(ws, uid); return m ? m.role : null; },
    appendAuditLog, logger: { error() {}, warn() {} },
  });
  let sys = makeSystem();

  const app = express();
  app.use(express.json());
  app.use(sanitizeInput);
  app.use('/api', authenticateFirebaseUser);
  app.use('/api/workspaces/:workspaceId/integrations', (req, res, next) => sys.int(req, res, next));
  app.use('/api/workspaces/:workspaceId/workflows', (req, res, next) => sys.wf.workflows(req, res, next));
  app.use('/api/workspaces/:workspaceId/workflow-runs', (req, res, next) => sys.wf.runs(req, res, next));
  app.use('/api/workspaces/:workspaceId/executions', (req, res, next) => sys.exec(req, res, next));
  const srv = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${srv.address().port}`;
  const call = async (method, url, { as, body, headers = {} } = {}) => {
    const res = await fetch(base + url, { method, headers: { 'content-type': 'application/json', ...headers, ...(as ? auth(as) : {}) }, body: body !== undefined && method !== 'GET' ? JSON.stringify(body) : undefined });
    const text = await res.text();
    allResponses.push(text);
    let j = null;
    try { j = JSON.parse(text); } catch { /* none */ }
    return { status: res.status, body: j, text };
  };

  const team = await wsService.createWorkspace(U.alice, { name: 'Acme Tax' });
  const other = await wsService.createWorkspace(U.mallory, { name: 'Other Co' });
  const bobWs = await wsService.createWorkspace(U.bob, { name: 'Bob Solo' });
  for (const [u, role] of [[U.carol, 'admin'], [U.bob, 'member'], [U.dave, 'member']]) {
    const inv = await wsService.createInvitation({ workspace: team, role: 'owner', userId: U.alice.uid }, { email: u.email, role });
    await wsService.acceptInvitation(u, { token: inv.token });
  }
  const I = (ws) => `/api/workspaces/${ws.id}/integrations`;
  const WF = (ws) => `/api/workspaces/${ws.id}/workflows`;
  const RUNS = (ws) => `/api/workspaces/${ws.id}/workflow-runs`;
  sys.runner.start();

  const ghBody = (name = 'Books repo', extra = {}) => ({ provider: 'github', name, config: { allowedRepos: ['acme/books'] }, credentials: { token: GH_TOKEN }, ...extra });
  const apiBody = (name = 'Price API', config = {}, creds = { token: API_TOKEN }) => ({
    provider: 'http', name,
    config: { baseUrl: `http://api.example.test:${apiPort}/v1/`, authType: 'bearer', ...config },
    ...(creds ? { credentials: creds } : {}),
  });
  async function waitRun(as, ws, runId, statuses, tries = 800) {
    let last;
    for (let i = 0; i < tries; i++) {
      last = await call('GET', `${RUNS(ws)}/${runId}`, { as });
      if (last.status === 200 && statuses.includes(last.body.data.status)) return last.body.data;
      await sleep(10);
    }
    throw new Error(`run ${runId} never reached ${statuses}: ${JSON.stringify(last && last.body && last.body.data && { s: last.body.data.status, f: last.body.data.failure, st: last.body.data.steps.map((x) => [x.status, x.error]) })}`);
  }
  async function publishedWorkflow(as, ws, name, definition) {
    const c = await call('POST', WF(ws), { as, body: { name, definition } });
    assert.strictEqual(c.status, 201, JSON.stringify(c.body));
    const p = await call('POST', `${WF(ws)}/${c.body.data.id}/publish`, { as, body: {} });
    assert.ok([200, 201].includes(p.status), JSON.stringify(p.body));
    return c.body.data;
  }
  async function runWf(as, ws, wfId, inputs = {}) {
    const r = await call('POST', `${WF(ws)}/${wfId}/runs`, { as, body: { inputs } });
    assert.strictEqual(r.status, 201, JSON.stringify(r.body));
    return r.body.data;
  }
  const connectorStep = (integrationId, action, input, extra = {}) => ({ key: extra.key || `s_${action}`, name: extra.name || action, connector: { integrationId, action, input }, ...extra.step });

  // ==================================================================
  // B. Credential crypto
  // ==================================================================
  await test('B crypto: AES-256-GCM round trip, random IV, tamper / wrong-AAD / wrong-key all fail closed', async () => {
    const aad = Buffer.from('nexus-integration:w:i');
    const a = credentials.encrypt({ token: GH_TOKEN }, aad);
    const b = credentials.encrypt({ token: GH_TOKEN }, aad);
    assert.strictEqual(a.algorithm, 'aes-256-gcm');
    assert.strictEqual(a.key_id, 'test-k1');
    assert.notStrictEqual(a.iv, b.iv);
    assert.notStrictEqual(a.ciphertext, b.ciphertext);
    assert.ok(!JSON.stringify(a).includes(GH_TOKEN));
    assert.deepStrictEqual(credentials.decrypt(a, aad), { token: GH_TOKEN });
    const flipped = { ...a, ciphertext: Buffer.from(a.ciphertext, 'base64').map((x, i) => (i === 0 ? x ^ 1 : x)).toString('base64') };
    assert.throws(() => credentials.decrypt(flipped, aad), (e) => e.code === 'CREDENTIAL_CORRUPT' && !e.message.includes(GH_TOKEN));
    assert.throws(() => credentials.decrypt(a, Buffer.from('nexus-integration:w:OTHER')), (e) => e.code === 'CREDENTIAL_CORRUPT');
    const other = createCredentialService({ store: intStore, keyRing: loadKeyRing({ INTEGRATION_ENCRYPTION_KEY: crypto.randomBytes(32).toString('hex'), INTEGRATION_ENCRYPTION_KEY_ID: 'test-k1' }) });
    assert.throws(() => other.decrypt(a, aad), (e) => e.code === 'CREDENTIAL_CORRUPT');
    const unknownKey = createCredentialService({ store: intStore, keyRing: loadKeyRing({ INTEGRATION_ENCRYPTION_KEY: crypto.randomBytes(32).toString('hex'), INTEGRATION_ENCRYPTION_KEY_ID: 'k2' }) });
    assert.throws(() => unknownKey.decrypt(a, aad), (e) => e.code === 'CREDENTIALS_UNAVAILABLE');
    // rotation: new key current, old key kept readable
    const rotated = createCredentialService({ store: intStore, keyRing: loadKeyRing({ INTEGRATION_ENCRYPTION_KEY: crypto.randomBytes(32).toString('base64'), INTEGRATION_ENCRYPTION_KEY_ID: 'k2', INTEGRATION_ENCRYPTION_OLD_KEYS: `test-k1:${KEY_B64}` }) });
    assert.deepStrictEqual(rotated.decrypt(a, aad), { token: GH_TOKEN });
    assert.strictEqual(rotated.encrypt({ x: 1 }, aad).key_id, 'k2');
  });

  await test('B config: missing / malformed key → CREDENTIALS_UNAVAILABLE (fail closed, no plaintext fallback)', async () => {
    assert.ok(loadKeyRing({}).error);
    assert.ok(loadKeyRing({ INTEGRATION_ENCRYPTION_KEY: 'short' }).error);
    assert.ok(loadKeyRing({ INTEGRATION_ENCRYPTION_KEY: crypto.randomBytes(16).toString('hex') }).error, '16-byte key rejected');
    assert.ok(loadKeyRing({ INTEGRATION_ENCRYPTION_KEY: KEY_B64, INTEGRATION_ENCRYPTION_KEY_ID: 'bad id!' }).error);
    const off = createCredentialService({ store: intStore, keyRing: loadKeyRing({}) });
    assert.strictEqual(off.isConfigured(), false);
    assert.throws(() => off.encrypt({ token: 'x' }, Buffer.from('a')), (e) => e.code === 'CREDENTIALS_UNAVAILABLE');
    await assert.rejects(off.getCredentialForExecution({ workspaceId: team.id, integrationId: crypto.randomUUID() }), (e) => e.code === 'CREDENTIALS_UNAVAILABLE');
    // service level: nothing is created when the secret could not be encrypted
    const svcOff = createIntegrationService({ store: intStore, registry, credentials: off, http: testHttp, getMemberRole: async () => 'owner', appendAuditLog });
    await assert.rejects(svcOff.createIntegration({ workspace: team, role: 'owner', userId: U.alice.uid }, ghBody('Should not exist')), (e) => e.status === 503 && e.code === 'CREDENTIALS_UNAVAILABLE');
    assert.ok(!(await intStore.listIntegrations(team.id)).some((i) => i.name === 'Should not exist'));
  });

  // ==================================================================
  // A. Lifecycle + F. roles + D. no secrets in responses
  // ==================================================================
  let ghInt;
  let apiInt;
  await test('A/F lifecycle: admin connects GitHub; response has no token; members can only read metadata', async () => {
    const m = await call('POST', I(team), { as: U.bob, body: ghBody() });
    assert.strictEqual(m.status, 403, 'member cannot connect');
    const r = await call('POST', I(team), { as: U.carol, body: ghBody() });
    assert.strictEqual(r.status, 201, r.text);
    ghInt = r.body.data;
    assert.strictEqual(ghInt.status, 'connected');
    assert.strictEqual(ghInt.hasCredential, true);
    assert.strictEqual(ghInt.provider, 'github');
    assert.strictEqual(ghInt.workspaceId, team.id);
    assert.ok(!r.text.includes(GH_TOKEN));
    assert.deepStrictEqual(ghInt.config, { allowedRepos: ['acme/books'] });
    const acts = Object.fromEntries(ghInt.actions.map((a) => [a.name, a]));
    assert.strictEqual(acts.list_issues.enabled, true);
    assert.strictEqual(acts.list_issues.effectiveTier, 'green');
    assert.strictEqual(acts.create_issue.enabled, false, 'writes are disabled until an admin enables them');
    assert.strictEqual(acts.create_issue.risk, 'yellow');
    const l = await call('GET', I(team), { as: U.dave });
    assert.strictEqual(l.status, 200);
    assert.ok(l.body.data.some((x) => x.id === ghInt.id));
    assert.strictEqual((await call('GET', `${I(team)}/${ghInt.id}`, { as: U.dave })).status, 200);
    const dup = await call('POST', I(team), { as: U.alice, body: ghBody('books REPO') });
    assert.strictEqual(dup.status, 409, 'names are unique per workspace (case-insensitive)');
    const a2 = await call('POST', I(team), { as: U.alice, body: apiBody() });
    assert.strictEqual(a2.status, 201, a2.text);
    apiInt = a2.body.data;
  });

  await test('F roles: members cannot update, rotate, disconnect, health-check or change permissions (403)', async () => {
    for (const [m, suffix, body] of [['PATCH', '', { version: 0, name: 'x' }], ['POST', '/credentials', { credentials: { token: GH_TOKEN_2 } }], ['POST', '/disconnect', {}],
      ['POST', '/health', {}], ['PUT', '/permissions', { actions: { create_issue: { enabled: true } } }]]) {
      const r = await call(m, `${I(team)}/${ghInt.id}${suffix}`, { as: U.bob, body });
      assert.strictEqual(r.status, 403, `${m} ${suffix} → ${r.status}`);
    }
  });

  await test('A validation: unknown provider, bad config, bad credential, unknown fields → 400', async () => {
    const bad = [
      { provider: 'dropbox', name: 'x', config: {} },
      ghBody('g1', { config: { allowedRepos: [] } }),
      ghBody('g2', { config: { allowedRepos: ['not a repo'] } }),
      ghBody('g3', { credentials: { token: 'short' } }),
      ghBody('g4', { credentials: { token: GH_TOKEN, extra: 'x' } }),
      ghBody('g5', { config: { allowedRepos: ['acme/books'], apiBase: 'https://evil.example.org' } }),
      apiBody('h1', { baseUrl: 'ftp://api.example.com/' }),
      apiBody('h2', { authType: 'header', authHeaderName: 'Cookie' }),
      apiBody('h3', { authType: 'header', authHeaderName: 'Host' }),
      apiBody('h4', { allowedHosts: ['localhost'] }),
      apiBody('h5', { allowedHosts: ['*.internal'] }),
      apiBody('h6', { allowedPathPrefixes: ['/v1/../admin'] }),
      apiBody('h7', {}, null),
    ];
    for (const body of bad) {
      const r = await call('POST', I(team), { as: U.alice, body });
      assert.strictEqual(r.status, 400, `${JSON.stringify(body).slice(0, 100)} → ${r.status} ${r.text}`);
    }
  });

  await test('H config (production connector): https only, public DNS names only, no ports/userinfo/query', async () => {
    const prod = createHttpApiConnector();
    for (const baseUrl of ['http://api.example.com/', 'https://127.0.0.1/', 'https://localhost/', 'https://api.example.com:8443/', 'https://u:p@api.example.com/',
      'https://api.example.com/?a=1', 'https://metadata.google.internal/', 'https://10.0.0.1/', 'https://printer.local/', 'https://intranet/']) {
      assert.throws(() => prod.validateConfig({ baseUrl }), /baseUrl/, baseUrl);
    }
    assert.strictEqual(prod.validateConfig({ baseUrl: 'https://api.example.com/v2' }).baseUrl, 'https://api.example.com/v2/');
  });

  // ==================================================================
  // G. Registry
  // ==================================================================
  await test('G registry: providers endpoint describes actions, risk, approval and schemas; bad connectors rejected', async () => {
    const r = await call('GET', `${I(team)}/providers`, { as: U.dave });
    assert.strictEqual(r.status, 200);
    const gh = r.body.data.find((p) => p.provider === 'github');
    const ci = gh.actions.find((a) => a.name === 'create_issue');
    assert.strictEqual(ci.risk, 'yellow');
    assert.strictEqual(ci.requiresApproval, true);
    assert.strictEqual(ci.defaultEnabled, false);
    assert.strictEqual(ci.input.title.required, true);
    assert.ok(gh.credentialFields.every((f) => f.secret === true));
    assert.throws(() => createConnectorRegistry([createHttpApiConnector(), createHttpApiConnector()]), /duplicate/);
    assert.throws(() => createConnectorRegistry([{ provider: 'x1', actions: { a1: { risk: 'purple', safeToRepeat: () => true } } }]), /risk/);
    assert.throws(() => createConnectorRegistry([{ provider: 'x2', actions: { a1: { risk: 'green' } } }]), /safeToRepeat/);
  });

  // ==================================================================
  // E. Workspace isolation
  // ==================================================================
  await test('E isolation: other workspaces get 404 on every integration route (no existence oracle)', async () => {
    const fake = crypto.randomUUID();
    for (const [as, ws] of [[U.mallory, other], [U.mallory, team], [U.bob, bobWs]]) {
      for (const [m, suffix, body] of [['GET', '', undefined], ['PATCH', '', { version: 0, name: 'x' }], ['POST', '/credentials', { credentials: { token: GH_TOKEN_2 } }],
        ['POST', '/disconnect', {}], ['POST', '/health', {}], ['PUT', '/permissions', { actions: { list_issues: { enabled: false } } }]]) {
        const real = await call(m, `${I(ws)}/${ghInt.id}${suffix}`, { as, body });
        const missing = await call(m, `${I(ws)}/${fake}${suffix}`, { as, body });
        const expected = (as === U.mallory && ws === team) ? 404 : (as === U.bob && ws === bobWs) ? 404 : 404;
        assert.strictEqual(real.status, expected, `${ws.name} ${m} ${suffix}`);
        assert.strictEqual(real.status, missing.status, 'same response for a real foreign id and a random id');
        if (real.body && missing.body) assert.strictEqual(real.body.code, missing.body.code);
      }
    }
    const l = await call('GET', I(other), { as: U.mallory });
    assert.deepStrictEqual(l.body.data, []);
  });

  await test('E isolation: another workspace cannot use the integration from a workflow or the gateway', async () => {
    const c = await call('POST', WF(other), { as: U.mallory, body: { name: 'steal', definition: { steps: [connectorStep(ghInt.id, 'list_issues', { owner: 'acme', repo: 'books' })] } } });
    assert.strictEqual(c.status, 201, 'draft may reference any id…');
    const p = await call('POST', `${WF(other)}/${c.body.data.id}/publish`, { as: U.mallory, body: {} });
    assert.strictEqual(p.status, 400, '…but publishing checks it belongs to THIS workspace');
    assert.match(p.body.error, /not found in this workspace/);
    await assert.rejects(integrationService.gateway.prepareAction(other.id, U.mallory.uid, { integrationId: ghInt.id, action: 'list_issues', input: { owner: 'acme', repo: 'books' } }), (e) => e.code === 'INTEGRATION_NOT_FOUND');
    const before = ghLog.length;
    const r = await integrationService.gateway.executeAction(other.id, U.mallory.uid, { integrationId: ghInt.id, action: 'list_issues', input: { owner: 'acme', repo: 'books' } }, {});
    assert.strictEqual(r.success, false);
    assert.strictEqual(r.errorCode, 'INTEGRATION_NOT_FOUND');
    assert.strictEqual(ghLog.length, before, 'no call reached the provider');
    // a credential row can never be decrypted under another workspace
    await assert.rejects(credentials.getCredentialForExecution({ workspaceId: other.id, integrationId: ghInt.id }), (e) => e.code === 'CREDENTIAL_MISSING');
  });

  // ==================================================================
  // C. Plaintext never persisted
  // ==================================================================
  await test('C storage: the credential table holds only ciphertext; integrations/permissions rows hold no secret', async () => {
    const rec = await intStore.getCredential(team.id, ghInt.id);
    assert.ok(rec && rec.ciphertext && rec.iv && rec.auth_tag);
    assert.ok(!JSON.stringify(rec).includes(GH_TOKEN));
    const row = await intStore.getIntegration(team.id, ghInt.id);
    assert.ok(!JSON.stringify(row).includes(GH_TOKEN));
    if (!SUPA) assert.ok(!JSON.stringify(intStore._dump()).includes(GH_TOKEN));
  });

  // ==================================================================
  // I/J/K/L. SSRF, redirects, timeouts, size limits
  // ==================================================================
  await test('I SSRF (production client): loopback, private, link-local/metadata, internal names, IP tricks → blocked, no socket', async () => {
    const lookups = [];
    const prodClient = createSafeHttpClient({
      lookup: (h, o, cb) => { lookups.push(h); const map = { 'evil.example.com': '10.1.2.3', 'meta.example.com': '169.254.169.254', 'v6.example.com': '::1', 'mapped.example.com': '::ffff:127.0.0.1' }; cb(null, [{ address: map[h] || '93.184.216.34', family: map[h] && map[h].includes(':') ? 6 : 4 }]); },
    });
    const cases = [
      ['https://localhost/x', 'localhost'], ['https://127.0.0.1/x', '127.0.0.1'], ['https://[::1]/x', '::1'], ['https://169.254.169.254/latest/meta-data', '169.254.169.254'],
      ['https://metadata.google.internal/computeMetadata/v1', 'metadata.google.internal'], ['https://10.0.0.5/', '10.0.0.5'], ['https://2130706433/', '127.0.0.1'],
      ['https://0x7f.0.0.1/', '127.0.0.1'], ['https://[::ffff:127.0.0.1]/', '::ffff:7f00:1'], ['https://evil.example.com/', 'evil.example.com'], ['https://meta.example.com/', 'meta.example.com'],
      ['https://v6.example.com/', 'v6.example.com'], ['https://mapped.example.com/', 'mapped.example.com'], ['https://db/', 'db'], ['https://printer.local/', 'printer.local'],
      ['https://service.internal/', 'service.internal'],
    ];
    for (const [url, host] of cases) {
      await assert.rejects(prodClient.request({ url, allowedHosts: [host] }), (e) => ['BLOCKED_DESTINATION'].includes(e.code), url);
    }
    await assert.rejects(prodClient.request({ url: 'http://api.example.com/', allowedHosts: ['api.example.com'] }), (e) => e.code === 'BLOCKED_DESTINATION', 'plain http');
    await assert.rejects(prodClient.request({ url: 'https://user:pw@api.example.com/', allowedHosts: ['api.example.com'] }), (e) => e.code === 'BLOCKED_DESTINATION', 'userinfo');
    await assert.rejects(prodClient.request({ url: 'https://api.example.com:8443/', allowedHosts: ['api.example.com'] }), (e) => e.code === 'BLOCKED_DESTINATION', 'port');
    await assert.rejects(prodClient.request({ url: 'https://api.other.com/', allowedHosts: ['api.example.com'] }), (e) => e.code === 'HOST_NOT_ALLOWED');
    await assert.rejects(prodClient.request({ url: 'https://api.example.com/', allowedHosts: [] }), (e) => e.code === 'HOST_NOT_ALLOWED');
    await assert.rejects(prodClient.request({ url: 'https://api.example.com/', method: 'DELETE', allowedHosts: ['api.example.com'] }), (e) => e.code === 'METHOD_NOT_ALLOWED');
    // mixed DNS answer (one public, one private) is rejected
    const mixed = createSafeHttpClient({ lookup: (h, o, cb) => cb(null, [{ address: '93.184.216.34', family: 4 }, { address: '192.168.1.10', family: 4 }]) });
    await assert.rejects(mixed.request({ url: 'https://split.example.com/', allowedHosts: ['split.example.com'] }), (e) => e.code === 'BLOCKED_DESTINATION');
  });

  await test('I DNS rebinding: the host is resolved once per hop and the socket is pinned to the validated address', async () => {
    flipCount = 0;
    lookupCalls = [];
    const r = await testHttp.request({ url: `http://flip.example.test:${apiPort}/v1/prices?sku=pin`, allowedHosts: ['flip.example.test'] });
    assert.strictEqual(r.status, 200, 'reached the address that was validated');
    assert.strictEqual(lookupCalls.filter((h) => h === 'flip.example.test').length, 1, 'no second (rebindable) resolution');
    await assert.rejects(testHttp.request({ url: `http://flip.example.test:${apiPort}/v1/prices`, allowedHosts: ['flip.example.test'] }), (e) => e.code === 'BLOCKED_DESTINATION', 'the next resolution (private) is refused');
  });

  await test('J redirects: to a private address or an off-list host → blocked; same-host ok; loops bounded; POST never follows', async () => {
    const opts = { allowedHosts: ['api.example.test', 'internal.example.test'] };
    await assert.rejects(testHttp.request({ url: `http://api.example.test:${apiPort}/v1/redirect-internal`, ...opts }), (e) => e.code === 'BLOCKED_DESTINATION');
    await assert.rejects(testHttp.request({ url: `http://api.example.test:${apiPort}/v1/redirect-offlist`, ...opts }), (e) => e.code === 'HOST_NOT_ALLOWED' || e.code === 'BLOCKED_DESTINATION');
    const ok = await testHttp.request({ url: `http://api.example.test:${apiPort}/v1/redirect-ok`, ...opts });
    assert.strictEqual(ok.status, 200);
    assert.strictEqual(JSON.parse(ok.body).sku, 'redirected');
    await assert.rejects(testHttp.request({ url: `http://api.example.test:${apiPort}/v1/loop`, ...opts }), (e) => e.code === 'TOO_MANY_REDIRECTS');
    await assert.rejects(testHttp.request({ url: `http://api.example.test:${apiPort}/v1/redirect-ok`, method: 'POST', allowedMethods: ['POST'], body: '{}', ...opts }), (e) => e.code === 'REDIRECT_NOT_ALLOWED');
    // credentials are dropped when a redirect changes host
    apiLog.length = 0;
    await testHttp.request({ url: `http://api.example.test:${apiPort}/v1/redirect-cross`, headers: { Authorization: `Bearer ${API_TOKEN}` }, allowedHosts: ['api.example.test', 'cdn.example.test'] });
    const hop2 = apiLog.find((l) => l.query.sku === 'cdn');
    assert.ok(hop2, 'second hop reached');
    assert.strictEqual(hop2.headers.authorization, undefined, 'Authorization not forwarded cross-host');
    assert.strictEqual(apiLog[0].headers.authorization, `Bearer ${API_TOKEN}`);
  });

  await test('K/L timeout, response-size limit (declared and streamed), content-type allowlist', async () => {
    const t0 = Date.now();
    await assert.rejects(testHttp.request({ url: `http://api.example.test:${apiPort}/v1/slow`, allowedHosts: ['api.example.test'], timeoutMs: 800 }), (e) => e.code === 'TIMEOUT');
    assert.ok(Date.now() - t0 < 2500);
    await assert.rejects(testHttp.request({ url: `http://api.example.test:${apiPort}/v1/big`, allowedHosts: ['api.example.test'], maxBytes: 4096 }), (e) => e.code === 'RESPONSE_TOO_LARGE');
    await assert.rejects(testHttp.request({ url: `http://api.example.test:${apiPort}/v1/binary`, allowedHosts: ['api.example.test'], allowedContentTypes: ['application/json'] }), (e) => e.code === 'BAD_CONTENT_TYPE');
  });

  // ==================================================================
  // H. HTTP connector via the gateway
  // ==================================================================
  await test('H http.get: allowed path works with auth; traversal / other hosts / off-prefix paths refused', async () => {
    apiLog.length = 0;
    const gw = integrationService.gateway;
    const ok = await gw.executeAction(team.id, U.bob.uid, { integrationId: apiInt.id, action: 'get', input: { path: '/v1/prices', query: { sku: 'TP-1' } } }, { executionId: 'x' });
    assert.strictEqual(ok.success, true, JSON.stringify(ok));
    assert.deepStrictEqual(ok.data.data, { sku: 'TP-1', price: 499, currency: 'INR' });
    assert.strictEqual(apiLog[0].headers.authorization, `Bearer ${API_TOKEN}`, 'credential used on the wire…');
    assert.ok(!JSON.stringify(ok).includes(API_TOKEN), '…never in the result');
    for (const p of ['/v1/../admin', '//evil.example.org/x', '/admin', 'v1/prices', '/v1/prices?x=1', '/v1/%2e%2e/admin']) {
      const r = await gw.executeAction(team.id, U.bob.uid, { integrationId: apiInt.id, action: 'get', input: { path: p } }, {});
      assert.strictEqual(r.success, false, p);
      assert.strictEqual(r.errorCode, 'INVALID_CONNECTOR_INPUT', `${p} → ${r.errorCode}`);
    }
    const post = await gw.executeAction(team.id, U.bob.uid, { integrationId: apiInt.id, action: 'post_json', input: { path: '/v1/orders', body: {} } }, {});
    assert.strictEqual(post.errorCode, 'ACTION_NOT_AVAILABLE', 'POST requires allowPost in the integration config');
  });

  // ==================================================================
  // S. Evidence redaction (provider echoing the secret)
  // ==================================================================
  await test('S redaction: a provider that echoes the token back never leaks it into results, evidence or audit', async () => {
    const r = await integrationService.gateway.executeAction(team.id, U.bob.uid, { integrationId: apiInt.id, action: 'get', input: { path: '/v1/echo' } }, {});
    assert.strictEqual(r.success, true);
    assert.ok(!JSON.stringify(r).includes(API_TOKEN), JSON.stringify(r));
    const h = await integrationService.gateway.executeAction(team.id, U.bob.uid, { integrationId: apiInt.id, action: 'get', input: { path: '/v1/unauth' } }, {});
    assert.strictEqual(h.success, false);
    assert.strictEqual(h.errorCode, 'AUTH_FAILED');
    assert.ok(!JSON.stringify(h).includes(API_TOKEN));
    // an auth failure flags the integration; an admin reconnects with a new token
    assert.strictEqual((await intStore.getIntegration(team.id, apiInt.id)).status, 'revoked');
    const rot = await call('POST', `${I(team)}/${apiInt.id}/credentials`, { as: U.carol, body: { credentials: { token: API_TOKEN } } });
    assert.strictEqual(rot.status, 200);
    assert.strictEqual(rot.body.data.status, 'connected');
  });

  await test('S scrubbing: a shapeless secret echoed by a provider is removed even though no redaction pattern matches it', async () => {
    const c = await call('POST', I(team), { as: U.alice, body: apiBody('Echo API', { authType: 'header', authHeaderName: 'X-API-Key' }, { token: PLAIN_TOKEN }) });
    assert.strictEqual(c.status, 201, c.text);
    const r = await integrationService.gateway.executeAction(team.id, U.bob.uid, { integrationId: c.body.data.id, action: 'get', input: { path: '/v1/echo' } }, {});
    assert.strictEqual(r.success, true);
    assert.strictEqual(apiLog[apiLog.length - 1].headers['x-api-key'], PLAIN_TOKEN, 'sent on the wire');
    assert.strictEqual(r.data.data.youSent, '[REDACTED]');
    assert.ok(!JSON.stringify(r).includes(PLAIN_TOKEN));
    const e = await startExec(U.bob, team, { integrationId: c.body.data.id, action: 'get', input: { path: '/v1/echo' } });
    const ev = await sys.execService.getEvidence({ workspace: team, role: 'member', userId: U.bob.uid }, e.id);
    assert.ok(!JSON.stringify(ev).includes(PLAIN_TOKEN));
  });

  await test('S race: a provider auth failure never overrides a credential rotation that happened during the call', async () => {
    const pending = integrationService.gateway.executeAction(team.id, U.bob.uid, { integrationId: apiInt.id, action: 'get', input: { path: '/v1/unauth-slow' } }, {});
    await sleep(120);
    const rot = await call('POST', `${I(team)}/${apiInt.id}/credentials`, { as: U.carol, body: { credentials: { token: API_TOKEN } } });
    assert.strictEqual(rot.status, 200);
    const r = await pending;
    assert.strictEqual(r.errorCode, 'AUTH_FAILED');
    assert.strictEqual((await intStore.getIntegration(team.id, apiInt.id)).status, 'connected', 'the admin\'s reconnect wins');
  });

  // ==================================================================
  // M/O. GitHub connector through Layer 3
  // ==================================================================
  async function startExec(as, ws, connectorStepSpec, sysOverride) {
    const s = sysOverride || sys;
    const { execution } = await s.execService.createExecution({ workspace: ws, role: 'member', userId: as.uid }, { goal: 'Connector action', connectorStep: connectorStepSpec });
    for (let i = 0; i < 400; i++) {
      const e = await s.execService.getExecution({ workspace: ws, role: 'member', userId: as.uid }, execution.id);
      if (['completed', 'failed', 'cancelled', 'waiting_approval'].includes(e.status)) return e;
      await sleep(5);
    }
    throw new Error('execution did not settle');
  }

  await test('M/O GitHub reads through Layer 3: issues (PRs filtered), PRs, file content; evidence has provider/action/target, no token', async () => {
    const e = await startExec(U.bob, team, { integrationId: ghInt.id, action: 'list_issues', input: { owner: 'acme', repo: 'books' } });
    assert.strictEqual(e.status, 'completed', JSON.stringify(e.failure));
    const ev = await sys.execService.getEvidence({ workspace: team, role: 'member', userId: U.bob.uid }, e.id);
    const s0 = ev.steps[0];
    assert.strictEqual(s0.action, 'github.list_issues');
    assert.strictEqual(s0.tool, 'connector');
    assert.strictEqual(s0.riskTier, 'green');
    assert.strictEqual(s0.output.target.provider, 'github');
    assert.strictEqual(s0.output.target.resource, 'github:acme/books');
    assert.strictEqual(s0.output.data.count, 1, 'pull requests are filtered out of issues');
    assert.strictEqual(s0.verification.status, 'verified');
    assert.ok(!JSON.stringify(ev).includes(GH_TOKEN));
    const f = await startExec(U.bob, team, { integrationId: ghInt.id, action: 'read_file', input: { owner: 'acme', repo: 'books', path: 'docs/README.md' } });
    const fev = await sys.execService.getEvidence({ workspace: team, role: 'member', userId: U.bob.uid }, f.id);
    assert.match(fev.steps[0].output.data.content || JSON.stringify(fev.steps[0].output.data), /GST filing helper/);
    const dir = await startExec(U.bob, team, { integrationId: ghInt.id, action: 'read_file', input: { owner: 'acme', repo: 'books', path: 'docs' } });
    assert.strictEqual(dir.failure.code, 'CONNECTOR_NOT_A_FILE');
    const pr = await startExec(U.bob, team, { integrationId: ghInt.id, action: 'list_pull_requests', input: { owner: 'acme', repo: 'books', state: 'all', limit: '5' } });
    assert.strictEqual(pr.status, 'completed');
    const repo = await startExec(U.bob, team, { integrationId: ghInt.id, action: 'get_repository', input: { owner: 'acme', repo: 'books' } });
    assert.strictEqual(repo.status, 'completed');
  });

  await test('M GitHub: repository allowlist, path traversal and unknown actions are refused before any API call', async () => {
    const before = ghLog.length;
    for (const [action, input, code] of [
      ['list_issues', { owner: 'acme', repo: 'payroll' }, 'INVALID_CONNECTOR_INPUT'],
      ['read_file', { owner: 'acme', repo: 'books', path: '../../etc/passwd' }, 'INVALID_CONNECTOR_INPUT'],
      ['read_file', { owner: 'acme', repo: 'books', path: '/abs' }, 'INVALID_CONNECTOR_INPUT'],
      ['merge_pull_request', { owner: 'acme', repo: 'books' }, 'ACTION_NOT_AVAILABLE'],
      ['list_issues', { owner: 'acme', repo: 'books', extra: 'x' }, 'INVALID_CONNECTOR_INPUT'],
    ]) {
      const e = await startExec(U.bob, team, { integrationId: ghInt.id, action, input });
      assert.strictEqual(e.status, 'failed');
      assert.strictEqual(e.failure.code, code, `${action} ${JSON.stringify(input)} → ${e.failure.code}`);
    }
    assert.strictEqual(ghLog.length, before);
  });

  await test('O Layer 3 input validation: malformed connector steps → 400; gateway missing → INTEGRATIONS_DISABLED', async () => {
    for (const cs of [{ integrationId: 'nope', action: 'list_issues' }, { integrationId: ghInt.id, action: 'Bad Action' }, { integrationId: ghInt.id, action: 'list_issues', input: [] }]) {
      await assert.rejects(sys.execService.createExecution({ workspace: team, role: 'member', userId: U.bob.uid }, { goal: 'x', connectorStep: cs }), (e) => e.status === 400);
    }
    const bare = createAgentExecutionService({ store: execStore, options: { retryDelayMs: 0 }, deps: { appendAuditLog }, logger: { error() {} } });
    const e = await startExec(U.bob, team, { integrationId: ghInt.id, action: 'list_issues', input: { owner: 'acme', repo: 'books' } }, { execService: bare });
    assert.strictEqual(e.failure.code, 'INTEGRATIONS_DISABLED');
  });

  // ==================================================================
  // N. Approval / risk / permissions
  // ==================================================================
  let issueRun;
  await test('N writes: create_issue is disabled by default → run fails with a clear error, no API call', async () => {
    const w = await publishedWorkflow(U.bob, team, 'File issue', { variables: [{ name: 'title' }], steps: [connectorStep(ghInt.id, 'create_issue', { owner: 'acme', repo: 'books', title: '{{input.title}}' })] });
    const before = ghLog.filter((l) => l.method === 'POST').length;
    const r = await waitRun(U.bob, team, (await runWf(U.bob, team, w.id, { title: 'Totals off' })).id, ['failed', 'completed', 'waiting_approval']);
    assert.strictEqual(r.status, 'failed');
    assert.strictEqual(r.failure.code, 'ACTION_NOT_ENABLED');
    assert.strictEqual(ghLog.filter((l) => l.method === 'POST').length, before);
  });

  await test('N writes: once enabled, create_issue (YELLOW) waits for approval; others cannot approve; initiator approves → exactly one issue', async () => {
    const p = await call('PUT', `${I(team)}/${ghInt.id}/permissions`, { as: U.carol, body: { actions: { create_issue: { enabled: true } } } });
    assert.strictEqual(p.status, 200, p.text);
    const w = await publishedWorkflow(U.bob, team, 'File issue 2', { variables: [{ name: 'title' }], steps: [connectorStep(ghInt.id, 'create_issue', { owner: 'acme', repo: 'books', title: 'Bug: {{input.title}}', body: 'Found by Nexus' })] });
    issueRun = await runWf(U.bob, team, w.id, { title: 'Totals off' });
    const waiting = await waitRun(U.bob, team, issueRun.id, ['waiting_approval', 'failed']);
    assert.strictEqual(waiting.status, 'waiting_approval', JSON.stringify(waiting.failure));
    const appr = waiting.steps[0].execution.waitingForApproval;
    assert.strictEqual(appr.action, 'github.create_issue');
    assert.strictEqual(appr.riskTier, 'yellow');
    assert.strictEqual(appr.step.parameters.input.title, 'Bug: Totals off');
    assert.ok(!JSON.stringify(waiting).includes(GH_TOKEN));
    const issuePosts = () => ghLog.filter((l) => l.method === 'POST' && l.path === '/repos/acme/books/issues');
    const before = issuePosts().length;
    assert.strictEqual((await call('POST', `${RUNS(team)}/${issueRun.id}/steps/0/approvals/${appr.id}/approve`, { as: U.dave, body: {} })).status, 403);
    assert.strictEqual((await call('POST', `${RUNS(other)}/${issueRun.id}/steps/0/approvals/${appr.id}/approve`, { as: U.mallory, body: {} })).status, 404);
    const rs = await Promise.all([1, 2, 3].map(() => call('POST', `${RUNS(team)}/${issueRun.id}/steps/0/approvals/${appr.id}/approve`, { as: U.bob, body: {} })));
    assert.strictEqual(rs.filter((r) => r.status === 200).length, 1);
    const done = await waitRun(U.bob, team, issueRun.id, ['completed', 'failed']);
    assert.strictEqual(done.status, 'completed', JSON.stringify(done.failure));
    const posts = issuePosts();
    assert.strictEqual(posts.length, before + 1, 'exactly one issue created (nothing before approval, once after)');
    assert.strictEqual(JSON.parse(posts[posts.length - 1].body).title, 'Bug: Totals off');
    assert.strictEqual(done.steps[0].execution.verification.status, 'verified');
    assert.match(done.steps[0].output.message, /Created issue #\d+/);
  });

  await test('N policy: admin can require ADMIN approval even for a read; members cannot approve it; minRole blocks members', async () => {
    await call('PUT', `${I(team)}/${ghInt.id}/permissions`, { as: U.alice, body: { actions: { get_repository: { approval: 'admin' }, list_pull_requests: { minRole: 'admin' } } } });
    const w = await publishedWorkflow(U.bob, team, 'Guarded read', { steps: [connectorStep(ghInt.id, 'get_repository', { owner: 'acme', repo: 'books' })] });
    const r1 = await runWf(U.bob, team, w.id);
    const waiting = await waitRun(U.bob, team, r1.id, ['waiting_approval', 'failed', 'completed']);
    const a = waiting.steps[0].execution.waitingForApproval;
    assert.strictEqual(a.riskTier, 'red');
    assert.strictEqual(a.requiredRole, 'admin');
    assert.strictEqual((await call('POST', `${RUNS(team)}/${r1.id}/steps/0/approvals/${a.id}/approve`, { as: U.bob, body: {} })).status, 403);
    assert.strictEqual((await call('POST', `${RUNS(team)}/${r1.id}/steps/0/approvals/${a.id}/reject`, { as: U.carol, body: {} })).status, 200);
    assert.strictEqual((await waitRun(U.bob, team, r1.id, ['failed'])).failure.code, 'APPROVAL_REJECTED');
    const w2 = await publishedWorkflow(U.bob, team, 'Admin-only read', { steps: [connectorStep(ghInt.id, 'list_pull_requests', { owner: 'acme', repo: 'books' })] });
    const r2 = await waitRun(U.bob, team, (await runWf(U.bob, team, w2.id)).id, ['failed', 'completed']);
    assert.strictEqual(r2.failure.code, 'PERMISSION_DENIED');
    const r3 = await waitRun(U.carol, team, (await runWf(U.carol, team, w2.id)).id, ['failed', 'completed']);
    assert.strictEqual(r3.status, 'completed', 'an admin initiator passes the minimum role');
    await call('PUT', `${I(team)}/${ghInt.id}/permissions`, { as: U.alice, body: { actions: { get_repository: { approval: 'default' }, list_pull_requests: { minRole: 'member' } } } });
    const bad = await call('PUT', `${I(team)}/${ghInt.id}/permissions`, { as: U.alice, body: { actions: { merge_pull_request: { enabled: true } } } });
    assert.strictEqual(bad.status, 400, 'unknown / destructive actions cannot be enabled');
    const bad2 = await call('PUT', `${I(team)}/${apiInt.id}/permissions`, { as: U.alice, body: { actions: { post_json: { enabled: true } } } });
    assert.strictEqual(bad2.status, 400, 'POST cannot be enabled unless allowPost is configured');
  });

  // ==================================================================
  // P. Layer 4 workflow: http → agent → github
  // ==================================================================
  await test('P workflow: HTTP read → agent analysis → GitHub issue; outputs chained; one task; evidence per step', async () => {
    SCRIPTS.analyze = (n) => (n === 0 ? { done: false, action: 'read_text', payload: { platform: 'browser', parameters: {}, target: {}, value: null } } : { done: true, reason: 'Price 499 is 10% above target' });
    const w = await publishedWorkflow(U.bob, team, 'Competitor research', {
      variables: [{ name: 'sku' }],
      steps: [
        connectorStep(apiInt.id, 'get', { path: '/v1/prices', query: '{"sku":"{{input.sku}}"}' }, { key: 'fetch', name: 'Fetch price' }),
        { key: 'analyze', name: 'Analyze', instruction: 'analyze the price data: {{steps.fetch.output}}' },
        { ...connectorStep(ghInt.id, 'create_issue', { owner: 'acme', repo: 'books', title: 'Price alert {{input.sku}}', body: '{{steps.analyze.output}}' }, { key: 'file', name: 'File issue' }) },
      ],
    });
    const run1 = await runWf(U.bob, team, w.id, { sku: 'TP-9' });
    const waiting = await waitRun(U.bob, team, run1.id, ['waiting_approval', 'failed']);
    assert.strictEqual(waiting.status, 'waiting_approval', JSON.stringify(waiting.failure || waiting.steps.map((s) => s.error)));
    assert.deepStrictEqual(waiting.steps.map((s) => s.status), ['succeeded', 'succeeded', 'waiting_approval']);
    assert.match(waiting.steps[0].output.message, /HTTP 200/);
    const a = waiting.steps[2].execution.waitingForApproval;
    assert.strictEqual(a.step.parameters.input.body, 'Price 499 is 10% above target');
    assert.ok(prompts.some((p) => p.includes('analyze the price data: HTTP 200 from api.example.test')), 'agent step saw the connector output');
    assert.strictEqual((await call('POST', `${RUNS(team)}/${run1.id}/steps/2/approvals/${a.id}/approve`, { as: U.bob, body: {} })).status, 200);
    const done = await waitRun(U.bob, team, run1.id, ['completed', 'failed']);
    assert.strictEqual(done.status, 'completed', JSON.stringify(done.failure));
    const ev = await call('GET', `${RUNS(team)}/${run1.id}/evidence`, { as: U.dave });
    assert.strictEqual(ev.status, 200);
    assert.deepStrictEqual(ev.body.data.steps.map((s) => s.executions[0].steps[0].action), ['http.get', 'read_text', 'github.create_issue']);
    for (const s of ev.body.data.steps) assert.strictEqual(s.executions[0].execution.taskId, done.taskId);
    assert.ok(!ev.text.includes(GH_TOKEN) && !ev.text.includes(API_TOKEN));
  });

  // ==================================================================
  // Q/R. Idempotency + retry safety
  // ==================================================================
  let postInt;
  await test('Q/R POST: controlled POST needs admin config + enablement; idempotency key is stable per workflow step', async () => {
    const r = await call('POST', I(team), { as: U.alice, body: apiBody('Orders API', { allowPost: true, postPathPrefixes: ['/v1/orders'], idempotencyHeader: 'Idempotency-Key' }) });
    assert.strictEqual(r.status, 201, r.text);
    postInt = r.body.data;
    assert.strictEqual(postInt.actions.find((a) => a.name === 'post_json').enabled, false);
    assert.strictEqual(postInt.actions.find((a) => a.name === 'post_json').safeToRetry, true, 'idempotency header configured');
    await call('PUT', `${I(team)}/${postInt.id}/permissions`, { as: U.alice, body: { actions: { post_json: { enabled: true } } } });
    const w = await publishedWorkflow(U.bob, team, 'Place order', { steps: [connectorStep(postInt.id, 'post_json', { path: '/v1/orders', body: '{"sku":"TP-1","qty":2}' })] });
    const run1 = await runWf(U.bob, team, w.id);
    const waiting = await waitRun(U.bob, team, run1.id, ['waiting_approval', 'failed']);
    const a = waiting.steps[0].execution.waitingForApproval;
    assert.strictEqual(a.riskTier, 'yellow');
    apiLog.length = 0;
    await call('POST', `${RUNS(team)}/${run1.id}/steps/0/approvals/${a.id}/approve`, { as: U.bob, body: {} });
    const done = await waitRun(U.bob, team, run1.id, ['completed', 'failed']);
    assert.strictEqual(done.status, 'completed', JSON.stringify(done.failure));
    const orders = apiLog.filter((l) => l.path === '/v1/orders');
    assert.strictEqual(orders.length, 1);
    assert.strictEqual(orders[0].headers['idempotency-key'], `wfstep:${run1.id}:0`);
    assert.deepStrictEqual(JSON.parse(orders[0].body), { sku: 'TP-1', qty: 2 });
  });

  await test('R retry safety: transient failure of a READ is retried once by Layer 3; a failed non-idempotent WRITE is never retried → needs review', async () => {
    failOnceCount = 0;
    const e = await startExec(U.bob, team, { integrationId: apiInt.id, action: 'get', input: { path: '/v1/fail-once' } });
    assert.strictEqual(e.status, 'completed', JSON.stringify(e.failure));
    const ev = await sys.execService.getEvidence({ workspace: team, role: 'member', userId: U.bob.uid }, e.id);
    assert.strictEqual(ev.steps[0].attempts, 2);
    assert.strictEqual(ev.steps[0].recovery.strategy, 'retry_idempotent');
    // non-idempotent POST (no idempotency header) failing with a 500
    const r = await call('POST', I(team), { as: U.alice, body: apiBody('Orders no-idem', { allowPost: true }) });
    await call('PUT', `${I(team)}/${r.body.data.id}/permissions`, { as: U.alice, body: { actions: { post_json: { enabled: true } } } });
    const w = await publishedWorkflow(U.bob, team, 'Failing order', { steps: [{ ...connectorStep(r.body.data.id, 'post_json', { path: '/v1/orders-fail', body: '{"a":1}' }), retry: { maxAttempts: 3 } }] });
    const run1 = await runWf(U.bob, team, w.id);
    const waiting = await waitRun(U.bob, team, run1.id, ['waiting_approval', 'failed']);
    apiLog.length = 0;
    await call('POST', `${RUNS(team)}/${run1.id}/steps/0/approvals/${waiting.steps[0].execution.waitingForApproval.id}/approve`, { as: U.bob, body: {} });
    const rv = await waitRun(U.bob, team, run1.id, ['needs_review', 'failed', 'completed']);
    assert.strictEqual(rv.status, 'needs_review', JSON.stringify(rv.failure));
    assert.strictEqual(apiLog.filter((l) => l.path === '/v1/orders-fail').length, 1, 'the POST was sent exactly once');
    assert.match(rv.reviewReason, /human-approved|http\.post_json/);
  });

  await test('R crash during a non-idempotent connector call → recovery never re-sends it (needs review)', async () => {
    const r = await call('POST', I(team), { as: U.alice, body: apiBody('Orders slow', { allowPost: true, timeoutMs: 30000 }) });
    await call('PUT', `${I(team)}/${r.body.data.id}/permissions`, { as: U.alice, body: { actions: { post_json: { enabled: true, approval: 'default' } } } });
    // policy: make the (yellow) write auto-approved for this test by approving via API as usual
    const w = await publishedWorkflow(U.bob, team, 'Slow order', { steps: [{ ...connectorStep(r.body.data.id, 'post_json', { path: '/v1/orders-slow', body: '{"a":1}' }), retry: { maxAttempts: 3 } }] });
    const run1 = await runWf(U.bob, team, w.id);
    const waiting = await waitRun(U.bob, team, run1.id, ['waiting_approval', 'failed']);
    apiLog.length = 0;
    await call('POST', `${RUNS(team)}/${run1.id}/steps/0/approvals/${waiting.steps[0].execution.waitingForApproval.id}/approve`, { as: U.bob, body: {} });
    for (let i = 0; i < 300 && !apiLog.some((l) => l.path === '/v1/orders-slow'); i++) await sleep(10);
    assert.ok(apiLog.some((l) => l.path === '/v1/orders-slow'), 'request in flight');
    // crash: abandon the worker; a fresh process takes over after the lease expires
    await sys.runner.stop({ abandon: true });
    sys = makeSystem();
    await sleep(2700);
    sys.runner.start();
    const rv = await waitRun(U.bob, team, run1.id, ['needs_review', 'failed', 'completed'], 1500);
    assert.strictEqual(rv.status, 'needs_review');
    assert.strictEqual(apiLog.filter((l) => l.path === '/v1/orders-slow').length, 1, 'never re-sent');
  });

  // ==================================================================
  // U. Disconnected / revoked
  // ==================================================================
  await test('U disconnect: secret deleted; workflows fail fast with a connection error and never call the provider; reconnect restores', async () => {
    const w = await publishedWorkflow(U.bob, team, 'Read issues', { steps: [connectorStep(ghInt.id, 'list_issues', { owner: 'acme', repo: 'books' })] });
    const d = await call('POST', `${I(team)}/${ghInt.id}/disconnect`, { as: U.carol, body: {} });
    assert.strictEqual(d.status, 200);
    assert.strictEqual(d.body.data.status, 'disconnected');
    assert.strictEqual(d.body.data.hasCredential, false);
    assert.strictEqual(await intStore.getCredential(team.id, ghInt.id), null, 'ciphertext removed');
    const before = ghLog.length;
    const r = await waitRun(U.bob, team, (await runWf(U.bob, team, w.id)).id, ['failed', 'completed']);
    assert.strictEqual(r.status, 'failed');
    assert.strictEqual(r.failure.code, 'INTEGRATION_UNAVAILABLE');
    assert.match(r.failure.message, /disconnected; an admin must reconnect it/);
    assert.strictEqual(ghLog.length, before);
    assert.strictEqual((await call('POST', `${I(team)}/${ghInt.id}/health`, { as: U.carol, body: {} })).status, 409);
    const rc = await call('POST', `${I(team)}/${ghInt.id}/credentials`, { as: U.carol, body: { credentials: { token: GH_TOKEN_2 } } });
    assert.strictEqual(rc.body.data.status, 'connected');
    const ok = await waitRun(U.bob, team, (await runWf(U.bob, team, w.id)).id, ['failed', 'completed']);
    assert.strictEqual(ok.status, 'completed');
    assert.strictEqual(ghLog[ghLog.length - 1].auth, `Bearer ${GH_TOKEN_2}`, 'rotated token in use');
  });

  await test('U health: good token → connected; provider rejects token → revoked, runs then fail without calling it', async () => {
    const h = await call('POST', `${I(team)}/${ghInt.id}/health`, { as: U.carol, body: {} });
    assert.strictEqual(h.status, 200);
    assert.deepStrictEqual([h.body.data.ok, h.body.data.status], [true, 'connected']);
    assert.match(h.body.data.detail, /nexus-bot/);
    const badTok = `ghp_${crypto.randomBytes(18).toString('hex')}`;
    await call('POST', `${I(team)}/${ghInt.id}/credentials`, { as: U.carol, body: { credentials: { token: badTok } } });
    const h2 = await call('POST', `${I(team)}/${ghInt.id}/health`, { as: U.carol, body: {} });
    assert.deepStrictEqual([h2.body.data.ok, h2.body.data.status], [false, 'revoked']);
    assert.ok(!h2.text.includes(badTok));
    const w = await publishedWorkflow(U.bob, team, 'After revoke', { steps: [connectorStep(ghInt.id, 'get_repository', { owner: 'acme', repo: 'books' })] });
    const before = ghLog.length;
    const r = await waitRun(U.bob, team, (await runWf(U.bob, team, w.id)).id, ['failed', 'completed']);
    assert.strictEqual(r.failure.code, 'INTEGRATION_UNAVAILABLE');
    assert.strictEqual(ghLog.length, before);
    SECRETS.push(badTok);
    await call('POST', `${I(team)}/${ghInt.id}/credentials`, { as: U.carol, body: { credentials: { token: GH_TOKEN } } });
  });

  await test('A update: config edit needs the current version; concurrent edits → one wins', async () => {
    const g = (await call('GET', `${I(team)}/${ghInt.id}`, { as: U.carol })).body.data;
    const rs = await Promise.all(['A', 'B'].map((n) => call('PATCH', `${I(team)}/${ghInt.id}`, { as: U.carol, body: { version: g.version, name: `Books ${n}` } })));
    assert.deepStrictEqual(rs.map((r) => r.status).sort(), [200, 409]);
    const stale = await call('PATCH', `${I(team)}/${ghInt.id}`, { as: U.carol, body: { version: g.version, config: { allowedRepos: ['acme/*'] } } });
    assert.strictEqual(stale.status, 409);
  });

  await test('P publish guard: workflows without the integrations layer refuse connector steps (INTEGRATIONS_DISABLED)', async () => {
    const svc = createWorkflowService({ store: wfStore, dataStore, executionService: sys.execService, appendAuditLog });
    const ctx = { workspace: team, role: 'owner', userId: U.alice.uid };
    const w = await svc.createWorkflow(ctx, { name: 'No integrations', definition: { steps: [connectorStep(ghInt.id, 'list_issues', { owner: 'acme', repo: 'books' })] } });
    await assert.rejects(svc.publishWorkflow(ctx, w.id), (e) => e.code === 'INTEGRATIONS_DISABLED');
  });

  // ==================================================================
  // T. Audit + global secret scan
  // ==================================================================
  await test('T audit: lifecycle + execution events with workspace/actor/provider/action/result, never secrets', async () => {
    for (const action of ['integration_connected', 'integration_disconnected', 'integration_permissions_changed', 'integration_credential_rotated',
      'integration_health_checked', 'integration_updated', 'connector_executed', 'agent_execution_approval_approve', 'agent_execution_approval_reject']) {
      assert.ok(auditRows.some((a) => a.action === action), `missing ${action}`);
    }
    const exec = auditRows.filter((a) => a.action === 'connector_executed');
    assert.ok(exec.some((a) => a.result.success === false && a.payload.code));
    for (const a of exec) {
      assert.ok(a.workspaceId && a.userId && a.payload.action);
      assert.ok(a.payload.provider || a.payload.code === 'INTEGRATION_NOT_FOUND');
    }
    const mentions = auditRows.filter((a) => a.payload && a.payload.integrationId === ghInt.id);
    // Team events are attributed to the team; a foreign workspace's failed
    // attempt is audited in ITS OWN workspace and discloses nothing (no provider).
    for (const a of mentions) {
      if (a.workspaceId !== team.id) {
        assert.strictEqual(a.payload.code, 'INTEGRATION_NOT_FOUND');
        assert.strictEqual(a.payload.provider, null);
        assert.strictEqual(a.result.success, false);
      }
    }
    assert.ok(mentions.filter((a) => a.workspaceId === team.id).length > 5);
  });

  await test('D/S/T secret scan: no generated secret appears in ANY API response, audit row, planner prompt, execution, step, approval, task or run', async () => {
    const dumps = [allResponses.join('\n'), JSON.stringify(auditRows), prompts.join('\n')];
    const execs = await execStore.listExecutions(team.id, { limit: 200 });
    for (const e of execs) {
      dumps.push(JSON.stringify(e), JSON.stringify(await execStore.listSteps(team.id, e.id)), JSON.stringify(await execStore.listApprovals(team.id, e.id)));
    }
    for (const r of await wfStore.listRuns(team.id, { limit: 100 })) {
      dumps.push(JSON.stringify(r), JSON.stringify(await wfStore.listRunSteps(team.id, r.id)));
      if (r.task_id) dumps.push(JSON.stringify(await dataStore.getTask(team.id, r.task_id)), JSON.stringify(await dataStore.listActivity(team.id, r.task_id, { limit: 100 })));
    }
    dumps.push(JSON.stringify(await intStore.listIntegrations(team.id)));
    const all = dumps.join('\n');
    assert.ok(all.length > 10000, 'scanned a meaningful amount of data');
    for (const s of SECRETS) assert.ok(!all.includes(s), `secret leaked: ${s.slice(0, 6)}…`);
  });

  await sys.runner.stop();
  srv.close();
  (await apiServer).close();
  (await ghServer).close();
  console.log(`\n${passed} passed, ${failed} failed (store: ${SUPA ? 'supabase' : 'memory'})`);
  process.exit(failed ? 1 : 0);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
