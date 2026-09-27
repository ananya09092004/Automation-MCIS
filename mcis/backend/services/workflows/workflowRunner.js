/**
 * Layer 4 — durable workflow runner (PostgreSQL-backed jobs + leases).
 *
 * One `workflow_jobs` row per run. A worker claims a job atomically
 * (claim_workflow_job: FOR UPDATE SKIP LOCKED), holds a lease that it
 * extends with heartbeats while it drives the run, and releases the job
 * when the run finishes, pauses for human review, or must be retried.
 * If a worker dies, its lease expires and the job is claimed again
 * (a "recovery", bounded by max_recoveries).
 *
 * Every workflow step is executed by the EXISTING Layer 3 engine
 * (executionService.createExecution): planning, risk tiers, approvals,
 * per-action retry/diagnose/replan, verification and evidence all come
 * from Layer 3. This runner only sequences steps, renders their
 * instruction from the run's (redacted) inputs and earlier outputs, and
 * decides — conservatively — whether a failed or interrupted step may be
 * repeated:
 *
 *   A step is re-run automatically ONLY if its failure code is transient
 *   AND nothing it did could have changed state: every recorded action
 *   and the action that was in flight (agent_executions.inflight) is a
 *   read-only / navigation action (SAFE_TO_REPEAT_ACTIONS) and no
 *   human-approved action was attempted. Otherwise the run is paused as
 *   `needs_review` and a human decides (retry / skip / fail).
 *
 * Duplicate protection: job lease (one driver per run), per-attempt
 * idempotency key on the Layer 3 execution (`wfrun:<run>:<pos>:<attempt>`),
 * unique (run_id, position), unique execution_id, the step attempt number
 * persisted BEFORE the execution is created, and Layer 3's one-active-
 * execution-per-workspace index.
 *
 * Layer 6 multi-instance safety: every claim increments the job's
 * lease_fence (fencing token). Heartbeats, releases and the consequential
 * transitions (start an attempt, settle a step) only succeed for the
 * current owner AND fence, so a stale worker that lost its lease — even
 * one that re-claimed under the same worker id — cannot write a decision.
 * Layer 3 executions carry their own ownership lease (see executionService).
 *
 * Layer 6 structured outputs: a step's declared typed outputs are
 * validated (validateStructuredOutputs) before a later step can use them;
 * outputs whose content shows prompt-injection signals TAINT every later
 * step that references them (non-read actions then need approval).
 * See docs/LAYER4_WORKFLOWS.md and docs/LAYER6_SECURITY.md.
 */
'use strict';

const crypto = require('crypto');
// Layer 6: sensitive-data classifier (superset of sensitiveDataFilter).
const { sanitize, sanitizeString } = require('../security/sensitiveClassifier');

const redact = (v, o) => sanitize(v, o);
const redactString = (v, max) => sanitizeString(v, max);
const { hasRole } = require('../workspaceService');
const { render, renderValue, parseTemplate, validateStructuredOutputs, LIMITS } = require('./definition');
const classifier = require('../security/sensitiveClassifier');

const DEFAULTS = Object.freeze({
  leaseSeconds: 60,
  heartbeatMs: 15000,
  idlePollMs: 2000,
  execPollMs: 500,
  maxConcurrent: 5,
  schedulerIntervalMs: 30000,
  busyRetryMs: 5000,
  busyMaxWaitMs: 10 * 60 * 1000,
  maxJobAttempts: 50,
  sweepAgeMs: 60 * 1000,
  stopTimeoutMs: 10000,
});

const RUN_TERMINAL = new Set(['completed', 'failed', 'cancelled']);
const EXEC_ACTIVE = new Set(['created', 'planning', 'waiting_approval', 'executing', 'verifying']);
// Layer 3 failure codes for which another attempt may help (if safe).
const RETRYABLE = new Set([
  'TOOL_FAILURE', 'TIMEOUT', 'BROWSER_FAILURE', 'INVALID_RESULT', 'MISSING_DATA', 'PLANNER_ERROR',
  'EXECUTION_TIMEOUT', 'MAX_STEPS', 'SERVER_RESTART', 'ENGINE_ERROR', 'INVALID_STEP',
]);
// Evidence rows for actions that were never sent to the executor.
// Layer 6: POLICY_DENIED / STALE_APPROVAL rows are firewall denials (never sent).
// Layer 7: QUOTA_EXCEEDED rows are plan-limit denials (never sent either).
const NOT_EXECUTED = new Set(['INVALID_STEP', 'APPROVAL_REQUIRED', 'POLICY_DENIED', 'STALE_APPROVAL', 'QUOTA_EXCEEDED']);

class StopDriving extends Error {
  constructor(reason) { super(reason); this.name = 'StopDriving'; this.reason = reason; }
}

