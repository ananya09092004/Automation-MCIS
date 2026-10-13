/**
 * Layer 1 — Supabase data access for workspaces / members / invitations.
 *
 * Thin persistence only: NO authorization decisions live here. Every
 * access rule is enforced in services/workspaceService.js, which is the
 * only caller. Tables are created by
 * migrations/20260923_layer1_workspaces.up.sql.
 *
 * The Supabase client is created lazily (first query), not at require
 * time, so loading this module never adds startup work or throws when
 * env vars are missing (e.g. in unit tests).
 *
 * Requires SUPABASE_KEY to be the service_role key: the new tables have
 * RLS enabled with no policies (deny-by-default for anon/authenticated).
 */
'use strict';

const { createClient } = require('@supabase/supabase-js');

let client = null;
function db() {
  if (!client) client = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
  return client;
}

// Supabase returns { data, error }; normalise to throw so the service can
// map Postgres error codes (e.g. 23505 unique_violation) consistently.
function unwrap({ data, error }) {
  if (error) {
    const err = new Error(error.message || 'Database error');
    err.code = error.code;
    err.dbError = true;
    throw err;
  }
  return data;
}

const WS_COLS = 'id, name, owner_id, is_personal, created_at, updated_at';
const INV_PUBLIC_COLS = 'id, workspace_id, email, role, invited_by, status, expires_at, accepted_by, accepted_at, created_at';

function createSupabaseWorkspaceStore() {
  return {
    async findPersonalWorkspace(ownerId) {
      const rows = unwrap(await db().from('workspaces').select(WS_COLS)
        .eq('owner_id', ownerId).eq('is_personal', true).limit(1));
      return rows[0] || null;
    },

    async getWorkspace(id) {
      const rows = unwrap(await db().from('workspaces').select(WS_COLS).eq('id', id).limit(1));
      return rows[0] || null;
    },

    async insertWorkspace({ name, owner_id, is_personal }) {
      return unwrap(await db().from('workspaces')
        .insert({ name, owner_id, is_personal }).select(WS_COLS).single());
    },

    async updateWorkspace(id, patch) {
      return unwrap(await db().from('workspaces')
        .update({ ...patch, updated_at: new Date().toISOString() })
        .eq('id', id).select(WS_COLS).single());
    },

    async deleteWorkspace(id) {
      unwrap(await db().from('workspaces').delete().eq('id', id));
    },

    async getMember(workspaceId, userId) {
      const rows = unwrap(await db().from('workspace_members')
        .select('workspace_id, user_id, role, created_at')
        .eq('workspace_id', workspaceId).eq('user_id', userId).limit(1));
      return rows[0] || null;
    },

    async insertMember({ workspace_id, user_id, role }) {
      return unwrap(await db().from('workspace_members')
        .insert({ workspace_id, user_id, role })
        .select('workspace_id, user_id, role, created_at').single());
    },

    async updateMemberRole(workspaceId, userId, role) {
      const rows = unwrap(await db().from('workspace_members')
        .update({ role, updated_at: new Date().toISOString() })
        .eq('workspace_id', workspaceId).eq('user_id', userId)
        .select('workspace_id, user_id, role, created_at'));
      return rows[0] || null;
    },

    /** Layer 9: atomic owner hand-over (RPC transfer_workspace_ownership, one transaction). */
    // Layer 9: serialized post-write check of max_members (RPC revokes an over-limit invitation).
    async enforceMemberLimit(workspaceId, invitationId, limit) {
      return unwrap(await db().rpc('enforce_member_limit', { p_workspace: workspaceId, p_invitation: invitationId, p_limit: limit })) === true;
    },
    async transferOwnership(workspaceId, fromUid, toUid) {
      return unwrap(await db().rpc('transfer_workspace_ownership', { p_workspace: workspaceId, p_from: fromUid, p_to: toUid })) === true;
    },

    async deleteMember(workspaceId, userId) {
      unwrap(await db().from('workspace_members').delete()
        .eq('workspace_id', workspaceId).eq('user_id', userId));
    },

    async listMembers(workspaceId) {
      return unwrap(await db().from('workspace_members')
        .select('user_id, role, created_at')
        .eq('workspace_id', workspaceId).order('created_at', { ascending: true }));
    },

    // Returns [{ role, workspace: {...} }] for every workspace the user belongs to.
    async listMembershipsForUser(userId) {
      const rows = unwrap(await db().from('workspace_members')
        .select(`role, workspaces ( ${WS_COLS} )`)
        .eq('user_id', userId));
      return rows
        .filter((r) => r.workspaces)
        .map((r) => ({ role: r.role, workspace: r.workspaces }));
    },

    async insertInvitation(row) {
      return unwrap(await db().from('workspace_invitations')
        .insert(row).select(INV_PUBLIC_COLS).single());
    },

    async listInvitations(workspaceId) {
      return unwrap(await db().from('workspace_invitations')
        .select(INV_PUBLIC_COLS)
        .eq('workspace_id', workspaceId).order('created_at', { ascending: false }));
    },

    async getInvitation(id) {
      const rows = unwrap(await db().from('workspace_invitations')
        .select(INV_PUBLIC_COLS).eq('id', id).limit(1));
      return rows[0] || null;
    },

    async findInvitationByTokenHash(tokenHash) {
      const rows = unwrap(await db().from('workspace_invitations')
        .select(INV_PUBLIC_COLS).eq('token_hash', tokenHash).limit(1));
      return rows[0] || null;
    },

    async findPendingInvitation(workspaceId, email) {
      const rows = unwrap(await db().from('workspace_invitations')
        .select(INV_PUBLIC_COLS)
        .eq('workspace_id', workspaceId).eq('email', email).eq('status', 'pending').limit(1));
      return rows[0] || null;
    },

    // Compare-and-set on status: only transitions an invitation that is
    // still in `fromStatus`. Returns the updated row, or null if another
    // request already changed it (makes invites single-use under races).
    async transitionInvitation(id, fromStatus, patch) {
      const rows = unwrap(await db().from('workspace_invitations')
        .update(patch).eq('id', id).eq('status', fromStatus).select(INV_PUBLIC_COLS));
      return rows[0] || null;
    },
  };
}

module.exports = { createSupabaseWorkspaceStore };
