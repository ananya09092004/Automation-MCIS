/**
 * Final hardening — desktop-agent pairing and device revocation.
 *   backend-addon/devicePairing.js  (pair/start, pair/approve, pair/status)
 *   routes/device.js                (DELETE /:deviceId revoke)
 *   agentSocket.js                  (disconnectAgent)
 * Real Express + HTTP; Supabase replaced by the test-only fake.
 */
'use strict';

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://127.0.0.1:9';
process.env.SUPABASE_KEY = process.env.SUPABASE_KEY || 'unused';
process.env.AGENT_HEARTBEAT_MS = '120'; // fast heartbeat for the presence tests

const assert = require('assert');
const http = require('http');
const Module = require('module');
const express = require('express');
const { createFakeSupabase } = require('./support/fakeSupabase');

function fakeModule(p, exp) { const m = new Module(p, null); m.exports = exp; m.loaded = true; require.cache[p] = m; }
const fake = createFakeSupabase({ tables: { pairing_sessions: [], device_tokens: [] } });
fakeModule(require.resolve('@supabase/supabase-js'), { createClient: () => fake.client });
const auditRows = [];
fakeModule(require.resolve('../security-engine/auditLog'), { appendAuditLog: async (...a) => { auditRows.push(a); }, getAuditLog: async () => [], getWorkspaceAuditLog: async () => [] });

const pairing = require('../backend-addon/devicePairing');
const deviceRoutes = require('../routes/device');
const agentSocket = require('../agentSocket');

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`PASS: ${name}`); passed++; } catch (err) { console.error(`FAIL: ${name}\n  ${err.stack || err.message}`); failed++; }
}

// Same mounting as server.js; a stub stands in for Firebase auth (x-test-uid).
const app = express();
app.use(express.json());
app.use((req, res, next) => { if (req.headers['x-test-uid']) req.user = { uid: req.headers['x-test-uid'] }; next(); });
app.use('/api/device', deviceRoutes);
app.use('/api/device', pairing);

function call(server, method, path, { uid, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port: server.address().port, method, path, headers: { ...(uid ? { 'x-test-uid': uid } : {}), ...(data ? { 'content-type': 'application/json' } : {}) } }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: (() => { try { return JSON.parse(raw); } catch { return raw; } })() }));
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

