/**
 * Layer 9 — operations routes.
 *
 *   /api/workspaces/:workspaceId/retention
 *     GET   /          effective retention + floors            admin+
 *     PUT   /          { executionsDays, auditDays } (null = keep)   owner
 *     POST  /purge     purge this workspace now (audited)      owner
 *
 *   GET /health/ready   readiness: database reachable and (when this
 *                       deployment runs workflow workers) ≥1 live worker.
 *                       Counts only — no ids, no workspace data.
 *   GET /metrics        Prometheus text; requires Bearer METRICS_TOKEN.
 */
'use strict';

const express = require('express');
const { WorkspaceError } = require('../services/workspaceService');
const { workspaceContext } = require('../middleware/workspaceContext');

function sendError(res, err, logger) {
  if (err instanceof WorkspaceError || (err && Number.isInteger(err.status) && err.status < 500 && err.code)) {
    return res.status(err.status).json({ success: false, error: err.message, code: err.code });
  }
  if (err && err.code === '22023') return res.status(400).json({ success: false, error: 'Retention below the minimum.', code: 'INVALID_RETENTION' });
  logger?.error?.(`Ops route error: ${err && (err.code || err.name)}`);
  return res.status(500).json({ success: false, error: 'Operations service error' });
}

function createRetentionRouter({ workspaceService, retentionService, logger = console }) {
  const router = express.Router({ mergeParams: true });
  router.use(workspaceContext(workspaceService, { logger }));
  const h = (fn) => async (req, res) => {
    try {
      res.set('Cache-Control', 'no-store');
      return res.json({ success: true, data: await fn(req) });
    } catch (err) { return sendError(res, err, logger); }
  };
  router.get('/', h((req) => retentionService.getPolicy(req.workspace)));
  router.put('/', h((req) => retentionService.setPolicy(req.workspace, req.body || {})));
  router.post('/purge', h((req) => retentionService.purgeNow(req.workspace)));
  return router;
}

/** Readiness probe. `checkDb` resolves when the database answers. */
function readinessHandler({ checkDb, workerHealth = null, requireWorkers = false }) {
  return async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const out = { status: 'ready', database: 'ok' };
    let ok = true;
    try { await checkDb(); } catch { ok = false; out.database = 'unavailable'; }
    if (workerHealth) {
      try {
        const s = await workerHealth.summary();
        out.workers = { live: s.live, stale: s.stale, runningJobs: s.runningJobs };
        if (requireWorkers && s.live < 1) ok = false;
      } catch { out.workers = 'unavailable'; if (requireWorkers) ok = false; }
    }
    if (!ok) out.status = 'not_ready';
    return res.status(ok ? 200 : 503).json(out);
  };
}

module.exports = { createRetentionRouter, readinessHandler };
