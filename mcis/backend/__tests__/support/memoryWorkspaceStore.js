/**
 * TEST-ONLY in-memory implementation of the workspace store interface
 * (services/workspaceStore.js). It mirrors the constraints of
 * migrations/20260923_layer1_workspaces.up.sql that the service relies
 * on (unique personal workspace per owner, member PK, single owner,
 * one pending invite per email, FK cascade) and raises Postgres-style
 * `code: '23505'` errors so the service's race handling is exercised.
 *
 * Every method yields to the event loop first so concurrent requests
 * interleave like they would against a real database.
 */
'use strict';

const crypto = require('crypto');

function uniqueViolation(what) {
  const err = new Error(`duplicate key value violates unique constraint (${what})`);
  err.code = '23505';
  return err;
}

const tick = () => new Promise((r) => setImmediate(r));
const clone = (o) => (o ? JSON.parse(JSON.stringify(o)) : o);
const INV_PUBLIC = ({ token_hash, ...rest }) => rest; // eslint-disable-line no-unused-vars

function createMemoryWorkspaceStore() {
  const workspaces = new Map();
  const members = new Map(); // key `${ws}|${uid}`
  const invitations = new Map();
  const nowIso = () => new Date().toISOString();

  const store = {
    _dump: () => ({ workspaces: [...workspaces.values()], members: [...members.values()], invitations: [...invitations.values()] }),

    async findPersonalWorkspace(ownerId) {
      await tick();
      return clone([...workspaces.values()].find((w) => w.owner_id === ownerId && w.is_personal) || null);
    },
    async getWorkspace(id) {
      await tick();
      return clone(workspaces.get(id) || null);
    },
    async insertWorkspace({ name, owner_id, is_personal }) {
      await tick();
      if (is_personal && [...workspaces.values()].some((w) => w.owner_id === owner_id && w.is_personal)) {
        throw uniqueViolation('workspaces_one_personal_per_owner');
      }
      const row = { id: crypto.randomUUID(), name, owner_id, is_personal: !!is_personal, created_at: nowIso(), updated_at: nowIso() };
      workspaces.set(row.id, row);
      return clone(row);
    },
    async updateWorkspace(id, patch) {
      await tick();
      const w = workspaces.get(id);
      Object.assign(w, patch, { updated_at: nowIso() });
      return clone(w);
    },
    async deleteWorkspace(id) {
      await tick();
      workspaces.delete(id);
      for (const [k, m] of members) if (m.workspace_id === id) members.delete(k);
      for (const [k, i] of invitations) if (i.workspace_id === id) invitations.delete(k);
    },
    async getMember(workspaceId, userId) {
      await tick();
      return clone(members.get(`${workspaceId}|${userId}`) || null);
    },
    async insertMember({ workspace_id, user_id, role }) {
      await tick();
      if (!workspaces.has(workspace_id)) {
        const err = new Error('foreign key violation'); err.code = '23503'; throw err;
      }
      const key = `${workspace_id}|${user_id}`;
      if (members.has(key)) throw uniqueViolation('workspace_members_pkey');
      if (role === 'owner' && [...members.values()].some((m) => m.workspace_id === workspace_id && m.role === 'owner')) {
        throw uniqueViolation('workspace_members_single_owner');
      }
      const row = { workspace_id, user_id, role, created_at: nowIso() };
      members.set(key, row);
      return clone(row);
    },
    async updateMemberRole(workspaceId, userId, role) {
      await tick();
      const m = members.get(`${workspaceId}|${userId}`);
      if (!m) return null;
      m.role = role;
      return clone(m);
    },
    // Layer 9: mirrors RPC transfer_workspace_ownership (single synchronous section = one transaction).
    async transferOwnership(workspaceId, fromUid, toUid) {
      await tick();
      const ws = workspaces.get(workspaceId);
      const from = members.get(`${workspaceId}|${fromUid}`);
      const to = members.get(`${workspaceId}|${toUid}`);
      if (!ws || ws.is_personal || ws.owner_id !== fromUid || !from || from.role !== 'owner' || !to || to.role === 'owner') return false;
      to.role = 'owner';
      from.role = 'admin';
      ws.owner_id = toUid;
      return true;
    },
    // Layer 9: mirrors RPC enforce_member_limit (one synchronous section = the locked transaction).
    async enforceMemberLimit(workspaceId, invitationId, limit) {
      await tick();
      if (!workspaces.has(workspaceId)) return false;
      const t = Date.now();
      const n = [...members.values()].filter((m) => m.workspace_id === workspaceId).length
        + [...invitations.values()].filter((i) => i.workspace_id === workspaceId && i.status === 'pending' && Date.parse(i.expires_at) > t).length;
      if (n <= limit) return true;
      const inv = invitations.get(invitationId);
      if (inv && inv.workspace_id === workspaceId && inv.status === 'pending') inv.status = 'revoked';
      return false;
    },
    async deleteMember(workspaceId, userId) {
      await tick();
      members.delete(`${workspaceId}|${userId}`);
    },
    async listMembers(workspaceId) {
      await tick();
      return [...members.values()].filter((m) => m.workspace_id === workspaceId)
        .map(({ user_id, role, created_at }) => ({ user_id, role, created_at }));
    },
    async listMembershipsForUser(userId) {
      await tick();
      return [...members.values()].filter((m) => m.user_id === userId && workspaces.has(m.workspace_id))
        .map((m) => ({ role: m.role, workspace: clone(workspaces.get(m.workspace_id)) }));
    },
    async insertInvitation(row) {
      await tick();
      if ([...invitations.values()].some((i) => i.workspace_id === row.workspace_id && i.email === row.email && i.status === 'pending')) {
        throw uniqueViolation('workspace_invitations_one_pending');
      }
      const full = { id: crypto.randomUUID(), accepted_by: null, accepted_at: null, created_at: nowIso(), ...row };
      invitations.set(full.id, full);
      return clone(INV_PUBLIC(full));
    },
    async listInvitations(workspaceId) {
      await tick();
      return [...invitations.values()].filter((i) => i.workspace_id === workspaceId).map((i) => clone(INV_PUBLIC(i)));
    },
    async getInvitation(id) {
      await tick();
      const i = invitations.get(id);
      return i ? clone(INV_PUBLIC(i)) : null;
    },
    async findInvitationByTokenHash(tokenHash) {
      await tick();
      const i = [...invitations.values()].find((x) => x.token_hash === tokenHash);
      return i ? clone(INV_PUBLIC(i)) : null;
    },
    async findPendingInvitation(workspaceId, email) {
      await tick();
      const i = [...invitations.values()].find((x) => x.workspace_id === workspaceId && x.email === email && x.status === 'pending');
      return i ? clone(INV_PUBLIC(i)) : null;
    },
    async transitionInvitation(id, fromStatus, patch) {
      await tick();
      const i = invitations.get(id);
      if (!i || i.status !== fromStatus) return null;
      Object.assign(i, patch);
      return clone(INV_PUBLIC(i));
    },
  };
  return store;
}

module.exports = { createMemoryWorkspaceStore };
