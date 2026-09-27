/**
 * Layer 2 — workspace collaboration & admin APIs.
 *
 * Tasks  (mounted at /api/workspaces/:workspaceId/tasks)
 *   GET    /                         ?status=&assignee=me|<uid>&limit=
 *   POST   /                         { title, description?, priority?, assignee? }
 *   GET    /:taskId                  task + linked executions + recent activity
 *   PATCH  /:taskId                  { title?, description?, priority? }
 *   POST   /:taskId/assign           { assignee: { type: 'human', userId } | { type: 'agent' } | null }
 *   POST   /:taskId/status           { status }
 *   GET    /:taskId/activity
 *   POST   /:taskId/comments         { body }
 *   POST   /:taskId/execute          { idempotencyKey? } (or Idempotency-Key header) → Layer 3 execution
 *   DELETE /:taskId                  admin+, only without executions
 *
 * Permission grants (mounted at /api/workspaces/:workspaceId/permissions)
 *   GET / (member+) · POST / { resource } (admin+) · DELETE /:grantId (admin+)
 *
 * Audit (mounted at /api/workspaces/:workspaceId/audit)
 *   GET / ?limit=&before=   (admin+)
 *
 * All behind middleware/auth.js (Firebase) + Layer 1 workspaceContext
 * (membership; non-members get 404). Workspace id comes only from the URL
 * and is re-checked against the caller's membership.
 */
'use strict';

const express = require('express');
const { createWorkspaceService, WorkspaceError } = require('../services/workspaceService');
const { createSupabaseWorkspaceStore } = require('../services/workspaceStore');
const { workspaceContext } = require('../middleware/workspaceContext');
const { ExecutionError } = require('../services/agentExecution/executionService');
const { createWorkspaceDataService } = require('../services/workspaceData/workspaceDataService');
const { createSupabaseWorkspaceDataStore } = require('../services/workspaceData/workspaceDataStore');

function sendError(res, err, logger) {
  if (err instanceof WorkspaceError || err instanceof ExecutionError) {
    return res.status(err.status).json({ success: false, error: err.message, code: err.code, ...(err.extra || {}) });
  }
  if (logger && logger.error) logger.error(`Workspace data route error: ${err && err.message}`);
  return res.status(500).json({ success: false, error: 'Workspace data service error' });
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

function buildService({ workspaceService, executionService, dataService, logger }) {
  if (dataService) return dataService;
  const { appendAuditLog, getWorkspaceAuditLog } = require('../security-engine/auditLog');
  const execSvc = executionService || require('./executions').executionService;
  return createWorkspaceDataService({
    store: createSupabaseWorkspaceDataStore(),
    workspaceService,
    executionService: execSvc,
    appendAuditLog,
    getWorkspaceAuditLog,
    logger,
  });
}

function createWorkspaceDataRouters({ workspaceService, executionService, dataService, logger } = {}) {
  const wsSvc = workspaceService || createWorkspaceService(createSupabaseWorkspaceStore());
  const svc = buildService({ workspaceService: wsSvc, executionService, dataService, logger });
  const h = handle(logger);
  const withCtx = workspaceContext(wsSvc, { logger });

  // ---- tasks ----
  const tasks = express.Router({ mergeParams: true });
  tasks.use(withCtx);
  tasks.get('/', h((req) => svc.listTasks(req.workspace, { status: req.query.status, assignee: req.query.assignee, agentId: req.query.agentId, limit: req.query.limit })));
  tasks.post('/', h((req) => svc.createTask(req.workspace, req.body || {}), 201));
  tasks.get('/:taskId', h((req) => svc.getTask(req.workspace, req.params.taskId)));
  tasks.patch('/:taskId', h((req) => svc.updateTask(req.workspace, req.params.taskId, req.body || {})));
  tasks.post('/:taskId/assign', h((req) => svc.assignTask(req.workspace, req.params.taskId, req.body || {})));
  tasks.post('/:taskId/status', h((req) => svc.changeStatus(req.workspace, req.params.taskId, req.body || {})));
  tasks.get('/:taskId/activity', h((req) => svc.listActivity(req.workspace, req.params.taskId)));
  tasks.post('/:taskId/comments', h((req) => svc.addComment(req.workspace, req.params.taskId, req.body || {}), 201));
  tasks.post('/:taskId/execute', h(async (req) => {
    const { execution, replayed } = await svc.executeTask(req.workspace, req.params.taskId, {
      idempotencyKey: req.get('idempotency-key') || (req.body && req.body.idempotencyKey),
    });
    return { __status: replayed ? 200 : 201, data: { ...execution, replayed } };
  }));
  tasks.delete('/:taskId', h((req) => svc.deleteTask(req.workspace, req.params.taskId)));

  // ---- permission grants ----
  const permissions = express.Router({ mergeParams: true });
  permissions.use(withCtx);
  permissions.get('/', h((req) => svc.listGrants(req.workspace)));
  permissions.post('/', h((req) => svc.createGrant(req.workspace, req.body || {}), 201));
  permissions.delete('/:grantId', h((req) => svc.deleteGrant(req.workspace, req.params.grantId)));

  // ---- audit ----
  const audit = express.Router({ mergeParams: true });
  audit.use(withCtx);
  audit.get('/', h((req) => svc.listAudit(req.workspace, { limit: req.query.limit, before: req.query.before })));

  return { tasks, permissions, audit, service: svc };
}

module.exports = { createWorkspaceDataRouters };
