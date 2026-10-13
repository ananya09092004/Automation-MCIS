/**
 * Layer 10 — load / concurrency measurements for monitoring (NOT part of `npm test`).
 *
 *   node __tests__/load/revenueLoad.js            (memory stores)
 *   WORKSPACE_TEST_STORE=supabase SUPABASE_URL=… SUPABASE_KEY=… node __tests__/load/revenueLoad.js
 *
 * Real: integration gateway + Agent Firewall + SSRF-safe client + web_page
 * connector, monitoring service (observations, snapshots, diffs), alert
 * engine, lease-based worker claims, entitlements (metering). Double: one
 * local HTTP server serving a product page. Numbers describe THIS machine
 * and THIS store — not a production capacity claim.
 */
'use strict';

const assert = require('assert');
const Module = require('module');
const path = require('path');
const crypto = require('crypto');
const http = require('http');

const ROOT = path.join(__dirname, '..', '..');
const R = (...p) => require.resolve(path.join(ROOT, ...p));
const SUPA = process.env.WORKSPACE_TEST_STORE === 'supabase';
if (!SUPA) { process.env.SUPABASE_URL = 'http://127.0.0.1:9'; process.env.SUPABASE_KEY = 'unused'; }
function fakeModule(p, exp) { const m = new Module(p, null); m.exports = exp; m.loaded = true; require.cache[p] = m; }
if (!SUPA) fakeModule(require.resolve('@supabase/supabase-js'), { createClient: () => ({ from() { const b = { select() { return b; }, eq() { return b; }, async maybeSingle() { return { data: null, error: null }; }, async insert() { return { data: null, error: null }; } }; return b; } }) });
fakeModule(R('services', 'logger.js'), { info() {}, warn() {}, error() {}, debug() {} });

const { createWorkspaceService } = require(R('services', 'workspaceService.js'));
const { createIntegrationService } = require(R('services', 'integrations', 'integrationService.js'));
const { createCredentialService, loadKeyRing } = require(R('services', 'integrations', 'credentialService.js'));
const { createSafeHttpClient } = require(R('services', 'integrations', 'safeHttp.js'));
const { createConnectorRegistry } = require(R('services', 'integrations', 'connectorRegistry.js'));
const { createWebPageConnector } = require(R('services', 'integrations', 'connectors', 'webPageConnector.js'));
const { createAgentFirewall } = require(R('services', 'security', 'agentFirewall.js'));
const { createEntitlementService } = require(R('services', 'billing', 'entitlementService.js'));
const { createConnectorActions } = require(R('services', 'actions', 'connectorActions.js'));
const { createEventBus } = require(R('services', 'revenue', 'common.js'));
const { createMonitoringService } = require(R('services', 'revenue', 'monitoringService.js'));
const { createAlertService } = require(R('services', 'revenue', 'alertService.js'));
const { createRevenueWorker } = require(R('services', 'revenue', 'revenueWorker.js'));
const S = (n) => require(path.join(__dirname, '..', 'support', n));

const quiet = { info() {}, warn() {}, error() {} };
const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s.length ? Math.round(s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]) : null; };
let PRICE = 1000;