function deterministicUuid(seed) {
  const h = crypto.createHash('sha256').update(seed).digest('hex');
  const variant = ((parseInt(h[16], 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

function createWorkflowRunner({
  store, service, dataStore, executionService, execStore, appendAuditLog, getMemberRole,
  safeToRepeatActions, logger = console, options = {}, securityEvents = null, workerHealth = null,
} = {}) {
  if (!store || !executionService || !execStore) throw new Error('workflow runner: store, executionService and execStore are required');
  const opt = { ...DEFAULTS, ...options };
  const now = opt.now || (() => new Date());
  const workerId = opt.workerId || `wf_${executionService.runnerId || crypto.randomBytes(8).toString('hex')}`;
  const SAFE = new Set(safeToRepeatActions || require('../../backend-routing/intentRouter').SAFE_TO_REPEAT_ACTIONS);

  const active = new Map(); // jobId -> ctl
  const cancelSignals = new Set();
  let running = false;
  let ticking = false;
  let tickAgain = false;
  let idleTimer = null;
  let schedTimer = null;
  let lastClaimErrorLog = 0;
  let healthTimer = null;
  // Layer 9: worker liveness for operations (never blocks or breaks the worker).
  const beat = () => {
    if (!workerHealth) return;
    try { Promise.resolve(workerHealth.beat({ workerId, kind: 'workflow', runningJobs: active.size })).catch(() => {}); } catch { /* never */ }
  };

  const sleep = (ms) => new Promise((r) => { const t = setTimeout(r, ms); if (t.unref) t.unref(); });
  const iso = () => now().toISOString();

  const audit = (userId, action, payload, workspaceId, success = true, error = null) => {
    if (!appendAuditLog) return;
    try {
      Promise.resolve(appendAuditLog(userId, action, redact(payload), { success, error }, workspaceId)).catch(() => {});
    } catch { /* never break the runner on audit failure */ }
  };

  // Layer 6: steps of an API-key-triggered run act with at most MEMBER rights.
  // Layer 10: run lifecycle listeners (webhooks, QA) and review notifications.
  const runListeners = [];
  let onReviewRequested = null;
  const notifyRun = (run) => { for (const fn of runListeners) { try { Promise.resolve(fn(run)).catch(() => {}); } catch { /* never */ } } };
  const sysCtx = (run) => ({ workspace: { id: run.workspace_id }, role: null, userId: run.initiated_by, ...(run.trigger === 'api' ? { apiKeyId: 'api-trigger' } : {}) });
  const secEvent = (ws, actor, type, payload, extra) => { try { if (securityEvents) securityEvents.record(ws, actor, type, payload, extra); } catch { /* never */ } };

  // ------------------------------------------------------------------
  // Compare-and-set helpers
  // ------------------------------------------------------------------
  async function patchRun(ws, id, patchFn) {
    for (let i = 0; i < 6; i++) {
      const cur = await store.getRun(ws, id);
      if (!cur) return null;
      const patch = typeof patchFn === 'function' ? patchFn(cur) : patchFn;
      if (!patch) return cur;
      const updated = await store.updateRun(ws, id, cur.version, patch);
      if (updated) return updated;
    }
    throw new Error('workflow run update conflict');
  }

  async function getStep(ws, runId, position) {
    return (await store.listRunSteps(ws, runId)).find((s) => s.position === position) || null;
  }

  async function patchStep(ws, runId, position, patchFn) {
    for (let i = 0; i < 6; i++) {
      const cur = await getStep(ws, runId, position);
      if (!cur) return null;
      const patch = typeof patchFn === 'function' ? patchFn(cur) : patchFn;
      if (!patch) return cur;
      const updated = await store.updateRunStep(ws, cur.id, cur.version, patch);
      if (updated) return updated;
    }
    throw new Error('workflow step update conflict');
  }

  // ------------------------------------------------------------------
  // Task (Layer 2) integration
  // ------------------------------------------------------------------
  async function setTaskStatus(run, status, note) {
    if (!dataStore || !run || !run.task_id) return;
    try {
      for (let i = 0; i < 4; i++) {
        const t = await dataStore.getTask(run.workspace_id, run.task_id);
        if (!t || t.status === status) return;
        if ((t.status === 'done' || t.status === 'cancelled') && status !== 'in_progress') return;
        const updated = await dataStore.updateTask(run.workspace_id, t.id, t.version, {
          status, completed_at: status === 'done' ? iso() : null,
        });
        if (updated) {
          await dataStore.insertActivity({
            id: crypto.randomUUID(), task_id: t.id, workspace_id: t.workspace_id, actor_id: run.initiated_by,
            kind: 'status_changed', body: null, data: redact({ from: t.status, to: status, workflowRunId: run.id, note: note || null }),
          });
          return;
        }
      }
    } catch (err) {
      logger.warn?.(`[workflowRunner] task status update failed: ${err.message}`);
    }
  }

  async function ensureTask(run, version) {
    const ws = run.workspace_id;
    if (!dataStore) return run;
    if (run.task_id) {
      await setTaskStatus(run, 'in_progress');
      return run;
    }
    // Deterministic id → a recovery can never create a second task.
    const id = deterministicUuid(`workflow-run-task:${run.id}`);
    let task = await dataStore.getTask(ws, id);
    if (!task) {
      try {
        task = await dataStore.insertTask({
          id,
          workspace_id: ws,
          title: redactString(`Workflow: ${version.name}`, 200).slice(0, 200),
          description: `Automated run of workflow version ${version.version_number} (run ${run.id}).`,
          priority: 'medium',
          status: 'in_progress',
          created_by: run.initiated_by,
          assignee_type: 'agent',
          assignee_user_id: null,
        });
        await dataStore.insertActivity({
          id: crypto.randomUUID(), task_id: id, workspace_id: ws, actor_id: run.initiated_by,
          kind: 'created', body: null, data: { workflowRunId: run.id, workflowId: run.workflow_id, version: run.version_number },
        });
      } catch (err) {
        if (err.code !== '23505') throw err;
        task = await dataStore.getTask(ws, id);
        if (!task) throw err;
      }
    }
    return patchRun(ws, run.id, (cur) => (cur.task_id ? null : { task_id: id }));
  }

  // ------------------------------------------------------------------
  // Finalization (also used by the service for idle runs)
  // ------------------------------------------------------------------
  async function closeOpenSteps(ws, runId, status) {
    for (const s of await store.listRunSteps(ws, runId)) {
      if (['pending', 'running', 'waiting_approval'].includes(s.status)) {
        await store.updateRunStep(ws, s.id, s.version, { status, finished_at: iso() }).catch(() => null);
      }
    }
  }

  async function finalizeCancelled(ws, runId, message = 'Cancelled.', code = 'CANCELLED') {
    // Close open steps BEFORE the run turns terminal, so a reader never
    // sees a finished run with steps still pending.
    const before = await store.getRun(ws, runId);
    if (!before || RUN_TERMINAL.has(before.status)) return before;
    await closeOpenSteps(ws, runId, 'cancelled');
    const run = await patchRun(ws, runId, (cur) => (RUN_TERMINAL.has(cur.status) ? null : {
      status: 'cancelled', finished_at: iso(), failure_code: code, failure_message: redactString(message, 500),
    }));
    if (!run) return null;
    if (run.status === 'cancelled' && run.failure_code === code) {
      await setTaskStatus(run, 'cancelled', message);
      audit(run.initiated_by, 'workflow_run_cancelled', { workspaceId: ws, runId, code }, ws);
      notifyRun(run);
    }
    cancelSignals.delete(runId);
    return run;
  }

  async function finalizeFailed(ws, runId, code, message) {
    const before = await store.getRun(ws, runId);
    if (!before || RUN_TERMINAL.has(before.status)) return before;
    await closeOpenSteps(ws, runId, 'cancelled');
    const run = await patchRun(ws, runId, (cur) => (RUN_TERMINAL.has(cur.status) ? null : {
      status: 'failed', finished_at: iso(), failure_code: code, failure_message: redactString(message || code, 500),
    }));
    if (!run) return null;
    if (run.status === 'failed' && run.failure_code === code) {
      await setTaskStatus(run, 'blocked', `Workflow run failed: ${code}`);
      audit(run.initiated_by, 'workflow_run_failed', { workspaceId: ws, runId, code }, ws, false, redactString(message || code, 200));
      notifyRun(run);
    }
    return run;
  }

  async function completeRun(run) {
    const ws = run.workspace_id;
    const steps = await store.listRunSteps(ws, run.id);
    const succeeded = steps.filter((s) => s.status === 'succeeded');
    const skipped = steps.filter((s) => s.status === 'skipped');
    const vs = (st) => succeeded.filter((s) => s.verification && s.verification.status === st).length;
    const summary = {
      steps: steps.length, succeeded: succeeded.length, skipped: skipped.length,
      verified: vs('verified'), notApplicable: vs('not_applicable'), unverified: vs('unverified'),
    };
    let status;
    if (skipped.length || summary.unverified) status = 'partially_verified';
    else if (summary.verified) status = 'verified';
    else status = 'not_applicable';
    const last = succeeded.length ? succeeded[succeeded.length - 1] : null;
    const done = await patchRun(ws, run.id, (cur) => (RUN_TERMINAL.has(cur.status) ? null : {
      status: 'completed',
      finished_at: iso(),
      result: redact({ message: `Completed ${succeeded.length} of ${steps.length} step(s).`, lastOutput: last && last.output ? last.output.message || null : null }),
      verification: { status, ...summary },
    }));
    if (done && done.status === 'completed') {
      await setTaskStatus(done, 'done');
      audit(done.initiated_by, 'workflow_run_completed', { workspaceId: ws, runId: run.id, verification: status }, ws);
      notifyRun(done);
    }
    return done;
  }

  // ------------------------------------------------------------------
  // Step execution
  // ------------------------------------------------------------------
  /** Earlier steps' text outputs, validated structured outputs and taint. */
  function templateCtx(run, pos, steps) {
    const stepOutputs = {};
    const structured = {};
    const tainted = new Set();
    for (const s of steps) {
      if (s.position < pos && s.status === 'succeeded' && s.output) {
        if (typeof s.output.message === 'string') stepOutputs[s.step_key] = s.output.message;
        if (s.output.outputs && typeof s.output.outputs === 'object') structured[s.step_key] = s.output.outputs;
        if (s.output.tainted) tainted.add(s.step_key);
      }
    }
    return { inputs: run.inputs || {}, stepOutputs, structured, taintedKeys: tainted };
  }

  /** Does this step's text reference an earlier TAINTED step's output? */
  function stepTainted(sdef, ctx) {
    if (!ctx.taintedKeys.size) return false;
    const texts = [sdef.instruction, sdef.expectedOutput || ''];
    if (sdef.connector) {
      for (const v of Object.values(sdef.connector.input || {})) {
        if (typeof v === 'string') texts.push(v);
        else if (v && typeof v === 'object') for (const vv of Object.values(v)) if (typeof vv === 'string') texts.push(vv); // Layer 10 nested inputs
      }
    }
    return texts.some((t) => parseTemplate(t, 'template').some((r) => r.kind === 'step' && ctx.taintedKeys.has(r.key)));
  }

  function buildGoal(run, def, pos, steps) {
    const sdef = def.steps[pos];
    const ctx = templateCtx(run, pos, steps);
    let goal = render(sdef.instruction, ctx);
    if (sdef.expectedOutput) goal += `\n\nExpected result: ${render(sdef.expectedOutput, ctx)}`;
    return goal.slice(0, LIMITS.renderedGoal);
  }

  function renderConnector(connector, run, pos, steps) {
    const ctx = templateCtx(run, pos, steps);
    const input = {};
    for (const [k, v] of Object.entries(connector.input || {})) {
      if (typeof v === 'string') input[k] = renderValue(v, ctx);
      else if (v && typeof v === 'object' && !Array.isArray(v)) {
        // Layer 10: one level of named values (POST body, query, headers).
        input[k] = {};
        for (const [kk, vv] of Object.entries(v)) input[k][kk] = typeof vv === 'string' ? renderValue(vv, ctx) : vv;
      } else input[k] = v;
    }
    return { integrationId: connector.integrationId, action: connector.action, input };
  }

  /** Layer 6: extract + validate a finished step's declared structured outputs. */
  async function structuredOutputs(ws, sdef, exec, message) {
    if (!sdef.outputs || !sdef.outputs.length) return { ok: true, values: null, tainted: false };
    let source;
    if (sdef.connector) {
      const evidence = await execStore.listSteps(ws, exec.id);
      const last = [...evidence].reverse().find((e) => e.status === 'succeeded');
      source = last && last.output ? last.output.data : null;
    } else {
      source = { summary: message };
    }
    const r = validateStructuredOutputs(sdef.outputs, source, classifier);
    return { ...r, tainted: !!r.suspicious };
  }

  async function isSafeToRetry(ws, exec) {
    const [steps, approvals] = await Promise.all([execStore.listSteps(ws, exec.id), execStore.listApprovals(ws, exec.id)]);
    if (approvals.some((a) => a.status === 'approved')) {
      return { safe: false, reason: 'A human-approved action was already attempted in this step.' };
    }
    const unsafe = steps.find((s) => !NOT_EXECUTED.has(s.error_code) && !SAFE.has(s.action));
    if (unsafe) {
      return { safe: false, reason: `Action "${unsafe.action}" (step ${unsafe.step_index}) may already have changed state.` };
    }
    const f = exec.inflight;
    if (f && !steps.some((s) => s.step_index === f.stepIndex) && !SAFE.has(f.action)) {
      return { safe: false, reason: `Action "${f.action}" was in flight when the execution was interrupted; its outcome is unknown.` };
    }
    return { safe: true };
  }

  const manualRetries = (step) => (step.attempts || []).filter((a) => a.resolution === 'retry_step').length;

  function assertDriving(ctl) {
    if (ctl.lost) throw new StopDriving('lease_lost');
    if (ctl.stopping) throw new StopDriving('stopping');
  }

  // Fencing for the rare, consequential transitions (starting an attempt,
  // settling a step): re-read the job and make sure THIS worker still owns
  // the lease, so a worker that lost its lease can never write a decision.
  async function assertLeaseHeld(ctl) {
    assertDriving(ctl);
    const job = await store.getJobByRun(ctl.job.workspace_id, ctl.job.run_id);
    if (!job || job.status !== 'running' || job.lease_owner !== workerId || Number(job.lease_fence || 0) !== Number(ctl.job.lease_fence || 0)) {
      ctl.lost = true;
      secEvent(ctl.job.workspace_id, 'system', 'worker_fenced', {
        runId: ctl.job.run_id, workerId, fence: Number(ctl.job.lease_fence || 0), currentFence: job ? Number(job.lease_fence || 0) : null,
      }, { success: false });
      throw new StopDriving('lease_lost');
    }
  }

  async function cancelRequested(run) {
    if (cancelSignals.has(run.id)) return true;
    const cur = await store.getRun(run.workspace_id, run.id);
    return !cur || !!cur.cancel_requested;
  }

  async function failStep(ws, runId, pos, code, message, attempts) {
    await patchStep(ws, runId, pos, (cur) => ({
      status: 'failed', error_code: code, error_message: redactString(message || code, 500), finished_at: iso(),
      ...(attempts ? { attempts } : {}),
      execution_id: cur.execution_id,
    }));
  }

  /**
   * Drives ONE attempt of the step at `pos` to a decision.
   * Returns 'advance' | 'retry' | 'paused' | 'failed' | 'cancelled' | { cancelled: code }.
   */
  async function runStep(ctl, run, def, pos) {
    const ws = run.workspace_id;
    const sdef = def.steps[pos];
    let step = await getStep(ws, run.id, pos);
    // Layer 10: a human review step pauses the run until a reviewer decides
    // (workflowService.resolveRun approve / reject). Nothing is executed.
    if (sdef.type === 'review') {
      await assertLeaseHeld(ctl);
      await patchStep(ws, run.id, pos, {
        status: 'needs_review', attempt: Math.max(1, step.attempt), started_at: step.started_at || iso(),
        error_code: 'HUMAN_REVIEW', error_message: redactString(`Waiting for human review: ${sdef.instruction}`, 500),
      });
      await patchRun(ws, run.id, (cur) => (RUN_TERMINAL.has(cur.status) ? null : { status: 'needs_review', review_reason: redactString(`Human review: ${sdef.name}`, 500) }));
      audit(run.initiated_by, 'workflow_run_needs_review', { workspaceId: ws, runId: run.id, position: pos, code: 'HUMAN_REVIEW' }, ws);
      if (onReviewRequested) { try { await onReviewRequested({ run, position: pos, step: sdef }); } catch { /* never */ } }
      return 'paused';
    }
    let exec = step.execution_id ? await execStore.getExecution(ws, step.execution_id) : null;

    if (!exec) {
      let attempt = step.attempt;
      await assertLeaseHeld(ctl);
      if (step.status === 'pending' || attempt === 0) {
        attempt = step.attempt + 1;
        const allowed = 1 + sdef.retry.maxAttempts + manualRetries(step);
        if (attempt > allowed) {
          await failStep(ws, run.id, pos, step.error_code || 'ATTEMPTS_EXHAUSTED', step.error_message || 'No attempts left for this step.');
          return 'failed';
        }
        // Persist the attempt number BEFORE creating the execution: a crash
        // after this point reuses the same idempotency key (no duplicate).
        step = await patchStep(ws, run.id, pos, {
          status: 'running', attempt, started_at: step.started_at || iso(), error_code: null, error_message: null,
        });
      }
      const stepsNow = await store.listRunSteps(ws, run.id);
      const goal = buildGoal(run, def, pos, stepsNow);
      const tainted = stepTainted(sdef, templateCtx(run, pos, stepsNow));
      const key = `wfrun:${run.id}:${pos}:${attempt}`;
      const waitUntil = now().getTime() + opt.busyMaxWaitMs;
      let started = null;
      while (!started) {
        assertDriving(ctl);
        if (await cancelRequested(run)) return 'cancelled';
        try {
          started = await executionService.createExecution(sysCtx(run), {
            goal, idempotencyKey: key, taskId: run.task_id || null, approvalPolicy: sdef.approval, trackInflight: true,
            ...(sdef.agentId ? { agentId: sdef.agentId } : {}), // Layer 10: AI workforce agent
            // Layer 6: bound into every approval of this execution.
            workflowContext: { runId: run.id, versionId: run.workflow_version_id, position: pos, tainted },
            // Layer 5: a connector step runs ONE integration action through
            // the same Layer 3 lifecycle. Only references + rendered (redacted)
            // input travel here; the credential is resolved inside the gateway.
            // The idempotency key is stable across attempts of this step.
            ...(sdef.connector ? { connectorStep: { ...renderConnector(sdef.connector, run, pos, await store.listRunSteps(ws, run.id)), idempotencyKey: `wfstep:${run.id}:${pos}` } } : {}),
          });
        } catch (err) {
          if (err.code === 'EXECUTION_IN_PROGRESS' && now().getTime() < waitUntil) {
            await sleep(opt.busyRetryMs);
            continue;
          }
          if (err.code === 'EXECUTION_IN_PROGRESS') {
            await failStep(ws, run.id, pos, 'WORKSPACE_BUSY', 'Another execution kept the workspace busy for too long.');
            return 'failed';
          }
          if (err.code === 'EMERGENCY_STOP_ACTIVE') return { cancelled: 'EMERGENCY_STOP' };
          if (err.status && err.status < 500) {
            await failStep(ws, run.id, pos, err.code || 'STEP_START_FAILED', err.message);
            return 'failed';
          }
          throw err;
        }
      }
      const execId = started.execution.id;
      step = await patchStep(ws, run.id, pos, (cur) => (cur.execution_id === execId ? null : { execution_id: execId }));
      if (!started.replayed && dataStore && run.task_id) {
        await dataStore.insertActivity({
          id: crypto.randomUUID(), task_id: run.task_id, workspace_id: ws, actor_id: run.initiated_by,
          kind: 'execution_started', body: null, data: { executionId: execId, workflowRunId: run.id, step: sdef.key, attempt },
        }).catch(() => {});
      }
      exec = await execStore.getExecution(ws, execId);
    }

    // ---------------- wait for the Layer 3 execution ----------------
    const stepDeadline = Date.parse(exec.created_at) + sdef.timeoutMinutes * 60000;
    const runDeadline = run.deadline_at ? Date.parse(run.deadline_at) : Infinity;
    while (EXEC_ACTIVE.has(exec.status)) {
      if (!executionService.hasRuntime(exec.id)) {
        // Runtime is gone (process restarted): Layer 3 reconciles it to
        // FAILED(SERVER_RESTART); its evidence and in-flight marker stay.
        await executionService.getExecution(sysCtx(run), exec.id).catch(() => null);
        const after = await execStore.getExecution(ws, exec.id);
        if (after && EXEC_ACTIVE.has(after.status)) await sleep(opt.execPollMs);
        exec = after;
        continue;
      }
      assertDriving(ctl);
      const t = now().getTime();
      if (await cancelRequested(run)) {
        await executionService.abortExecution(ws, exec.id, { status: 'cancelled', code: 'CANCELLED', message: 'Workflow run cancelled.' });
      } else if (t > runDeadline) {
        await executionService.abortExecution(ws, exec.id, { status: 'failed', code: 'RUN_TIMEOUT', message: 'Workflow run exceeded its time limit.' });
      } else if (t > stepDeadline) {
        await executionService.abortExecution(ws, exec.id, { status: 'failed', code: 'STEP_TIMEOUT', message: 'Workflow step exceeded its time limit.' });
      } else if (exec.status === 'waiting_approval') {
        if (step.status !== 'waiting_approval') step = await patchStep(ws, run.id, pos, { status: 'waiting_approval' });
        await patchRun(ws, run.id, (cur) => (cur.status === 'running' ? { status: 'waiting_approval' } : null));
        if (exec.pending_approval_id) {
          const a = await execStore.getApproval(ws, exec.id, exec.pending_approval_id);
          if (a && a.status === 'pending' && Date.parse(a.expires_at) <= t) {
            await execStore.transitionApproval(ws, a.id, 'pending', { status: 'expired', decided_at: iso() });
            await executionService.abortExecution(ws, exec.id, {
              status: 'failed', code: 'APPROVAL_EXPIRED', message: 'The approval request expired before a decision was made.',
            });
          }
        }
      } else {
        if (step.status === 'waiting_approval') step = await patchStep(ws, run.id, pos, { status: 'running' });
        await patchRun(ws, run.id, (cur) => (cur.status === 'waiting_approval' ? { status: 'running' } : null));
      }
      const fresh = await execStore.getExecution(ws, exec.id);
      if (fresh && EXEC_ACTIVE.has(fresh.status)) await sleep(opt.execPollMs);
      exec = (await execStore.getExecution(ws, exec.id)) || fresh;
    }
    return settleStep(ctl, run, def, pos, exec);
  }

  async function settleStep(ctl, run, def, pos, exec) {
    await assertLeaseHeld(ctl);
    const ws = run.workspace_id;
    const sdef = def.steps[pos];
    const step = await getStep(ws, run.id, pos);
    const attempts = [
      ...(step.attempts || []).filter((a) => a.executionId !== exec.id),
      { attempt: step.attempt, executionId: exec.id, status: exec.status, failureCode: exec.failure_code || null, at: iso() },
    ];
    await patchRun(ws, run.id, (cur) => (cur.status === 'waiting_approval' ? { status: 'running' } : null));

    if (exec.status === 'completed') {
      const v = (exec.verification && exec.verification.status) || 'unverified';
      if (sdef.verification === 'required' && v !== 'verified') {
        await failStep(ws, run.id, pos, 'VERIFICATION_REQUIRED',
          `Step "${sdef.key}" requires verified evidence but its execution ended "${v}".`, attempts);
        return 'failed';
      }
      const message = exec.result && exec.result.message ? redactString(String(exec.result.message), LIMITS.stepOutput) : '';
      const so = await structuredOutputs(ws, sdef, exec, message);
      if (!so.ok) {
        secEvent(ws, run.initiated_by, 'structured_output_rejected', { runId: run.id, position: pos, step: sdef.key, error: so.error }, { success: false });
        await failStep(ws, run.id, pos, 'OUTPUT_INVALID', `Step "${sdef.key}" produced invalid structured output: ${so.error}`, attempts);
        return 'failed';
      }
      if (so.redacted) secEvent(ws, run.initiated_by, 'sensitive_data_blocked', { runId: run.id, position: pos, step: sdef.key, where: 'structured_output' });
      if (so.tainted) secEvent(ws, run.initiated_by, 'suspicious_tool_injection', { runId: run.id, position: pos, step: sdef.key, where: 'structured_output' });
      await patchStep(ws, run.id, pos, {
        status: 'succeeded',
        output: { message, ...(so.values ? { outputs: so.values } : {}), ...(so.tainted ? { tainted: true } : {}) },
        verification: redact({ status: v, note: exec.verification ? exec.verification.note || null : null }),
        attempts,
        error_code: null,
        error_message: null,
        finished_at: iso(),
      });
      await patchRun(ws, run.id, (cur) => (cur.current_step === pos ? { current_step: pos + 1 } : null));
      return 'advance';
    }

    // failed / cancelled
    if (await cancelRequested(run)) {
      await patchStep(ws, run.id, pos, { status: 'cancelled', attempts, finished_at: iso() });
      return 'cancelled';
    }
    const code = exec.failure_code || 'STEP_FAILED';
    if (exec.status === 'cancelled') {
      await patchStep(ws, run.id, pos, { status: 'cancelled', attempts, error_code: code, error_message: exec.failure_message, finished_at: iso() });
      return { cancelled: code };
    }
    if (!RETRYABLE.has(code)) {
      await failStep(ws, run.id, pos, code, exec.failure_message, attempts);
      return 'failed';
    }
    const allowed = 1 + sdef.retry.maxAttempts + manualRetries(step);
    const safety = await isSafeToRetry(ws, exec);
    if (!safety.safe) {
      await patchStep(ws, run.id, pos, {
        status: 'needs_review', attempts, error_code: code,
        error_message: redactString(`${exec.failure_message || code} — ${safety.reason}`, 500),
      });
      await patchRun(ws, run.id, (cur) => (RUN_TERMINAL.has(cur.status) ? null : {
        status: 'needs_review', review_reason: redactString(safety.reason, 500),
      }));
      audit(run.initiated_by, 'workflow_run_needs_review', { workspaceId: ws, runId: run.id, position: pos, code }, ws);
      return 'paused';
    }
    if (step.attempt >= allowed) {
      await failStep(ws, run.id, pos, code, exec.failure_message, attempts);
      return 'failed';
    }
    await patchStep(ws, run.id, pos, {
      status: 'pending', execution_id: null, attempts, error_code: code, error_message: exec.failure_message,
    });
    audit(run.initiated_by, 'workflow_step_retry', { workspaceId: ws, runId: run.id, position: pos, code, attempt: step.attempt + 1 }, ws);
    return 'retry';
  }

  // ------------------------------------------------------------------
  // Run driver
  // ------------------------------------------------------------------
  async function drive(job, ctl) {
    const ws = job.workspace_id;
    let run = await store.getRun(ws, job.run_id);
    if (!run) return { status: 'failed', error: 'run not found' };
    if (RUN_TERMINAL.has(run.status)) return { status: run.status === 'completed' ? 'completed' : run.status === 'cancelled' ? 'cancelled' : 'failed' };
    if (run.status === 'needs_review') return { status: 'paused' };
    if (job.recoveries > job.max_recoveries) {
      await finalizeFailed(ws, run.id, 'RECOVERY_EXHAUSTED', `The run was interrupted ${job.recoveries} times; giving up.`);
      return { status: 'failed', error: 'recovery limit reached' };
    }
    if (job.recoveries > 0 && ['running', 'waiting_approval'].includes(run.status)) {
      audit(run.initiated_by, 'workflow_run_recovered', { workspaceId: ws, runId: run.id, recoveries: job.recoveries, step: run.current_step }, ws);
    }
    if (await cancelRequested(run)) {
      await finalizeCancelled(ws, run.id, 'Cancelled by a user.');
      return { status: 'cancelled' };
    }

    const version = await store.getVersion(ws, run.workflow_id, run.workflow_version_id);
    if (!version) {
      await finalizeFailed(ws, run.id, 'VERSION_MISSING', 'The workflow version for this run no longer exists.');
      return { status: 'failed' };
    }
    const def = version.definition;

    // Materialize run steps once (unique (run_id, position) prevents dupes).
    const existing = await store.listRunSteps(ws, run.id);
    const have = new Set(existing.map((s) => s.position));
    const missing = def.steps.map((s, position) => ({ s, position })).filter(({ position }) => !have.has(position));
    if (missing.length) {
      try {
        await store.insertRunSteps(missing.map(({ s, position }) => ({
          id: crypto.randomUUID(), run_id: run.id, workspace_id: ws, position, step_key: s.key, status: 'pending', attempt: 0, attempts: [],
        })));
      } catch (err) {
        if (err.code !== '23505') throw err;
      }
    }

    run = await ensureTask(run, version);
    const startedAt = run.started_at || iso();
    const deadline = run.deadline_at || new Date(Date.parse(startedAt) + def.policy.maxRunMinutes * 60000).toISOString();
    run = await patchRun(ws, run.id, (cur) => (RUN_TERMINAL.has(cur.status) ? null : {
      status: cur.status === 'waiting_approval' ? 'waiting_approval' : 'running',
      started_at: startedAt,
      deadline_at: deadline,
    }));

    for (let guard = 0; guard < def.steps.length * 12 + 12; guard++) {
      assertDriving(ctl);
      run = await store.getRun(ws, run.id);
      if (RUN_TERMINAL.has(run.status)) return { status: run.status === 'completed' ? 'completed' : run.status === 'cancelled' ? 'cancelled' : 'failed' };
      if (run.cancel_requested || cancelSignals.has(run.id)) {
        await finalizeCancelled(ws, run.id, 'Cancelled by a user.');
        return { status: 'cancelled' };
      }
      if (now().getTime() > Date.parse(run.deadline_at)) {
        await finalizeFailed(ws, run.id, 'RUN_TIMEOUT', 'Workflow run exceeded its time limit.');
        return { status: 'failed' };
      }
      const pos = run.current_step;
      if (pos >= def.steps.length) {
        await completeRun(run);
        return { status: 'completed' };
      }
      const step = await getStep(ws, run.id, pos);
      if (step.status === 'succeeded' || step.status === 'skipped') {
        await patchRun(ws, run.id, (cur) => (cur.current_step === pos ? { current_step: pos + 1 } : null));
        continue;
      }
      if (step.status === 'needs_review') {
        await patchRun(ws, run.id, (cur) => (RUN_TERMINAL.has(cur.status) ? null : { status: 'needs_review' }));
        return { status: 'paused' };
      }
      if (step.status === 'failed') {
        await finalizeFailed(ws, run.id, step.error_code || 'STEP_FAILED', `Step "${step.step_key}" failed: ${step.error_message || step.error_code}`);
        return { status: 'failed' };
      }
      if (step.status === 'cancelled') {
        await finalizeCancelled(ws, run.id, 'Step was cancelled.');
        return { status: 'cancelled' };
      }

      const res = await runStep(ctl, run, def, pos);
      if (res === 'advance' || res === 'retry') continue;
      if (res === 'paused') return { status: 'paused' };
      if (res === 'cancelled') {
        await finalizeCancelled(ws, run.id, 'Cancelled by a user.');
        return { status: 'cancelled' };
      }
      if (res && res.cancelled) {
        await finalizeCancelled(ws, run.id, res.cancelled === 'EMERGENCY_STOP' ? 'Stopped by emergency stop.' : 'The step\'s execution was cancelled.', res.cancelled);
        return { status: 'cancelled' };
      }
      // failed
      const failedStep = await getStep(ws, run.id, pos);
      await finalizeFailed(ws, run.id, failedStep.error_code || 'STEP_FAILED',
        `Step "${failedStep.step_key}" failed: ${failedStep.error_message || failedStep.error_code}`);
      return { status: 'failed' };
    }
    await finalizeFailed(ws, run.id, 'RUN_LOOP_BOUND', 'Workflow driver loop bound reached.');
    return { status: 'failed' };
  }

  async function processJob(job) {
    const ctl = { job, lost: false, stopping: false, abandoned: false, done: null };
    active.set(job.id, ctl);
    const hb = setInterval(() => {
      store.heartbeatJob(job.id, workerId, opt.leaseSeconds, job.lease_fence)
        .then((ok) => { if (!ok) ctl.lost = true; })
        .catch((err) => logger.warn?.(`[workflowRunner] heartbeat failed: ${err.message}`));
    }, opt.heartbeatMs);
    if (hb.unref) hb.unref();
    ctl.hb = hb;
    ctl.done = (async () => {
      let outcome = null;
      try {
        outcome = await drive(job, ctl);
      } catch (err) {
        if (err instanceof StopDriving) {
          outcome = err.reason === 'stopping' && !ctl.abandoned ? { status: 'queued', delaySeconds: 0, error: null } : null;
        } else {
          logger.error?.(`[workflowRunner] run ${job.run_id} error: ${err.message}`);
          const error = redactString(err.message || 'runner error', 500);
          if (job.attempts >= opt.maxJobAttempts) {
            await finalizeFailed(job.workspace_id, job.run_id, 'JOB_ATTEMPTS_EXHAUSTED', 'The workflow runner failed repeatedly.').catch(() => {});
            outcome = { status: 'failed', error };
          } else {
            outcome = { status: 'queued', delaySeconds: Math.min(60, 2 ** Math.min(job.attempts, 6)), error };
          }
        }
      } finally {
        clearInterval(hb);
      }
      if (outcome && !ctl.lost && !ctl.abandoned) {
        await store.releaseJob(job.id, workerId, { ...outcome, fence: job.lease_fence }).catch((err) => logger.error?.(`[workflowRunner] release failed: ${err.message}`));
      }
      active.delete(job.id);
      if (running) kick();
    })();
    return ctl.done;
  }

  // ------------------------------------------------------------------
  // Claim loop, scheduler, sweep
  // ------------------------------------------------------------------
  async function tick() {
    if (!running) return;
    if (ticking) { tickAgain = true; return; }
    ticking = true;
    try {
      while (running && active.size < opt.maxConcurrent) {
        const job = await store.claimJob(workerId, opt.leaseSeconds);
        if (!job) break;
        // Layer 10 fix: a claim that resolves AFTER stop() must not be driven
        // by this (stopping / crashed) instance — its execution service would
        // not own the new executions, and another instance would reconcile
        // them as SERVER_RESTART. Hand the job back (graceful) or let its
        // lease expire (abandoned, like a real crash).
        if (!running) {
          if (!stoppedAbandon) await store.releaseJob(job.id, workerId, { status: 'queued', delaySeconds: 0, error: null, fence: job.lease_fence }).catch(() => {});
          break;
        }
        processJob(job);
      }
    } catch (err) {
      // Rate-limited: a missing migration must not flood the logs.
      if (Date.now() - lastClaimErrorLog > 60000) {
        lastClaimErrorLog = Date.now();
        logger.error?.(`[workflowRunner] claim failed: ${err.message}`);
      }
    } finally {
      ticking = false;
      if (tickAgain) { tickAgain = false; setImmediate(() => tick()); }
    }
  }

  let stoppedAbandon = false;
  function kick() {
    if (running) setImmediate(() => tick());
  }

  async function schedulerTick() {
    try {
      const t = now().getTime();
      const due = await store.listDueScheduledWorkflows(new Date(t).toISOString(), 20);
      for (const w of due) {
        const slot = w.next_run_at;
        const intervalMs = w.schedule_interval_minutes * 60000;
        let next = Date.parse(slot) + intervalMs;
        if (next <= t) next = t + intervalMs; // missed slots are not back-filled
        const claimed = await store.claimScheduleSlot(w.workspace_id, w.id, slot, new Date(next).toISOString());
        if (!claimed) continue; // another scheduler took this slot
        const role = getMemberRole ? await getMemberRole(w.workspace_id, w.schedule_owner) : null;
        if (!role || !hasRole(role, 'admin')) {
          await store.updateWorkflow(w.workspace_id, w.id, claimed.revision, {
            trigger_type: 'manual', schedule_interval_minutes: null, schedule_inputs: null, schedule_owner: null, next_run_at: null,
          }).catch(() => null);
          audit(w.schedule_owner || 'system', 'workflow_schedule_disabled', { workspaceId: w.workspace_id, workflowId: w.id, reason: 'schedule owner is no longer an admin member' }, w.workspace_id, false);
          continue;
        }
        try {
          await service.createRunRecord({
            workflow: claimed, initiatedBy: w.schedule_owner, trigger: 'scheduled', inputs: w.schedule_inputs || {}, scheduledFor: slot,
          });
        } catch (err) {
          audit(w.schedule_owner, 'workflow_schedule_skipped', { workspaceId: w.workspace_id, workflowId: w.id, code: err.code || null }, w.workspace_id, false, redactString(err.message || '', 200));
        }
      }
      const stale = await store.listStaleQueuedRuns(new Date(t - opt.sweepAgeMs).toISOString(), 20);
      for (const r of stale) await service.ensureJob(r);
    } catch (err) {
      logger.error?.(`[workflowRunner] scheduler error: ${err.message}`);
    }
  }

  function start() {
    if (running) return;
    running = true;
    idleTimer = setInterval(() => tick(), opt.idlePollMs);
    if (idleTimer.unref) idleTimer.unref();
    if (opt.schedulerIntervalMs > 0) {
      schedTimer = setInterval(() => schedulerTick(), opt.schedulerIntervalMs);
      if (schedTimer.unref) schedTimer.unref();
    }
    if (workerHealth) {
      beat();
      healthTimer = setInterval(beat, opt.workerHeartbeatMs || 15000);
      if (healthTimer.unref) healthTimer.unref();
    }
    kick();
  }

  /**
   * stop()                → stop claiming, let active drivers release their
   *                         jobs back to the queue (graceful shutdown).
   * stop({abandon:true})  → simulate a crash: stop without releasing; the
   *                         leases expire and another worker recovers them.
   */
  async function stop({ abandon = false } = {}) {
    running = false;
    stoppedAbandon = abandon;
    clearInterval(idleTimer);
    clearInterval(schedTimer);
    clearInterval(healthTimer);
    if (workerHealth && !abandon && workerHealth.remove) {
      try { Promise.resolve(workerHealth.remove(workerId)).catch(() => {}); } catch { /* never */ }
    }
    const drivers = [];
    for (const ctl of active.values()) {
      ctl.stopping = true;
      ctl.abandoned = abandon;
      // A crashed process cannot heartbeat: stop immediately so the lease
      // really expires (graceful stop keeps it alive until release).
      if (abandon && ctl.hb) clearInterval(ctl.hb);
      if (ctl.done) drivers.push(ctl.done);
    }
    if (!abandon && drivers.length) {
      await Promise.race([Promise.all(drivers), sleep(opt.stopTimeoutMs)]);
    }
  }

  function signalCancel(runId) {
    cancelSignals.add(runId);
  }

  return {
    start, stop, tick, kick, schedulerTick, processJob, signalCancel,
    finalizeCancelled, finalizeFailed,
    addRunListener(fn) { if (typeof fn === 'function') runListeners.push(fn); }, // Layer 10
    setReviewNotifier(fn) { onReviewRequested = typeof fn === 'function' ? fn : null; }, // Layer 10
    workerId,
    get activeCount() { return active.size; },
    _isSafeToRetry: isSafeToRetry,
  };
}

module.exports = { createWorkflowRunner, deterministicUuid, RETRYABLE, DEFAULTS };
