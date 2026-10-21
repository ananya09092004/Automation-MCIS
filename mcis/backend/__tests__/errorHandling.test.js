/**
 * Final hardening — global error responses (middleware/errorResponses.js).
 * Same wiring as server.js: cors(origin allowlist) → express.json → routes →
 * global handler. Plain Node + assert, real HTTP.
 */
'use strict';

// The default /api/workspaces router (as mounted by server.js) is loaded below with
// an unreachable database, so its unexpected-error path can be exercised for real.
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://127.0.0.1:9';
process.env.SUPABASE_KEY = process.env.SUPABASE_KEY || 'unused';

const assert = require('assert');
const http = require('http');
const express = require('express');
const cors = require('cors');
const { corsOriginDenied, createGlobalErrorHandler } = require('../middleware/errorResponses');

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`PASS: ${name}`); passed++; } catch (err) { console.error(`FAIL: ${name}\n  ${err.stack || err.message}`); failed++; }
}

const logs = [];
const logger = { warn: (m) => logs.push(['warn', m]), error: (m) => logs.push(['error', m]) };
const allowed = ['https://app.example.com'];
const app = express();
app.use((req, res, next) => { req.requestId = 'req-test'; next(); });
app.use(cors({ origin(origin, cb) { if (!origin || allowed.includes(origin)) return cb(null, true); return cb(corsOriginDenied()); }, credentials: true }));
app.use(express.json({ limit: '1kb' }));
app.get('/api/ok', (req, res) => res.json({ success: true, data: 'secret-data' }));
app.post('/api/echo', (req, res) => res.json({ success: true, data: req.body }));
app.get('/api/boom', () => { throw new Error('db password=hunter2 connection failed'); });
app.use(createGlobalErrorHandler(logger));

function call(server, { method = 'GET', path, headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: server.address().port, method, path, headers }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: data, json: (() => { try { return JSON.parse(data); } catch { return null; } })() }));
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

(async () => {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));

  await test('disallowed CORS origin → 403 CORS_ORIGIN_DENIED, no CORS headers, no data (was 500)', async () => {
    const r = await call(server, { path: '/api/ok', headers: { Origin: 'https://evil.example' } });
    assert.strictEqual(r.status, 403);
    assert.strictEqual(r.json.code, 'CORS_ORIGIN_DENIED');
    assert.strictEqual(r.headers['access-control-allow-origin'], undefined);
    assert.ok(!r.text.includes('secret-data'));
    assert.strictEqual(r.json.requestId, 'req-test');
  });

  await test('allowed origin and same-origin / server-to-server requests still pass', async () => {
    const a = await call(server, { path: '/api/ok', headers: { Origin: 'https://app.example.com' } });
    assert.strictEqual(a.status, 200);
    assert.strictEqual(a.headers['access-control-allow-origin'], 'https://app.example.com');
    const b = await call(server, { path: '/api/ok' });
    assert.strictEqual(b.status, 200);
  });

  await test('malformed JSON body → 400 INVALID_JSON (was 500)', async () => {
    const r = await call(server, { method: 'POST', path: '/api/echo', headers: { 'Content-Type': 'application/json' }, body: '{bad json' });
    assert.strictEqual(r.status, 400);
    assert.strictEqual(r.json.code, 'INVALID_JSON');
  });

  await test('oversized JSON body → 413 PAYLOAD_TOO_LARGE (was 500)', async () => {
    const r = await call(server, { method: 'POST', path: '/api/echo', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ x: 'a'.repeat(5000) }) });
    assert.strictEqual(r.status, 413);
    assert.strictEqual(r.json.code, 'PAYLOAD_TOO_LARGE');
  });

  await test('unexpected errors stay a generic 500 and never return the internal message', async () => {
    const r = await call(server, { path: '/api/boom' });
    assert.strictEqual(r.status, 500);
    assert.strictEqual(r.json.error, 'Something went wrong');
    assert.ok(!r.text.includes('hunter2') && !r.text.includes('connection failed'));
    assert.ok(logs.some(([lvl, m]) => lvl === 'error' && m.includes('/api/boom')), 'logged server-side');
  });

  await test('client errors are logged as warnings, not errors', async () => {
    const errorsBefore = logs.filter(([l]) => l === 'error').length;
    await call(server, { path: '/api/ok', headers: { Origin: 'https://evil.example' } });
    await call(server, { method: 'POST', path: '/api/echo', headers: { 'Content-Type': 'application/json' }, body: '{' });
    assert.strictEqual(logs.filter(([l]) => l === 'error').length, errorsBefore);
  });

  // Production incident: GET /api/workspaces returned "Workspace service error" (500)
  // and nothing was logged, because the router was created without a logger.
  await test('workspace router logs the database error code + message, response stays generic', async () => {
    const { createWorkspacesRouter } = require('../routes/workspaces');
    const lines = [];
    const failing = { listWorkspaces: async () => { const e = new Error('permission denied for table workspaces'); e.code = '42501'; throw e; } };
    const wsApp = express();
    wsApp.use((req, res, next) => { req.user = { uid: 'u1' }; next(); });
    wsApp.use('/api/workspaces', createWorkspacesRouter({ service: failing, logger: { error: (m) => lines.push(m) } }));
    const s2 = wsApp.listen(0, '127.0.0.1');
    await new Promise((r) => s2.once('listening', r));
    try {
      const r = await call(s2, { path: '/api/workspaces' });
      assert.strictEqual(r.status, 500);
      assert.strictEqual(r.json.error, 'Workspace service error');
      assert.ok(!r.text.includes('permission denied'), 'internal detail never sent to the client');
      assert.deepStrictEqual(lines, ['Workspace error: [42501] permission denied for table workspaces']);
    } finally { s2.close(); }
  });

  await test('the router server.js mounts logs unexpected errors (it used to be created without a logger)', async () => {
    const mounted = require('../routes/workspaces'); // default export, unreachable database
    const original = console.error;
    const seen = [];
    console.error = (...a) => { seen.push(a.join(' ')); };
    const wsApp = express();
    wsApp.use((req, res, next) => { req.user = { uid: 'u1' }; next(); });
    wsApp.use('/api/workspaces', mounted);
    const s3 = wsApp.listen(0, '127.0.0.1');
    await new Promise((r) => s3.once('listening', r));
    try {
      const r = await call(s3, { path: '/api/workspaces' });
      assert.strictEqual(r.status, 500);
      assert.ok(seen.some((l) => l.startsWith('Workspace error:')), `expected a "Workspace error:" log line, got ${JSON.stringify(seen)}`);
    } finally { console.error = original; s3.close(); }
  });

  server.close();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
