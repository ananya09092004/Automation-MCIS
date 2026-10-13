/**
 * Nexus Automation API — minimal JavaScript client (Node 18+, uses fetch).
 *
 *   const { NexusClient, verifyWebhookSignature } = require('@nexus/automation-sdk');
 *   const nexus = new NexusClient({ baseUrl: 'https://api.your-nexus.example', apiKey: process.env.NEXUS_API_KEY });
 *   const run = await nexus.startWorkflowRun(workflowId, { inputs: { company: 'Example Ltd' } }, { idempotencyKey: 'order-0001' });
 *
 * The key is sent only in the Authorization header (never in a URL).
 * Every POST needs an idempotency key: reuse it when retrying the same
 * request, use a new one for new work. Errors throw NexusApiError with the
 * server's { status, code, message }.
 */
'use strict';

const crypto = require('crypto');

class NexusApiError extends Error {
  constructor(status, code, message) {
    super(message || `Nexus API error (${status})`);
    this.name = 'NexusApiError';
    this.status = status;
    this.code = code || null;
  }
}

const KEY_RE = /^[A-Za-z0-9_.:-]{8,128}$/;
const enc = encodeURIComponent;

class NexusClient {
  constructor({ baseUrl, apiKey, fetchImpl = globalThis.fetch, timeoutMs = 30000 } = {}) {
    if (!baseUrl || !/^https?:\/\//.test(baseUrl)) throw new Error('baseUrl must be an http(s) URL');
    if (!apiKey || typeof apiKey !== 'string') throw new Error('apiKey is required');
    if (typeof fetchImpl !== 'function') throw new Error('fetch is not available (Node 18+ or pass fetchImpl)');
    this.base = `${baseUrl.replace(/\/+$/, '')}/api/automation/v1`;
    this.fetch = fetchImpl;
    this.timeoutMs = timeoutMs;
    Object.defineProperty(this, 'apiKey', { value: apiKey, enumerable: false }); // never serialized
  }

  async request(method, path, { body, idempotencyKey } = {}) {
    if (method === 'POST') {
      if (typeof idempotencyKey !== 'string' || !KEY_RE.test(idempotencyKey)) throw new Error('idempotencyKey (8-128 chars of A-Z a-z 0-9 _ . : -) is required for POST requests');
    }
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), this.timeoutMs);
    try {
      const res = await this.fetch(`${this.base}${path}`, {
        method,
        signal: ctl.signal,
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          Accept: 'application/json',
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      let json = null;
      try { json = await res.json(); } catch { /* empty */ }
      if (!res.ok || !json || json.success === false) throw new NexusApiError(res.status, json && json.code, json && json.error);
      return json.data;
    } finally { clearTimeout(t); }
  }

  // Workflows / executions
  startWorkflowRun(workflowId, { inputs } = {}, { idempotencyKey } = {}) { return this.request('POST', `/workflows/${enc(workflowId)}/runs`, { body: { inputs }, idempotencyKey }); }
  getRun(runId) { return this.request('GET', `/runs/${enc(runId)}`); }
  getRunEvidence(runId) { return this.request('GET', `/runs/${enc(runId)}/evidence`); }
  listRuns({ workflowId, status, limit, cursor } = {}) { return this.request('GET', `/runs${qs({ workflowId, status, limit, cursor })}`); }
  createExecution(goal, { idempotencyKey } = {}) { return this.request('POST', '/executions', { body: { goal }, idempotencyKey }); }
  getExecution(executionId) { return this.request('GET', `/executions/${enc(executionId)}`); }
  getExecutionEvidence(executionId) { return this.request('GET', `/executions/${enc(executionId)}/evidence`); }
  listExecutions({ status, limit, cursor } = {}) { return this.request('GET', `/executions${qs({ status, limit, cursor })}`); }

  // Agent QA
  startQaRun(projectId, { suiteId, scenarioIds } = {}, { idempotencyKey } = {}) { return this.request('POST', `/qa/projects/${enc(projectId)}/runs`, { body: { suiteId, scenarioIds }, idempotencyKey }); }
  getQaRun(runId) { return this.request('GET', `/qa/runs/${enc(runId)}`); }
  submitQaResult(runId, resultId, report, { idempotencyKey } = {}) { return this.request('POST', `/qa/runs/${enc(runId)}/results/${enc(resultId)}`, { body: report, idempotencyKey }); }
  qaMetrics(projectId, { runs } = {}) { return this.request('GET', `/qa/projects/${enc(projectId)}/metrics${qs({ runs })}`); }

  // Monitoring
  listMonitors({ kind, health } = {}) { return this.request('GET', `/monitoring/monitors${qs({ kind, health })}`); }
  getMonitor(monitorId) { return this.request('GET', `/monitoring/monitors/${enc(monitorId)}`); }
  submitObservation(monitorId, { values, present } = {}, { idempotencyKey } = {}) { return this.request('POST', `/monitoring/monitors/${enc(monitorId)}/observations`, { body: { values, ...(present === false ? { present: false } : {}) }, idempotencyKey }); }
  listChanges({ monitorId, since, limit } = {}) { return this.request('GET', `/monitoring/changes${qs({ monitorId, since, limit })}`); }
  listAlerts({ acknowledged } = {}) { return this.request('GET', `/monitoring/alerts${qs({ acknowledged })}`); }
  competitorDashboard() { return this.request('GET', '/competitors/dashboard'); }
  usage() { return this.request('GET', '/usage'); }

  /** Poll an execution until it is finished (completed / failed / cancelled). */
  async waitForExecution(executionId, { intervalMs = 2000, timeoutMs = 10 * 60000 } = {}) {
    const end = Date.now() + timeoutMs;
    for (;;) {
      const e = await this.getExecution(executionId);
      if (['completed', 'failed', 'cancelled'].includes(e.status)) return e;
      if (Date.now() > end) throw new Error('Timed out waiting for the execution');
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }
}

function qs(o) {
  const p = Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k, v]) => `${enc(k)}=${enc(String(v))}`);
  return p.length ? `?${p.join('&')}` : '';
}

/**
 * Verify a Nexus webhook: header "Nexus-Signature: t=<unix>,v1=<hex HMAC-SHA256(secret, `${t}.${rawBody}`)>".
 * Pass the RAW request body (string or Buffer), not re-serialized JSON.
 */
function verifyWebhookSignature(secret, rawBody, header, { toleranceSeconds = 300, now = Date.now() } = {}) {
  const m = /^t=(\d{9,12}),v1=([0-9a-f]{64})$/.exec(String(header || ''));
  if (!m || !secret) return false;
  if (Math.abs(now / 1000 - Number(m[1])) > toleranceSeconds) return false;
  const expect = crypto.createHmac('sha256', secret).update(`${m[1]}.${Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody)}`).digest();
  const got = Buffer.from(m[2], 'hex');
  return got.length === expect.length && crypto.timingSafeEqual(got, expect);
}

module.exports = { NexusClient, NexusApiError, verifyWebhookSignature };
