/**
 * Layer 2 — collaboration foundation: workspace tasks, assignment
 * (human or AI agent), status, priority, comments/activity, the task →
 * execution link, workspace permission grants and the workspace audit view.
 *
 *   Workspace → Tasks → Executions (Layer 3) → Steps → Evidence
 *
 * Every method takes the Layer 1 workspace context ({ workspace, role,
 * userId }) that middleware/workspaceContext.js resolved from the verified
 * Firebase uid + membership. Nothing workspace/user-related is read from
 * request bodies. Role rules (owner > admin > member):
 *
 *   view / list tasks, activity, grants ............ member+
 *   create task, comment ........................... member+
 *   edit title/description/priority ................ creator, human assignee, admin+
 *   change status .................................. creator, human assignee, admin+
 *   assign (any member / agent / unassign) ......... creator, admin+
 *   claim an UNASSIGNED task for yourself .......... member+
 *   execute task (start a Layer 3 agent execution) . creator, human assignee, admin+
 *   delete task (only if it has no executions) ..... admin+
 *   manage workspace permission grants ............. admin+
 *   read workspace audit log ....................... admin+
 *   approve / reject / cancel executions ........... Layer 3 rules (unchanged)
 */
'use strict';

const crypto = require('crypto');
const { WorkspaceError, hasRole } = require('../workspaceService');
// Layer 6: sensitive-data classifier (superset of sensitiveDataFilter).
const { sanitize, sanitizeString } = require('../security/sensitiveClassifier');

const redact = (v, o) => sanitize(v, o);
const redactString = (v, max) => sanitizeString(v, max);

const TASK_STATUSES = ['todo', 'in_progress', 'blocked', 'done', 'cancelled'];
const PRIORITIES = ['low', 'medium', 'high', 'urgent'];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const taskNotFound = () => new WorkspaceError(404, 'TASK_NOT_FOUND', 'Task not found');
const forbidden = (msg) => new WorkspaceError(403, 'FORBIDDEN', msg);
const badRequest = (msg) => new WorkspaceError(400, 'BAD_REQUEST', msg);

function cleanText(value, { field, min = 0, max }) {
  if (value === undefined || value === null) value = '';
  if (typeof value !== 'string') throw badRequest(`${field} must be a string`);
  const v = value.trim();
  if (v.length < min || v.length > max) throw badRequest(`${field} must be ${min}-${max} characters`);
  return redactString(v, max);
}

function requireCtx(ctx) {
  if (!ctx || !ctx.workspace || !ctx.workspace.id || !ctx.userId) {
    throw new WorkspaceError(401, 'AUTH_REQUIRED', 'Authentication required');
  }
  return ctx.workspace.id;
}

function taskView(t) {
  return {
    id: t.id,
    workspaceId: t.workspace_id,
    title: t.title,
    description: t.description,
    status: t.status,
    priority: t.priority,
    createdBy: t.created_by,
    assignee: t.assignee_type ? { type: t.assignee_type, userId: t.assignee_user_id || null, ...(t.assignee_agent_id ? { agentId: t.assignee_agent_id } : {}) } : null,
    createdAt: t.created_at,
    updatedAt: t.updated_at,
    completedAt: t.completed_at || null,
  };
}

function activityView(a) {
  return { id: a.id, kind: a.kind, actorId: a.actor_id, body: a.body || null, data: a.data || null, createdAt: a.created_at };
}