(async () => {
  const page = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<script type="application/ld+json">${JSON.stringify({ '@type': 'Product', name: 'Load kettle', offers: { price: String(PRICE + (Number((req.url.match(/\d+/) || [0])[0]) % 7)), priceCurrency: 'INR', availability: 'InStock' } })}</script>`);
  });
  await new Promise((r) => page.listen(0, '127.0.0.1', r));
  const port = page.address().port;
  const httpc = createSafeHttpClient({ lookup: (h, o, cb) => cb(null, [{ address: '127.0.0.1', family: 4 }]), isAddressAllowed: () => true, allowInsecureHttp: true, allowedPorts: [port] });
  const stores = SUPA ? {
    ws: require(R('services', 'workspaceStore.js')).createSupabaseWorkspaceStore(),
    int: require(R('services', 'integrations', 'integrationStore.js')).createSupabaseIntegrationStore(),
    sec: require(R('services', 'security', 'securityStore.js')).createSupabaseSecurityStore(),
    bill: require(R('services', 'billing', 'billingStore.js')).createSupabaseBillingStore(),
    rev: require(R('services', 'revenue', 'revenueStore.js')).createSupabaseRevenueStore(),
  } : {
    ws: S('memoryWorkspaceStore.js').createMemoryWorkspaceStore(), int: S('memoryIntegrationStore.js').createMemoryIntegrationStore(),
    sec: S('memorySecurityStore.js').createMemorySecurityStore({ now: () => new Date(), auditRows: [] }),
  };
  if (!SUPA) {
    stores.bill = S('memoryBillingStore.js').createMemoryBillingStore({ now: () => new Date(), workspaceExists: async (id) => !!(await stores.ws.getWorkspace(id)) });
    stores.rev = S('memoryRevenueStore.js').createMemoryRevenueStore({ now: () => new Date() });
  }
  const getMemberRole = async (ws, uid) => { const m = await stores.ws.getMember(ws, uid); return m ? m.role : null; };
  const wsSvc = createWorkspaceService(stores.ws, { requireVerifiedEmail: false });
  const user = { uid: `load_${crypto.randomBytes(3).toString('hex')}`, email: 'load@example.com', emailVerified: true };
  const ws = await wsSvc.createWorkspace(user, { name: `Load ${user.uid}` });
  const ctx = { workspace: ws, role: 'owner', userId: user.uid };
  const firewall = createAgentFirewall({ store: stores.sec, getMemberRole, logger: quiet, options: { policyCacheMs: 5000, connectorLimit: { limit: 100000, windowSeconds: 60 } } });
  const creds = createCredentialService({ store: stores.int, keyRing: loadKeyRing({ INTEGRATION_ENCRYPTION_KEY: crypto.randomBytes(32).toString('base64') }) });
  const integ = createIntegrationService({ store: stores.int, registry: createConnectorRegistry([createWebPageConnector({ allowInsecureHttpForTests: true })]), credentials: creds, http: httpc, getMemberRole, logger: quiet });
  integ.setFirewall(firewall);
  const ent = createEntitlementService({ store: stores.bill, enabled: false, logger: quiet });
  const events = createEventBus({ logger: quiet });
  const monitoring = createMonitoringService({ store: stores.rev, connectorActions: createConnectorActions({ integrationService: integ, getFirewall: () => firewall }), integrations: integ, usage: ent, events, logger: quiet });
  const alerts = createAlertService({ store: stores.rev, events, logger: quiet });
  events.on('monitor.checked', (e) => alerts.onMonitorChecked(e));
  const wp = await integ.createIntegration(ctx, { provider: 'web_page', name: 'load', config: { allowedHosts: ['shop.load.example'] } });
  await alerts.createRule(ctx, { name: 'drop', ruleType: 'price_drop_pct', threshold: 0.1, cooldownMinutes: 0 });
  const out = { store: SUPA ? 'supabase' : 'memory', scenarios: {} };

  // 1) N monitors, 4 workers claiming concurrently
  const N = Number(process.env.LOAD_MONITORS || 200);
  const ids = [];
  for (let i = 0; i < N; i++) ids.push((await monitoring.createMonitor(ctx, { name: `m${i}`, kind: 'product', sourceType: 'web_page', integrationId: wp.id, source: { url: `http://shop.load.example:${port}/p/${i}` }, checkIntervalMinutes: 15 }, { internal: true })).id);
  const lat = [];
  const timed = { runCheck: monitoring.runCheck };
  monitoring.runCheck = async (...a) => { const t = Date.now(); try { return await timed.runCheck(...a); } finally { lat.push(Date.now() - t); } };
  const workers = [0, 1, 2, 3].map((i) => createRevenueWorker({ store: stores.rev, monitoring, logger: quiet, options: { workerId: `lw${i}`, monitorBatch: 20 } }));
  let t0 = Date.now();
  let total = 0;
  for (let round = 0; round < 50 && total < N; round++) total += (await Promise.all(workers.map((w) => w.monitorsTick()))).reduce((a, b) => a + b, 0);
  let dur = Date.now() - t0;
  let obsCount = 0;
  for (const id of ids) obsCount += (await stores.rev.list('monitor_observations', ws.id, { filter: { monitor_id: id }, limit: 10 })).length;
  assert.ok(total >= N, 'every monitor checked (the claim is cross-workspace: due monitors of other workspaces may be checked too)');
  assert.strictEqual(obsCount, N, 'exactly one observation per monitor (no double claims)');
  out.scenarios.workerChecks = { monitors: N, workers: 4, checks: total, seconds: dur / 1000, checksPerSecond: Math.round((total / dur) * 10000) / 10, p50ms: pct(lat, 50), p95ms: pct(lat, 95), maxMs: Math.max(...lat) };

  // 2) price change → diffs + alerts, again through workers (due now)
  PRICE = 900;
  await stores.rev.updateWhere('monitors', ws.id, {}, { next_check_at: new Date(Date.now() - 1000).toISOString() });
  t0 = Date.now(); total = 0; lat.length = 0;
  for (let round = 0; round < 50 && total < N; round++) total += (await Promise.all(workers.map((w) => w.monitorsTick()))).reduce((a, b) => a + b, 0);
  dur = Date.now() - t0;
  const changes = await stores.rev.count('monitor_changes', ws.id, { change_type: 'price_decrease' });
  const alertCount = await stores.rev.count('alerts', ws.id);
  assert.strictEqual(changes, N, 'one price_decrease per monitor');
  assert.strictEqual(alertCount, N, 'one alert per change (deduplicated)');
  out.scenarios.changesAndAlerts = { checks: total, seconds: dur / 1000, p50ms: pct(lat, 50), p95ms: pct(lat, 95), priceDecreases: changes, alerts: alertCount };

  // 3) API submissions with 25% duplicate keys, concurrency 25
  const sub = await monitoring.createMonitor(ctx, { name: 'feed', kind: 'product', sourceType: 'api_submission' }, { internal: true });
  const M = Number(process.env.LOAD_SUBMISSIONS || 400);
  const keys = Array.from({ length: M }, (_, i) => `load-key-${i % Math.round(M * 0.75)}`);
  const slat = [];
  t0 = Date.now();
  let next = 0;
  await Promise.all(Array.from({ length: 25 }, async () => {
    while (next < keys.length) {
      const k = keys[next++];
      const t = Date.now();
      await monitoring.submitObservation(ctx, sub.id, { idempotencyKey: k, values: { price: 100 + (Number(k.split('-').pop()) % 50), currency: 'INR' } });
      slat.push(Date.now() - t);
    }
  }));
  dur = Date.now() - t0;
  const subObs = await stores.rev.count('monitor_observations', ws.id, { monitor_id: sub.id });
  assert.strictEqual(subObs, Math.round(M * 0.75), 'one observation per idempotency key');
  out.scenarios.apiSubmissions = { requests: M, uniqueKeys: Math.round(M * 0.75), concurrency: 25, seconds: dur / 1000, perSecond: Math.round((M / dur) * 10000) / 10, p50ms: pct(slat, 50), p95ms: pct(slat, 95), observations: subObs };

  console.log(JSON.stringify(out, null, 2));
  page.close();
  process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
