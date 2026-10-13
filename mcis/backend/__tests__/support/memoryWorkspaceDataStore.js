/**
 * TEST-ONLY in-memory implementation of
 * services/workspaceData/workspaceDataStore.js. Mirrors the SQL constraints
 * the service relies on (migrations/20260925_layer2_...):
 *   - workspace_permission_grants unique (workspace_id, resource_name) → 23505
 *   - activity (task_id, workspace_id) must reference an existing task → 23503
 *   - deleting a task referenced by an execution (ON DELETE RESTRICT)   → 23503
 *   - optimistic version check on task update
 */
'use strict';

const tick = () => new Promise((r) => setImmediate(r));
const clone = (o) => (o == null ? null : JSON.parse(JSON.stringify(o)));
const err = (code, message) => Object.assign(new Error(message), { code });

function createMemoryWorkspaceDataStore({ taskHasExecutions = async () => false } = {}) {
  const tasks = new Map();
  const activity = [];
  const grants = new Map();
  const nowIso = () => new Date().toISOString();

  return {
    _dump: () => ({ tasks: [...tasks.values()], activity: [...activity], grants: [...grants.values()] }),

    async insertTask(row) {
      await tick();
      const full = { description: '', status: 'todo', priority: 'medium', assignee_type: null, assignee_user_id: null,
        version: 0, created_at: nowIso(), updated_at: nowIso(), completed_at: null, ...clone(row) };
      tasks.set(full.id, full);
      return clone(full);
    },
    async getTask(workspaceId, id) {
      await tick();
      const t = tasks.get(id);
      return t && t.workspace_id === workspaceId ? clone(t) : null;
    },
    async listTasks(workspaceId, { status, assigneeUserId, assigneeAgentId, limit = 50 } = {}) {
      await tick();
      return [...tasks.values()]
        .filter((t) => t.workspace_id === workspaceId && (!status || t.status === status) && (!assigneeUserId || t.assignee_user_id === assigneeUserId)
          && (!assigneeAgentId || t.assignee_agent_id === assigneeAgentId))
        .sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, limit).map(clone);
    },
    async updateTask(workspaceId, id, expectedVersion, patch) {
      await tick();
      const t = tasks.get(id);
      if (!t || t.workspace_id !== workspaceId || t.version !== expectedVersion) return null;
      Object.assign(t, clone(patch), { version: expectedVersion + 1, updated_at: nowIso() });
      return clone(t);
    },
    async deleteTask(workspaceId, id) {
      await tick();
      const t = tasks.get(id);
      if (!t || t.workspace_id !== workspaceId) return false;
      if (await taskHasExecutions(workspaceId, id)) throw err('23503', 'violates foreign key constraint "agent_executions_task_fk"');
      tasks.delete(id);
      for (let i = activity.length - 1; i >= 0; i--) if (activity[i].task_id === id) activity.splice(i, 1);
      return true;
    },
    async insertActivity(row) {
      await tick();
      const t = tasks.get(row.task_id);
      if (!t || t.workspace_id !== row.workspace_id) throw err('23503', 'violates foreign key constraint (task_id, workspace_id)');
      const full = { created_at: nowIso(), ...clone(row) };
      activity.push(full);
      return clone(full);
    },
    async listActivity(workspaceId, taskId, { limit = 100 } = {}) {
      await tick();
      return activity.filter((a) => a.workspace_id === workspaceId && a.task_id === taskId).slice(0, limit).map(clone);
    },
    async listGrants(workspaceId) {
      await tick();
      return [...grants.values()].filter((g) => g.workspace_id === workspaceId).map(clone);
    },
    async insertGrant(row) {
      await tick();
      if ([...grants.values()].some((g) => g.workspace_id === row.workspace_id && g.resource_name === row.resource_name)) {
        throw err('23505', 'duplicate key value violates unique constraint (workspace_id, resource_name)');
      }
      const full = { created_at: nowIso(), ...clone(row) };
      grants.set(full.id, full);
      return clone(full);
    },
    async deleteGrant(workspaceId, id) {
      await tick();
      const g = grants.get(id);
      if (!g || g.workspace_id !== workspaceId) return false;
      grants.delete(id);
      return true;
    },
  };
}

module.exports = { createMemoryWorkspaceDataStore };
