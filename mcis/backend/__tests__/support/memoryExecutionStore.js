/**
 * TEST-ONLY in-memory implementation of services/agentExecution/executionStore.js.
 * Mirrors the constraints of migrations/20260924_layer3_agent_executions.up.sql
 * that the service relies on:
 *   - unique (workspace_id, idempotency_key)          → 23505 "…idempotency"
 *   - one non-terminal execution per workspace         → 23505 "…one_active_per_ws"
 *   - one pending approval per execution               → 23505 "…one_pending"
 *   - step/approval workspace must equal execution's   → 23503
 *   - optimistic version check on update
 * Every method yields to the event loop so concurrent requests interleave.
 */
'use strict';

const crypto = require('crypto');

const ACTIVE = new Set(['created', 'planning', 'waiting_approval', 'executing', 'verifying']);
const tick = () => new Promise((r) => setImmediate(r));
const clone = (o) => (o == null ? null : JSON.parse(JSON.stringify(o)));
const err = (code, message) => Object.assign(new Error(message), { code });

function createMemoryExecutionStore() {
  const executions = new Map();
  const steps = [];
  const approvals = new Map();
  const nowIso = () => new Date().toISOString();

  const checkParent = (row) => {
    const e = executions.get(row.execution_id);
    if (!e || e.workspace_id !== row.workspace_id) throw err('23503', 'violates foreign key constraint (execution_id, workspace_id)');
  };

  return {
    _dump: () => ({ executions: [...executions.values()], steps: [...steps], approvals: [...approvals.values()] }),

    async insertExecution(row) {
      await tick();
      const all = [...executions.values()];
      if (row.idempotency_key && all.some((e) => e.workspace_id === row.workspace_id && e.idempotency_key === row.idempotency_key)) {
        throw err('23505', 'duplicate key value violates unique constraint "agent_executions_idempotency"');
      }
      if (all.some((e) => e.workspace_id === row.workspace_id && ACTIVE.has(e.status))) {
        throw err('23505', 'duplicate key value violates unique constraint "agent_executions_one_active_per_ws"');
      }
      const full = {
        current_step: 0, steps_executed: 0, pending_approval_id: null, result: null, failure_code: null,
        failure_message: null, verification: null, version: 0, created_at: nowIso(), updated_at: nowIso(),
        started_at: null, finished_at: null, ...row,
      };
      executions.set(full.id, full);
      return clone(full);
    },
    async getExecution(workspaceId, id) {
      await tick();
      const e = executions.get(id);
      return e && e.workspace_id === workspaceId ? clone(e) : null;
    },
    async findByIdempotencyKey(workspaceId, key) {
      await tick();
      return clone([...executions.values()].find((e) => e.workspace_id === workspaceId && e.idempotency_key === key) || null);
    },
    async findActiveExecution(workspaceId) {
      await tick();
      return clone([...executions.values()].find((e) => e.workspace_id === workspaceId && ACTIVE.has(e.status)) || null);
    },
    async listExecutions(workspaceId, { limit = 20, status, before } = {}) {
      await tick();
      const { olderThan } = require('../../services/automation/pagination');
      return [...executions.values()].filter((e) => e.workspace_id === workspaceId && (!status || e.status === status) && olderThan(e, before))
        .sort((a, b) => b.created_at.localeCompare(a.created_at) || (b.id < a.id ? -1 : b.id > a.id ? 1 : 0)).slice(0, limit).map(clone);
    },
    async listExecutionsForTask(workspaceId, taskId, { limit = 20 } = {}) {
      await tick();
      return [...executions.values()].filter((e) => e.workspace_id === workspaceId && e.task_id === taskId)
        .sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, limit).map(clone);
    },
    async updateExecution(workspaceId, id, expectedVersion, patch) {
      await tick();
      const e = executions.get(id);
      if (!e || e.workspace_id !== workspaceId || e.version !== expectedVersion) return null;
      Object.assign(e, clone(patch), { version: expectedVersion + 1, updated_at: nowIso() });
      return clone(e);
    },
    async setInflight(workspaceId, id, value) {
      await tick();
      const e = executions.get(id);
      if (e && e.workspace_id === workspaceId) e.inflight = clone(value);
    },
    async setLease(workspaceId, id, leaseExpiresAt) {
      await tick();
      const e = executions.get(id);
      if (e && e.workspace_id === workspaceId && ACTIVE.has(e.status)) e.lease_expires_at = leaseExpiresAt;
    },
    async insertStep(row) {
      await tick();
      checkParent(row);
      if (steps.some((s) => s.execution_id === row.execution_id && s.step_index === row.step_index)) {
        throw err('23505', 'duplicate key value violates unique constraint (execution_id, step_index)');
      }
      const full = { created_at: nowIso(), ...clone(row) };
      steps.push(full);
      return clone(full);
    },
    async listSteps(workspaceId, executionId) {
      await tick();
      return steps.filter((s) => s.workspace_id === workspaceId && s.execution_id === executionId)
        .sort((a, b) => a.step_index - b.step_index).map(clone);
    },
    async insertApproval(row) {
      await tick();
      checkParent(row);
      if ([...approvals.values()].some((a) => a.execution_id === row.execution_id && a.status === 'pending')) {
        throw err('23505', 'duplicate key value violates unique constraint "agent_execution_approvals_one_pending"');
      }
      const full = { id: crypto.randomUUID(), decided_by: null, decision_note: null, decided_at: null, created_at: nowIso(), ...clone(row) };
      approvals.set(full.id, full);
      return clone(full);
    },
    async getApproval(workspaceId, executionId, approvalId) {
      await tick();
      const a = approvals.get(approvalId);
      return a && a.workspace_id === workspaceId && a.execution_id === executionId ? clone(a) : null;
    },
    async listApprovals(workspaceId, executionId) {
      await tick();
      return [...approvals.values()].filter((a) => a.workspace_id === workspaceId && a.execution_id === executionId).map(clone);
    },
    async transitionApproval(workspaceId, approvalId, fromStatus, patch) {
      await tick();
      const a = approvals.get(approvalId);
      if (!a || a.workspace_id !== workspaceId || a.status !== fromStatus) return null;
      Object.assign(a, clone(patch));
      return clone(a);
    },
    async supersedePendingApprovals(workspaceId, executionId) {
      await tick();
      for (const a of approvals.values()) {
        if (a.workspace_id === workspaceId && a.execution_id === executionId && a.status === 'pending') {
          a.status = 'superseded';
          a.decided_at = nowIso();
        }
      }
    },
  };
}

module.exports = { createMemoryExecutionStore };
