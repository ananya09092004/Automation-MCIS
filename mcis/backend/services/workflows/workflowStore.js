/**
 * Layer 4 — Supabase persistence for workflows, versions, runs, run steps
 * and durable jobs. Tables: migrations/20260926_layer4_workflows.up.sql
 *
 * Persistence only — no authorization. Every tenant query is filtered by
 * workspace_id. The only cross-workspace reads are the worker's job claim
 * (RPC) and the scheduler's due-workflow scan; both return rows that the
 * worker then processes strictly inside that row's own workspace.
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

const first = (rows) => (Array.isArray(rows) ? rows[0] || null : rows || null);
const nowIso = () => new Date().toISOString();

function createSupabaseWorkflowStore() {
  return {
    // ---------------- workflows ----------------
    async insertWorkflow(row) {
      return unwrap(await db().from('workflows').insert(row).select('*').single());
    },
    async getWorkflow(workspaceId, id) {
      return first(unwrap(await db().from('workflows').select('*').eq('workspace_id', workspaceId).eq('id', id).limit(1)));
    },
    async listWorkflows(workspaceId, { status, limit = 50 } = {}) {
      let q = db().from('workflows').select('*').eq('workspace_id', workspaceId);
      if (status) q = q.eq('status', status);
      return unwrap(await q.order('created_at', { ascending: false }).limit(limit));
    },
    // Optimistic concurrency on `revision` (concurrent edits → null).
    async updateWorkflow(workspaceId, id, expectedRevision, patch) {
      return first(unwrap(await db().from('workflows')
        .update({ ...patch, revision: expectedRevision + 1, updated_at: nowIso() })
        .eq('workspace_id', workspaceId).eq('id', id).eq('revision', expectedRevision)
        .select('*')));
    },
    async listDueScheduledWorkflows(beforeIso, limit = 20) {
      return unwrap(await db().from('workflows').select('*')
        .eq('trigger_type', 'scheduled').eq('status', 'active')
        .lte('next_run_at', beforeIso).order('next_run_at', { ascending: true }).limit(limit));
    },
    // CAS on next_run_at: exactly one scheduler wins a slot.
    async claimScheduleSlot(workspaceId, id, slotIso, nextIso) {
      return first(unwrap(await db().from('workflows')
        .update({ next_run_at: nextIso, updated_at: nowIso() })
        .eq('workspace_id', workspaceId).eq('id', id)
        .eq('trigger_type', 'scheduled').eq('status', 'active').eq('next_run_at', slotIso)
        .select('*')));
    },

    // ---------------- versions (immutable) ----------------
    async insertVersion(row) {
      return unwrap(await db().from('workflow_versions').insert(row).select('*').single());
    },
    async getVersion(workspaceId, workflowId, versionId) {
      return first(unwrap(await db().from('workflow_versions').select('*')
        .eq('workspace_id', workspaceId).eq('workflow_id', workflowId).eq('id', versionId).limit(1)));
    },
    async getVersionByNumber(workspaceId, workflowId, n) {
      return first(unwrap(await db().from('workflow_versions').select('*')
        .eq('workspace_id', workspaceId).eq('workflow_id', workflowId).eq('version_number', n).limit(1)));
    },
    async listVersions(workspaceId, workflowId) {
      return unwrap(await db().from('workflow_versions')
        .select('id, workflow_id, workspace_id, version_number, name, definition_hash, created_by, created_at')
        .eq('workspace_id', workspaceId).eq('workflow_id', workflowId)
        .order('version_number', { ascending: false }));
    },

    // ---------------- runs ----------------
    async insertRun(row) {
      return unwrap(await db().from('workflow_runs').insert(row).select('*').single());
    },
    async getRun(workspaceId, id) {
      return first(unwrap(await db().from('workflow_runs').select('*').eq('workspace_id', workspaceId).eq('id', id).limit(1)));
    },
    async findRunByIdempotencyKey(workspaceId, key) {
      return first(unwrap(await db().from('workflow_runs').select('*')
        .eq('workspace_id', workspaceId).eq('idempotency_key', key).limit(1)));
    },
    async findRunBySlot(workspaceId, workflowId, slotIso) {
      return first(unwrap(await db().from('workflow_runs').select('*')
        .eq('workspace_id', workspaceId).eq('workflow_id', workflowId).eq('scheduled_for', slotIso).limit(1)));
    },
    // Layer 9: serialized post-write check of max_active_workflows (RPC undoes an over-limit activation).
    async enforceActiveWorkflowLimit(workspaceId, id, limit, prev) {
      return unwrap(await db().rpc('enforce_active_workflow_limit', {
        p_workspace: workspaceId, p_workflow: id, p_limit: limit, p_prev_status: prev.status,
        p_prev_version: prev.activeVersionId || null, p_prev_archived_at: prev.archivedAt || null,
      })) === true;
    },
    // Layer 9: optional status filter + keyset cursor (created_at, id) DESC.
    async listRuns(workspaceId, { workflowId, limit = 20, status, before } = {}) {
      let q = db().from('workflow_runs').select('*').eq('workspace_id', workspaceId);
      if (workflowId) q = q.eq('workflow_id', workflowId);
      if (status) q = q.eq('status', status);
      if (before) q = q.or(`created_at.lt.${before.createdAt},and(created_at.eq.${before.createdAt},id.lt.${before.id})`);
      return unwrap(await q.order('created_at', { ascending: false }).order('id', { ascending: false }).limit(limit));
    },
    // Sweep: queued runs older than `beforeIso` (their job may be missing
    // if the process died between inserting the run and its job).
    // Anti-join: only runs that have NO job row.
    async listStaleQueuedRuns(beforeIso, limit = 20) {
      const rows = unwrap(await db().from('workflow_runs').select('*, workflow_jobs(id)')
        .eq('status', 'queued').lt('created_at', beforeIso).is('workflow_jobs', null)
        .order('created_at', { ascending: true }).limit(limit));
      return rows.map(({ workflow_jobs: _j, ...r }) => r);
    },
    async updateRun(workspaceId, id, expectedVersion, patch) {
      return first(unwrap(await db().from('workflow_runs')
        .update({ ...patch, version: expectedVersion + 1, updated_at: nowIso() })
        .eq('workspace_id', workspaceId).eq('id', id).eq('version', expectedVersion)
        .select('*')));
    },

    // ---------------- run steps ----------------
    async insertRunSteps(rows) {
      return unwrap(await db().from('workflow_run_steps').insert(rows).select('*'));
    },
    async listRunSteps(workspaceId, runId) {
      return unwrap(await db().from('workflow_run_steps').select('*')
        .eq('workspace_id', workspaceId).eq('run_id', runId).order('position', { ascending: true }));
    },
    async updateRunStep(workspaceId, id, expectedVersion, patch) {
      return first(unwrap(await db().from('workflow_run_steps')
        .update({ ...patch, version: expectedVersion + 1, updated_at: nowIso() })
        .eq('workspace_id', workspaceId).eq('id', id).eq('version', expectedVersion)
        .select('*')));
    },

    // ---------------- durable jobs ----------------
    async insertJob(row) {
      return unwrap(await db().from('workflow_jobs').insert(row).select('*').single());
    },
    async getJobByRun(workspaceId, runId) {
      return first(unwrap(await db().from('workflow_jobs').select('*')
        .eq('workspace_id', workspaceId).eq('run_id', runId).limit(1)));
    },
    // Layer 6: fenced job RPCs (every claim increments lease_fence; heartbeat
    // and release require the current owner AND fence).
    async claimJob(workerId, leaseSeconds) {
      return first(unwrap(await db().rpc('claim_workflow_job_v2', { p_worker: workerId, p_lease_seconds: leaseSeconds })));
    },
    async heartbeatJob(jobId, workerId, leaseSeconds, fence) {
      return unwrap(await db().rpc('heartbeat_workflow_job_v2', { p_job: jobId, p_worker: workerId, p_fence: Number(fence || 0), p_lease_seconds: leaseSeconds })) === true;
    },
    async releaseJob(jobId, workerId, { status, delaySeconds = 0, error = null, fence = 0 }) {
      return unwrap(await db().rpc('release_workflow_job_v2', {
        p_job: jobId, p_worker: workerId, p_fence: Number(fence || 0), p_status: status, p_delay_seconds: Math.max(0, Math.round(delaySeconds)), p_error: error,
      })) === true;
    },
    // Non-owner transitions of jobs that are NOT running (cancel a queued
    // run, re-queue a paused one). A running job is only ever changed by
    // its lease owner (releaseJob).
    async transitionIdleJob(workspaceId, runId, fromStatuses, patch) {
      return first(unwrap(await db().from('workflow_jobs')
        .update({ ...patch, updated_at: nowIso() })
        .eq('workspace_id', workspaceId).eq('run_id', runId).in('status', fromStatuses)
        .select('*')));
    },
  };
}

module.exports = { createSupabaseWorkflowStore };
