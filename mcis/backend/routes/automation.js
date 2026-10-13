/**
 * Layer 6 — machine API authenticated by WORKSPACE API KEYS.
 * Mounted at /api/automation/v1 BEFORE the Firebase middleware (it has its
 * own authentication); nothing else accepts API keys.
 *
 *   POST /workflows/:workflowId/runs   { inputs? } + Idempotency-Key header    scope workflows:run
 *   GET  /runs/:runId                  run status / steps / evidence summary     scope runs:read
 *   POST /executions                   { goal } + Idempotency-Key header         scope executions:run  (Layer 7)
 *   GET  /executions/:executionId      status / progress / approval state        scope runs:read       (Layer 7)
 *   GET  /runs?workflowId=&status=&limit=&cursor=        page of runs         scope runs:read       (Layer 9)
 *   GET  /executions?status=&limit=&cursor=              page of executions   scope runs:read       (Layer 9)
 *   GET  /openapi.json                 public API description (no key)                                  (Layer 8)
 *   Layer 10: GET /executions/:id/evidence, GET /runs/:id/evidence (runs:read);
 *     POST /qa/projects/:id/runs, POST /qa/runs/:id/results/:resultId (qa:run);
 *     GET /qa/runs/:id, GET /qa/projects/:id/metrics (qa:read);
 *     GET /monitoring/monitors[/:id], /monitoring/changes, /monitoring/alerts,
 *     /competitors/dashboard (monitoring:read); POST /monitoring/monitors/:id/observations
 *     (monitoring:write); GET /usage (usage:read)
 *
 * Layer 7: every authenticated request is one `api_call` (plan quota
 * api_calls_per_month, reserved atomically; 402 QUOTA_EXCEEDED when
 * exhausted). Runs and executions additionally consume their own quotas
 * inside the Layer 4 / Layer 3 services.
 *
 * Key: `Authorization: Bearer nxk_…` or `X-Api-Key: nxk_…`. Keys in the URL
 * (?api_key=, ?key=, ?token=) are refused so they never land in logs.
 * The key resolves to its workspace with MEMBER rights (never more); the run
 * then goes through the normal Layer 4 service (workflow must allow the
 * 'api' trigger), the Agent Firewall (roleCap member), Layer 3 approvals
 * (which a key can never decide) and the audit log.
 *
 * Rate limits: failed authentications per client IP (in-process, per
 * instance — an unauthenticated flood never reaches the database) and
 * requests per key (database-backed, shared by all instances).
 */
'use strict';

const crypto = require('crypto');
const express = require('express');
const { WorkspaceError } = require('../services/workspaceService');
const { createProcessRateLimiter } = require('../services/security/securityEvents');
const { buildApiSpec } = require('../services/automation/apiSpec');

