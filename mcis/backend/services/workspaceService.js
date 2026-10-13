/**
 * Layer 1 — workspace (tenant) business rules and authorization.
 *
 * This module is the single place where multi-tenant access rules are
 * decided. It is storage-agnostic: it receives a `store` (production:
 * services/workspaceStore.js → Supabase; tests: an in-memory store with
 * the same interface) so the same rules are exercised in both.
 *
 * Isolation model
 *   - Every read/write is scoped by a workspace id that was resolved
 *     through `resolveContext`, which requires a membership row for the
 *     authenticated Firebase uid. There is no code path that takes a
 *     workspace id from the client and uses it without that check.
 *   - Non-members get 404 (not 403) so workspace ids cannot be probed.
 *   - Sub-resources (members, invitations) are re-checked to belong to
 *     the resolved workspace before they are read or changed.
 *
 * Roles: owner > admin > member
 *   owner  — everything, incl. delete workspace and change roles
 *   admin  — rename, invite members, revoke invites, remove members
 *   member — read workspace + member list, leave
 */
'use strict';

const crypto = require('crypto');

const ROLES = Object.freeze(['owner', 'admin', 'member']);
const ROLE_RANK = Object.freeze({ member: 1, admin: 2, owner: 3 });
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PERSONAL_WORKSPACE_NAME = 'Personal';

class WorkspaceError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'WorkspaceError';
    this.status = status;
    this.code = code;
  }
}

const notFound = () => new WorkspaceError(404, 'WORKSPACE_NOT_FOUND', 'Workspace not found');
const forbidden = (msg = 'Insufficient workspace role') => new WorkspaceError(403, 'FORBIDDEN', msg);
const badRequest = (msg) => new WorkspaceError(400, 'BAD_REQUEST', msg);
const conflict = (code, msg) => new WorkspaceError(409, code, msg);

function isUuid(v) {
  return typeof v === 'string' && UUID_RE.test(v);
}

function isValidUid(v) {
  return typeof v === 'string' && v.length > 0 && v.length <= 128 && !/[\s/]/.test(v);
}

function hasRole(role, minRole) {
  return (ROLE_RANK[role] || 0) >= ROLE_RANK[minRole];
}

function normalizeName(name) {
  if (typeof name !== 'string') throw badRequest('name is required');
  const trimmed = name.trim();
  if (trimmed.length < 1 || trimmed.length > 100) throw badRequest('name must be 1-100 characters');
  return trimmed;
}

function normalizeEmail(email) {
  if (typeof email !== 'string') throw badRequest('email is required');
  const e = email.trim().toLowerCase();
  if (e.length > 254 || !EMAIL_RE.test(e)) throw badRequest('email is invalid');
  return e;
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
}

function isUniqueViolation(err) {
  return err && err.code === '23505';
}

function requireUid(user) {
  if (!user || !isValidUid(user.uid)) {
    throw new WorkspaceError(401, 'AUTH_REQUIRED', 'Authentication required');
  }
  return user.uid;
}

