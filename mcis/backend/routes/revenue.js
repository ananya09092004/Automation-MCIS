/**
 * Layer 10 — revenue product suite routes (Firebase auth + Layer 1
 * workspaceContext; non-members get 404; the workspace comes only from the
 * URL and is re-checked against the caller's membership).
 *
 * /api/workspaces/:workspaceId/monitoring
 *   GET  /monitors                    list (member+)          POST /monitors            create (admin+)
 *   GET  /monitors/:id                detail + history        PATCH /monitors/:id       update (admin+)
 *   DELETE /monitors/:id              (admin+)                POST /monitors/:id/check  check now (admin+)
 *   GET  /changes                     detected changes
 *   GET  /rules | POST /rules | PATCH /rules/:id | DELETE /rules/:id        alert rules (write: admin+)
 *   GET  /alerts | POST /alerts/:id/acknowledge (member+) | POST /alerts/:id/deliveries/:deliveryId/retry (admin+)
 * /api/workspaces/:workspaceId/competitors
 *   GET  /dashboard | GET /products | POST /products | GET/PATCH/DELETE /products/:id
 *   POST /products/:id/competitors | DELETE /products/:id/competitors/:cid
 *   POST /products/:id/competitors/:cid/match   { decision: confirm|reject, version } (admin+)
 *   GET  /recommendations | POST /recommendations/:id/status | POST /recommendations/:id/act
 * /api/workspaces/:workspaceId/reliability
 *   GET/POST /projects | GET/DELETE /projects/:id | POST /projects/:id/suites
 *   POST /suites/:id/scenarios | DELETE /scenarios/:id
 *   POST /projects/:id/runs | GET /runs | GET /runs/:id | POST /runs/:id/cancel
 *   POST /runs/:id/results/:resultId (external agent result, in-app) | GET /projects/:id/metrics
 * /api/workspaces/:workspaceId/agents
 *   GET / | POST / | POST /defaults | GET /:id | PATCH /:id
 * /api/workspaces/:workspaceId/webhooks   (admin+)
 *   GET / | POST / | PATCH /:id | DELETE /:id | POST /:id/rotate-secret | POST /:id/test | GET /:id/deliveries
 * /api/workspaces/:workspaceId/lifecycle  (owner)
 *   GET /export | POST /delete { confirmName }
 */
'use strict';

const express = require('express');
const { WorkspaceError } = require('../services/workspaceService');
const { workspaceContext } = require('../middleware/workspaceContext');

function sendError(res, err, logger) {
  if (err instanceof WorkspaceError || (err && Number.isInteger(err.status) && err.status < 500 && err.code)) {
    return res.status(err.status).json({ success: false, error: err.message, code: err.code, ...(err.extra || {}) });
  }
  if (err && err.status === 503 && err.code) return res.status(503).json({ success: false, error: err.message, code: err.code });
  if (logger && logger.error) logger.error(`Revenue route error (${err && (err.code || err.name)})`);
  return res.status(500).json({ success: false, error: 'Service error' });
}

function makeHandler(logger) {
  return (fn, ok = 200) => async (req, res) => {
    try {
      res.set('Cache-Control', 'no-store');
      const out = await fn(req);
      if (out && out.__status) return res.status(out.__status).json({ success: true, data: out.data });
      return res.status(ok).json({ success: true, data: out });
    } catch (err) { return sendError(res, err, logger); }
  };
}

