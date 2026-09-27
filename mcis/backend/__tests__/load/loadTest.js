/**
 * Layer 9 — load / concurrency measurements (NOT part of `npm test`).
 *
 *   node __tests__/load/loadTest.js            (memory stores)
 *   WORKSPACE_TEST_STORE=supabase SUPABASE_URL=… SUPABASE_KEY=… node __tests__/load/loadTest.js
 *
 * Real: HTTP stack, Firebase-auth middleware, Layer 1 workspace context,
 * Layer 3 executions, Layer 4 workflows + durable runner, Layer 6 firewall
 * + API keys + automation API, Layer 7 entitlements / reservations.
 * Doubles: Firebase token verification, Gemini planner, Nexus bridge (a
 * fixed 5 ms "desktop action"). Numbers describe THIS machine and THIS
 * store; they are not a production capacity claim.
 *
 * Prints one JSON document with every scenario's measurements and the
 * correctness checks made under load (exit 1 if a check fails).
 */
'use strict';

const assert = require('assert');
const Module = require('module');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..', '..');
const R = (...p) => require.resolve(path.join(ROOT, ...p));
const SUPA = process.env.WORKSPACE_TEST_STORE === 'supabase';
if (!SUPA) { process.env.SUPABASE_URL = 'http://127.0.0.1:9'; process.env.SUPABASE_KEY = 'unused'; }
process.env.NODE_ENV = 'production';
delete process.env.ALLOW_UNAUTHENTICATED_API;

function fakeModule(p, exp) { const m = new Module(p, null); m.exports = exp; m.loaded = true; require.cache[p] = m; }
if (!SUPA) fakeModule(require.resolve('@supabase/supabase-js'), { createClient: () => ({ from() { const b = { select() { return b; }, eq() { return b; }, async maybeSingle() { return { data: null, error: null }; }, async insert() { return { data: null, error: null }; } }; return b; } }) });
fakeModule(R('config', 'firebaseAdmin.js'), () => ({ auth: () => ({ async verifyIdToken(t) { const [k, uid] = String(t).split('|'); if (k !== 'tok' || !uid) throw new Error('bad'); return { uid, email: `${uid}@example.com`, email_verified: true }; } }) }));
fakeModule(R('services', 'logger.js'), { info() {}, warn() {}, error() {}, debug() {} });
fakeModule(R('backend-routing', 'geminiClient.js'), {
  generateContent: async (prompt) => {
    const section = prompt.split('Steps executed so far:\n')[1].split('\n\nClarifications')[0];
    const n = (section.match(/^\d+\. /gm) || []).length;
    const reply = n === 0 ? { done: false, action: 'read_text', payload: { platform: 'browser', parameters: {}, target: {}, value: null } } : { done: true, reason: 'done' };
    return { response: { text: () => JSON.stringify(reply) } };
  },
});
let nexusCount = 0;
fakeModule(R('backend-routing', 'nexusBridge.js'), { sendCommandToNexus: async () => { nexusCount++; await new Promise((r) => setTimeout(r, 5)); return { success: true, data: 'ok', evidence: { verified: true } }; } });

const express = require('express');
const auth = require(R('middleware', 'auth.js'));
const { createWorkspaceService } = require(R('services', 'workspaceService.js'));
const { createAgentExecutionService } = require(R('services', 'agentExecution', 'executionService.js'));
const { createWorkflowService } = require(R('services', 'workflows', 'workflowService.js'));
const { createWorkflowRunner } = require(R('services', 'workflows', 'workflowRunner.js'));
const { createWorkflowRouters } = require(R('routes', 'workflows.js'));
const { createAgentFirewall } = require(R('services', 'security', 'agentFirewall.js'));
const { createSecurityEvents, createDbRateLimiter } = require(R('services', 'security', 'securityEvents.js'));
const { createApiKeyService } = require(R('services', 'security', 'apiKeyService.js'));
const { createAutomationRouter } = require(R('routes', 'automation.js'));
const { createEntitlementService } = require(R('services', 'billing', 'entitlementService.js'));
const { createSubscriptionService } = require(R('services', 'billing', 'subscriptionService.js'));
const { createNoProvider } = require(R('services', 'billing', 'providers.js'));
const { createCounters } = require(R('routes', 'billing.js'));
const policyEngine = require(R('services', 'security', 'policyEngine.js'));
const S = (n) => require(path.join(__dirname, '..', 'support', n));