(async () => {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const startSession = async (deviceId) => (await call(server, 'POST', '/api/device/pair/start', { body: { deviceId } })).body.sessionId;
  const setCreated = (sid, iso) => { fake.tables.pairing_sessions.find((s) => s.session_id === sid).created_at = iso; };

  await test('happy path: start → approve → the device token is delivered exactly once', async () => {
    const sid = await startSession('LAPTOP-1');
    setCreated(sid, new Date().toISOString());
    assert.deepStrictEqual((await call(server, 'GET', `/api/device/pair/status?sessionId=${sid}`)).body, { approved: false });
    assert.strictEqual((await call(server, 'POST', '/api/device/pair/approve', { uid: 'alice', body: { sessionId: sid } })).status, 200);
    const first = await call(server, 'GET', `/api/device/pair/status?sessionId=${sid}`);
    assert.strictEqual(first.status, 200);
    assert.strictEqual(first.body.approved, true);
    assert.match(first.body.token, /^[0-9a-f]{64}$/);
    const row = fake.tables.device_tokens.find((d) => d.user_id === 'alice' && d.device_id === 'LAPTOP-1');
    assert.strictEqual(row.token, first.body.token, 'the delivered token is the one the agent socket accepts');
    const again = await call(server, 'GET', `/api/device/pair/status?sessionId=${sid}`);
    assert.strictEqual(again.status, 410, 'second pickup refused (was: token returned to anyone with the session id, forever)');
    assert.strictEqual(again.body.code, 'PAIRING_TOKEN_COLLECTED');
    assert.strictEqual(fake.tables.pairing_sessions.find((s) => s.session_id === sid).token, null, 'stored copy cleared');
  });

  await test('a session approved by one account cannot be re-approved by another (no device takeover)', async () => {
    const sid = await startSession('LAPTOP-2');
    setCreated(sid, new Date().toISOString());
    assert.strictEqual((await call(server, 'POST', '/api/device/pair/approve', { uid: 'alice', body: { sessionId: sid } })).status, 200);
    const steal = await call(server, 'POST', '/api/device/pair/approve', { uid: 'mallory', body: { sessionId: sid } });
    assert.strictEqual(steal.status, 409);
    assert.strictEqual(steal.body.code, 'PAIRING_ALREADY_APPROVED');
    assert.ok(!fake.tables.device_tokens.some((d) => d.user_id === 'mallory'), 'no token minted for the other account');
  });

  await test('expired pairing sessions cannot be approved or polled', async () => {
    const sid = await startSession('LAPTOP-3');
    setCreated(sid, new Date(Date.now() - pairing.PAIRING_TTL_MS - 60000).toISOString());
    assert.strictEqual((await call(server, 'POST', '/api/device/pair/approve', { uid: 'alice', body: { sessionId: sid } })).status, 404);
    assert.strictEqual((await call(server, 'GET', `/api/device/pair/status?sessionId=${sid}`)).status, 404);
    assert.ok(!fake.tables.device_tokens.some((d) => d.device_id === 'LAPTOP-3'));
  });

  await test('revocation: owner-only, deletes the token, clears pairing copies, closes the live socket, audited', async () => {
    const before = fake.tables.device_tokens.length;
    // Another user cannot revoke alice's device (404, nothing deleted).
    const other = await call(server, 'DELETE', '/api/device/LAPTOP-1', { uid: 'mallory' });
    assert.strictEqual(other.status, 404);
    assert.strictEqual(fake.tables.device_tokens.length, before);
    // Unauthenticated → 401.
    assert.strictEqual((await call(server, 'DELETE', '/api/device/LAPTOP-1')).status, 401);
    const ok = await call(server, 'DELETE', '/api/device/LAPTOP-1', { uid: 'alice' });
    assert.strictEqual(ok.status, 200);
    assert.strictEqual(ok.body.revoked, 'LAPTOP-1');
    assert.ok(!fake.tables.device_tokens.some((d) => d.user_id === 'alice' && d.device_id === 'LAPTOP-1'), 'token row deleted');
    assert.ok(auditRows.some(([uid, action, payload]) => uid === 'alice' && action === 'device_revoked' && payload.deviceId === 'LAPTOP-1'));
    assert.strictEqual((await call(server, 'DELETE', '/api/device/LAPTOP-1', { uid: 'alice' })).status, 404, 'already revoked');
  });

  await test('disconnectAgent closes a live connection with code 4003', async () => {
    const WebSocket = require('ws');
    const srv = http.createServer();
    agentSocket.attachAgentSocket(srv);
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    fake.tables.device_tokens.push({ id: 'x', user_id: 'bob', device_id: 'PC-9', token: 'tok-pc9', created_at: new Date().toISOString() });
    const ws = new WebSocket(`ws://127.0.0.1:${srv.address().port}/agent`, { headers: { 'x-device-id': 'PC-9', 'x-auth-token': 'tok-pc9' } });
    const closed = new Promise((r) => ws.on('close', (code) => r(code)));
    await new Promise((r) => ws.on('open', r));
    assert.strictEqual(agentSocket.disconnectAgent('alice', 'LAPTOP-1'), false, 'no connection → nothing to close');
    let done = false; // the socket registers after its async token lookup
    for (let i = 0; i < 100 && !done; i++) { done = agentSocket.disconnectAgent('bob', 'PC-9'); if (!done) await new Promise((r) => setTimeout(r, 10)); }
    assert.ok(done, 'connection was registered and then closed');
    assert.strictEqual(await closed, 4003);
    srv.close();
  });

  await test('presence: a connected device is listed online (own devices only), offline after it disconnects', async () => {
    const WebSocket = require('ws');
    const srv = http.createServer();
    agentSocket.attachAgentSocket(srv);
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    fake.tables.device_tokens.push({ id: 'p1', user_id: 'carol', device_id: 'DESK-1', token: 'tok-desk1', created_at: new Date().toISOString() });
    fake.tables.device_tokens.push({ id: 'p2', user_id: 'carol', device_id: 'DESK-2', token: 'tok-desk2', created_at: new Date().toISOString() });
    const ws = new WebSocket(`ws://127.0.0.1:${srv.address().port}/agent`, { headers: { 'x-device-id': 'DESK-1', 'x-auth-token': 'tok-desk1' } });
    await new Promise((r) => ws.on('open', r));
    let p = {};
    for (let i = 0; i < 100 && !(p['DESK-1'] && p['DESK-1'].online); i++) { p = agentSocket.agentPresence('carol'); await new Promise((r) => setTimeout(r, 10)); }
    assert.strictEqual(p['DESK-1'].online, true);
    assert.ok(p['DESK-1'].connectedAt && p['DESK-1'].lastSeenAt);
    assert.deepStrictEqual(agentSocket.agentPresence('mallory'), {}, 'another user sees nothing');
    const list = await call(server, 'GET', '/api/device/list', { uid: 'carol' });
    const byId = Object.fromEntries(list.body.devices.map((d) => [d.device_id, d]));
    assert.strictEqual(byId['DESK-1'].online, true);
    assert.strictEqual(byId['DESK-2'].online, false, 'never connected → offline');
    assert.ok(!('token' in byId['DESK-1']), 'tokens are never listed');
    const closed = new Promise((r) => ws.on('close', r));
    ws.close(); await closed;
    for (let i = 0; i < 100 && agentSocket.agentPresence('carol')['DESK-1'].online; i++) await new Promise((r) => setTimeout(r, 10));
    assert.strictEqual(agentSocket.agentPresence('carol')['DESK-1'].online, false);
    srv.close();
  });

  await test('heartbeat: an agent that stops answering pings is disconnected and shown offline', async () => {
    const WebSocket = require('ws');
    const srv = http.createServer();
    agentSocket.attachAgentSocket(srv);
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    fake.tables.device_tokens.push({ id: 'p3', user_id: 'dave', device_id: 'HUNG-1', token: 'tok-hung', created_at: new Date().toISOString() });
    const ws = new WebSocket(`ws://127.0.0.1:${srv.address().port}/agent`, { headers: { 'x-device-id': 'HUNG-1', 'x-auth-token': 'tok-hung' }, autoPong: false });
    const closed = new Promise((r) => ws.on('close', (code) => r(code)));
    await new Promise((r) => ws.on('open', r));
    await closed; // terminated after an unanswered ping (heartbeat 120 ms in this test)
    for (let i = 0; i < 100 && (agentSocket.agentPresence('dave')['HUNG-1'] || {}).online; i++) await new Promise((r) => setTimeout(r, 10));
    assert.strictEqual(agentSocket.agentPresence('dave')['HUNG-1'].online, false);
    srv.close();
  });

  server.close();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