function createRevenueRouters({ workspaceService, monitoring, alerts, competitors, qa, agents, webhooks, lifecycle, logger } = {}) {
  const h = makeHandler(logger);
  const withCtx = () => {
    const r = express.Router({ mergeParams: true });
    r.use(workspaceContext(workspaceService, { logger }));
    return r;
  };
  const q = (req, k) => (Array.isArray(req.query[k]) ? req.query[k][0] : req.query[k]);
  const out = {};

  if (monitoring && alerts) {
    const r = withCtx();
    r.get('/monitors', h((req) => monitoring.listMonitors(req.workspace, { kind: q(req, 'kind'), health: q(req, 'health'), limit: q(req, 'limit') })));
    r.post('/monitors', h((req) => monitoring.createMonitor(req.workspace, req.body || {}), 201));
    r.get('/monitors/:id', h((req) => monitoring.getMonitor(req.workspace, req.params.id)));
    r.patch('/monitors/:id', h((req) => monitoring.updateMonitor(req.workspace, req.params.id, req.body || {})));
    r.delete('/monitors/:id', h((req) => monitoring.deleteMonitor(req.workspace, req.params.id)));
    r.post('/monitors/:id/check', h((req) => monitoring.checkNow(req.workspace, req.params.id, { requestId: req.get('idempotency-key') })));
    r.get('/changes', h((req) => monitoring.listChanges(req.workspace, { monitorId: q(req, 'monitorId'), since: q(req, 'since'), limit: q(req, 'limit') })));
    r.get('/rules', h((req) => alerts.listRules(req.workspace)));
    r.post('/rules', h((req) => alerts.createRule(req.workspace, req.body || {}), 201));
    r.patch('/rules/:id', h((req) => alerts.updateRule(req.workspace, req.params.id, req.body || {})));
    r.delete('/rules/:id', h((req) => alerts.deleteRule(req.workspace, req.params.id)));
    r.get('/alerts', h((req) => alerts.listAlerts(req.workspace, { acknowledged: q(req, 'acknowledged'), monitorId: q(req, 'monitorId'), limit: q(req, 'limit') })));
    r.post('/alerts/:id/acknowledge', h((req) => alerts.acknowledge(req.workspace, req.params.id)));
    r.post('/alerts/:id/deliveries/:deliveryId/retry', h((req) => alerts.retryDelivery(req.workspace, req.params.id, req.params.deliveryId)));
    out.monitoring = r;
  }
  if (competitors) {
    const r = withCtx();
    r.get('/dashboard', h((req) => competitors.dashboard(req.workspace)));
    r.get('/products', h((req) => competitors.listProducts(req.workspace, { limit: q(req, 'limit') })));
    r.post('/products', h((req) => competitors.createProduct(req.workspace, req.body || {}), 201));
    r.get('/products/:id', h((req) => competitors.productDetail(req.workspace, req.params.id)));
    r.patch('/products/:id', h((req) => competitors.updateProduct(req.workspace, req.params.id, req.body || {})));
    r.delete('/products/:id', h((req) => competitors.deleteProduct(req.workspace, req.params.id)));
    r.post('/products/:id/competitors', h((req) => competitors.addCompetitor(req.workspace, req.params.id, req.body || {}), 201));
    r.delete('/products/:id/competitors/:cid', h((req) => competitors.removeCompetitor(req.workspace, req.params.id, req.params.cid)));
    r.post('/products/:id/competitors/:cid/match', h((req) => competitors.decideMatch(req.workspace, req.params.id, req.params.cid, req.body || {})));
    r.get('/recommendations', h((req) => competitors.listRecommendations(req.workspace, { status: q(req, 'status'), productId: q(req, 'productId'), limit: q(req, 'limit') })));
    r.post('/recommendations/:id/status', h((req) => competitors.setRecommendationStatus(req.workspace, req.params.id, req.body || {})));
    r.post('/recommendations/:id/act', h((req) => competitors.actOnRecommendation(req.workspace, req.params.id, { ...(req.body || {}), ...(req.get('idempotency-key') ? { idempotencyKey: req.get('idempotency-key') } : {}) }), 201));
    out.competitors = r;
  }
  if (qa) {
    const r = withCtx();
    r.get('/projects', h((req) => qa.listProjects(req.workspace)));
    r.post('/projects', h((req) => qa.createProject(req.workspace, req.body || {}), 201));
    r.get('/projects/:id', h((req) => qa.getProject(req.workspace, req.params.id)));
    r.delete('/projects/:id', h((req) => qa.deleteProject(req.workspace, req.params.id)));
    r.post('/projects/:id/suites', h((req) => qa.createSuite(req.workspace, req.params.id, req.body || {}), 201));
    r.post('/suites/:id/scenarios', h((req) => qa.createScenario(req.workspace, req.params.id, req.body || {}), 201));
    r.delete('/scenarios/:id', h((req) => qa.deleteScenario(req.workspace, req.params.id)));
    r.post('/projects/:id/runs', h(async (req) => {
      const { run, replayed } = await qa.startRun(req.workspace, req.params.id, { ...(req.body || {}), ...(req.get('idempotency-key') ? { idempotencyKey: req.get('idempotency-key') } : {}) });
      return { __status: replayed ? 200 : 201, data: { ...run, replayed } };
    }));
    r.get('/runs', h((req) => qa.listRuns(req.workspace, { projectId: q(req, 'projectId'), limit: q(req, 'limit') })));
    r.get('/runs/:id', h((req) => qa.getRun(req.workspace, req.params.id)));
    r.post('/runs/:id/cancel', h((req) => qa.cancelRun(req.workspace, req.params.id)));
    r.post('/runs/:id/results/:resultId', h(async (req) => {
      const o = await qa.submitExternalResult(req.workspace, req.params.id, req.params.resultId, req.body || {});
      return { __status: o.replayed ? 200 : 201, data: { ...o.result, replayed: o.replayed } };
    }));
    r.get('/projects/:id/metrics', h((req) => qa.projectMetrics(req.workspace, req.params.id, { runs: q(req, 'runs') })));
    out.reliability = r;
  }
  if (agents) {
    const r = withCtx();
    r.get('/', h((req) => agents.list(req.workspace, { status: q(req, 'status') })));
    r.post('/', h((req) => agents.create(req.workspace, req.body || {}), 201));
    r.post('/defaults', h((req) => agents.provisionDefaults(req.workspace)));
    r.get('/:id', h((req) => agents.get(req.workspace, req.params.id)));
    r.patch('/:id', h((req) => agents.update(req.workspace, req.params.id, req.body || {})));
    out.agents = r;
  }
  if (webhooks) {
    const r = withCtx();
    r.get('/', h((req) => webhooks.list(req.workspace)));
    r.post('/', h((req) => webhooks.create(req.workspace, req.body || {}), 201));
    r.patch('/:id', h((req) => webhooks.update(req.workspace, req.params.id, req.body || {})));
    r.delete('/:id', h((req) => webhooks.remove(req.workspace, req.params.id)));
    r.post('/:id/rotate-secret', h((req) => webhooks.rotateSecret(req.workspace, req.params.id)));
    r.post('/:id/test', h((req) => webhooks.test(req.workspace, req.params.id), 202));
    r.get('/:id/deliveries', h((req) => webhooks.deliveries(req.workspace, req.params.id, { limit: q(req, 'limit') })));
    out.webhooks = r;
  }
  if (lifecycle) {
    const r = withCtx();
    r.get('/export', h((req) => lifecycle.exportWorkspace(req.workspace)));
    r.post('/delete', h((req) => lifecycle.deleteWorkspace(req.workspace, req.body || {})));
    out.lifecycle = r;
  }
  return out;
}

