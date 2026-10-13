/**
 * Layer 3 — /api/workspaces/:workspaceId/executions
 *
 *   POST   /                                         start an agent execution   { goal, idempotencyKey? }
 *                                                   (or Idempotency-Key header) → 201, or 200 on idempotent replay
 *   GET    /                                         list recent executions (member+)
 *   GET    /:executionId                             status / current step / progress / approval / result
 *   GET    /:executionId/evidence                    redacted step evidence + approvals
 *   POST   /:executionId/approvals/:approvalId/approve   { note? }
 *   POST   /:executionId/approvals/:approvalId/reject    { note? }
 *   POST   /:executionId/cancel
 *
 * Auth: behind middleware/auth.js (Firebase). Tenant boundary: Layer 1's
 * workspaceContext (membership required; non-members get 404). The
 * workspace id comes ONLY from the URL and is re-checked against the
 * caller's membership; user identity comes ONLY from the verified token.
 */
'use strict';

const express = require('express');
const { createWorkspaceService, WorkspaceError } = require('../services/workspaceService');
const { createSupabaseWorkspaceStore } = require('../services/workspaceStore');
const { workspaceContext } = require('../middleware/workspaceContext');
const { createAgentExecutionService, ExecutionError } = require('../services/agentExecution/executionService');
const { createSupabaseExecutionStore } = require('../services/agentExecution/executionStore');

function sendError(res, err, logger) {
  if (err instanceof ExecutionError || err instanceof WorkspaceError) {
    return res.status(err.status).json({ success: false, error: err.message, code: err.code, ...(err.extra || {}) });
  }
  if (logger && logger.error) logger.error(`Execution route error: ${err && err.message}`);
  return res.status(500).json({ success: false, error: 'Execution service error' });
}

function createExecutionsRouter({ workspaceService, executionService, logger } = {}) {
  const wsSvc = workspaceService || createWorkspaceService(createSupabaseWorkspaceStore());
  // Layer 6: durable ownership lease so several backend instances can share
  // the executions table safely (MULTI_INSTANCE_EXECUTION=false → Layer 3's
  // single-instance behaviour).
  const leaseMs = process.env.MULTI_INSTANCE_EXECUTION === 'false' ? 0 : 30000;
  const execSvc = executionService || createAgentExecutionService({ store: createSupabaseExecutionStore(), logger, options: { leaseMs } });
  const router = express.Router({ mergeParams: true });

  // Every route below requires workspace membership.
  router.use(workspaceContext(wsSvc, { logger }));

  const handle = (fn, okStatus = 200) => async (req, res) => {
    try {
      const out = await fn(req);
      if (out && out.__status) return res.status(out.__status).json({ success: true, data: out.data });
      return res.status(okStatus).json({ success: true, data: out });
    } catch (err) {
      return sendError(res, err, logger);
    }
  };

  router.post('/', handle(async (req) => {
    const body = req.body || {};
    const { execution, replayed } = await execSvc.createExecution(req.workspace, {
      goal: body.goal,
      idempotencyKey: req.get('idempotency-key') || body.idempotencyKey,
      ...(body.agentId !== undefined ? { agentId: body.agentId } : {}), // Layer 10: run as an AI workforce agent
    });
    return { __status: replayed ? 200 : 201, data: { ...execution, replayed } };
  }));

  router.get('/', handle((req) => execSvc.listExecutions(req.workspace, { limit: req.query.limit })));

  router.get('/:executionId', handle((req) => execSvc.getExecution(req.workspace, req.params.executionId)));

  router.get('/:executionId/evidence', handle((req) => execSvc.getEvidence(req.workspace, req.params.executionId)));

  router.post('/:executionId/approvals/:approvalId/approve', handle((req) =>
    execSvc.decideApproval(req.workspace, req.params.executionId, req.params.approvalId, {
      decision: 'approve', note: req.body && req.body.note,
    })));

  router.post('/:executionId/approvals/:approvalId/reject', handle((req) =>
    execSvc.decideApproval(req.workspace, req.params.executionId, req.params.approvalId, {
      decision: 'reject', note: req.body && req.body.note,
    })));

  router.post('/:executionId/cancel', handle((req) => execSvc.cancelExecution(req.workspace, req.params.executionId)));

  // Exposed so Layer 2 tasks share THIS instance (execution runtimes are
  // in-process; a second instance would treat them as interrupted).
  router.executionService = execSvc;
  return router;
}

const defaultRouter = createExecutionsRouter();
module.exports = defaultRouter;
module.exports.createExecutionsRouter = createExecutionsRouter;
module.exports.executionService = defaultRouter.executionService;
