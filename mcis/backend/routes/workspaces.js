/**
 * Layer 1 — /api/workspaces
 *
 *   GET    /                                    list my workspaces (creates personal one if missing)
 *   POST   /                                    create team workspace        { name }
 *   GET    /current                             workspace from X-Workspace-Id (or personal)
 *   POST   /invitations/accept                  accept an invite             { token }
 *   GET    /:workspaceId                        member+
 *   PATCH  /:workspaceId                        admin+   { name }
 *   DELETE /:workspaceId                        owner    (not personal)
 *   GET    /:workspaceId/members                member+
 *   PATCH  /:workspaceId/members/:userId        owner    { role: admin|member }
 *   DELETE /:workspaceId/members/:userId        admin+ (owner for admins), or self to leave
 *   GET    /:workspaceId/invitations            admin+
 *   POST   /:workspaceId/invitations            admin+ (owner to invite admin) { email, role }
 *   DELETE /:workspaceId/invitations/:id        admin+
 *   POST   /:workspaceId/transfer-ownership    owner    { newOwnerId }  (Layer 9; old owner becomes admin)
 *
 * Mounted behind middleware/auth.js (app.use('/api', authenticateFirebaseUser)).
 * No email is sent: the invite token is returned once to the inviter to share.
 */
'use strict';

const express = require('express');
const { createWorkspaceService, WorkspaceError } = require('../services/workspaceService');
const { createSupabaseWorkspaceStore } = require('../services/workspaceStore');
const { workspaceContext, toActor, sendWorkspaceError } = require('../middleware/workspaceContext');

function createWorkspacesRouter({ service, logger } = {}) {
  const svc = service || createWorkspaceService(createSupabaseWorkspaceStore());
  const router = express.Router();
  const withCtx = workspaceContext(svc, { logger });

  const handle = (fn, okStatus = 200) => async (req, res) => {
    try {
      const data = await fn(req);
      res.status(okStatus).json({ success: true, data });
    } catch (err) {
      sendWorkspaceError(res, err, logger);
    }
  };

  const requireActor = (req) => {
    const actor = toActor(req);
    if (!actor) throw new WorkspaceError(401, 'AUTH_REQUIRED', 'Authentication required');
    return actor;
  };

  // --- routes that do not target a specific workspace id ---
  router.get('/', handle((req) => svc.listWorkspaces(requireActor(req))));

  router.post('/', handle((req) =>
    svc.createWorkspace(requireActor(req), { name: req.body && req.body.name }), 201));

  router.get('/current', withCtx, handle((req) => svc.getWorkspace(req.workspace)));

  router.post('/invitations/accept', handle((req) =>
    svc.acceptInvitation(requireActor(req), { token: req.body && req.body.token })));

  // --- workspace-scoped routes: withCtx enforces membership first ---
  router.get('/:workspaceId', withCtx, handle((req) => svc.getWorkspace(req.workspace)));

  router.patch('/:workspaceId', withCtx, handle((req) =>
    svc.updateWorkspace(req.workspace, { name: req.body && req.body.name })));

  router.delete('/:workspaceId', withCtx, handle((req) => svc.deleteWorkspace(req.workspace)));

  router.get('/:workspaceId/members', withCtx, handle((req) => svc.listMembers(req.workspace)));

  router.patch('/:workspaceId/members/:userId', withCtx, handle((req) =>
    svc.changeMemberRole(req.workspace, req.params.userId, { role: req.body && req.body.role })));

  router.delete('/:workspaceId/members/:userId', withCtx, handle((req) =>
    svc.removeMember(req.workspace, req.params.userId)));

  // Layer 9: owner hands the workspace to another member (atomic).
  router.post('/:workspaceId/transfer-ownership', withCtx, handle((req) =>
    svc.transferOwnership(req.workspace, req.body && req.body.newOwnerId)));

  router.get('/:workspaceId/invitations', withCtx, handle((req) => svc.listInvitations(req.workspace)));

  router.post('/:workspaceId/invitations', withCtx, handle((req) =>
    svc.createInvitation(req.workspace, {
      email: req.body && req.body.email,
      role: (req.body && req.body.role) || 'member',
    }), 201));

  router.delete('/:workspaceId/invitations/:invitationId', withCtx, handle((req) =>
    svc.revokeInvitation(req.workspace, req.params.invitationId)));

  router.workspaceService = svc; // Layer 7: plan member limits are attached to this instance
  return router;
}

module.exports = createWorkspacesRouter();
module.exports.createWorkspacesRouter = createWorkspacesRouter;
