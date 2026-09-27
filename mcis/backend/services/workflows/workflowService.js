/**
 * Layer 4 — Workflows: definitions, immutable versions, runs, approvals,
 * cancellation, human review and scheduling configuration.
 *
 *   Workspace → Workflow → Version (immutable) → Run → Task (Layer 2)
 *            → Step executions (Layer 3) → Steps / Evidence / Approvals
 *
 * Execution is NOT done here: runs are queued as durable jobs and driven
 * by services/workflows/workflowRunner.js, which reuses the Layer 3
 * execution engine for every step. This service never runs an action.
 *
 * Every method takes the Layer 1 workspace context ({ workspace, role,
 * userId }) resolved server-side from the verified Firebase uid +
 * membership. Workflow/run/version/step ownership is always re-checked
 * against that workspace; nothing tenant-related is read from bodies.
 *
 * Roles (owner > admin > member):
 *   view workflows / versions / runs / evidence ........ member+
 *   create workflow (draft) ............................. member+
 *   edit draft / publish / archive / re-activate ........ creator or admin+
 *   configure trigger + schedule ........................ admin+
 *   start a run (active workflow only) .................. member+
 *   cancel a run / resolve a run that needs review ...... initiator or admin+
 *   approve / reject a step action ...................... Layer 3 rules
 *                                                          (execution creator = run initiator, or admin+;
 *                                                           RED / 'admin' policy → admin+)
 */
'use strict';

const crypto = require('crypto');
const { WorkspaceError, hasRole } = require('../workspaceService');
// Layer 6: sensitive-data classifier (superset of sensitiveDataFilter).
const { sanitize, sanitizeString } = require('../security/sensitiveClassifier');

const redact = (v, o) => sanitize(v, o);
const redactString = (v, max) => sanitizeString(v, max);
const {
  normalizeDefinition, validateInputs, hashDefinition, stableStringify, DefinitionError,
} = require('./definition');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9_.:-]{8,128}$/;
const RUN_TERMINAL = new Set(['completed', 'failed', 'cancelled']);
const TRIGGERS = ['manual', 'scheduled', 'api'];
const RUN_STATUSES = ['queued', 'running', 'waiting_approval', 'needs_review', 'completed', 'failed', 'cancelled'];

const wfNotFound = () => new WorkspaceError(404, 'WORKFLOW_NOT_FOUND', 'Workflow not found');
const runNotFound = () => new WorkspaceError(404, 'WORKFLOW_RUN_NOT_FOUND', 'Workflow run not found');
const forbidden = (msg) => new WorkspaceError(403, 'FORBIDDEN', msg);
const badRequest = (msg) => new WorkspaceError(400, 'BAD_REQUEST', msg);
const conflict = (code, msg, extra) => Object.assign(new WorkspaceError(409, code, msg), extra ? { extra } : {});

const sha256 = (t) => crypto.createHash('sha256').update(t, 'utf8').digest('hex');

function requireCtx(ctx) {
  if (!ctx || !ctx.workspace || !ctx.workspace.id || !ctx.userId) {
    throw new WorkspaceError(401, 'AUTH_REQUIRED', 'Authentication required');
  }
  return ctx.workspace.id;
}

function cleanName(v) {
  if (typeof v !== 'string' || !v.trim() || v.trim().length > 120) throw badRequest('name must be 1-120 characters');
  return redactString(v.trim(), 120);
}
function cleanDescription(v) {
  if (v === undefined || v === null) return '';
  if (typeof v !== 'string' || v.length > 2000) throw badRequest('description must be at most 2000 characters');
  return redactString(v.trim(), 2000);
}

// ---------------------------------------------------------------------
// Views (never include raw inputs — only the redacted stored copy)
// ---------------------------------------------------------------------
function workflowView(w) {
  return {
    id: w.id,
    workspaceId: w.workspace_id,
    name: w.name,
    description: w.description,
    status: w.status,
    createdBy: w.created_by,
    draft: w.draft,
    activeVersionId: w.active_version_id || null,
    latestVersion: w.latest_version,
    trigger: {
      type: w.trigger_type,
      intervalMinutes: w.schedule_interval_minutes || null,
      nextRunAt: w.next_run_at || null,
      owner: w.schedule_owner || null,
      inputs: w.schedule_inputs || null,
    },
    revision: w.revision,
    createdAt: w.created_at,
    updatedAt: w.updated_at,
    archivedAt: w.archived_at || null,
  };
}

function versionView(v, { withDefinition = false } = {}) {
  return {
    id: v.id,
    workflowId: v.workflow_id,
    version: v.version_number,
    name: v.name,
    definitionHash: v.definition_hash,
    createdBy: v.created_by,
    createdAt: v.created_at,
    ...(withDefinition ? { definition: v.definition } : {}),
  };
}

function runStepView(s) {
  return {
    position: s.position,
    key: s.step_key,
    status: s.status,
    attempt: s.attempt,
    executionId: s.execution_id || null,
    attempts: s.attempts || [],
    output: s.output || null,
    verification: s.verification || null,
    error: s.error_code ? { code: s.error_code, message: s.error_message } : null,
    startedAt: s.started_at || null,
    finishedAt: s.finished_at || null,
  };
}

