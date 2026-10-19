/**
 * Final hardening — global error responses (middleware/errorResponses.js).
 * Same wiring as server.js: cors(origin allowlist) → express.json → routes →
 * global handler. Plain Node + assert, real HTTP.
 */
'use strict';

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

  server.close();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
