/**
 * TEST-ONLY in-memory implementation of services/workflows/workflowStore.js.
 * Mirrors the constraints of migrations/20260926_layer4_workflows.up.sql
 * that the service/runner rely on:
 *   - workflow_versions unique (workflow_id, version_number) → 23505; no UPDATE
 *   - workflow_runs unique (workspace_id, idempotency_key)    → 23505
 *   - workflow_runs unique (workflow_id, scheduled_for)       → 23505
 *   - run.workflow_version_id must belong to run.workflow_id  → 23503
 *   - run.task_id must be in the run's workspace              → 23503
 *   - workflow_run_steps unique (run_id, position)            → 23505
 *   - workflow_run_steps unique (execution_id)                → 23505
 *   - workflow_jobs unique (run_id)                           → 23505
 *   - claim_workflow_job_v2 / heartbeat / release semantics (lease owner + fence,
 *     expiry, recoveries) using an injectable clock
 *   - optimistic version / revision checks
 * Every method yields to the event loop so concurrent callers interleave.
 */
'use strict';

const tick = () => new Promise((r) => setImmediate(r));
const clone = (o) => (o == null ? null : JSON.parse(JSON.stringify(o)));
const err = (code, message) => Object.assign(new Error(message), { code });

function createMemoryWorkflowStore({ now = () => new Date(), taskExists = async () => true } = {}) {
  const workflows = new Map();
  const versions = new Map();
  const runs = new Map();
  const steps = new Map();
  const jobs = new Map();
  const iso = () => now().toISOString();
  const ms = (v) => (v ? Date.parse(v) : NaN);

  return {
    _dump: () => ({
      workflows: [...workflows.values()], versions: [...versions.values()], runs: [...runs.values()],
      steps: [...steps.values()], jobs: [...jobs.values()],
    }),
    _jobs: jobs,

    // ---------------- workflows ----------------
    async insertWorkflow(row) {
      await tick();
      const full = {
        description: '', status: 'draft', draft: { variables: [], steps: [], policy: {} }, active_version_id: null,
        latest_version: 0, trigger_type: 'manual', schedule_interval_minutes: null, schedule_inputs: null,
        schedule_owner: null, next_run_at: null, revision: 0, created_at: iso(), updated_at: iso(), archived_at: null,
        ...clone(row),
      };
      workflows.set(full.id, full);
      return clone(full);
    },
    async getWorkflow(workspaceId, id) {
      await tick();
      const w = workflows.get(id);
      return w && w.workspace_id === workspaceId ? clone(w) : null;
    },
    async listWorkflows(workspaceId, { status, limit = 50 } = {}) {
      await tick();
      return [...workflows.values()].filter((w) => w.workspace_id === workspaceId && (!status || w.status === status))
        .sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, limit).map(clone);
    },
    async updateWorkflow(workspaceId, id, expectedRevision, patch) {
      await tick();
      const w = workflows.get(id);
      if (!w || w.workspace_id !== workspaceId || w.revision !== expectedRevision) return null;
      const next = { ...w, ...clone(patch) };
      if (next.active_version_id) {
        const v = versions.get(next.active_version_id);
        if (!v || v.workflow_id !== id) throw err('23503', 'violates foreign key constraint "workflows_active_version_fk"');
      }
      if (next.trigger_type === 'scheduled' && (!next.schedule_interval_minutes || !next.schedule_owner)) throw err('23514', 'check constraint');
      Object.assign(w, clone(patch), { revision: expectedRevision + 1, updated_at: iso() });
      return clone(w);
    },
    // Layer 9: mirrors RPC enforce_active_workflow_limit (one synchronous section = the locked transaction).
    async enforceActiveWorkflowLimit(workspaceId, id, limit, prev) {
      await tick();
      const n = [...workflows.values()].filter((w) => w.workspace_id === workspaceId && w.status === 'active').length;
      if (n <= limit) return true;
      const w = workflows.get(id);
      if (w && w.workspace_id === workspaceId && w.status === 'active') {
        Object.assign(w, { status: prev.status, active_version_id: prev.activeVersionId || null, revision: w.revision + 1, updated_at: iso(),
          ...(prev.status === 'archived' ? { archived_at: prev.archivedAt || iso() } : {}) });
      }
      return false;
    },
    async listDueScheduledWorkflows(beforeIso, limit = 20) {
      await tick();
      return [...workflows.values()]
        .filter((w) => w.trigger_type === 'scheduled' && w.status === 'active' && w.next_run_at && ms(w.next_run_at) <= ms(beforeIso))
        .sort((a, b) => ms(a.next_run_at) - ms(b.next_run_at)).slice(0, limit).map(clone);
    },
    async claimScheduleSlot(workspaceId, id, slotIso, nextIso) {
      await tick();
      const w = workflows.get(id);
      if (!w || w.workspace_id !== workspaceId || w.trigger_type !== 'scheduled' || w.status !== 'active' || ms(w.next_run_at) !== ms(slotIso)) return null;
      w.next_run_at = nextIso;
      w.updated_at = iso();
      return clone(w);
    },

    // ---------------- versions ----------------
    async insertVersion(row) {
      await tick();
      const wf = workflows.get(row.workflow_id);
      if (!wf || wf.workspace_id !== row.workspace_id) throw err('23503', 'violates foreign key constraint (workflow_id, workspace_id)');
      if ([...versions.values()].some((v) => v.workflow_id === row.workflow_id && v.version_number === row.version_number)) {
        throw err('23505', 'duplicate key value violates unique constraint (workflow_id, version_number)');
      }
      const full = { created_at: iso(), ...clone(row) };
      versions.set(full.id, Object.freeze(full));
      return clone(full);
    },
    async getVersion(workspaceId, workflowId, versionId) {
      await tick();
      const v = versions.get(versionId);
      return v && v.workspace_id === workspaceId && v.workflow_id === workflowId ? clone(v) : null;
    },
    async getVersionByNumber(workspaceId, workflowId, n) {
      await tick();
      return clone([...versions.values()].find((v) => v.workspace_id === workspaceId && v.workflow_id === workflowId && v.version_number === n) || null);
    },
    async listVersions(workspaceId, workflowId) {
      await tick();
      return [...versions.values()].filter((v) => v.workspace_id === workspaceId && v.workflow_id === workflowId)
        .sort((a, b) => b.version_number - a.version_number)
        .map(({ definition: _d, ...v }) => clone(v));
    },

    // ---------------- runs ----------------
    async insertRun(row) {
      await tick();
      const wf = workflows.get(row.workflow_id);
      if (!wf || wf.workspace_id !== row.workspace_id) throw err('23503', 'violates foreign key constraint (workflow_id, workspace_id)');
      const v = versions.get(row.workflow_version_id);
      if (!v || v.workflow_id !== row.workflow_id) throw err('23503', 'violates foreign key constraint (workflow_version_id, workflow_id)');
      if (row.task_id && !(await taskExists(row.workspace_id, row.task_id))) throw err('23503', 'violates foreign key constraint (task_id, workspace_id)');
      const all = [...runs.values()];
      if (row.idempotency_key && all.some((r) => r.workspace_id === row.workspace_id && r.idempotency_key === row.idempotency_key)) {
        throw err('23505', 'duplicate key value violates unique constraint "workflow_runs_idempotency"');
      }
      if (row.scheduled_for && all.some((r) => r.workflow_id === row.workflow_id && ms(r.scheduled_for) === ms(row.scheduled_for))) {
        throw err('23505', 'duplicate key value violates unique constraint "workflow_runs_schedule_slot"');
      }
      const full = {
        status: 'queued', current_step: 0, inputs: {}, task_id: null, idempotency_key: null, request_hash: null,
        scheduled_for: null, cancel_requested: false, result: null, verification: null, failure_code: null,
        failure_message: null, review_reason: null, deadline_at: null, version: 0, created_at: iso(), updated_at: iso(),
        started_at: null, finished_at: null, ...clone(row),
      };
      runs.set(full.id, full);
      return clone(full);
    },
    async getRun(workspaceId, id) {
      await tick();
      const r = runs.get(id);
      return r && r.workspace_id === workspaceId ? clone(r) : null;
    },
    async findRunByIdempotencyKey(workspaceId, key) {
      await tick();
      return clone([...runs.values()].find((r) => r.workspace_id === workspaceId && r.idempotency_key === key) || null);
    },
    async findRunBySlot(workspaceId, workflowId, slotIso) {
      await tick();
      return clone([...runs.values()].find((r) => r.workspace_id === workspaceId && r.workflow_id === workflowId && ms(r.scheduled_for) === ms(slotIso)) || null);
    },
    async listRuns(workspaceId, { workflowId, limit = 20, status, before } = {}) {
      await tick();
      const { olderThan } = require('../../services/automation/pagination');
      return [...runs.values()].filter((r) => r.workspace_id === workspaceId && (!workflowId || r.workflow_id === workflowId)
        && (!status || r.status === status) && olderThan(r, before))
        .sort((a, b) => b.created_at.localeCompare(a.created_at) || (b.id < a.id ? -1 : b.id > a.id ? 1 : 0)).slice(0, limit).map(clone);
    },
    async listStaleQueuedRuns(beforeIso, limit = 20) {
      await tick();
      const withJob = new Set([...jobs.values()].map((j) => j.run_id));
      return [...runs.values()].filter((r) => r.status === 'queued' && ms(r.created_at) < ms(beforeIso) && !withJob.has(r.id))
        .slice(0, limit).map(clone);
    },
    async updateRun(workspaceId, id, expectedVersion, patch) {
      await tick();
      const r = runs.get(id);
      if (!r || r.workspace_id !== workspaceId || r.version !== expectedVersion) return null;
      if (patch.task_id && !(await taskExists(workspaceId, patch.task_id))) throw err('23503', 'violates foreign key constraint (task_id, workspace_id)');
      Object.assign(r, clone(patch), { version: expectedVersion + 1, updated_at: iso() });
      return clone(r);
    },

    // ---------------- run steps ----------------
    async insertRunSteps(rows) {
      await tick();
      for (const row of rows) {
        const r = runs.get(row.run_id);
        if (!r || r.workspace_id !== row.workspace_id) throw err('23503', 'violates foreign key constraint (run_id, workspace_id)');
        if ([...steps.values()].some((s) => s.run_id === row.run_id && s.position === row.position)) {
          throw err('23505', 'duplicate key value violates unique constraint (run_id, position)');
        }
      }
      const out = [];
      for (const row of rows) {
        const full = {
          status: 'pending', attempt: 0, execution_id: null, attempts: [], output: null, verification: null,
          error_code: null, error_message: null, version: 0, started_at: null, finished_at: null, updated_at: iso(), ...clone(row),
        };
        steps.set(full.id, full);
        out.push(clone(full));
      }
      return out;
    },
    async listRunSteps(workspaceId, runId) {
      await tick();
      return [...steps.values()].filter((s) => s.workspace_id === workspaceId && s.run_id === runId)
        .sort((a, b) => a.position - b.position).map(clone);
    },
    async updateRunStep(workspaceId, id, expectedVersion, patch) {
      await tick();
      const s = steps.get(id);
      if (!s || s.workspace_id !== workspaceId || s.version !== expectedVersion) return null;
      if (patch.execution_id && [...steps.values()].some((o) => o.id !== id && o.execution_id === patch.execution_id)) {
        throw err('23505', 'duplicate key value violates unique constraint "workflow_run_steps_one_execution"');
      }
      Object.assign(s, clone(patch), { version: expectedVersion + 1, updated_at: iso() });
      return clone(s);
    },

    // ---------------- jobs ----------------
    async insertJob(row) {
      await tick();
      const r = runs.get(row.run_id);
      if (!r || r.workspace_id !== row.workspace_id) throw err('23503', 'violates foreign key constraint (run_id, workspace_id)');
      if ([...jobs.values()].some((j) => j.run_id === row.run_id)) throw err('23505', 'duplicate key value violates unique constraint "workflow_jobs_run_id_key"');
      const full = {
        status: 'queued', run_at: iso(), lease_owner: null, lease_expires_at: null, heartbeat_at: null, attempts: 0, lease_fence: 0,
        recoveries: 0, max_recoveries: 3, last_error: null, created_at: iso(), updated_at: iso(), ...clone(row),
      };
      jobs.set(full.id, full);
      return clone(full);
    },
    async getJobByRun(workspaceId, runId) {
      await tick();
      return clone([...jobs.values()].find((j) => j.workspace_id === workspaceId && j.run_id === runId) || null);
    },
    // Atomic (single JS turn after the tick) — mirrors FOR UPDATE SKIP LOCKED.
    async claimJob(workerId, leaseSeconds) {
      await tick();
      const t = now().getTime();
      const candidate = [...jobs.values()]
        .filter((j) => (j.status === 'queued' && ms(j.run_at) <= t) || (j.status === 'running' && ms(j.lease_expires_at) < t))
        .sort((a, b) => ms(a.run_at) - ms(b.run_at) || a.created_at.localeCompare(b.created_at))[0];
      if (!candidate) return null;
      if (candidate.status === 'running') candidate.recoveries += 1;
      Object.assign(candidate, {
        status: 'running', lease_owner: workerId, lease_fence: (candidate.lease_fence || 0) + 1, lease_expires_at: new Date(t + leaseSeconds * 1000).toISOString(),
        heartbeat_at: new Date(t).toISOString(), attempts: candidate.attempts + 1, updated_at: new Date(t).toISOString(),
      });
      return clone(candidate);
    },
    async heartbeatJob(jobId, workerId, leaseSeconds, fence) {
      await tick();
      const j = jobs.get(jobId);
      if (!j || j.lease_owner !== workerId || j.status !== 'running' || Number(fence || 0) !== j.lease_fence) return false;
      const t = now().getTime();
      j.lease_expires_at = new Date(t + leaseSeconds * 1000).toISOString();
      j.heartbeat_at = new Date(t).toISOString();
      return true;
    },
    async releaseJob(jobId, workerId, { status, delaySeconds = 0, error = null, fence = 0 }) {
      await tick();
      if (!['queued', 'paused', 'completed', 'failed', 'cancelled'].includes(status)) throw new Error('invalid job status');
      const j = jobs.get(jobId);
      if (!j || j.lease_owner !== workerId || j.status !== 'running' || Number(fence || 0) !== j.lease_fence) return false;
      Object.assign(j, {
        status,
        run_at: status === 'queued' ? new Date(now().getTime() + Math.max(0, delaySeconds) * 1000).toISOString() : j.run_at,
        lease_owner: null, lease_expires_at: null, last_error: error == null ? j.last_error : String(error).slice(0, 1000), updated_at: iso(),
      });
      return true;
    },
    async transitionIdleJob(workspaceId, runId, fromStatuses, patch) {
      await tick();
      const j = [...jobs.values()].find((x) => x.workspace_id === workspaceId && x.run_id === runId);
      if (!j || !fromStatuses.includes(j.status)) return null;
      Object.assign(j, clone(patch), { updated_at: iso() });
      return clone(j);
    },
  };
}

module.exports = { createMemoryWorkflowStore };
