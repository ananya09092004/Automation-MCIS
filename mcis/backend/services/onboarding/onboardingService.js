/**
 * Layer 8 — first-time customer onboarding.
 *
 *   new user → personal workspace → company workspace (create / pick / stay personal)
 *   → invite teammates or skip → choose a use case → create the first
 *   workflow from a template → run a first safe task → done
 *
 * Properties:
 *   - resumable: state lives in user_onboarding (one row per user); every
 *     step can be repeated and GET returns where the user is.
 *   - idempotent: repeating a step never creates a second workspace,
 *     workflow or run. Concurrent duplicates are resolved by CAS on the
 *     row's version; the loser's extra workspace is deleted (or its extra
 *     draft workflow archived) and the winner's is returned.
 *     The first run uses a deterministic Layer 4 Idempotency-Key.
 *   - no new powers: every action goes through the Layer 1 workspace
 *     service (membership → 404 for others' workspaces, role rules for
 *     invitations, plan member limits), the template service and the
 *     Layer 4 workflow service with the user's OWN context, so the first
 *     run passes through quotas, the Agent Firewall and approvals.
 *   - optional: existing users are never forced through it; `required` is
 *     true only for a brand-new user (no row, only a personal workspace,
 *     no workflows yet). Skipping is always allowed.
 */
'use strict';

const { WorkspaceError } = require('../workspaceService');
const { USE_CASES } = require('../templates/catalog');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STEPS = ['workspace', 'team', 'use_case', 'template', 'first_run', 'done'];
const MAX_INVITES = 10;