function createWorkspaceService(store, options = {}) {
  const now = options.now || (() => new Date());
  // Layer 7: optional entitlement service (plan member limits). Roles and
  // billing entitlements stay separate: this only caps HOW MANY members.
  let entitlements = options.entitlements || null;
  async function assertMemberCapacity(workspaceId, quantity) {
    if (!entitlements) return;
    try {
      await entitlements.assert(workspaceId, 'members', quantity);
    } catch (err) {
      throw new WorkspaceError(err.status || 503, err.code || 'ENTITLEMENT_UNAVAILABLE', err.message);
    }
  }
  // Layer 9: optional shared rate limiter + audit hook (set by the server).
  let rateLimiter = options.rateLimiter || null;
  let audit = options.audit || null;
  let mailer = options.mailer || null; // Layer 10
  const requireVerifiedEmail = options.requireVerifiedEmail !== undefined
    ? options.requireVerifiedEmail
    : process.env.WORKSPACE_INVITES_REQUIRE_VERIFIED_EMAIL !== 'false';

  // --------------------------------------------------------------
  // Personal workspace (every user has exactly one; created lazily
  // and race-safe via the partial unique index on owner_id).
  // --------------------------------------------------------------
  async function ensurePersonalWorkspace(uid) {
    let ws = await store.findPersonalWorkspace(uid);
    if (!ws) {
      try {
        ws = await store.insertWorkspace({ name: PERSONAL_WORKSPACE_NAME, owner_id: uid, is_personal: true });
      } catch (err) {
        if (!isUniqueViolation(err)) throw err;
        ws = await store.findPersonalWorkspace(uid); // concurrent request won the race
      }
    }
    const member = await store.getMember(ws.id, uid);
    if (!member) {
      try {
        await store.insertMember({ workspace_id: ws.id, user_id: uid, role: 'owner' });
      } catch (err) {
        if (!isUniqueViolation(err)) throw err;
      }
    }
    return ws;
  }

  async function listWorkspaces(user) {
    const uid = requireUid(user);
    await ensurePersonalWorkspace(uid);
    const memberships = await store.listMembershipsForUser(uid);
    return memberships
      .map(({ role, workspace }) => ({ ...workspace, role }))
      .sort((a, b) => (b.is_personal - a.is_personal) || String(a.created_at).localeCompare(String(b.created_at)));
  }

  async function createWorkspace(user, { name } = {}) {
    const uid = requireUid(user);
    const cleanName = normalizeName(name);
    const ws = await store.insertWorkspace({ name: cleanName, owner_id: uid, is_personal: false });
    try {
      await store.insertMember({ workspace_id: ws.id, user_id: uid, role: 'owner' });
    } catch (err) {
      await store.deleteWorkspace(ws.id).catch(() => {});
      throw err;
    }
    return { ...ws, role: 'owner' };
  }

  // --------------------------------------------------------------
  // Context resolution — THE tenant boundary. Returns
  // { workspace, role, userId } only if the user is a member.
  // No workspace id → the user's personal workspace.
  // --------------------------------------------------------------
  async function resolveContext(user, requestedWorkspaceId) {
    const uid = requireUid(user);

    if (requestedWorkspaceId === undefined || requestedWorkspaceId === null || requestedWorkspaceId === '') {
      const ws = await ensurePersonalWorkspace(uid);
      return { workspace: ws, role: 'owner', userId: uid };
    }

    if (!isUuid(requestedWorkspaceId)) throw notFound();

    const member = await store.getMember(requestedWorkspaceId, uid);
    if (!member) throw notFound();

    const ws = await store.getWorkspace(requestedWorkspaceId);
    if (!ws) throw notFound();

    return { workspace: ws, role: member.role, userId: uid };
  }

  function assertRole(ctx, minRole) {
    if (!ctx || !hasRole(ctx.role, minRole)) throw forbidden();
  }

  async function getWorkspace(ctx) {
    return { ...ctx.workspace, role: ctx.role };
  }

  async function updateWorkspace(ctx, { name } = {}) {
    assertRole(ctx, 'admin');
    const updated = await store.updateWorkspace(ctx.workspace.id, { name: normalizeName(name) });
    return { ...updated, role: ctx.role };
  }

  async function deleteWorkspace(ctx) {
    assertRole(ctx, 'owner');
    if (ctx.workspace.is_personal) throw badRequest('A personal workspace cannot be deleted');
    await store.deleteWorkspace(ctx.workspace.id);
    return { deleted: true, id: ctx.workspace.id };
  }

  // --------------------------------------------------------------
  // Members
  // --------------------------------------------------------------
  async function listMembers(ctx) {
    assertRole(ctx, 'member');
    return store.listMembers(ctx.workspace.id);
  }

  async function getTargetMember(ctx, targetUid) {
    if (!isValidUid(targetUid)) throw new WorkspaceError(404, 'MEMBER_NOT_FOUND', 'Member not found');
    const target = await store.getMember(ctx.workspace.id, targetUid);
    if (!target) throw new WorkspaceError(404, 'MEMBER_NOT_FOUND', 'Member not found');
    return target;
  }

  async function changeMemberRole(ctx, targetUid, { role } = {}) {
    assertRole(ctx, 'owner');
    if (role !== 'admin' && role !== 'member') throw badRequest("role must be 'admin' or 'member'");
    const target = await getTargetMember(ctx, targetUid);
    if (target.role === 'owner') throw forbidden('The owner role cannot be changed');
    const updated = await store.updateMemberRole(ctx.workspace.id, targetUid, role);
    if (!updated) throw new WorkspaceError(404, 'MEMBER_NOT_FOUND', 'Member not found');
    return updated;
  }

  async function removeMember(ctx, targetUid) {
    assertRole(ctx, 'member');
    const target = await getTargetMember(ctx, targetUid);

    if (target.role === 'owner') {
      throw forbidden('The owner cannot be removed (delete the workspace instead)');
    }

    const isSelf = targetUid === ctx.userId;
    if (!isSelf) {
      // admin may remove members; only owner may remove admins
      const needed = target.role === 'admin' ? 'owner' : 'admin';
      assertRole(ctx, needed);
    }

    await store.deleteMember(ctx.workspace.id, targetUid);
    return { removed: true, userId: targetUid, workspaceId: ctx.workspace.id, left: isSelf };
  }

  // --------------------------------------------------------------
  // Invitations
  // --------------------------------------------------------------
  async function listInvitations(ctx) {
    assertRole(ctx, 'admin');
    const rows = await store.listInvitations(ctx.workspace.id);
    const t = now().getTime();
    return rows.map((r) => ({
      ...r,
      status: r.status === 'pending' && new Date(r.expires_at).getTime() <= t ? 'expired' : r.status,
    }));
  }

  async function createInvitation(ctx, { email, role = 'member' } = {}) {
    assertRole(ctx, 'admin');
    if (ctx.workspace.is_personal) throw badRequest('Invitations are not available for a personal workspace');
    if (role !== 'admin' && role !== 'member') throw badRequest("role must be 'admin' or 'member'");
    if (role === 'admin') assertRole(ctx, 'owner'); // only the owner can grant admin
    const cleanEmail = normalizeEmail(email);

    const existing = await store.findPendingInvitation(ctx.workspace.id, cleanEmail);
    if (existing) {
      if (new Date(existing.expires_at).getTime() > now().getTime()) {
        throw conflict('INVITE_EXISTS', 'A pending invitation for this email already exists');
      }
      await store.transitionInvitation(existing.id, 'pending', { status: 'revoked' });
    }

    // Layer 7: a pending invitation reserves a seat (members + pending ≤ plan limit).
    await assertMemberCapacity(ctx.workspace.id, 1);

    const token = crypto.randomBytes(32).toString('base64url');
    let invitation;
    try {
      invitation = await store.insertInvitation({
        workspace_id: ctx.workspace.id,
        email: cleanEmail,
        role,
        token_hash: hashToken(token),
        invited_by: ctx.userId,
        status: 'pending',
        expires_at: new Date(now().getTime() + INVITE_TTL_MS).toISOString(),
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw conflict('INVITE_EXISTS', 'A pending invitation for this email already exists');
      throw err;
    }
    // Layer 9: the check above is not atomic with the insert. Re-count WITH
    // this invitation: if concurrent invitations pushed the workspace over its
    // plan limit, this one is withdrawn — the limit is never exceeded.
    if (entitlements) {
      // Serialized re-count under a per-workspace lock; an over-limit
      // invitation is revoked by the store in the same transaction.
      if (entitlements.enforceCount && store.enforceMemberLimit) {
        try {
          await entitlements.enforceCount(ctx.workspace.id, 'members', (limit) => store.enforceMemberLimit(ctx.workspace.id, invitation.id, limit));
        } catch (err) {
          if (err.code !== 'QUOTA_EXCEEDED') await store.transitionInvitation(invitation.id, 'pending', { status: 'revoked' }).catch(() => {});
          throw new WorkspaceError(err.status || 503, err.code || 'ENTITLEMENT_UNAVAILABLE', err.message);
        }
      } else {
        try { await assertMemberCapacity(ctx.workspace.id, 0); } catch (err) {
          await store.transitionInvitation(invitation.id, 'pending', { status: 'revoked' }).catch(() => {});
          throw err;
        }
      }
    }
    // Layer 10: optional invitation email (honest status; never blocks the invitation).
    let emailResult;
    if (mailer && mailer.configured) {
      emailResult = await mailer.send({ to: cleanEmail, workspaceName: ctx.workspace.name, role, token, invitationId: invitation.id })
        .catch(() => ({ status: 'failed', code: 'MAILER_ERROR' }));
      if (audit) {
        try { Promise.resolve(audit(ctx.userId, 'workspace_invitation_emailed', { workspaceId: ctx.workspace.id, invitationId: invitation.id, status: emailResult.status, code: emailResult.code || null }, { success: emailResult.status === 'sent' }, ctx.workspace.id)).catch(() => {}); } catch { /* never */ }
      }
    } else emailResult = { status: 'not_configured' };
    // The raw token is returned exactly once and never stored.
    return { invitation, token, email: emailResult };
  }

  async function revokeInvitation(ctx, invitationId) {
    assertRole(ctx, 'admin');
    const notFoundInv = new WorkspaceError(404, 'INVITE_NOT_FOUND', 'Invitation not found');
    if (!isUuid(invitationId)) throw notFoundInv;
    const inv = await store.getInvitation(invitationId);
    // Cross-tenant guard: an invitation from another workspace is invisible here.
    if (!inv || inv.workspace_id !== ctx.workspace.id) throw notFoundInv;
    if (inv.status !== 'pending') throw conflict('INVITE_NOT_PENDING', 'Invitation is no longer pending');
    const updated = await store.transitionInvitation(inv.id, 'pending', { status: 'revoked' });
    if (!updated) throw conflict('INVITE_NOT_PENDING', 'Invitation is no longer pending');
    return updated;
  }

  async function acceptInvitation(user, { token } = {}) {
    const uid = requireUid(user);
    // Layer 9: DB-backed attempt limit per user (shared by all instances; fails closed).
    if (rateLimiter && !(await rateLimiter.hit(['invite_accept', uid], INVITE_ACCEPT_WINDOW_S, INVITE_ACCEPT_LIMIT))) {
      throw new WorkspaceError(429, 'RATE_LIMITED', 'Too many invitation attempts. Try again later.');
    }
    const invalid = new WorkspaceError(404, 'INVITE_INVALID', 'Invitation is invalid or has expired');
    if (typeof token !== 'string' || token.length < 20 || token.length > 200) throw invalid;

    const inv = await store.findInvitationByTokenHash(hashToken(token));
    if (!inv || inv.status !== 'pending') throw invalid;
    if (new Date(inv.expires_at).getTime() <= now().getTime()) throw invalid;

    const userEmail = typeof user.email === 'string' ? user.email.trim().toLowerCase() : '';
    if (!userEmail || userEmail !== inv.email) {
      throw forbidden('This invitation was sent to a different email address');
    }
    if (requireVerifiedEmail && user.emailVerified !== true) {
      throw forbidden('Verify your email address before accepting invitations');
    }

    if (await store.getMember(inv.workspace_id, uid)) {
      throw conflict('ALREADY_MEMBER', 'You are already a member of this workspace');
    }

    // Layer 7: this invitation's seat is already counted; a plan downgrade
    // since it was sent must still be respected.
    await assertMemberCapacity(inv.workspace_id, 0);

    // Single-use: only one request can move it out of 'pending'.
    const claimed = await store.transitionInvitation(inv.id, 'pending', {
      status: 'accepted',
      accepted_by: uid,
      accepted_at: now().toISOString(),
    });
    if (!claimed) throw invalid;

    try {
      await store.insertMember({ workspace_id: inv.workspace_id, user_id: uid, role: inv.role });
    } catch (err) {
      if (!isUniqueViolation(err)) {
        // Put the invite back so the user can retry after a transient failure.
        await store.transitionInvitation(inv.id, 'accepted', {
          status: 'pending', accepted_by: null, accepted_at: null,
        }).catch(() => {});
        throw err;
      }
    }

    const ws = await store.getWorkspace(inv.workspace_id);
    return { workspace: { ...ws, role: inv.role } };
  }

  /**
   * Layer 9: hand the workspace to another member. Owner only, company
   * workspaces only; the target must already be a member. The store does it
   * in ONE transaction (new owner ← owner, old owner → admin, workspaces.owner_id),
   * guarded by the current owner id, so concurrent transfers cannot both win.
   */
  async function transferOwnership(ctx, targetUid) {
    assertRole(ctx, 'owner');
    if (ctx.workspace.is_personal) throw forbidden('A personal workspace cannot be transferred');
    if (!isValidUid(targetUid) || targetUid === ctx.userId) throw badRequest('Choose another member of this workspace');
    const target = await getTargetMember(ctx, targetUid);
    if (target.role === 'owner') throw badRequest('That member is already the owner');
    const ok = await store.transferOwnership(ctx.workspace.id, ctx.userId, targetUid);
    if (!ok) throw conflict('OWNERSHIP_CHANGED', 'Ownership changed at the same time; reload and try again');
    if (audit) {
      try { Promise.resolve(audit(ctx.userId, 'workspace_ownership_transferred', { workspaceId: ctx.workspace.id, from: ctx.userId, to: targetUid }, { success: true }, ctx.workspace.id)).catch(() => {}); } catch { /* audit never breaks the request */ }
    }
    const ws = await store.getWorkspace(ctx.workspace.id);
    return { workspace: { ...ws, role: 'admin' }, owner: targetUid };
  }

  return {
    setEntitlements(e) { entitlements = e || null; }, // Layer 7
    setRateLimiter(r) { rateLimiter = r || null; }, // Layer 9
    setAudit(a) { audit = a || null; }, // Layer 9
    setMailer(m) { mailer = m || null; }, // Layer 10: invitation emails
    transferOwnership,
    ensurePersonalWorkspace,
    listWorkspaces,
    createWorkspace,
    resolveContext,
    assertRole,
    getWorkspace,
    updateWorkspace,
    deleteWorkspace,
    listMembers,
    changeMemberRole,
    removeMember,
    listInvitations,
    createInvitation,
    revokeInvitation,
    acceptInvitation,
  };
}

const INVITE_ACCEPT_LIMIT = 20;
const INVITE_ACCEPT_WINDOW_S = 600;

module.exports = {
  createWorkspaceService,
  WorkspaceError,
  ROLES,
  hasRole,
  hashToken,
  isUuid,
  INVITE_TTL_MS,
};
