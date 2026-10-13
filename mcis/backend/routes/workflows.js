/**
 * Layer 4 — workflows + durable runs.
 *
 * Workflows (mounted at /api/workspaces/:workspaceId/workflows)
 *   GET    /                                  ?status=draft|active|archived
 *   POST   /                                  { name, description?, definition? }            (member+)
 *   GET    /:workflowId                       workflow + draft + versions
 *   PATCH  /:workflowId                       { revision, name?, description?, definition? } (creator/admin)
 *   POST   /:workflowId/publish               { revision? } → new immutable version        (creator/admin)
 *   POST   /:workflowId/archive                                                              (creator/admin)
 *   POST   /:workflowId/activate              re-activate an archived workflow                (creator/admin)
 *   PUT    /:workflowId/trigger               { type: manual|scheduled|api, intervalMinutes?, inputs? } (admin+)
 *   GET    /:workflowId/versions/:version     immutable definition of one version
 *   POST   /:workflowId/runs                  { inputs?, trigger?, taskId? } (+ Idempotency-Key) → 201 / 200 replay
 *   GET    /:workflowId/runs
 *
 * Runs (mounted at /api/workspaces/:workspaceId/workflow-runs)
 *   GET    /                                  ?workflowId=
 *   GET    /:runId                            status, current step, steps, approval state, evidence summary
 *   GET    /:runId/evidence                   redacted Layer 3 evidence for every step attempt
 *   POST   /:runId/cancel                                                                    (initiator/admin)
 *   POST   /:runId/resolve                    { action: retry_step|skip_step|fail }          (initiator/admin)
 *   POST   /:runId/steps/:position/approvals/:approvalId/approve|reject  { note? }          (Layer 3 rules)
 *
 * All behind middleware/auth.js (Firebase) + Layer 1 workspaceContext
 * (membership; non-members get 404). The workspace comes only from the URL
 * and is re-checked against the caller's membership.
 */
'use strict';

const express = require('express');
const { createWorkspaceService, WorkspaceError } = require('../services/workspaceService');
const { createSupabaseWorkspaceStore } = require('../services/workspaceStore');
const { workspaceContext } = require('../middleware/workspaceContext');
const { ExecutionError } = require('../services/agentExecution/executionService');
const { DefinitionError } = require('../services/workflows/definition');

function sendError(res, err, logger) {
  if (err instanceof WorkspaceError || err instanceof ExecutionError || err instanceof DefinitionError) {
    return res.status(err.status).json({ success: false, error: err.message, code: err.code, ...(err.extra || {}) });
  }
  if (logger && logger.error) logger.error(`Workflow route error: ${err && err.message}`);
  return res.status(500).json({ success: false, error: 'Workflow service error' });
}

const handle = (logger) => (fn, okStatus = 200) => async (req, res) => {
  try {
    const out = await fn(req);
    if (out && out.__status) return res.status(out.__status).json({ success: true, data: out.data });
    return res.status(okStatus).json({ success: true, data: out });
  } catch (err) {
    return sendError(res, err, logger);
  }
};