function runView(r) {
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    workflowId: r.workflow_id,
    workflowVersionId: r.workflow_version_id,
    version: r.version_number,
    initiatedBy: r.initiated_by,
    trigger: r.trigger,
    status: r.status,
    currentStep: r.current_step,
    inputs: r.inputs,
    taskId: r.task_id || null,
    scheduledFor: r.scheduled_for || null,
    cancelRequested: !!r.cancel_requested,
    result: r.result || null,
    verification: r.verification || null,
    failure: r.failure_code ? { code: r.failure_code, message: r.failure_message } : null,
    reviewReason: r.review_reason || null,
    createdAt: r.created_at,
    startedAt: r.started_at || null,
    finishedAt: r.finished_at || null,
    updatedAt: r.updated_at,
  };
}

function createWorkflowService({
  store, dataStore, executionService, appendAuditLog, integrationResolver = null, logger = console, options = {}, usage = null,
} = {}) {
  if (!store) throw new Error('workflow store is required');
  const now = options.now || (() => new Date());
  let runner = null;
  let meter = usage; // Layer 7 entitlement / usage service (optional)
  const quotaError = (err) => Object.assign(new WorkspaceError(err.status || 503, err.code || 'ENTITLEMENT_UNAVAILABLE', err.message), err.extra ? { extra: err.extra } : {});
  // Layer 7: making a workflow active counts against max_active_workflows.
  async function assertCanActivate(w) {
    if (!meter || w.status === 'active') return;
    try { await meter.assert(w.workspace_id, 'active_workflows', 1); } catch (err) { throw quotaError(err); }
  }

  /**
   * Layer 9: the check in assertCanActivate is not atomic with the write.
   * After a workflow BECAME active, re-count: if concurrent activations pushed
   * the workspace over max_active_workflows, put this workflow back to its
   * previous state and refuse (every racer does the same → never exceeded).
   */
  async function verifyActiveLimit(before, updated) {
    if (!meter || before.status === 'active' || updated.status !== 'active') return updated;
    const revert = () => store.updateWorkflow(updated.workspace_id, updated.id, updated.revision, {
      status: before.status, active_version_id: before.active_version_id || null,
      ...(before.status === 'archived' ? { archived_at: before.archived_at || now().toISOString() } : {}),
    }).catch(() => {});
    // Serialized re-count under a per-workspace lock: an over-limit activation
    // is undone by the store in the same transaction (never exceeded, and at
    // least min(limit, racers) activations survive — no livelock).
    if (meter.enforceCount && store.enforceActiveWorkflowLimit) {
      try {
        await meter.enforceCount(updated.workspace_id, 'active_workflows', (limit) => store.enforceActiveWorkflowLimit(updated.workspace_id, updated.id, limit, {
          status: before.status, activeVersionId: before.active_version_id || null, archivedAt: before.archived_at || null,
        }));
        return updated;
      } catch (err) {
        if (err.code !== 'QUOTA_EXCEEDED') await revert();
        throw quotaError(err);
      }
    }
    try { await meter.assert(updated.workspace_id, 'active_workflows', 0); return updated; } catch (err) {
      await revert();
      throw quotaError(err);
    }
  }

  const isAdmin = (ctx) => hasRole(ctx.role, 'admin');
  const canManageWorkflow = (ctx, w) => isAdmin(ctx) || w.created_by === ctx.userId;
  const canManageRun = (ctx, r) => isAdmin(ctx) || r.initiated_by === ctx.userId;
  let agentResolver = null; // Layer 10

  const audit = (userId, action, payload, workspaceId, success = true, error = null) => {
    if (!appendAuditLog) return;
    try {
      Promise.resolve(appendAuditLog(userId, action, redact(payload), { success, error }, workspaceId)).catch(() => {});
    } catch { /* audit never breaks the request */ }
  };

  function asDefinitionError(err) {
    if (err instanceof DefinitionError) {
      const e = new WorkspaceError(400, err.code, err.message);
      if (err.extra) e.extra = err.extra;
      return e;
    }
    return err;
  }

  async function loadWorkflow(ctx, id) {
    const ws = requireCtx(ctx);
    if (typeof id !== 'string' || !UUID_RE.test(id)) throw wfNotFound();
    const w = await store.getWorkflow(ws, id);
    if (!w) throw wfNotFound();
    return w;
  }

  async function loadRun(ctx, runId) {
    const ws = requireCtx(ctx);
    if (typeof runId !== 'string' || !UUID_RE.test(runId)) throw runNotFound();
    const r = await store.getRun(ws, runId);
    if (!r) throw runNotFound();
    return r;
  }

  // ------------------------------------------------------------------
  // Workflows
  // ------------------------------------------------------------------
  async function listWorkflows(ctx, { status, limit } = {}) {
    const ws = requireCtx(ctx);
    if (status !== undefined && !['draft', 'active', 'archived'].includes(status)) throw badRequest('invalid status filter');
    const n = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);
    return (await store.listWorkflows(ws, { status, limit: n })).map(workflowView);
  }

  async function createWorkflow(ctx, body = {}) {
    const ws = requireCtx(ctx);
    const name = cleanName(body.name);
    const description = cleanDescription(body.description);
    let draft;
    try { draft = normalizeDefinition(body.definition); } catch (err) { throw asDefinitionError(err); }
    const w = await store.insertWorkflow({
      id: crypto.randomUUID(),
      workspace_id: ws,
      name,
      description,
      status: 'draft',
      created_by: ctx.userId,
      draft,
      trigger_type: 'manual',
    });
    audit(ctx.userId, 'workflow_created', { workspaceId: ws, workflowId: w.id }, ws);
    return workflowView(w);
  }

  async function getWorkflow(ctx, id) {
    const w = await loadWorkflow(ctx, id);
    const versions = await store.listVersions(w.workspace_id, w.id);
    return { ...workflowView(w), versions: versions.map((v) => versionView(v)) };
  }

  async function getVersion(ctx, id, versionNumber) {
    const w = await loadWorkflow(ctx, id);
    const n = parseInt(versionNumber, 10);
    if (!Number.isInteger(n) || n < 1) throw new WorkspaceError(404, 'WORKFLOW_VERSION_NOT_FOUND', 'Version not found');
    const v = await store.getVersionByNumber(w.workspace_id, w.id, n);
    if (!v) throw new WorkspaceError(404, 'WORKFLOW_VERSION_NOT_FOUND', 'Version not found');
    return versionView(v, { withDefinition: true });
  }

  function requireRevision(body, w) {
    if (body.revision === undefined || body.revision === null) throw badRequest('revision is required (the workflow revision you edited)');
    if (!Number.isInteger(body.revision)) throw badRequest('revision must be an integer');
    if (body.revision !== w.revision) {
      throw conflict('WORKFLOW_CONFLICT', 'The workflow was changed by someone else; reload and retry.', { currentRevision: w.revision });
    }
  }

  async function casWorkflow(w, patch) {
    const updated = await store.updateWorkflow(w.workspace_id, w.id, w.revision, patch);
    if (!updated) throw conflict('WORKFLOW_CONFLICT', 'The workflow was changed concurrently; reload and retry.');
    return updated;
  }

  // Editing changes ONLY the draft. Published versions (and therefore
  // every run, including in-flight ones) are never touched.
  async function updateWorkflow(ctx, id, body = {}) {
    const w = await loadWorkflow(ctx, id);
    if (!canManageWorkflow(ctx, w)) throw forbidden('Only the workflow creator or a workspace admin can edit it.');
    if (w.status === 'archived') throw conflict('WORKFLOW_ARCHIVED', 'Archived workflows cannot be edited; re-activate it first.');
    requireRevision(body, w);
    const patch = {};
    if (body.name !== undefined) patch.name = cleanName(body.name);
    if (body.description !== undefined) patch.description = cleanDescription(body.description);
    if (body.definition !== undefined) {
      try { patch.draft = normalizeDefinition(body.definition); } catch (err) { throw asDefinitionError(err); }
    }
    if (!Object.keys(patch).length) throw badRequest('Nothing to update');
    const updated = await casWorkflow(w, patch);
    audit(ctx.userId, 'workflow_updated', { workspaceId: w.workspace_id, workflowId: w.id, fields: Object.keys(patch) }, w.workspace_id);
    return workflowView(updated);
  }

  async function publishWorkflow(ctx, id, body = {}) {
    const w = await loadWorkflow(ctx, id);
    if (!canManageWorkflow(ctx, w)) throw forbidden('Only the workflow creator or a workspace admin can publish it.');
    if (w.status === 'archived') throw conflict('WORKFLOW_ARCHIVED', 'Archived workflows cannot be published; re-activate it first.');
    if (body.revision !== undefined) requireRevision(body, w);
    let definition;
    try { definition = normalizeDefinition(w.draft, { forPublish: true }); } catch (err) { throw asDefinitionError(err); }
    // Layer 5: connector steps must reference an integration of THIS
    // workspace and an action its provider actually has.
    for (const [i, st] of definition.steps.entries()) {
      // Layer 10: an agent step's AI workforce agent must be an active agent of THIS workspace.
      if (st.agentId) {
        const a = agentResolver ? await agentResolver.resolve(w.workspace_id, st.agentId) : null;
        if (!a) throw badRequest(`steps[${i}]: agent not found in this workspace`);
        if (a.status !== 'active') throw badRequest(`steps[${i}]: agent "${a.name}" is archived`);
      }
      if (!st.connector) continue;
      if (!integrationResolver) throw conflict('INTEGRATIONS_DISABLED', 'This workflow uses integrations, which are not enabled on this server.');
      try {
        await integrationResolver.validateStepReference(w.workspace_id, st.connector.integrationId, st.connector.action);
      } catch (err) {
        throw badRequest(`steps[${i}]: ${err.status === 404 ? 'integration not found in this workspace' : err.message}`);
      }
    }
    const hash = hashDefinition({ name: w.name, definition });
    await assertCanActivate(w);

    // Same content as the latest version → idempotent (no new version).
    if (w.latest_version > 0) {
      const latest = await store.getVersionByNumber(w.workspace_id, w.id, w.latest_version);
      if (latest && latest.definition_hash === hash) {
        const updated = w.active_version_id === latest.id && w.status === 'active'
          ? w : await verifyActiveLimit(w, await casWorkflow(w, { active_version_id: latest.id, status: 'active' }));
        return { workflow: workflowView(updated), version: versionView(latest), created: false };
      }
    }

    let version;
    try {
      version = await store.insertVersion({
        id: crypto.randomUUID(),
        workflow_id: w.id,
        workspace_id: w.workspace_id,
        version_number: w.latest_version + 1,
        name: w.name,
        definition,
        definition_hash: hash,
        created_by: ctx.userId,
      });
    } catch (err) {
      if (err.code === '23505') throw conflict('WORKFLOW_CONFLICT', 'Another publish happened at the same time; reload and retry.');
      throw err;
    }
    const updated = await verifyActiveLimit(w, await casWorkflow(w, {
      active_version_id: version.id,
      latest_version: version.version_number,
      status: 'active',
    }));
    audit(ctx.userId, 'workflow_published', { workspaceId: w.workspace_id, workflowId: w.id, version: version.version_number }, w.workspace_id);
    return { workflow: workflowView(updated), version: versionView(version), created: true };
  }

  async function archiveWorkflow(ctx, id) {
    const w = await loadWorkflow(ctx, id);
    if (!canManageWorkflow(ctx, w)) throw forbidden('Only the workflow creator or a workspace admin can archive it.');
    if (w.status === 'archived') return workflowView(w);
    // Runs already in progress keep executing their own immutable version.
    const updated = await casWorkflow(w, { status: 'archived', archived_at: now().toISOString(), next_run_at: null });
    audit(ctx.userId, 'workflow_archived', { workspaceId: w.workspace_id, workflowId: w.id }, w.workspace_id);
    return workflowView(updated);
  }

  async function activateWorkflow(ctx, id) {
    const w = await loadWorkflow(ctx, id);
    if (!canManageWorkflow(ctx, w)) throw forbidden('Only the workflow creator or a workspace admin can re-activate it.');
    if (w.status !== 'archived') return workflowView(w);
    const status = w.active_version_id ? 'active' : 'draft';
    if (status === 'active') await assertCanActivate(w);
    const patch = { status, archived_at: null };
    if (status === 'active' && w.trigger_type === 'scheduled') {
      patch.next_run_at = new Date(now().getTime() + w.schedule_interval_minutes * 60000).toISOString();
    }
    const updated = await verifyActiveLimit(w, await casWorkflow(w, patch));
    audit(ctx.userId, 'workflow_activated', { workspaceId: w.workspace_id, workflowId: w.id }, w.workspace_id);
    return workflowView(updated);
  }

  // Trigger configuration. A scheduled workflow runs unattended as the
  // admin who configured it (schedule_owner); membership is re-checked
  // at every firing.
  async function setTrigger(ctx, id, body = {}) {
    const w = await loadWorkflow(ctx, id);
    if (!isAdmin(ctx)) throw forbidden('Only a workspace admin or owner can configure workflow triggers.');
    if (body.revision !== undefined) requireRevision(body, w);
    const type = body.type;
    if (!TRIGGERS.includes(type)) throw badRequest(`type must be one of ${TRIGGERS.join(', ')}`);
    let patch;
    if (type === 'scheduled') {
      if (w.status !== 'active' || !w.active_version_id) throw conflict('WORKFLOW_NOT_ACTIVE', 'Publish the workflow before scheduling it.');
      const interval = body.intervalMinutes;
      if (!Number.isInteger(interval) || interval < 15 || interval > 10080) throw badRequest('intervalMinutes must be an integer between 15 and 10080');
      const version = await store.getVersion(w.workspace_id, w.id, w.active_version_id);
      let inputs;
      try { inputs = validateInputs(version.definition, body.inputs); } catch (err) { throw asDefinitionError(err); }
      patch = {
        trigger_type: 'scheduled',
        schedule_interval_minutes: interval,
        schedule_inputs: inputs,
        schedule_owner: ctx.userId,
        next_run_at: new Date(now().getTime() + interval * 60000).toISOString(),
      };
    } else {
      patch = { trigger_type: type, schedule_interval_minutes: null, schedule_inputs: null, schedule_owner: null, next_run_at: null };
    }
    const updated = await casWorkflow(w, patch);
    audit(ctx.userId, 'workflow_trigger_set', {
      workspaceId: w.workspace_id, workflowId: w.id, type, intervalMinutes: patch.schedule_interval_minutes,
    }, w.workspace_id);
    return workflowView(updated);
  }

  // ------------------------------------------------------------------
  // Runs
  // ------------------------------------------------------------------

  /**
   * Creates run + durable job. Used by the API (manual/api trigger) and by
   * the scheduler. The caller has authorized `initiatedBy` in `workspaceId`.
   */
  async function createRunRecord({ workflow, initiatedBy, trigger, inputs, idempotencyKey = null, taskId = null, scheduledFor = null }) {
    const ws = workflow.workspace_id;
    if (workflow.status !== 'active' || !workflow.active_version_id) {
      throw conflict('WORKFLOW_NOT_ACTIVE', 'Only an active (published) workflow can be run.');
    }
    const version = await store.getVersion(ws, workflow.id, workflow.active_version_id);
    if (!version) throw conflict('WORKFLOW_NOT_ACTIVE', 'The workflow has no published version.');
    let cleanInputs;
    try { cleanInputs = validateInputs(version.definition, inputs); } catch (err) { throw asDefinitionError(err); }
    const requestHash = sha256(stableStringify({ ws, workflowId: workflow.id, versionId: version.id, inputs: cleanInputs, taskId, trigger }));

    const replay = (existing) => {
      if (existing.request_hash !== requestHash) {
        throw conflict('IDEMPOTENCY_CONFLICT', 'This idempotency key was already used for a different request.');
      }
      return { run: existing, replayed: true };
    };
    if (idempotencyKey) {
      const existing = await store.findRunByIdempotencyKey(ws, idempotencyKey);
      if (existing) return replay(existing);
    }

    // Layer 7: workflow-run quota, reserved atomically before the run exists.
    // Key = the request's own identity (idempotency key / schedule slot), so
    // a replayed or raced duplicate is never charged twice.
    const runId = crypto.randomUUID();
    let usageHandle = null;
    if (meter) {
      const key = idempotencyKey ? `wfrun:key:${idempotencyKey}` : (scheduledFor ? `wfrun:slot:${workflow.id}:${new Date(scheduledFor).getTime()}` : `wfrun:${runId}`);
      try { usageHandle = await meter.begin(ws, 'workflow_runs', key); } catch (err) { throw quotaError(err); }
    }
    const releaseUsage = () => (usageHandle ? meter.release(usageHandle).catch(() => {}) : null);

    let run;
    try {
      run = await store.insertRun({
        id: runId,
        workspace_id: ws,
        workflow_id: workflow.id,
        workflow_version_id: version.id,
        version_number: version.version_number,
        initiated_by: initiatedBy,
        trigger,
        status: 'queued',
        inputs: cleanInputs,
        task_id: taskId,
        idempotency_key: idempotencyKey,
        request_hash: requestHash,
        scheduled_for: scheduledFor,
      });
    } catch (err) {
      if (err.code === '23505' && idempotencyKey) {
        const existing = await store.findRunByIdempotencyKey(ws, idempotencyKey);
        if (existing) { await releaseUsage(); return replay(existing); }
      }
      if (err.code === '23505' && scheduledFor) {
        const existing = await store.findRunBySlot(ws, workflow.id, scheduledFor);
        if (existing) { await releaseUsage(); return { run: existing, replayed: true }; }
      }
      await releaseUsage();
      throw err;
    }
    if (usageHandle) {
      await meter.commit(usageHandle, { source: 'workflow_run', sourceId: run.id, actorId: initiatedBy })
        .catch((e) => logger.error?.(`[workflows] usage commit failed: ${e.code || e.message}`));
    }
    // The job is created right after the run. If the process dies in
    // between, the runner's sweep creates the missing job (ensureJob).
    await ensureJob(run);
    audit(initiatedBy, 'workflow_run_started', {
      workspaceId: ws, workflowId: workflow.id, runId: run.id, version: version.version_number, trigger,
    }, ws);
    if (runner) runner.kick();
    return { run, replayed: false };
  }

  async function ensureJob(run) {
    try {
      // run_at defaults to the DATABASE clock (the claim compares against
      // the DB's now()), so app/DB clock skew can never delay a job.
      await store.insertJob({ id: crypto.randomUUID(), workspace_id: run.workspace_id, run_id: run.id, status: 'queued' });
    } catch (err) {
      if (err.code !== '23505') throw err; // job already exists
    }
  }

  async function startRun(ctx, workflowId, body = {}, { idempotencyKey } = {}) {
    const w = await loadWorkflow(ctx, workflowId);
    const key = idempotencyKey === undefined || idempotencyKey === null || idempotencyKey === '' ? null : idempotencyKey;
    if (key !== null && (typeof key !== 'string' || !IDEMPOTENCY_KEY_RE.test(key))) {
      throw badRequest('Idempotency key must be 8-128 characters of [A-Za-z0-9_.:-]');
    }
    const trigger = body.trigger === undefined ? 'manual' : body.trigger;
    if (trigger !== 'manual' && trigger !== 'api') throw badRequest("trigger must be 'manual' or 'api'");
    if (trigger === 'api' && !key) throw badRequest('API-triggered runs require an Idempotency-Key');
    if (trigger === 'api' && w.trigger_type !== 'api') throw conflict('TRIGGER_NOT_ENABLED', 'API triggering is not enabled for this workflow.');

    let taskId = null;
    if (body.taskId !== undefined && body.taskId !== null) {
      if (!dataStore) throw new WorkspaceError(503, 'TASKS_UNAVAILABLE', 'Tasks are unavailable');
      if (typeof body.taskId !== 'string' || !UUID_RE.test(body.taskId)) throw new WorkspaceError(404, 'TASK_NOT_FOUND', 'Task not found');
      const t = await dataStore.getTask(w.workspace_id, body.taskId);
      if (!t) throw new WorkspaceError(404, 'TASK_NOT_FOUND', 'Task not found');
      const mayUse = isAdmin(ctx) || t.created_by === ctx.userId || (t.assignee_type === 'human' && t.assignee_user_id === ctx.userId);
      if (!mayUse) throw forbidden('Only the task creator, its assignee or a workspace admin can run a workflow for it.');
      if (t.status === 'done' || t.status === 'cancelled') throw conflict('TASK_CLOSED', `Task is ${t.status}; reopen it first.`);
      taskId = t.id;
    }
    const { run, replayed } = await createRunRecord({
      workflow: w, initiatedBy: ctx.userId, trigger, inputs: body.inputs, idempotencyKey: key, taskId,
    });
    return { run: runView(run), replayed };
  }

  async function listRuns(ctx, { workflowId, limit } = {}) {
    const ws = requireCtx(ctx);
    if (workflowId !== undefined && (typeof workflowId !== 'string' || !UUID_RE.test(workflowId))) return [];
    const n = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 100);
    return (await store.listRuns(ws, { workflowId, limit: n })).map(runView);
  }

  /**
   * Layer 9 (automation API): one page of runs, newest first.
   * { workflowId?, status?, limit? (1-100), cursor? } → { items, nextCursor }
   */
  async function pageRuns(ctx, { workflowId, status, limit, cursor } = {}) {
    const ws = requireCtx(ctx);
    const P = require('../automation/pagination');
    const n = P.parseLimit(limit);
    const before = P.decodeCursor(cursor);
    if (workflowId !== undefined && (typeof workflowId !== 'string' || !UUID_RE.test(workflowId))) throw new WorkspaceError(400, 'INVALID_FILTER', 'workflowId must be a workflow id.');
    if (status !== undefined && !RUN_STATUSES.includes(status)) throw new WorkspaceError(400, 'INVALID_FILTER', `status must be one of ${RUN_STATUSES.join(', ')}.`);
    const rows = await store.listRuns(ws, { workflowId: workflowId ? workflowId.toLowerCase() : undefined, status, before, limit: n + 1 });
    return P.page(rows, n, runView);
  }

  // Runs of ONE workflow: the workflow itself must be in the caller's
  // workspace (404 otherwise, like every other workflow route).
  async function listWorkflowRuns(ctx, workflowId, { limit } = {}) {
    const w = await loadWorkflow(ctx, workflowId);
    return listRuns(ctx, { workflowId: w.id, limit });
  }

  const sysCtxFor = (ctx) => ({ workspace: ctx.workspace, role: ctx.role, userId: ctx.userId });

  async function executionSummary(ctx, executionId) {
    if (!executionService || !executionId) return null;
    try {
      const e = await executionService.getExecution(sysCtxFor(ctx), executionId);
      return {
        id: e.id,
        status: e.status,
        currentAction: e.currentAction,
        progress: e.progress,
        waitingForApproval: e.waitingForApproval,
        failure: e.failure,
        verification: e.verification,
        evidenceSummary: e.evidenceSummary || null,
      };
    } catch (err) {
      if (err && err.status === 404) return null;
      throw err;
    }
  }

  async function getRun(ctx, runId) {
    const r = await loadRun(ctx, runId);
    const [steps, version] = await Promise.all([
      store.listRunSteps(r.workspace_id, r.id),
      store.getVersion(r.workspace_id, r.workflow_id, r.workflow_version_id),
    ]);
    const defSteps = version ? version.definition.steps : [];
    const out = [];
    for (const s of steps) {
      const def = defSteps[s.position] || {};
      out.push({
        ...runStepView(s),
        name: def.name || s.step_key,
        approvalPolicy: def.approval || 'auto',
        verificationPolicy: def.verification || 'best_effort',
        execution: await executionSummary(ctx, s.execution_id),
      });
    }
    // Steps not materialized yet (run still queued) are shown as pending.
    for (let i = steps.length; i < defSteps.length; i++) {
      out.push({ position: i, key: defSteps[i].key, name: defSteps[i].name, status: 'pending', attempt: 0, executionId: null, attempts: [], execution: null });
    }
    return { ...runView(r), steps: out };
  }

  async function getRunEvidence(ctx, runId) {
    const r = await loadRun(ctx, runId);
    const steps = await store.listRunSteps(r.workspace_id, r.id);
    const out = [];
    for (const s of steps) {
      const executions = [];
      const ids = [...new Set([...(s.attempts || []).map((a) => a.executionId), s.execution_id].filter(Boolean))];
      for (const id of ids) {
        try {
          executions.push(await executionService.getEvidence(sysCtxFor(ctx), id));
        } catch (err) {
          if (!err || err.status !== 404) throw err;
        }
      }
      out.push({ ...runStepView(s), executions });
    }
    return { run: runView(r), steps: out };
  }

  async function cancelRun(ctx, runId) {
    const r = await loadRun(ctx, runId);
    if (!canManageRun(ctx, r)) throw forbidden('Only the run initiator or a workspace admin can cancel it.');
    if (RUN_TERMINAL.has(r.status)) throw conflict('RUN_FINISHED', `Run is already ${r.status}.`);
    let updated = r.cancel_requested ? r : await store.updateRun(r.workspace_id, r.id, r.version, { cancel_requested: true });
    if (!updated) updated = await store.getRun(r.workspace_id, r.id);
    audit(ctx.userId, 'workflow_run_cancel_requested', { workspaceId: r.workspace_id, runId: r.id }, r.workspace_id);
    // Not being executed right now → finalize here. Otherwise the job's
    // lease owner stops the step's execution and finalizes.
    const idle = await store.transitionIdleJob(r.workspace_id, r.id, ['queued', 'paused'], { status: 'cancelled' });
    if (idle && runner) {
      updated = await runner.finalizeCancelled(r.workspace_id, r.id, 'Cancelled by a user.');
    } else if (runner) {
      runner.signalCancel(r.id);
    }
    return runView(updated || r);
  }

  // A run paused for human review (recovery could not guarantee that a
  // retry is safe). The human decides: retry the step, skip it, or fail.
  async function resolveRun(ctx, runId, body = {}) {
    const r = await loadRun(ctx, runId);
    if (r.status !== 'needs_review') throw conflict('RUN_NOT_IN_REVIEW', 'Run is not waiting for review.');
    // Layer 10: human review steps (type 'review') are approved / rejected.
    {
      const steps0 = await store.listRunSteps(r.workspace_id, r.id);
      const st0 = steps0.find((s) => s.position === r.current_step);
      if (st0 && st0.status === 'needs_review' && st0.error_code === 'HUMAN_REVIEW') return resolveReview(ctx, r, st0, body);
    }
    if (!canManageRun(ctx, r)) throw forbidden('Only the run initiator or a workspace admin can resolve it.');
    const action = body.action;
    if (!['retry_step', 'skip_step', 'fail'].includes(action)) throw badRequest("action must be 'retry_step', 'skip_step' or 'fail'");
    const steps = await store.listRunSteps(r.workspace_id, r.id);
    const step = steps.find((s) => s.position === r.current_step);
    if (!step || step.status !== 'needs_review') throw conflict('RUN_NOT_IN_REVIEW', 'No step is waiting for review.');

    if (action === 'fail') {
      await store.updateRunStep(r.workspace_id, step.id, step.version, { status: 'failed', finished_at: now().toISOString() });
      const job = await store.transitionIdleJob(r.workspace_id, r.id, ['paused'], { status: 'failed' });
      if (!job) throw conflict('RUN_BUSY', 'Run is being processed; retry shortly.');
      const failed = runner ? await runner.finalizeFailed(r.workspace_id, r.id, 'REVIEW_FAILED', 'Failed by a reviewer.') : r;
      audit(ctx.userId, 'workflow_run_resolved', { workspaceId: r.workspace_id, runId: r.id, action, position: step.position }, r.workspace_id);
      return runView(failed || r);
    }

    const history = [...(step.attempts || []), { attempt: step.attempt, resolvedBy: ctx.userId, resolution: action, at: now().toISOString() }];
    // retry_step: ONE more attempt, explicitly authorized by a human (the
    // runner counts `resolution: 'retry_step'` entries as extra attempts).
    const stepPatch = action === 'retry_step'
      ? { status: 'pending', execution_id: null, attempts: history, error_code: null, error_message: null }
      : { status: 'skipped', attempts: history, finished_at: now().toISOString() };
    const s2 = await store.updateRunStep(r.workspace_id, step.id, step.version, stepPatch);
    if (!s2) throw conflict('RUN_BUSY', 'Run changed concurrently; reload and retry.');
    const r2 = await store.updateRun(r.workspace_id, r.id, r.version, {
      status: 'queued', review_reason: null, failure_code: null, failure_message: null,
      current_step: action === 'skip_step' ? r.current_step + 1 : r.current_step,
    });
    if (!r2) throw conflict('RUN_BUSY', 'Run changed concurrently; reload and retry.');
    // run_at is left as-is (already in the past) → due immediately.
    const job = await store.transitionIdleJob(r.workspace_id, r.id, ['paused'], { status: 'queued' });
    if (!job) throw conflict('RUN_BUSY', 'Run is being processed; retry shortly.');
    audit(ctx.userId, 'workflow_run_resolved', { workspaceId: r.workspace_id, runId: r.id, action, position: step.position }, r.workspace_id);
    if (runner) runner.kick();
    return runView(r2);
  }

  /**
   * Layer 10: decision on a human review step. The reviewer needs the
   * step's reviewerRole (member+ by default); approve → the step succeeds
   * with the reviewer's note as its output and the run continues;
   * reject → the run fails with REVIEW_REJECTED.
   */
  async function resolveReview(ctx, r, step, body) {
    const version = await store.getVersion(r.workspace_id, r.workflow_id, r.workflow_version_id);
    const sdef = version && version.definition.steps[step.position];
    if (!sdef || sdef.type !== 'review') throw conflict('RUN_NOT_IN_REVIEW', 'No review step is waiting.');
    const role = sdef.review.reviewerRole;
    if (!(role === 'member' ? !!ctx.role : isAdmin(ctx))) throw forbidden(`This review needs the ${role} role.`);
    const action = body.action;
    if (!['approve', 'reject'].includes(action)) throw badRequest("action must be 'approve' or 'reject' for a review step");
    const note = body.note === undefined || body.note === null ? '' : body.note;
    if (typeof note !== 'string' || note.length > 2000) throw badRequest('note must be at most 2000 characters');
    const cleanNote = redactString(note.trim(), 2000);
    const decided = { decision: action === 'approve' ? 'approved' : 'rejected', by: ctx.userId, at: now().toISOString(), note: cleanNote || null };
    const history = [...(step.attempts || []), { attempt: step.attempt, review: decided }];
    if (action === 'reject') {
      const s2 = await store.updateRunStep(r.workspace_id, step.id, step.version, { status: 'failed', attempts: history, error_code: 'REVIEW_REJECTED', error_message: redactString(`Rejected by a reviewer${cleanNote ? `: ${cleanNote}` : ''}`, 500), output: { review: decided }, finished_at: now().toISOString() });
      if (!s2) throw conflict('RUN_BUSY', 'Run changed concurrently; reload and retry.');
      const job = await store.transitionIdleJob(r.workspace_id, r.id, ['paused'], { status: 'failed' });
      if (!job) throw conflict('RUN_BUSY', 'Run is being processed; retry shortly.');
      const failed = runner ? await runner.finalizeFailed(r.workspace_id, r.id, 'REVIEW_REJECTED', 'Rejected by a reviewer.') : r;
      audit(ctx.userId, 'workflow_review_rejected', { workspaceId: r.workspace_id, runId: r.id, position: step.position }, r.workspace_id);
      return runView(failed || r);
    }
    const s2 = await store.updateRunStep(r.workspace_id, step.id, step.version, {
      status: 'succeeded', attempts: history, error_code: null, error_message: null, finished_at: now().toISOString(),
      output: { message: cleanNote || 'Approved by a reviewer.', review: decided },
      verification: { status: 'verified', note: `Human review by ${ctx.userId}` },
    });
    if (!s2) throw conflict('RUN_BUSY', 'Run changed concurrently; reload and retry.');
    const r2 = await store.updateRun(r.workspace_id, r.id, r.version, { status: 'queued', review_reason: null, current_step: r.current_step + 1 });
    if (!r2) throw conflict('RUN_BUSY', 'Run changed concurrently; reload and retry.');
    const job = await store.transitionIdleJob(r.workspace_id, r.id, ['paused'], { status: 'queued' });
    if (!job) throw conflict('RUN_BUSY', 'Run is being processed; retry shortly.');
    audit(ctx.userId, 'workflow_review_approved', { workspaceId: r.workspace_id, runId: r.id, position: step.position }, r.workspace_id);
    if (runner) runner.kick();
    return runView(r2);
  }

  // Approvals are Layer 3 approvals. This endpoint only verifies the
  // chain workspace → run → (immutable) version → current step → the
  // step's execution, then delegates to executionService.decideApproval,
  // which enforces role, staleness, expiry and single use (replay).
  async function decideApproval(ctx, runId, position, approvalId, { decision, note } = {}) {
    const r = await loadRun(ctx, runId);
    const pos = Number.parseInt(position, 10);
    if (!Number.isInteger(pos) || pos < 0 || String(pos) !== String(position)) {
      throw new WorkspaceError(404, 'APPROVAL_NOT_FOUND', 'Approval not found');
    }
    const steps = await store.listRunSteps(r.workspace_id, r.id);
    const step = steps.find((s) => s.position === pos);
    if (!step || !step.execution_id) throw new WorkspaceError(404, 'APPROVAL_NOT_FOUND', 'Approval not found');
    if (RUN_TERMINAL.has(r.status) || r.cancel_requested) throw conflict('STALE_APPROVAL', 'This run is no longer active.');
    if (r.current_step !== pos || !['running', 'waiting_approval'].includes(step.status)) {
      throw conflict('STALE_APPROVAL', 'This approval does not belong to the run\'s current step.');
    }
    const out = await executionService.decideApproval(sysCtxFor(ctx), step.execution_id, approvalId, { decision, note });
    audit(ctx.userId, `workflow_run_approval_${decision}`, {
      workspaceId: r.workspace_id, runId: r.id, position: pos, approvalId, version: r.version_number,
    }, r.workspace_id);
    if (runner) runner.kick();
    return { run: runView(await store.getRun(r.workspace_id, r.id)), approval: out.approval };
  }

  return {
    listWorkflows, createWorkflow, getWorkflow, getVersion, updateWorkflow, publishWorkflow, archiveWorkflow, activateWorkflow, setTrigger,
    startRun, listRuns, pageRuns, listWorkflowRuns, getRun, getRunEvidence, cancelRun, resolveRun, decideApproval,
    // runner integration
    createRunRecord, ensureJob,
    attachRunner(r) { runner = r; },
    setUsageMeter(m) { meter = m || null; }, // Layer 7
    setAgentResolver(r) { agentResolver = r || null; }, // Layer 10
  };
}

module.exports = { createWorkflowService, workflowView, runView, runStepView, versionView, RUN_TERMINAL };
