/**
 * Layer 2 — Supabase persistence for workspace tasks, task activity and
 * workspace permission grants. Tables:
 * migrations/20260925_layer2_workspace_data_scoping.up.sql
 *
 * Persistence only. EVERY query is scoped by a server-resolved
 * workspace_id; authorization lives in taskService / grantService.
 */
'use strict';

const { createClient } = require('@supabase/supabase-js');

let client = null;
function db() {
  if (!client) client = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
  return client;
}

function unwrap({ data, error }) {
  if (error) {
    const err = new Error(error.message || 'Database error');
    err.code = error.code;
    err.details = error.details;
    err.dbError = true;
    throw err;
  }
  return data;
}

function createSupabaseWorkspaceDataStore() {
  return {
    // ---- tasks ----
    async insertTask(row) {
      return unwrap(await db().from('workspace_tasks').insert(row).select('*').single());
    },
    async getTask(workspaceId, id) {
      const rows = unwrap(await db().from('workspace_tasks').select('*')
        .eq('workspace_id', workspaceId).eq('id', id).limit(1));
      return rows[0] || null;
    },
    async listTasks(workspaceId, { status, assigneeUserId, assigneeAgentId, limit = 50 } = {}) {
      let q = db().from('workspace_tasks').select('*').eq('workspace_id', workspaceId);
      if (status) q = q.eq('status', status);
      if (assigneeAgentId) q = q.eq('assignee_agent_id', assigneeAgentId); // Layer 10
      if (assigneeUserId) q = q.eq('assignee_user_id', assigneeUserId);
      return unwrap(await q.order('created_at', { ascending: false }).limit(limit));
    },
    async updateTask(workspaceId, id, expectedVersion, patch) {
      const rows = unwrap(await db().from('workspace_tasks')
        .update({ ...patch, version: expectedVersion + 1, updated_at: new Date().toISOString() })
        .eq('workspace_id', workspaceId).eq('id', id).eq('version', expectedVersion)
        .select('*'));
      return rows[0] || null;
    },
    async deleteTask(workspaceId, id) {
      const rows = unwrap(await db().from('workspace_tasks').delete()
        .eq('workspace_id', workspaceId).eq('id', id).select('id'));
      return rows.length > 0;
    },

    // ---- activity / comments ----
    async insertActivity(row) {
      return unwrap(await db().from('workspace_task_activity').insert(row).select('*').single());
    },
    async listActivity(workspaceId, taskId, { limit = 100 } = {}) {
      return unwrap(await db().from('workspace_task_activity').select('*')
        .eq('workspace_id', workspaceId).eq('task_id', taskId)
        .order('created_at', { ascending: true }).limit(limit));
    },

    // ---- workspace permission grants ----
    async listGrants(workspaceId) {
      return unwrap(await db().from('workspace_permission_grants').select('*')
        .eq('workspace_id', workspaceId).order('created_at', { ascending: false }));
    },
    async insertGrant(row) {
      return unwrap(await db().from('workspace_permission_grants').insert(row).select('*').single());
    },
    async deleteGrant(workspaceId, id) {
      const rows = unwrap(await db().from('workspace_permission_grants').delete()
        .eq('workspace_id', workspaceId).eq('id', id).select('id'));
      return rows.length > 0;
    },
  };
}

module.exports = { createSupabaseWorkspaceDataStore };
