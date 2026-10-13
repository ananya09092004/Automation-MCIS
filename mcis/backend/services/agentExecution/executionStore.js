/**
 * Layer 3 — Supabase persistence for agent executions, steps (evidence)
 * and approvals. Tables: migrations/20260924_layer3_agent_executions.up.sql
 *
 * Persistence only — no authorization here. EVERY query is scoped by
 * workspace_id; there is intentionally no "get by id" without it.
 * Callers (executionService / executionEngine) pass a workspace id that
 * was resolved server-side by Layer 1's workspace context.
 *
 * Client is created lazily (never at require time).
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

const EXEC = 'agent_executions';
const STEPS = 'agent_execution_steps';
const APPR = 'agent_execution_approvals';

function createSupabaseExecutionStore() {
  return {
    async insertExecution(row) {
      return unwrap(await db().from(EXEC).insert(row).select('*').single());
    },

    async getExecution(workspaceId, id) {
      const rows = unwrap(await db().from(EXEC).select('*')
        .eq('workspace_id', workspaceId).eq('id', id).limit(1));
      return rows[0] || null;
    },

    async findByIdempotencyKey(workspaceId, key) {
      const rows = unwrap(await db().from(EXEC).select('*')
        .eq('workspace_id', workspaceId).eq('idempotency_key', key).limit(1));
      return rows[0] || null;
    },

    async findActiveExecution(workspaceId) {
      const rows = unwrap(await db().from(EXEC).select('*')
        .eq('workspace_id', workspaceId)
        .in('status', ['created', 'planning', 'waiting_approval', 'executing', 'verifying'])
        .limit(1));
      return rows[0] || null;
    },

    // Layer 9: optional status filter + keyset cursor (created_at, id) DESC.
    async listExecutions(workspaceId, { limit = 20, status, before } = {}) {
      let q = db().from(EXEC).select('*').eq('workspace_id', workspaceId);
      if (status) q = q.eq('status', status);
      if (before) q = q.or(`created_at.lt.${before.createdAt},and(created_at.eq.${before.createdAt},id.lt.${before.id})`);
      return unwrap(await q.order('created_at', { ascending: false }).order('id', { ascending: false }).limit(limit));
    },

    async listExecutionsForTask(workspaceId, taskId, { limit = 20 } = {}) {
      return unwrap(await db().from(EXEC).select('*')
        .eq('workspace_id', workspaceId).eq('task_id', taskId)
        .order('created_at', { ascending: false }).limit(limit));
    },

    // Optimistic concurrency: only applies if `version` still matches.
    async updateExecution(workspaceId, id, expectedVersion, patch) {
      const rows = unwrap(await db().from(EXEC)
        .update({ ...patch, version: expectedVersion + 1, updated_at: new Date().toISOString() })
        .eq('workspace_id', workspaceId).eq('id', id).eq('version', expectedVersion)
        .select('*'));
      return rows[0] || null;
    },

    // Layer 4: in-flight action marker (own column, no version bump).
    async setInflight(workspaceId, id, value) {
      unwrap(await db().from(EXEC).update({ inflight: value })
        .eq('workspace_id', workspaceId).eq('id', id));
    },

    // Layer 6: execution ownership lease (own column, no version bump).
    async setLease(workspaceId, id, leaseExpiresAt) {
      unwrap(await db().from(EXEC).update({ lease_expires_at: leaseExpiresAt })
        .eq('workspace_id', workspaceId).eq('id', id)
        .in('status', ['created', 'planning', 'waiting_approval', 'executing', 'verifying']));
    },

    async insertStep(row) {
      return unwrap(await db().from(STEPS).insert(row).select('*').single());
    },

    async listSteps(workspaceId, executionId) {
      return unwrap(await db().from(STEPS).select('*')
        .eq('workspace_id', workspaceId).eq('execution_id', executionId)
        .order('step_index', { ascending: true }));
    },

    async insertApproval(row) {
      return unwrap(await db().from(APPR).insert(row).select('*').single());
    },

    async getApproval(workspaceId, executionId, approvalId) {
      const rows = unwrap(await db().from(APPR).select('*')
        .eq('workspace_id', workspaceId).eq('execution_id', executionId).eq('id', approvalId).limit(1));
      return rows[0] || null;
    },

    async listApprovals(workspaceId, executionId) {
      return unwrap(await db().from(APPR).select('*')
        .eq('workspace_id', workspaceId).eq('execution_id', executionId)
        .order('created_at', { ascending: true }));
    },

    // Compare-and-set on status → single-use approvals under races.
    async transitionApproval(workspaceId, approvalId, fromStatus, patch) {
      const rows = unwrap(await db().from(APPR).update(patch)
        .eq('workspace_id', workspaceId).eq('id', approvalId).eq('status', fromStatus)
        .select('*'));
      return rows[0] || null;
    },

    async supersedePendingApprovals(workspaceId, executionId) {
      unwrap(await db().from(APPR).update({ status: 'superseded', decided_at: new Date().toISOString() })
        .eq('workspace_id', workspaceId).eq('execution_id', executionId).eq('status', 'pending'));
    },
  };
}

module.exports = { createSupabaseExecutionStore };
