/**
 * SDK tests against a local HTTP stand-in for the API (request shape,
 * headers, idempotency, errors) and the backend's own webhook signer.
 * Run: node test.js
 */
'use strict';

const assert = require('assert');
const http = require('http');
const path = require('path');
const { NexusClient, NexusApiError, verifyWebhookSignature } = require('./index');

const seen = [];
const server = http.createServer(async (req, res) => {
  let body = '';
  for await (const c of req) body += c;
  seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, idem: req.headers['idempotency-key'] || null, body: body ? JSON.parse(body) : null });
  res.setHeader('content-type', 'application/json');
  if (req.headers.authorization !== 'Bearer nxk_test_placeholder') { res.statusCode = 401; return res.end(JSON.stringify({ success: false, code: 'INVALID_API_KEY', error: 'bad key' })); }
  if (req.url.startsWith('/api/automation/v1/executions/done')) return res.end(JSON.stringify({ success: true, data: { id: 'done', status: 'completed' } }));
  if (req.url === '/api/automation/v1/executions' && req.method === 'POST') { res.statusCode = 201; return res.end(JSON.stringify({ success: true, data: { id: 'e1', status: 'created', replayed: false } })); }
  if (req.url.startsWith('/api/automation/v1/monitoring/monitors?')) return res.end(JSON.stringify({ success: true, data: [{ id: 'm1' }] }));
  if (req.url === '/api/automation/v1/usage') return res.end(JSON.stringify({ success: true, data: { meters: [] } }));
  res.statusCode = 404;
  return res.end(JSON.stringify({ success: false, code: 'NOT_FOUND', error: 'Not found' }));
});

(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const c = new NexusClient({ baseUrl, apiKey: 'nxk_test_placeholder' });
  assert.ok(!JSON.stringify(c).includes('nxk_'), 'the key is not serialized');
  await assert.rejects(c.createExecution('x'), /idempotencyKey/);
  const e = await c.createExecution('Summarise example.com', { idempotencyKey: 'sdk-test-0001' });
  assert.strictEqual(e.id, 'e1');
  assert.deepStrictEqual([seen.at(-1).idem, seen.at(-1).body, seen.at(-1).auth], ['sdk-test-0001', { goal: 'Summarise example.com' }, 'Bearer nxk_test_placeholder']);
  assert.ok(!seen.some((s) => /nxk_/.test(s.url)), 'key never in a URL');
  assert.deepStrictEqual(await c.listMonitors({ kind: 'product', health: 'STALE' }), [{ id: 'm1' }]);
  assert.strictEqual(seen.at(-1).url, '/api/automation/v1/monitoring/monitors?kind=product&health=STALE');
  assert.strictEqual((await c.waitForExecution('done', { intervalMs: 1 })).status, 'completed');
  await assert.rejects(c.getQaRun('nope'), (err) => err instanceof NexusApiError && err.status === 404 && err.code === 'NOT_FOUND');
  const bad = new NexusClient({ baseUrl, apiKey: 'wrong' });
  await assert.rejects(bad.usage(), (err) => err.status === 401 && err.code === 'INVALID_API_KEY');
  // webhook signatures produced by the backend verify with the SDK
  const { sign } = require(path.join(__dirname, '..', '..', 'backend', 'services', 'revenue', 'webhookService.js'));
  const secret = 'whsec_sdk_test_value_0001';
  const raw = JSON.stringify({ id: 'execution.completed:e1', type: 'execution.completed' });
  const t = Math.floor(Date.now() / 1000);
  assert.ok(verifyWebhookSignature(secret, raw, sign(secret, raw, t)));
  assert.ok(verifyWebhookSignature(secret, Buffer.from(raw), sign(secret, raw, t)));
  assert.ok(!verifyWebhookSignature(secret, `${raw} `, sign(secret, raw, t)));
  assert.ok(!verifyWebhookSignature('whsec_other', raw, sign(secret, raw, t)));
  assert.ok(!verifyWebhookSignature(secret, raw, sign(secret, raw, t - 3600)), 'replayed old deliveries rejected');
  server.close();
  console.log('sdk: 11 checks passed');
})().catch((err) => { console.error(err); server.close(); process.exit(1); });