/** REVENUE_SUITE_ENABLED (default on; 'false' turns the Layer 10 routes and worker off). */
function revenueFlag(env = process.env) {
  return env.REVENUE_SUITE_ENABLED !== 'false';
}

/**
 * Production wiring: every service reuses the SHARED Layer 1–9 instances
 * (execution service, integration gateway, Agent Firewall, entitlements,
 * workflow service, task service, worker health, metrics).
 */
function createRevenueSystem({
  workspaceService, integrationSystem = null, securitySystem = null, billingSystem = null, workflowSystem = null, executionService = null,
  dataService = null, workerHealth = null, metrics = null, opsStore = null, retentionService = null, logger = console,
} = {}) {
  const { createSupabaseRevenueStore } = require('../services/revenue/revenueStore');
  const { createEventBus } = require('../services/revenue/common');
  const { createConnectorActions } = require('../services/actions/connectorActions');
  const { createMonitoringService } = require('../services/revenue/monitoringService');
  const { createAlertService } = require('../services/revenue/alertService');
  const { createCompetitorService } = require('../services/revenue/competitorService');
  const { createAgentService } = require('../services/revenue/agentService');
  const { createQaService } = require('../services/revenue/qaService');
  const { createWebhookService } = require('../services/revenue/webhookService');
  const { createWorkspaceLifecycle } = require('../services/revenue/workspaceLifecycle');
  const { createRevenueWorker } = require('../services/revenue/revenueWorker');
  const { createCredentialService, loadKeyRing } = require('../services/integrations/credentialService');
  const { createSafeHttpClient } = require('../services/integrations/safeHttp');
  const { createSupabaseExecutionStore } = require('../services/agentExecution/executionStore');
  const { appendAuditLog } = require('../security-engine/auditLog');

  const store = createSupabaseRevenueStore();
  const events = createEventBus({ logger });
  const execSvc = executionService || require('./executions').executionService;
  const usage = billingSystem ? billingSystem.entitlements : null;
  const integrations = integrationSystem ? integrationSystem.service : null;
  const getFirewall = () => (securitySystem && securitySystem.firewallEnabled ? securitySystem.firewall : null);
  const connectorActions = integrations ? createConnectorActions({ integrationService: integrations, getFirewall, logger }) : null;

  const monitoring = createMonitoringService({ store, connectorActions, integrations, usage, events, appendAuditLog, logger });
  const alerts = createAlertService({ store, connectorActions, integrations, events, appendAuditLog, logger });
  const competitors = createCompetitorService({
    store, monitoring, usage, tasks: dataService, workflows: workflowSystem ? workflowSystem.service : null, events, appendAuditLog, logger,
  });
  alerts.setProductResolver((ws, monitorId) => competitors.linksForMonitor(ws, monitorId));
  // Order matters: competitor matching / recommendations first, then alerts.
  events.on('monitor.checked', (e) => competitors.onMonitorChecked(e));
  events.on('monitor.checked', (e) => alerts.onMonitorChecked(e));

  const agents = createAgentService({ store, integrations, appendAuditLog });
  execSvc.setAgentResolver({ resolve: agents.resolve });
  if (workflowSystem) workflowSystem.service.setAgentResolver({ resolve: agents.resolve });
  if (dataService && dataService.setAgentResolver) dataService.setAgentResolver({ resolve: agents.resolve });

  const qa = createQaService({
    store, executionService: execSvc, execStore: createSupabaseExecutionStore(), workflowService: workflowSystem ? workflowSystem.service : null,
    workflowStore: workflowSystem ? workflowSystem.store : null, connectorActions, usage, events, appendAuditLog, logger,
  });

  const keyRing = loadKeyRing();
  // Webhook signing secrets live encrypted in the revenue tables; the
  // credential service is used here for encrypt/decrypt ONLY. Its Layer 5
  // integration-credential store must never be touched from this path, so
  // it gets a store that refuses every call (the service requires one).
  const refuse = () => { throw new Error('webhook credentials: integration credential store is not available on this path'); };
  const noIntegrationCredentialStore = {
    upsertCredential: refuse, getCredential: refuse, getCredentialMeta: refuse, deleteCredential: refuse,
    listCredentialsNotUnderKey: refuse, replaceCredentialIfKey: refuse,
  };
  const webhooks = createWebhookService({ store, credentials: createCredentialService({ store: noIntegrationCredentialStore, keyRing }), http: createSafeHttpClient(), appendAuditLog, logger });
  // Event → webhook fan-out (ids and summaries only).
  execSvc.addFinishListener((e) => {
    if (e.status !== 'completed' && e.status !== 'failed') return null;
    return webhooks.emit(e.workspace_id, `execution.${e.status}`, e.id, {
      executionId: e.id, status: e.status, agentId: e.agent_id || null, taskId: e.task_id || null,
      failure: e.failure_code ? { code: e.failure_code } : null, verification: e.verification ? e.verification.status || null : null, finishedAt: e.finished_at,
    });
  });
  if (workflowSystem) {
    workflowSystem.runner.addRunListener((r) => {
      if (r.status !== 'completed' && r.status !== 'failed') return null;
      return webhooks.emit(r.workspace_id, `workflow_run.${r.status}`, r.id, {
        runId: r.id, workflowId: r.workflow_id, status: r.status, failure: r.failure_code ? { code: r.failure_code } : null,
        verification: r.verification ? r.verification.status || null : null, finishedAt: r.finished_at,
      });
    });
  }
  events.on('alert.created', (e) => webhooks.emit(e.workspaceId, 'alert.created', e.alert.id, e.alert));
  events.on('recommendation.created', (e) => webhooks.emit(e.workspaceId, 'recommendation.created', e.recommendation.id, e.recommendation));
  events.on('qa_run.completed', (e) => webhooks.emit(e.workspaceId, 'qa_run.completed', e.run.id, e.run));
  events.on('monitor.checked', (e) => (e.changes && e.changes.length
    ? webhooks.emit(e.workspaceId, 'monitor.changed', e.observation.id, { monitorId: e.monitor.id, name: e.monitor.name, health: e.monitor.health, changes: e.changes.map((c) => ({ type: c.changeType, field: c.field, oldValue: c.oldValue, newValue: c.newValue, verification: c.verification })) })
    : null));

  // Plan limits: counters for the Layer 10 count capabilities.
  if (billingSystem && billingSystem.counters) {
    billingSystem.counters.monitored_products = (ws) => store.count('ci_products', ws);
    if (integrations) billingSystem.counters.integrations = async (ws) => (await require('../services/integrations/integrationStore').createSupabaseIntegrationStore().listIntegrations(ws)).length;
  }
  if (integrations && usage) integrations.setEntitlements(usage);
  if (retentionService && retentionService.setRevenuePurge) {
    retentionService.setRevenuePurge((ws, c) => store.rpc('retention_purge_revenue', { p_workspace: ws, p_monitoring_before: c.monitoringBefore, p_qa_before: c.qaBefore }));
  }

  const lifecycle = createWorkspaceLifecycle({
    store, workspaceService, appendAuditLog, logger,
    getSubscription: billingSystem ? (ws) => billingSystem.store.getSubscription(ws) : null,
    hasActiveExecution: async (ws) => !!(await createSupabaseExecutionStore().findActiveExecution(ws)),
    onDeleted: [(ws) => { const fw = securitySystem && securitySystem.firewall; if (fw) fw.invalidate(ws); }],
    sources: {
      members: (ws, ctx) => workspaceService.listMembers(ctx),
      tasks: (ws, ctx) => (dataService ? dataService.listTasks(ctx, { limit: 200 }) : []),
      workflows: (ws, ctx) => (workflowSystem ? workflowSystem.service.listWorkflows(ctx, { limit: 200 }) : []),
      workflowRuns: (ws, ctx) => (workflowSystem ? workflowSystem.service.listRuns(ctx, { limit: 100 }) : []),
      executions: (ws, ctx) => execSvc.listExecutions(ctx, { limit: 100 }),
      integrations: (ws, ctx) => (integrations ? integrations.listIntegrations(ctx) : []),
      usage: (ws, ctx) => (billingSystem ? billingSystem.billing.history(ctx, { days: 366 }) : []),
    },
  });

  const worker = createRevenueWorker({
    store, monitoring, alerts, qa, webhooks, workerHealth, metrics, logger,
    listWorkspaceIds: opsStore ? (after, n) => opsStore.listWorkspaceIds(after, n) : null,
  });
  const routers = createRevenueRouters({ workspaceService, monitoring, alerts, competitors, qa, agents, webhooks, lifecycle, logger });
  logger.info?.(`Revenue suite: monitoring ${connectorActions ? 'with connectors' : 'API submissions only (INTEGRATIONS_ENABLED is not "true")'}; webhooks ${keyRing.error ? 'unavailable (INTEGRATION_ENCRYPTION_KEY)' : 'ready'}`);
  return { routers, store, events, monitoring, alerts, competitors, agents, qa, webhooks, lifecycle, worker, connectorActions };
}

module.exports = { createRevenueRouters, createRevenueSystem, revenueFlag };