const RUN = crypto.randomBytes(3).toString('hex');
const quiet = { error() {}, warn() {}, info() {} };
const pct = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s.length ? +s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))].toFixed(2) : null; };
const stats = (xs) => ({ n: xs.length, p50: pct(xs, 50), p95: pct(xs, 95), p99: pct(xs, 99), max: xs.length ? +Math.max(...xs).toFixed(2) : null });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const now = () => new Date();
  let wsStore; let execStore; let dataStore; let wfStore; let secStore; let billStore; let db = null;
  if (SUPA) {
    wsStore = require(R('services', 'workspaceStore.js')).createSupabaseWorkspaceStore();
    execStore = require(R('services', 'agentExecution', 'executionStore.js')).createSupabaseExecutionStore();
    dataStore = require(R('services', 'workspaceData', 'workspaceDataStore.js')).createSupabaseWorkspaceDataStore();
    wfStore = require(R('services', 'workflows', 'workflowStore.js')).createSupabaseWorkflowStore();
    secStore = require(R('services', 'security', 'securityStore.js')).createSupabaseSecurityStore();
    billStore = require(R('services', 'billing', 'billingStore.js')).createSupabaseBillingStore();
    db = require('@supabase/supabase-js').createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
  } else {
    wsStore = S('memoryWorkspaceStore.js').createMemoryWorkspaceStore();
    execStore = S('memoryExecutionStore.js').createMemoryExecutionStore();
    dataStore = S('memoryWorkspaceDataStore.js').createMemoryWorkspaceDataStore();
    wfStore = S('memoryWorkflowStore.js').createMemoryWorkflowStore({ taskExists: async () => true });
    secStore = S('memorySecurityStore.js').createMemorySecurityStore({ now, auditRows: [] });
    billStore = S('memoryBillingStore.js').createMemoryBillingStore({ now, workspaceExists: async (id) => !!(await wsStore.getWorkspace(id)) });
  }
  const getMemberRole = async (ws, uid) => { const m = uid ? await wsStore.getMember(ws, uid) : null; return m ? m.role : null; };
  const audit = async () => {};
  const events = createSecurityEvents({ appendAuditLog: audit, logger: quiet });
  const rateLimiter = createDbRateLimiter({ store: secStore, logger: quiet });
  const firewall = createAgentFirewall({ store: secStore, getMemberRole, events, rateLimiter, logger: quiet, options: { policyCacheMs: 5000 } });
  const counters = createCounters({ wsStore, wfStore, execStore });
  const ent = createEntitlementService({ store: billStore, enabled: true, counters, logger: quiet, options: { now, planCacheMs: 5000 } });
  const providers = { map: { none: createNoProvider() }, active: createNoProvider(), activeName: 'none' };
  const subs = createSubscriptionService({ store: billStore, providers, entitlements: ent, logger: quiet, options: { now } });
  const plan = async (id, limits) => {
    const row = { id, name: id, description: 'load', limits, price: null, is_public: false, sort_order: 99 };
    if (SUPA) { const { error } = await db.from('billing_plans').insert(row); if (error) throw new Error(error.message); } else billStore._plans.set(id, { ...row, updated_at: now().toISOString() });
  };
  const BIG = { executions_per_month: 100000, workflow_runs_per_month: 100000, api_calls_per_month: 1000000, connector_calls_per_month: 100000, max_members: 50, max_active_workflows: 100, max_concurrent_executions: 1, usage_retention_days: 90 };
  await plan(`ld_big_${RUN}`, BIG);
  await plan(`ld_30_${RUN}`, { ...BIG, workflow_runs_per_month: 30 });
  const wsService = createWorkspaceService(wsStore, { requireVerifiedEmail: true });
  wsService.setEntitlements(ent);
  const exec = createAgentExecutionService({ store: execStore, options: { retryDelayMs: 0, maxSteps: 4 }, deps: { appendAuditLog: audit }, logger: quiet });
  exec.setFirewall(firewall);
  exec.setUsageMeter(ent);
  const wfService = createWorkflowService({ store: wfStore, dataStore, executionService: exec, appendAuditLog: audit, usage: ent, logger: quiet });
  const runner = createWorkflowRunner({ store: wfStore, service: wfService, dataStore, executionService: exec, execStore, appendAuditLog: audit, getMemberRole, logger: quiet, securityEvents: events,
    options: { leaseSeconds: 10, heartbeatMs: 1000, idlePollMs: 20, execPollMs: 5, busyRetryMs: 20, schedulerIntervalMs: 0, maxConcurrent: 20 } });
  wfService.attachRunner(runner);
  // Higher per-key limit than production (60/min) so the scenario measures the stack, not the limiter.
  const apiKeys = createApiKeyService({ store: secStore, getMemberRole, events, rateLimiter, logger: quiet, options: { perKeyLimit: { limit: 100000, windowSeconds: 60 } } });

  const app = express();
  app.use(express.json());
  app.use('/api/automation/v1', createAutomationRouter({ apiKeyService: apiKeys, workflowService: wfService, executionService: exec, usage: ent, logger: quiet, ipLimit: { limit: 1000000, windowSeconds: 300 } }));
  app.use('/api', auth);
  const wfr = createWorkflowRouters({ workspaceService: wsService, workflowService: wfService });
  app.use('/api/workspaces/:workspaceId/workflows', wfr.workflows);
  app.use('/api/workspaces/:workspaceId/workflow-runs', wfr.runs);
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${srv.address().port}`;
  const call = async (method, url, { uid, headers = {}, body } = {}) => {
    const t0 = process.hrtime.bigint();
    const res = await fetch(base + url, { method, headers: { 'content-type': 'application/json', ...(uid ? { authorization: `Bearer tok|${uid}` } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
    const text = await res.text();
    return { status: res.status, ms: Number(process.hrtime.bigint() - t0) / 1e6, body: (() => { try { return JSON.parse(text); } catch { return null; } })() };
  };
  runner.start();
  const out = { store: SUPA ? 'supabase (local PostgREST + PostgreSQL 16)' : 'memory', node: process.version, scenarios: {}, checks: [] };
  const check = (name, ok, detail) => { out.checks.push({ name, ok: !!ok, ...(detail ? { detail } : {}) }); };

  // ---------------- setup: N workspaces, each with a published API-trigger workflow and a key ----------------
  const N = 20;
  const tenants = [];
  for (let i = 0; i < N; i++) {
    const uid = `ld${i}_${RUN}`;
    const ws = await wsService.createWorkspace({ uid, email: `${uid}@example.com`, emailVerified: true }, { name: `Load ${i}` });
    await subs.assignPlanManually(ws.id, { planId: `ld_big_${RUN}`, operator: 'load' });
    const c = await call('POST', `/api/workspaces/${ws.id}/workflows`, { uid, body: { name: 'L', definition: { steps: [{ key: 'a', name: 'A', instruction: 'load read the page' }] } } });
    await call('POST', `/api/workspaces/${ws.id}/workflows/${c.body.data.id}/publish`, { uid, body: {} });
    await call('PUT', `/api/workspaces/${ws.id}/workflows/${c.body.data.id}/trigger`, { uid, body: { type: 'api' } });
    const key = await apiKeys.createKey({ workspace: ws, role: 'owner', userId: uid }, { name: 'load', scopes: ['workflows:run', 'runs:read'] });
    tenants.push({ uid, ws, wf: c.body.data.id, key: key.key });
  }

  // ---------------- A: run starts through the API key surface (concurrency 20 × 5 per tenant) ----------------
  {
    const t0 = Date.now();
    const lat = [];
    const results = await Promise.all(tenants.flatMap((t) => Array.from({ length: 5 }, (_, j) => call('POST', `/api/automation/v1/workflows/${t.wf}/runs`, {
      headers: { authorization: `Bearer ${t.key}`, 'Idempotency-Key': `ld-${RUN}-${t.ws.id.slice(0, 8)}-${j}` }, body: { inputs: {} },
    }).then((r) => { lat.push(r.ms); return { t, r }; }))));
    const created = results.filter((x) => x.r.status === 201);
    check('A: every API run start accepted', created.length === N * 5, results.filter((x) => x.r.status !== 201).map((x) => x.r.status).slice(0, 5));
    // wait for completion
    const ids = created.map((x) => ({ t: x.t, id: x.r.body.data.id }));
    let done = 0;
    const deadline = Date.now() + 180000;
    while (Date.now() < deadline) {
      const st = await Promise.all(ids.map(({ t, id }) => wfStore.getRun(t.ws.id, id)));
      done = st.filter((r) => r && ['completed', 'failed', 'needs_review', 'cancelled'].includes(r.status)).length;
      if (done === ids.length) {
        check('A: all runs completed', st.every((r) => r.status === 'completed'), st.filter((r) => r.status !== 'completed').map((r) => r.status).slice(0, 5));
        check('A: runs stay in their workspace', st.every((r, i) => r.workspace_id === ids[i].t.ws.id));
        break;
      }
      await sleep(50);
    }
    const wall = (Date.now() - t0) / 1000;
    out.scenarios.A_api_run_starts = { requests: N * 5, tenants: N, startLatencyMs: stats(lat), allCompletedSeconds: +wall.toFixed(2), runsPerSecond: +((N * 5) / wall).toFixed(2), desktopActions: nexusCount };
    check('A: each run executed its single desktop action exactly once', nexusCount === N * 5, { nexusCount });
  }

  // ---------------- B: read load — paginated GET /runs with API keys ----------------
  {
    const lat = [];
    const t0 = Date.now();
    const reqs = 400;
    const rs = await Promise.all(Array.from({ length: reqs }, (_, i) => { const t = tenants[i % N]; return call('GET', `/api/automation/v1/runs?limit=10`, { headers: { authorization: `Bearer ${t.key}` } }).then((r) => { lat.push(r.ms); return { t, r }; }); }));
    const wall = (Date.now() - t0) / 1000;
    check('B: all list requests succeeded', rs.every((x) => x.r.status === 200), rs.filter((x) => x.r.status !== 200).map((x) => x.r.status).slice(0, 5));
    check('B: no cross-workspace rows under load', rs.every((x) => x.r.body.data.items.every((it) => it.workspaceId === x.t.ws.id)));
    out.scenarios.B_api_list_runs = { requests: reqs, concurrency: reqs, latencyMs: stats(lat), requestsPerSecond: +(reqs / wall).toFixed(1) };
  }

  // ---------------- C: quota race — 100 concurrent run starts against a 30-run plan ----------------
  {
    const t = tenants[0];
    const ws2 = await wsService.createWorkspace({ uid: t.uid, email: `${t.uid}@example.com`, emailVerified: true }, { name: 'Quota' });
    await subs.assignPlanManually(ws2.id, { planId: `ld_30_${RUN}`, operator: 'load' });
    const c = await call('POST', `/api/workspaces/${ws2.id}/workflows`, { uid: t.uid, body: { name: 'Q', definition: { steps: [{ key: 'a', name: 'A', instruction: 'load read' }] } } });
    await call('POST', `/api/workspaces/${ws2.id}/workflows/${c.body.data.id}/publish`, { uid: t.uid, body: {} });
    const lat = [];
    const rs = await Promise.all(Array.from({ length: 100 }, (_, j) => call('POST', `/api/workspaces/${ws2.id}/workflows/${c.body.data.id}/runs`, { uid: t.uid, headers: { 'Idempotency-Key': `q-${RUN}-${j}` }, body: { inputs: {} } }).then((r) => { lat.push(r.ms); return r; })));
    const ok = rs.filter((r) => r.status === 201).length;
    const quota = rs.filter((r) => r.status === 402).length;
    check('C: exactly the plan limit of runs was accepted (reserved atomically)', ok === 30, { ok, quota, other: rs.filter((r) => ![201, 402].includes(r.status)).map((r) => r.status).slice(0, 5) });
    out.scenarios.C_quota_race = { requests: 100, limit: 30, accepted: ok, refused402: quota, latencyMs: stats(lat) };
  }

  // ---------------- D: firewall decision throughput (pure) ----------------
  {
    const P = { ...policyEngine.defaultPolicy(), connectorActions: { 'github.*': 'approval', 'http.get': 'allow' }, domains: { allow: [], deny: ['evil.example'] } };
    const reqs = ['get_repository', 'create_issue', 'get'].map((a, i) => ({ workspaceId: tenants[0].ws.id, role: 'member', executionType: 'connector', provider: i < 2 ? 'github' : 'http', action: a, readOnly: i !== 1, baseRisk: i === 1 ? 'yellow' : 'green', resource: { url: 'https://api.example.com/x' }, input: { q: 'x' } }));
    const n = 20000;
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < n; i++) policyEngine.decide(reqs[i % 3], P);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    out.scenarios.D_firewall_decide = { decisions: n, totalMs: +ms.toFixed(1), perDecisionUs: +((ms * 1000) / n).toFixed(2) };
  }

  await runner.stop();
  srv.close();
  out.ok = out.checks.every((c) => c.ok);
  console.log(JSON.stringify(out, null, 2));
  process.exit(out.ok ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
