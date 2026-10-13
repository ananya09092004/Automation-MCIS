/**
 * Layer 2 — resolves the workspace a data request runs in and establishes
 * the request scope (services/workspaceScope.js).
 *
 * Mounted in server.js in front of /api/chat, /api/memory and /api/goals
 * only. NOT mounted on /api/command, /api/voice, /api/emergency,
 * /api/permissions or the agent socket — the voice pipeline is untouched.
 *
 *   X-Workspace-Id: <uuid>   → Layer 1 membership check (non-member → 404)
 *   (no header)              → the caller's personal workspace (unchanged
 *                              behaviour for existing clients)
 *
 * Workspace identity is derived server-side; the header only SELECTS among
 * workspaces the verified user already belongs to.
 *
 * Kill switch: WORKSPACE_DATA_SCOPING=off → pass-through (legacy behaviour),
 * e.g. while the Layer 2 migration is being rolled back.
 */
'use strict';

const { runWithScope } = require('../services/workspaceScope');
const { toActor, sendWorkspaceError } = require('./workspaceContext');

const PERSONAL_CACHE_TTL_MS = 10 * 60 * 1000;
const PERSONAL_CACHE_MAX = 10000;

function workspaceDataScope(workspaceService, { logger, enabled } = {}) {
  // A personal workspace can never be deleted and its owner can never be
  // removed or demoted (Layer 1 rules), so caching uid → personal id is
  // safe. Team workspaces are NEVER cached: membership/role changes must
  // take effect on the next request.
  const personalCache = new Map();

  async function personalContext(actor) {
    const hit = personalCache.get(actor.uid);
    if (hit && Date.now() - hit.at < PERSONAL_CACHE_TTL_MS) return hit.ctx;
    const ctx = await workspaceService.resolveContext(actor, undefined);
    if (personalCache.size >= PERSONAL_CACHE_MAX) personalCache.clear();
    personalCache.set(actor.uid, { ctx, at: Date.now() });
    return ctx;
  }

  return async function workspaceDataScopeMiddleware(req, res, next) {
    const isEnabled = enabled !== undefined ? enabled : process.env.WORKSPACE_DATA_SCOPING !== 'off';
    if (!isEnabled) return next();

    const requested = req.get('x-workspace-id');
    const actor = toActor(req);
    if (!actor) {
      // No verified user: only reachable through the existing development
      // bypass in middleware/auth.js. Selecting a workspace needs a user.
      if (requested) {
        return res.status(401).json({ success: false, error: 'Authentication required', code: 'AUTH_REQUIRED' });
      }
      return next();
    }

    try {
      const ctx = requested
        ? await workspaceService.resolveContext(actor, requested)
        : await personalContext(actor);
      req.workspace = { id: ctx.workspace.id, role: ctx.role, workspace: ctx.workspace, userId: ctx.userId };
      return runWithScope({
        userId: ctx.userId,
        workspaceId: ctx.workspace.id,
        isPersonal: !!ctx.workspace.is_personal,
        role: ctx.role,
      }, () => next());
    } catch (err) {
      return sendWorkspaceError(res, err, logger);
    }
  };
}

module.exports = { workspaceDataScope };
