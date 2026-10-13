/**
 * Layer 9 — Supabase persistence for retention settings, the retention
 * purge RPC and worker heartbeats.
 * Tables / RPCs: migrations/20261001_layer9_hardening.up.sql
 * Every workspace query is filtered by workspace_id.
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
    err.dbError = true;
    throw err;
  }
  return data;
}
const first = (rows) => (Array.isArray(rows) ? rows[0] || null : rows || null);

function createSupabaseOpsStore() {
  return {
    async getRetentionPolicy(workspaceId) {
      return first(unwrap(await db().from('workspace_retention_policies').select('*').eq('workspace_id', workspaceId).limit(1)));
    },
    async saveRetentionPolicy(workspaceId, { executionsDays, auditDays, updatedBy }) {
      return first(unwrap(await db().from('workspace_retention_policies').upsert({
        workspace_id: workspaceId, executions_days: executionsDays, audit_days: auditDays, updated_by: updatedBy, updated_at: new Date().toISOString(),
      }, { onConflict: 'workspace_id' }).select('*')));
    },
    /** One workspace per call; the RPC enforces the hard floors again. */
    async purgeWorkspace(workspaceId, { usageBefore, execBefore, auditBefore }) {
      return unwrap(await db().rpc('retention_purge_workspace', {
        p_workspace: workspaceId, p_usage_before: usageBefore, p_exec_before: execBefore, p_audit_before: auditBefore,
      }));
    },
    /** Workspace ids in id order after `afterId` (retention sweep paging). */
    async listWorkspaceIds(afterId, limit) {
      let q = db().from('workspaces').select('id').order('id', { ascending: true }).limit(limit);
      if (afterId) q = q.gt('id', afterId);
      return unwrap(await q).map((r) => r.id);
    },
    async upsertHeartbeat({ workerId, kind, runningJobs, version }) {
      unwrap(await db().from('worker_heartbeats').upsert({
        worker_id: workerId, kind, running_jobs: runningJobs, version: version || null, last_seen_at: new Date().toISOString(),
      }, { onConflict: 'worker_id' }));
    },
    async deleteHeartbeat(workerId) {
      unwrap(await db().from('worker_heartbeats').delete().eq('worker_id', workerId));
    },
    async listHeartbeats(limit = 100) {
      return unwrap(await db().from('worker_heartbeats').select('*').order('last_seen_at', { ascending: false }).limit(limit));
    },
  };
}

module.exports = { createSupabaseOpsStore };