function createWorkspaceDataService({ store, workspaceService, executionService, appendAuditLog, getWorkspaceAuditLog }) {
  if (!store) throw new Error('workspace data store is required');

  const audit = (ctx, action, payload) => {
    if (!appendAuditLog) return;
    try {
      Promise.resolve(appendAuditLog(ctx.userId, action, redact(payload), { success: true }, ctx.workspace.id)).catch(() => {});
    } catch { /* never break the request on audit failure */ }
  };

  const isAdmin = (ctx) => hasRole(ctx.role, 'admin');
  const isAssignee = (ctx, t) => t.assignee_type === 'human' && t.assignee_user_id === ctx.userId;
  const canWork = (ctx, t) => isAdmin(ctx) || t.created_by === ctx.userId || isAssignee(ctx, t);

  async function loadTask(ctx, id) {
    const ws = requireCtx(ctx);
    if (typeof id !== 'string' || !UUID_RE.test(id)) throw taskNotFound();
    const t = await store.getTask(ws, id);
    if (!t) throw taskNotFound();
    return t;
  }

  async function activity(ctx, task, kind, { body = null, data = null } = {}) {
    await store.insertActivity({
      id: crypto.randomUUID(),
      task_id: task.id,
      workspace_id: task.workspace_id,
      actor_id: ctx.userId,
      kind,
      body,
      data: data ? redact(data) : null,
    });
  }

  async function update(ctx, task, patch) {
    const updated = await store.updateTask(task.workspace_id, task.id, task.version, patch);
    if (!updated) throw new WorkspaceError(409, 'TASK_CONFLICT', 'Task was modified concurrently; reload and retry.');
    return updated;
  }

  // Validates an assignee and returns { assignee_type, assignee_user_id }.
  // Layer 10: tasks can be assigned to a named AI workforce agent. The
  // column only exists with the Layer 10 migration, so it is written only
  // when the agent resolver is attached.
  let agentResolver = null;
  const agentCol = (v) => (agentResolver ? { assignee_agent_id: v } : {});
  async function resolveAssignee(ctx, assignee) {
    if (assignee === null || assignee === undefined) return { assignee_type: null, assignee_user_id: null, ...agentCol(null) };
    if (typeof assignee !== 'object') throw badRequest('assignee must be an object or null');
    if (assignee.type === 'agent') {
      if (assignee.agentId === undefined || assignee.agentId === null) return { assignee_type: 'agent', assignee_user_id: null, ...agentCol(null) };
      if (!agentResolver) throw badRequest('Named agents are not available on this server');
      const a = typeof assignee.agentId === 'string' ? await agentResolver.resolve(requireCtx(ctx), assignee.agentId) : null;
      if (!a) throw badRequest('Agent not found in this workspace');
      if (a.status !== 'active') throw badRequest('This agent is archived');
      return { assignee_type: 'agent', assignee_user_id: null, assignee_agent_id: a.id };
    }
    if (assignee.type === 'human') {
      if (typeof assignee.userId !== 'string' || !assignee.userId) throw badRequest('assignee.userId is required');
      const members = await workspaceService.listMembers(ctx);
      if (!members.some((m) => m.user_id === assignee.userId)) {
        throw badRequest('Assignee must be a member of this workspace');
      }
      return { assignee_type: 'human', assignee_user_id: assignee.userId, ...agentCol(null) };
    }
    throw badRequest("assignee.type must be 'human' or 'agent'");
  }

  function assertCanAssign(ctx, task, next) {
    if (isAdmin(ctx) || task.created_by === ctx.userId) return;
    const claimingUnassigned = !task.assignee_type
      && next.assignee_type === 'human' && next.assignee_user_id === ctx.userId;
    if (!claimingUnassigned) {
      throw forbidden('Only the task creator or a workspace admin can assign this task (members may claim unassigned tasks).');
    }
  }

  // ---------------- tasks ----------------
  async function createTask(ctx, body = {}) {
    const ws = requireCtx(ctx);
    const title = cleanText(body.title, { field: 'title', min: 1, max: 200 });
    const description = cleanText(body.description, { field: 'description', max: 5000 });
    const priority = body.priority === undefined ? 'medium' : body.priority;
    if (!PRIORITIES.includes(priority)) throw badRequest(`priority must be one of ${PRIORITIES.join(', ')}`);
    const assignee = await resolveAssignee(ctx, body.assignee);
    // The creator of a task may assign it to any member or the agent (see role table).
    const task = await store.insertTask({
      id: crypto.randomUUID(),
      workspace_id: ws,
      title,
      description,
      priority,
      status: 'todo',
      created_by: ctx.userId,
      ...assignee,
    });
    await activity(ctx, task, 'created', { data: { priority, assignee: taskView(task).assignee } });
    audit(ctx, 'task_created', { taskId: task.id, workspaceId: ws, priority, assigneeType: task.assignee_type });
    if (task.assignee_type) audit(ctx, 'task_assigned', { taskId: task.id, workspaceId: ws, assignee: taskView(task).assignee });
    return taskView(task);
  }

  async function listTasks(ctx, { status, assignee, agentId, limit } = {}) {
    const ws = requireCtx(ctx);
    if (status !== undefined && !TASK_STATUSES.includes(status)) throw badRequest('invalid status filter');
    const assigneeUserId = assignee === 'me' ? ctx.userId : (typeof assignee === 'string' && assignee ? assignee : undefined);
    const n = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);
    const assigneeAgentId = typeof agentId === 'string' && /^[0-9a-f-]{36}$/i.test(agentId) ? agentId : undefined; // Layer 10
    const rows = await store.listTasks(ws, { status, assigneeUserId, assigneeAgentId, limit: n });
    return rows.map(taskView);
  }

  async function getTask(ctx, id) {
    const t = await loadTask(ctx, id);
    const executions = executionService ? await executionService.listTaskExecutions(ctx, t.id, { limit: 10 }) : [];
    const acts = await store.listActivity(t.workspace_id, t.id, { limit: 50 });
    return {
      ...taskView(t),
      executions: executions.map((e) => ({
        id: e.id, status: e.status, createdBy: e.createdBy, createdAt: e.createdAt, finishedAt: e.finishedAt,
        waitingForApproval: e.waitingForApproval ? { approvalId: e.waitingForApproval.id, action: e.waitingForApproval.action, riskTier: e.waitingForApproval.riskTier, requiredRole: e.waitingForApproval.requiredRole } : null,
        failure: e.failure, verification: e.verification,
      })),
      activity: acts.map(activityView),
    };
  }

  async function updateTask(ctx, id, body = {}) {
    const t = await loadTask(ctx, id);
    if (!canWork(ctx, t)) throw forbidden('Only the creator, the assignee or a workspace admin can edit this task.');
    const patch = {};
    if (body.title !== undefined) patch.title = cleanText(body.title, { field: 'title', min: 1, max: 200 });
    if (body.description !== undefined) patch.description = cleanText(body.description, { field: 'description', max: 5000 });
    if (body.priority !== undefined) {
      if (!PRIORITIES.includes(body.priority)) throw badRequest(`priority must be one of ${PRIORITIES.join(', ')}`);
      patch.priority = body.priority;
    }
    if (!Object.keys(patch).length) throw badRequest('Nothing to update');
    const updated = await update(ctx, t, patch);
    await activity(ctx, updated, 'updated', { data: { fields: Object.keys(patch) } });
    audit(ctx, 'task_updated', { taskId: t.id, workspaceId: t.workspace_id, fields: Object.keys(patch) });
    return taskView(updated);
  }

  async function assignTask(ctx, id, body = {}) {
    const t = await loadTask(ctx, id);
    const next = await resolveAssignee(ctx, body.assignee === undefined ? null : body.assignee);
    assertCanAssign(ctx, t, next);
    const updated = await update(ctx, t, next);
    const view = taskView(updated);
    await activity(ctx, updated, 'assigned', { data: { from: taskView(t).assignee, to: view.assignee } });
    audit(ctx, 'task_assigned', { taskId: t.id, workspaceId: t.workspace_id, from: taskView(t).assignee, to: view.assignee });
    return view;
  }

  async function changeStatus(ctx, id, body = {}) {
    const t = await loadTask(ctx, id);
    if (!canWork(ctx, t)) throw forbidden('Only the creator, the assignee or a workspace admin can change the status.');
    if (!TASK_STATUSES.includes(body.status)) throw badRequest(`status must be one of ${TASK_STATUSES.join(', ')}`);
    if (body.status === t.status) return taskView(t);
    const updated = await update(ctx, t, {
      status: body.status,
      completed_at: body.status === 'done' ? new Date().toISOString() : null,
    });
    await activity(ctx, updated, 'status_changed', { data: { from: t.status, to: body.status } });
    audit(ctx, 'task_status_changed', { taskId: t.id, workspaceId: t.workspace_id, from: t.status, to: body.status });
    return taskView(updated);
  }

  async function addComment(ctx, id, body = {}) {
    const t = await loadTask(ctx, id);
    const text = cleanText(body.body, { field: 'body', min: 1, max: 5000 });
    const row = await store.insertActivity({
      id: crypto.randomUUID(), task_id: t.id, workspace_id: t.workspace_id, actor_id: ctx.userId, kind: 'comment', body: text, data: null,
    });
    audit(ctx, 'task_commented', { taskId: t.id, workspaceId: t.workspace_id }); // body never logged
    return activityView(row);
  }

  async function listActivity(ctx, id) {
    const t = await loadTask(ctx, id);
    return (await store.listActivity(t.workspace_id, t.id, { limit: 200 })).map(activityView);
  }

  async function executeTask(ctx, id, { idempotencyKey } = {}) {
    if (!executionService) throw new WorkspaceError(503, 'EXECUTION_UNAVAILABLE', 'Execution service unavailable');
    const t = await loadTask(ctx, id);
    if (!canWork(ctx, t)) throw forbidden('Only the creator, the assignee or a workspace admin can run this task.');
    if (t.status === 'done' || t.status === 'cancelled') {
      throw new WorkspaceError(409, 'TASK_CLOSED', `Task is ${t.status}; reopen it before running it.`);
    }
    const goal = t.description ? `${t.title}\n\n${t.description}` : t.title;
    const { execution, replayed } = await executionService.createExecution(ctx, {
      goal, idempotencyKey, taskId: t.id, ...(t.assignee_agent_id ? { agentId: t.assignee_agent_id } : {}), // Layer 10
    });
    if (!replayed) {
      let current = t;
      if (t.status === 'todo' || t.status === 'blocked') {
        current = await update(ctx, t, { status: 'in_progress' }).catch(() => t);
      }
      await activity(ctx, current, 'execution_started', { data: { executionId: execution.id } });
      audit(ctx, 'task_execution_started', { taskId: t.id, workspaceId: t.workspace_id, executionId: execution.id });
    }
    return { execution, replayed };
  }

  async function deleteTask(ctx, id) {
    const t = await loadTask(ctx, id);
    if (!isAdmin(ctx)) throw forbidden('Only a workspace admin or owner can delete tasks.');
    try {
      await store.deleteTask(t.workspace_id, t.id);
    } catch (err) {
      if (err.code === '23503') {
        throw new WorkspaceError(409, 'TASK_HAS_EXECUTIONS', 'Task has executions and cannot be deleted; cancel it instead.');
      }
      throw err;
    }
    audit(ctx, 'task_deleted', { taskId: t.id, workspaceId: t.workspace_id });
    return { deleted: true, id: t.id };
  }

  // ---------------- workspace permission grants ----------------
  async function listGrants(ctx) {
    const ws = requireCtx(ctx);
    return (await store.listGrants(ws)).map((g) => ({ id: g.id, resource: g.resource_name, grantedBy: g.granted_by, createdAt: g.created_at }));
  }

  async function createGrant(ctx, body = {}) {
    const ws = requireCtx(ctx);
    if (!isAdmin(ctx)) throw forbidden('Only a workspace admin or owner can grant resource access.');
    if (typeof body.resource !== 'string' || !body.resource.trim() || body.resource.length > 500) {
      throw badRequest('resource must be 1-500 characters');
    }
    try {
      const g = await store.insertGrant({ id: crypto.randomUUID(), workspace_id: ws, resource_name: body.resource.trim(), granted_by: ctx.userId });
      audit(ctx, 'workspace_grant_created', { workspaceId: ws, grantId: g.id, resource: g.resource_name });
      return { id: g.id, resource: g.resource_name, grantedBy: g.granted_by, createdAt: g.created_at };
    } catch (err) {
      if (err.code === '23505') throw new WorkspaceError(409, 'GRANT_EXISTS', 'This resource is already granted in this workspace.');
      throw err;
    }
  }

  async function deleteGrant(ctx, grantId) {
    const ws = requireCtx(ctx);
    if (!isAdmin(ctx)) throw forbidden('Only a workspace admin or owner can revoke resource access.');
    if (typeof grantId !== 'string' || !UUID_RE.test(grantId) || !(await store.deleteGrant(ws, grantId))) {
      throw new WorkspaceError(404, 'GRANT_NOT_FOUND', 'Grant not found');
    }
    audit(ctx, 'workspace_grant_revoked', { workspaceId: ws, grantId });
    return { deleted: true, id: grantId };
  }

  // ---------------- audit ----------------
  async function listAudit(ctx, { limit, before } = {}) {
    const ws = requireCtx(ctx);
    if (!isAdmin(ctx)) throw forbidden('Only a workspace admin or owner can read the audit log.');
    if (!getWorkspaceAuditLog) return [];
    const rows = await getWorkspaceAuditLog(ws, { limit, before: typeof before === 'string' ? before : null });
    return rows.map((r) => ({ id: r.id, userId: r.user_id, action: r.action, payload: redact(r.payload), success: r.success, error: r.error ? redactString(r.error, 500) : null, createdAt: r.created_at }));
  }

  return {
    createTask, listTasks, getTask, updateTask, assignTask, changeStatus, addComment, listActivity, executeTask, deleteTask,
    setAgentResolver(r) { agentResolver = r || null; },
    listGrants, createGrant, deleteGrant, listAudit,
  };
}

module.exports = { createWorkspaceDataService, TASK_STATUSES, PRIORITIES };