function createWorkflowRouters({ workspaceService, workflowService, logger } = {}) {
  if (!workflowService) throw new Error('workflowService is required');
  const wsSvc = workspaceService || createWorkspaceService(createSupabaseWorkspaceStore());
  const svc = workflowService;
  const h = handle(logger);
  const withCtx = workspaceContext(wsSvc, { logger });
  const idem = (req) => req.get('idempotency-key') || (req.body && req.body.idempotencyKey);

  const workflows = express.Router({ mergeParams: true });
  workflows.use(withCtx);
  workflows.get('/', h((req) => svc.listWorkflows(req.workspace, { status: req.query.status, limit: req.query.limit })));
  workflows.post('/', h((req) => svc.createWorkflow(req.workspace, req.body || {}), 201));
  workflows.get('/:workflowId', h((req) => svc.getWorkflow(req.workspace, req.params.workflowId)));
  workflows.patch('/:workflowId', h((req) => svc.updateWorkflow(req.workspace, req.params.workflowId, req.body || {})));
  workflows.post('/:workflowId/publish', h(async (req) => {
    const out = await svc.publishWorkflow(req.workspace, req.params.workflowId, req.body || {});
    return { __status: out.created ? 201 : 200, data: out };
  }));
  workflows.post('/:workflowId/archive', h((req) => svc.archiveWorkflow(req.workspace, req.params.workflowId)));
  workflows.post('/:workflowId/activate', h((req) => svc.activateWorkflow(req.workspace, req.params.workflowId)));
  workflows.put('/:workflowId/trigger', h((req) => svc.setTrigger(req.workspace, req.params.workflowId, req.body || {})));
  workflows.get('/:workflowId/versions/:version', h((req) => svc.getVersion(req.workspace, req.params.workflowId, req.params.version)));
  workflows.post('/:workflowId/runs', h(async (req) => {
    const { run, replayed } = await svc.startRun(req.workspace, req.params.workflowId, req.body || {}, { idempotencyKey: idem(req) });
    return { __status: replayed ? 200 : 201, data: { ...run, replayed } };
  }));
  workflows.get('/:workflowId/runs', h((req) => svc.listWorkflowRuns(req.workspace, req.params.workflowId, { limit: req.query.limit })));

  const runs = express.Router({ mergeParams: true });
  runs.use(withCtx);
  runs.get('/', h((req) => svc.listRuns(req.workspace, { workflowId: req.query.workflowId, limit: req.query.limit })));
  runs.get('/:runId', h((req) => svc.getRun(req.workspace, req.params.runId)));
  runs.get('/:runId/evidence', h((req) => svc.getRunEvidence(req.workspace, req.params.runId)));
  runs.post('/:runId/cancel', h((req) => svc.cancelRun(req.workspace, req.params.runId)));
  runs.post('/:runId/resolve', h((req) => svc.resolveRun(req.workspace, req.params.runId, req.body || {})));
  for (const decision of ['approve', 'reject']) {
    runs.post(`/:runId/steps/:position/approvals/:approvalId/${decision}`, h((req) =>
      svc.decideApproval(req.workspace, req.params.runId, req.params.position, req.params.approvalId, {
        decision, note: req.body && req.body.note,
      })));
  }

  return { workflows, runs };
}

/**
 * Production wiring: Supabase stores, the SHARED Layer 3 execution
 * service (its runtimes are in-process), the Layer 2 task store and the
 * durable runner. The worker only starts when WORKFLOW_WORKER_ENABLED is
 * not 'false'. Since Layer 6 the job leases are fenced, so more than one
 * instance may run the worker (see docs/LAYER6_SECURITY.md §7).
 */
function createWorkflowSystem({ workspaceService, executionService, integrationResolver = null, extraSafeActions = [], securityEvents = null, usage = null, workerHealth = null, logger } = {}) {
  const { createSupabaseWorkflowStore } = require('../services/workflows/workflowStore');
  const { createWorkflowService } = require('../services/workflows/workflowService');
  const { createWorkflowRunner } = require('../services/workflows/workflowRunner');
  const { createSupabaseExecutionStore } = require('../services/agentExecution/executionStore');
  const { createSupabaseWorkspaceDataStore } = require('../services/workspaceData/workspaceDataStore');
  const { appendAuditLog } = require('../security-engine/auditLog');

  const wsStore = createSupabaseWorkspaceStore();
  const wsSvc = workspaceService || createWorkspaceService(wsStore);
  const execSvc = executionService || require('./executions').executionService;
  const store = createSupabaseWorkflowStore();
  const dataStore = createSupabaseWorkspaceDataStore();
  const service = createWorkflowService({ store, dataStore, executionService: execSvc, appendAuditLog, integrationResolver, usage, logger });
  const runner = createWorkflowRunner({
    store,
    service,
    dataStore,
    executionService: execSvc,
    execStore: createSupabaseExecutionStore(),
    appendAuditLog,
    // Layer 5: read-only connector actions are as safe to repeat as
    // read-only Nexus actions (recovery rules).
    safeToRepeatActions: [...require('../backend-routing/intentRouter').SAFE_TO_REPEAT_ACTIONS, ...extraSafeActions],
    getMemberRole: async (workspaceId, uid) => {
      if (!uid) return null;
      const m = await wsStore.getMember(workspaceId, uid);
      return m ? m.role : null;
    },
    securityEvents, // Layer 6: worker fencing / structured-output events
    workerHealth, // Layer 9: worker liveness heartbeats
    logger,
  });
  service.attachRunner(runner);
  const routers = createWorkflowRouters({ workspaceService: wsSvc, workflowService: service, logger });
  return { ...routers, service, runner, store };
}

module.exports = { createWorkflowRouters, createWorkflowSystem };