function createAutomationRouter({ apiKeyService, workflowService, executionService = null, usage = null, logger = console, ipLimit = { limit: 30, windowSeconds: 300 }, publicUrl = null, revenue = null, billing = null } = {}) {
  if (!apiKeyService) throw new Error('automation router: apiKeyService is required');
  const router = express.Router();
  const ipLimiter = createProcessRateLimiter();

  const fail = (res, status, code, error) => res.status(status).json({ success: false, error, code });

  // Layer 8: public, static documentation of this API (no key, no workspace
  // data). Registered BEFORE the key middleware on purpose.
  router.get('/openapi.json', (req, res) => {
    res.set('Cache-Control', 'public, max-age=300');
    return res.json(buildApiSpec({ serverUrl: publicUrl }));
  });

  router.use(async (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    for (const q of ['api_key', 'apikey', 'key', 'token', 'access_token']) {
      if (req.query && req.query[q] !== undefined) return fail(res, 400, 'KEY_IN_URL', 'Send the API key in the Authorization header, never in the URL.');
    }
    const ip = req.ip || 'unknown';
    if (ipLimiter.peek(['authfail', ip], ipLimit.windowSeconds) >= ipLimit.limit) return fail(res, 429, 'RATE_LIMITED', 'Too many failed attempts');
    const auth = req.get('authorization') || '';
    const m = /^Bearer\s+(\S+)$/i.exec(auth);
    const raw = m ? m[1] : req.get('x-api-key');
    try {
      req.apiContext = await apiKeyService.authenticate(raw);
    } catch (err) {
      if (err.status === 401) ipLimiter.hit(['authfail', ip], ipLimit.windowSeconds, ipLimit.limit);
      if (err instanceof WorkspaceError) return fail(res, err.status, err.code, err.message);
      logger.error?.(`Automation auth error: ${err.code || err.name}`);
      return fail(res, 500, 'AUTH_ERROR', 'Authentication failed');
    }
    // Layer 7: meter (and, when billing is enforced, cap) API calls.
    const meter = typeof usage === 'function' ? usage() : usage;
    if (meter) {
      try {
        // Layer 8: the plan must include API access (checked in the same plan read).
        const h = await meter.begin(req.apiContext.workspace.id, 'api_calls', `api:${req.apiContext.apiKeyId}:${crypto.randomUUID()}`, { feature: 'api_access' });
        await meter.commit(h, { source: 'api_key', sourceId: req.apiContext.apiKeyId, actorId: req.apiContext.userId }).catch(() => {});
      } catch (err) {
        if (err && Number.isInteger(err.status) && err.status < 600) return fail(res, err.status, err.code, err.message);
        return fail(res, 503, 'ENTITLEMENT_UNAVAILABLE', 'Usage limits could not be verified.');
      }
    }
    return next();
  });

  const h = (fn, ok = 200) => async (req, res) => {
    try {
      const out = await fn(req);
      return res.status(out && out.__status ? out.__status : ok).json({ success: true, data: out && out.__status ? out.data : out });
    } catch (err) {
      if (err && Number.isInteger(err.status) && err.status < 500) return fail(res, err.status, err.code, err.message);
      logger.error?.(`Automation route error: ${err && (err.code || err.name)}`);
      return fail(res, 500, 'AUTOMATION_ERROR', 'Automation service error');
    }
  };

  router.post('/workflows/:workflowId/runs', h(async (req) => {
    if (!workflowService) throw new WorkspaceError(503, 'WORKFLOWS_DISABLED', 'Workflows are not enabled on this server.');
    apiKeyService.requireScope(req.apiContext, 'workflows:run', req.params.workflowId);
    const body = req.body || {};
    const { run, replayed } = await workflowService.startRun(req.apiContext, req.params.workflowId,
      { inputs: body.inputs, trigger: 'api' }, { idempotencyKey: req.get('idempotency-key') });
    return { __status: replayed ? 200 : 201, data: { ...run, replayed } };
  }));

  // Layer 9: keyset-paginated lists ({ items, nextCursor }), newest first.
  const q1 = (v) => (Array.isArray(v) ? v[0] : v);
  router.get('/runs', h(async (req) => {
    if (!workflowService) throw new WorkspaceError(503, 'WORKFLOWS_DISABLED', 'Workflows are not enabled on this server.');
    apiKeyService.requireScope(req.apiContext, 'runs:read');
    let workflowId = q1(req.query.workflowId);
    const allowed = req.apiContext.workflowIds;
    if (allowed) {
      // A key limited to some workflows lists only those (one per request).
      if (!workflowId && allowed.length === 1) [workflowId] = allowed;
      if (!workflowId) throw new WorkspaceError(400, 'WORKFLOW_ID_REQUIRED', 'This API key is limited to specific workflows; pass workflowId.');
      if (!allowed.includes(String(workflowId).toLowerCase())) throw new WorkspaceError(404, 'WORKFLOW_NOT_FOUND', 'Workflow not found');
    }
    return workflowService.pageRuns(req.apiContext, { workflowId, status: q1(req.query.status), limit: q1(req.query.limit), cursor: q1(req.query.cursor) });
  }));

  router.get('/executions', h(async (req) => {
    if (!executionService) throw new WorkspaceError(503, 'EXECUTIONS_DISABLED', 'Executions are not available on this server.');
    apiKeyService.requireScope(req.apiContext, 'runs:read');
    return executionService.pageExecutions(req.apiContext, { status: q1(req.query.status), limit: q1(req.query.limit), cursor: q1(req.query.cursor) });
  }));

  router.get('/runs/:runId', h(async (req) => {
    if (!workflowService) throw new WorkspaceError(503, 'WORKFLOWS_DISABLED', 'Workflows are not enabled on this server.');
    apiKeyService.requireScope(req.apiContext, 'runs:read');
    const run = await workflowService.getRun(req.apiContext, req.params.runId);
    if (req.apiContext.workflowIds && !req.apiContext.workflowIds.includes(String(run.workflowId).toLowerCase())) {
      throw new WorkspaceError(404, 'RUN_NOT_FOUND', 'Run not found');
    }
    return run;
  }));

  router.post('/executions', h(async (req) => {
    if (!executionService) throw new WorkspaceError(503, 'EXECUTIONS_DISABLED', 'Executions are not available on this server.');
    apiKeyService.requireScope(req.apiContext, 'executions:run');
    const key = req.get('idempotency-key');
    if (!key) throw new WorkspaceError(400, 'BAD_REQUEST', 'API-submitted executions require an Idempotency-Key header');
    // Same Layer 3 path as the app: member rights (role cap), Agent Firewall,
    // approvals (which a key can never decide), evidence, audit, quotas.
    const { execution, replayed } = await executionService.createExecution(req.apiContext, { goal: (req.body || {}).goal, idempotencyKey: key });
    return { __status: replayed ? 200 : 201, data: { ...execution, replayed } };
  }));

  router.get('/executions/:executionId', h(async (req) => {
    if (!executionService) throw new WorkspaceError(503, 'EXECUTIONS_DISABLED', 'Executions are not available on this server.');
    apiKeyService.requireScope(req.apiContext, 'runs:read');
    return executionService.getExecution(req.apiContext, req.params.executionId);
  }));

  // ------------------------------------------------------------------
  // Layer 10: evidence, QA / reliability, monitoring, usage
  // ------------------------------------------------------------------
  const rev = () => (typeof revenue === 'function' ? revenue() : revenue);
  const need = (svc, code, what) => { if (!svc) throw new WorkspaceError(503, code, `${what} is not enabled on this server.`); return svc; };
  const idem = (req) => {
    const key = req.get('idempotency-key');
    if (!key) throw new WorkspaceError(400, 'BAD_REQUEST', 'This request requires an Idempotency-Key header');
    return key;
  };

  router.get('/executions/:executionId/evidence', h(async (req) => {
    if (!executionService) throw new WorkspaceError(503, 'EXECUTIONS_DISABLED', 'Executions are not available on this server.');
    apiKeyService.requireScope(req.apiContext, 'runs:read');
    return executionService.getEvidence(req.apiContext, req.params.executionId);
  }));
  router.get('/runs/:runId/evidence', h(async (req) => {
    if (!workflowService) throw new WorkspaceError(503, 'WORKFLOWS_DISABLED', 'Workflows are not enabled on this server.');
    apiKeyService.requireScope(req.apiContext, 'runs:read');
    const run = await workflowService.getRun(req.apiContext, req.params.runId);
    if (req.apiContext.workflowIds && !req.apiContext.workflowIds.includes(String(run.workflowId).toLowerCase())) throw new WorkspaceError(404, 'RUN_NOT_FOUND', 'Run not found');
    return workflowService.getRunEvidence(req.apiContext, req.params.runId);
  }));

  router.post('/qa/projects/:projectId/runs', h(async (req) => {
    const qa = need(rev() && rev().qa, 'QA_DISABLED', 'Agent reliability testing');
    apiKeyService.requireScope(req.apiContext, 'qa:run');
    const body = req.body || {};
    const { run, replayed } = await qa.startRun(req.apiContext, req.params.projectId, { suiteId: body.suiteId, scenarioIds: body.scenarioIds, idempotencyKey: idem(req) }, { trigger: 'api' });
    return { __status: replayed ? 200 : 201, data: { ...run, replayed } };
  }));
  router.get('/qa/runs/:runId', h(async (req) => {
    const qa = need(rev() && rev().qa, 'QA_DISABLED', 'Agent reliability testing');
    apiKeyService.requireScope(req.apiContext, 'qa:read');
    return qa.getRun(req.apiContext, req.params.runId);
  }));
  router.post('/qa/runs/:runId/results/:resultId', h(async (req) => {
    const qa = need(rev() && rev().qa, 'QA_DISABLED', 'Agent reliability testing');
    apiKeyService.requireScope(req.apiContext, 'qa:run');
    idem(req);
    const out = await qa.submitExternalResult(req.apiContext, req.params.runId, req.params.resultId, req.body || {});
    return { __status: out.replayed ? 200 : 201, data: { ...out.result, replayed: out.replayed } };
  }));
  router.get('/qa/projects/:projectId/metrics', h(async (req) => {
    const qa = need(rev() && rev().qa, 'QA_DISABLED', 'Agent reliability testing');
    apiKeyService.requireScope(req.apiContext, 'qa:read');
    return qa.projectMetrics(req.apiContext, req.params.projectId, { runs: q1(req.query.runs) });
  }));

  router.get('/monitoring/monitors', h(async (req) => {
    const m = need(rev() && rev().monitoring, 'MONITORING_DISABLED', 'Monitoring');
    apiKeyService.requireScope(req.apiContext, 'monitoring:read');
    return m.listMonitors(req.apiContext, { kind: q1(req.query.kind), health: q1(req.query.health), limit: q1(req.query.limit) });
  }));
  router.get('/monitoring/monitors/:monitorId', h(async (req) => {
    const m = need(rev() && rev().monitoring, 'MONITORING_DISABLED', 'Monitoring');
    apiKeyService.requireScope(req.apiContext, 'monitoring:read');
    return m.getMonitor(req.apiContext, req.params.monitorId);
  }));
  router.post('/monitoring/monitors/:monitorId/observations', h(async (req) => {
    const m = need(rev() && rev().monitoring, 'MONITORING_DISABLED', 'Monitoring');
    apiKeyService.requireScope(req.apiContext, 'monitoring:write');
    const out = await m.submitObservation(req.apiContext, req.params.monitorId, { ...(req.body || {}), idempotencyKey: idem(req) });
    return { __status: out.replayed ? 200 : 201, data: out };
  }));
  router.get('/monitoring/changes', h(async (req) => {
    const m = need(rev() && rev().monitoring, 'MONITORING_DISABLED', 'Monitoring');
    apiKeyService.requireScope(req.apiContext, 'monitoring:read');
    return m.listChanges(req.apiContext, { monitorId: q1(req.query.monitorId), since: q1(req.query.since), limit: q1(req.query.limit) });
  }));
  router.get('/monitoring/alerts', h(async (req) => {
    const a = need(rev() && rev().alerts, 'MONITORING_DISABLED', 'Monitoring');
    apiKeyService.requireScope(req.apiContext, 'monitoring:read');
    return a.listAlerts(req.apiContext, { acknowledged: q1(req.query.acknowledged), monitorId: q1(req.query.monitorId), limit: q1(req.query.limit) });
  }));
  router.get('/competitors/dashboard', h(async (req) => {
    const c = need(rev() && rev().competitors, 'MONITORING_DISABLED', 'Competitor intelligence');
    apiKeyService.requireScope(req.apiContext, 'monitoring:read');
    return c.dashboard(req.apiContext);
  }));
  router.get('/usage', h(async (req) => {
    const b = need(typeof billing === 'function' ? billing() : billing, 'BILLING_UNAVAILABLE', 'Usage reporting');
    apiKeyService.requireScope(req.apiContext, 'usage:read');
    const s = await b.summary(req.apiContext);
    // Usage only: no payment / provider details for API keys.
    return { plan: s.plan ? { id: s.plan.id, name: s.plan.name } : null, period: s.period, enforcement: s.enforcement, meters: s.meters };
  }));

  return router;
}

module.exports = { createAutomationRouter };