function createOnboardingService({
  store, workspaceService, templateService, workflowService, appendAuditLog = null, enabled = true, logger = console,
} = {}) {
  if (!store || !workspaceService) throw new Error('onboarding service: store and workspaceService are required');

  const uidOf = (user) => {
    if (!user || typeof user.uid !== 'string' || !user.uid) throw new WorkspaceError(401, 'AUTH_REQUIRED', 'Authentication required');
    return user.uid;
  };
  const requireEnabled = () => {
    if (!enabled) throw new WorkspaceError(404, 'ONBOARDING_DISABLED', 'Onboarding is not enabled on this server.');
  };
  const audit = (userId, action, payload, workspaceId) => {
    if (!appendAuditLog) return;
    try { Promise.resolve(appendAuditLog(userId, action, payload, { success: true }, workspaceId || null)).catch(() => {}); } catch { /* ignore */ }
  };
  const ctxFor = async (user, workspaceId) => {
    const c = await workspaceService.resolveContext(user, workspaceId); // non-member → 404
    return { id: c.workspace.id, role: c.role, workspace: c.workspace, userId: c.userId };
  };
  const later = (a, b) => (STEPS.indexOf(a) >= STEPS.indexOf(b) ? a : b); // never move backwards

  function view(row, extra = {}) {
    return {
      enabled,
      started: !!row,
      step: row ? row.step : null,
      completed: !!(row && row.completed_at),
      completedAt: row ? row.completed_at : null,
      personalWorkspaceId: row ? row.personal_workspace_id : null,
      workspaceId: row ? (row.company_workspace_id || row.personal_workspace_id) : null,
      companyWorkspaceId: row ? row.company_workspace_id : null,
      invitesSent: row ? row.invites_sent : 0,
      invitesSkipped: row ? row.invites_skipped : false,
      useCase: row ? row.use_case : null,
      templateId: row ? row.template_id : null,
      firstWorkflowId: row ? row.first_workflow_id : null,
      firstRunId: row ? row.first_run_id : null,
      steps: STEPS,
      useCases: Object.entries(USE_CASES).map(([id, label]) => ({ id, label })),
      ...extra,
    };
  }

  /** CAS update with retry on a moved version (reads the latest row each time). */
  async function update(uid, row, patchFn) {
    let cur = row;
    for (let i = 0; i < 4; i++) {
      const patch = patchFn(cur);
      if (!patch) return cur;
      const next = await store.updateOnboarding(uid, cur.version, patch);
      if (next) return next;
      cur = await store.getOnboarding(uid);
      if (!cur) throw new WorkspaceError(409, 'ONBOARDING_NOT_STARTED', 'Start onboarding first.');
    }
    throw new WorkspaceError(409, 'ONBOARDING_CONFLICT', 'Onboarding was updated concurrently; reload and retry.');
  }

  async function load(user) {
    requireEnabled();
    const uid = uidOf(user);
    const row = await store.getOnboarding(uid);
    if (!row) throw new WorkspaceError(409, 'ONBOARDING_NOT_STARTED', 'Start onboarding first.');
    return { uid, row };
  }

  /** The workspace onboarding works in (company, else personal) — membership re-checked every time. */
  async function workspaceCtx(user, row) {
    const id = row.company_workspace_id || row.personal_workspace_id;
    if (!id) throw new WorkspaceError(409, 'ONBOARDING_NO_WORKSPACE', 'Choose a workspace first.');
    return ctxFor(user, id);
  }

  // ------------------------------------------------------------------
  async function getState(user) {
    const uid = uidOf(user);
    if (!enabled) return view(null, { required: false });
    const row = await store.getOnboarding(uid);
    if (row) return view(row, { required: !row.completed_at });
    // No row: only brand-new users are pointed at onboarding.
    let required = false;
    try {
      const list = await workspaceService.listWorkspaces(user); // ensures the personal workspace
      if (list.length === 1 && list[0].is_personal && workflowService) {
        const wfs = await workflowService.listWorkflows(await ctxFor(user, list[0].id), { limit: 1 });
        required = wfs.length === 0;
      }
    } catch (err) {
      logger.warn?.(`[onboarding] could not determine whether onboarding is needed (${err.code || err.name})`);
    }
    return view(null, { required });
  }

  async function start(user) {
    requireEnabled();
    const uid = uidOf(user);
    const personal = await workspaceService.ensurePersonalWorkspace(uid);
    const created = await store.insertOnboarding({ user_id: uid, step: 'workspace', personal_workspace_id: personal.id });
    if (created) audit(uid, 'onboarding_started', { userId: uid }, personal.id);
    return view(created || await store.getOnboarding(uid), { required: true });
  }

  /** body: { mode: 'create', name } | { mode: 'existing', workspaceId } | { mode: 'personal' } */
  async function chooseWorkspace(user, body = {}) {
    const { uid, row } = await load(user);
    const mode = body.mode;
    if (mode === 'personal') {
      const next = await update(uid, row, (r) => ({ company_workspace_id: null, step: later(r.step, 'team') }));
      return view(next);
    }
    if (mode === 'existing') {
      if (typeof body.workspaceId !== 'string' || !UUID_RE.test(body.workspaceId)) throw new WorkspaceError(404, 'WORKSPACE_NOT_FOUND', 'Workspace not found');
      const ctx = await ctxFor(user, body.workspaceId); // non-member → 404, never joins
      const next = await update(uid, row, (r) => ({ company_workspace_id: ctx.workspace.is_personal ? null : ctx.id, step: later(r.step, 'team') }));
      return view(next);
    }
    if (mode !== 'create') throw new WorkspaceError(400, 'BAD_REQUEST', "mode must be 'create', 'existing' or 'personal'");

    // Idempotent: an existing company workspace the user still owns is reused.
    if (row.company_workspace_id) {
      try {
        const ctx = await ctxFor(user, row.company_workspace_id);
        if (ctx.role === 'owner') return view(row, { workspaceCreated: false });
      } catch (err) { if (!(err instanceof WorkspaceError)) throw err; }
    }
    const ws = await workspaceService.createWorkspace(user, { name: body.name });
    let next;
    try {
      next = await update(uid, row, (r) => (r.company_workspace_id && r.company_workspace_id !== row.company_workspace_id
        ? null // a concurrent request already created one
        : { company_workspace_id: ws.id, step: later(r.step, 'team') }));
    } catch (err) {
      await discardWorkspace(user, ws.id);
      throw err;
    }
    if (next.company_workspace_id !== ws.id) {
      await discardWorkspace(user, ws.id);
      return view(next, { workspaceCreated: false });
    }
    audit(uid, 'onboarding_workspace_created', { workspaceId: ws.id }, ws.id);
    return view(next, { workspaceCreated: true });
  }

  async function discardWorkspace(user, id) {
    try { await workspaceService.deleteWorkspace(await ctxFor(user, id)); } catch (err) {
      logger.warn?.(`[onboarding] could not remove duplicate workspace (${err.code || err.name})`);
    }
  }

  /** body: { invites: [{ email, role }] } or { skip: true }. Layer 1 enforces who may invite whom. */
  async function inviteTeam(user, body = {}) {
    const { uid, row } = await load(user);
    if (body.skip === true) {
      const next = await update(uid, row, (r) => ({ invites_skipped: true, step: later(r.step, 'use_case') }));
      return view(next, { invitations: [] });
    }
    const invites = Array.isArray(body.invites) ? body.invites : null;
    if (!invites || !invites.length || invites.length > MAX_INVITES) throw new WorkspaceError(400, 'BAD_REQUEST', `invites must be 1-${MAX_INVITES} entries`);
    if (!row.company_workspace_id) throw new WorkspaceError(409, 'PERSONAL_WORKSPACE', 'Teammates can only be invited to a company workspace.');
    const ctx = await workspaceCtx(user, row);
    const out = [];
    for (const inv of invites) {
      const email = inv && typeof inv.email === 'string' ? inv.email : '';
      const role = inv && inv.role === 'admin' ? 'admin' : 'member';
      try {
        const r = await workspaceService.createInvitation(ctx, { email, role }); // role rules + member limit
        out.push({ email: r.invitation.email, role: r.invitation.role, status: 'invited', token: r.token, expiresAt: r.invitation.expires_at });
      } catch (err) {
        if (!(err instanceof WorkspaceError)) throw err;
        out.push({ email, role, status: 'failed', code: err.code, error: err.message });
      }
    }
    const sent = out.filter((o) => o.status === 'invited').length;
    const next = await update(uid, row, (r) => ({ invites_sent: Math.min(100, r.invites_sent + sent), step: sent ? later(r.step, 'use_case') : r.step }));
    return view(next, { invitations: out });
  }

  async function chooseUseCase(user, body = {}) {
    const { uid, row } = await load(user);
    if (typeof body.useCase !== 'string' || !Object.prototype.hasOwnProperty.call(USE_CASES, body.useCase)) {
      throw new WorkspaceError(400, 'BAD_REQUEST', `useCase must be one of ${Object.keys(USE_CASES).join(', ')}`);
    }
    const next = await update(uid, row, (r) => ({ use_case: body.useCase, step: later(r.step, 'template') }));
    const templates = templateService
      ? (await templateService.listTemplates(await workspaceCtx(user, next), { useCase: body.useCase })).filter((t) => t.onboarding && t.available)
      : [];
    return view(next, { recommendedTemplates: templates });
  }

  /** body: { templateId, name? } → first workflow (created + published by the user). */
  async function createFirstWorkflow(user, body = {}) {
    const { uid, row } = await load(user);
    if (!templateService || !workflowService) throw new WorkspaceError(404, 'TEMPLATES_DISABLED', 'Workflow templates are not enabled on this server.');
    const ctx = await workspaceCtx(user, row);
    if (row.first_workflow_id) {
      try {
        const w = await workflowService.getWorkflow(ctx, row.first_workflow_id);
        return view(row, { workflow: w, workflowCreated: false });
      } catch (err) { if (!(err instanceof WorkspaceError)) throw err; }
    }
    const created = await templateService.instantiate(ctx, body.templateId, { name: body.name, publish: true });
    const wf = created.workflow;
    const next = await update(uid, row, (r) => (r.first_workflow_id && r.first_workflow_id !== row.first_workflow_id
      ? null
      : { first_workflow_id: wf.id, template_id: created.templateId, step: later(r.step, 'first_run') }));
    if (next.first_workflow_id !== wf.id) {
      try { await workflowService.archiveWorkflow(ctx, wf.id); } catch { /* best effort */ }
      return view(next, { workflowCreated: false });
    }
    audit(uid, 'onboarding_workflow_created', { workspaceId: ctx.id, workflowId: wf.id, templateId: created.templateId }, ctx.id);
    return view(next, { workflow: wf, workflowCreated: true });
  }

  /** body: { inputs } → the first run (Layer 4 idempotency key: never twice). */
  async function runFirstTask(user, body = {}) {
    const { uid, row } = await load(user);
    if (!workflowService) throw new WorkspaceError(404, 'WORKFLOWS_DISABLED', 'Workflows are not enabled on this server.');
    if (!row.first_workflow_id) throw new WorkspaceError(409, 'ONBOARDING_NO_WORKFLOW', 'Create your first workflow first.');
    const ctx = await workspaceCtx(user, row);
    if (row.first_run_id) {
      // Already started: return that run — never a second one (whatever inputs are sent now).
      try { return view(row, { run: await workflowService.getRun(ctx, row.first_run_id), replayed: true }); } catch (err) { if (!(err instanceof WorkspaceError)) throw err; }
    }
    const key = `onboarding:${row.first_workflow_id}`;
    const { run, replayed } = await workflowService.startRun(ctx, row.first_workflow_id, { inputs: body.inputs || {} }, { idempotencyKey: key });
    const next = await update(uid, row, (r) => ({ first_run_id: run.id, step: 'done', completed_at: r.completed_at || new Date().toISOString() }));
    if (!replayed) audit(uid, 'onboarding_first_run', { workspaceId: ctx.id, runId: run.id }, ctx.id);
    return view(next, { run, replayed });
  }

  /** Skip / finish at any point. */
  async function complete(user) {
    requireEnabled();
    const uid = uidOf(user);
    let row = await store.getOnboarding(uid);
    if (!row) {
      const personal = await workspaceService.ensurePersonalWorkspace(uid);
      row = (await store.insertOnboarding({ user_id: uid, step: 'workspace', personal_workspace_id: personal.id })) || await store.getOnboarding(uid);
    }
    const next = await update(uid, row, (r) => (r.completed_at ? null : { completed_at: new Date().toISOString(), step: 'done' }));
    return view(next, { required: false });
  }

  return { getState, start, chooseWorkspace, inviteTeam, chooseUseCase, createFirstWorkflow, runFirstTask, complete, STEPS };
}

module.exports = { createOnboardingService, STEPS };
