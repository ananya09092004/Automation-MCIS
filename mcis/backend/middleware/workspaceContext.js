/**
 * Layer 1 — workspace context + authorization middleware.
 *
 * Usage (must run AFTER middleware/auth.js has set req.user):
 *
 *   const { workspaceContext, requireWorkspaceRole } = require('./middleware/workspaceContext');
 *   router.get('/:workspaceId/things', workspaceContext(service), requireWorkspaceRole('member'), handler);
 *
 * Workspace id source (first match wins):
 *   1. :workspaceId route param
 *   2. X-Workspace-Id header
 *   3. none → the caller's personal workspace
 *
 * On success sets req.workspace = { id, role, workspace, userId }.
 * Non-members get 404 (ids can't be probed); missing auth gets 401 —
 * including when the auth middleware's dev bypass let the request
 * through without a verified user.
 *
 * NOT mounted globally: it costs a DB round trip, and must never be
 * added to the voice / command / agent hot paths without a cache.
 */
'use strict';

const { WorkspaceError, hasRole } = require('../services/workspaceService');

function toActor(req) {
  if (!req.user || !req.user.uid) return null;
  return {
    uid: req.user.uid,
    email: req.user.email || null,
    emailVerified: req.user.claims ? req.user.claims.email_verified === true : false,
  };
}

function sendWorkspaceError(res, err, logger) {
  if (err instanceof WorkspaceError) {
    return res.status(err.status).json({ success: false, error: err.message, code: err.code });
  }
  if (logger) logger.error(`Workspace error: ${err && err.message}`);
  return res.status(500).json({ success: false, error: 'Workspace service error' });
}

function workspaceContext(service, { logger } = {}) {
  return async function resolveWorkspaceContext(req, res, next) {
    const actor = toActor(req);
    if (!actor) {
      return res.status(401).json({ success: false, error: 'Authentication required', code: 'AUTH_REQUIRED' });
    }
    const requested = (req.params && req.params.workspaceId) || req.get('x-workspace-id') || undefined;
    try {
      const ctx = await service.resolveContext(actor, requested);
      req.workspace = {
        id: ctx.workspace.id,
        role: ctx.role,
        workspace: ctx.workspace,
        userId: ctx.userId,
      };
      return next();
    } catch (err) {
      return sendWorkspaceError(res, err, logger);
    }
  };
}

function requireWorkspaceRole(minRole) {
  return function checkWorkspaceRole(req, res, next) {
    if (!req.workspace) {
      return res.status(500).json({ success: false, error: 'workspaceContext middleware missing' });
    }
    if (!hasRole(req.workspace.role, minRole)) {
      return res.status(403).json({ success: false, error: 'Insufficient workspace role', code: 'FORBIDDEN' });
    }
    return next();
  };
}

module.exports = { workspaceContext, requireWorkspaceRole, toActor, sendWorkspaceError };
