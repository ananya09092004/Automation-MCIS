/**
 * Layer 3 — Agent Execution & Verification.
 *
 * Runs a workspace-scoped goal through the EXISTING Nexus planner/executor
 * primitives with a persisted lifecycle, human approval gates, structured
 * redacted evidence, bounded recovery and cancellation.
 *
 *   created → planning → (waiting_approval →) executing → planning … →
 *   verifying → completed | failed | cancelled
 *
 * Reused, not re-implemented:
 *   taskPlanner.decideNextStep       — the planner (Gemini, same prompt as voice/run_goal)
 *   taskPlanner.callNexusWithTimeout — the executor bridge (+ optional approval token)
 *   taskPlanner.diagnoseFailure      — post-failure state inspection
 *   taskPlanner.isEmergencyStopActive— the existing global kill switch
 *   riskModel.classifyRisk           — GREEN / YELLOW / RED
 *   permissions.isPermitted          — first-time resource approval (PERMISSIONS_ENFORCED)
 *   auditLog.appendAuditLog          — audit trail (redacted payloads)
 *   sensitiveDataFilter.redact       — everything persisted/returned
 *
 * The voice/run_goal plan runner (taskPlanner.runLoop) is NOT used or
 * changed: Layer 3 is an independent executor over the same primitives.
 *
 * Deployment: an execution's runtime (raw planner context, pending step)
 * lives in the process that created it. Layer 6 adds an optional durable
 * ownership lease (options.leaseMs → agent_executions.lease_expires_at,
 * renewed by a heartbeat): other instances then leave a leased execution
 * alone, can record approval decisions for it (the owner picks them up on
 * its next heartbeat), and only fail it as SERVER_RESTART once the lease
 * has expired. Nothing is ever silently resumed on another instance.
 * See docs/LAYER3_AGENT_EXECUTION.md and docs/LAYER6_SECURITY.md.
 *
 * Layer 6 Agent Firewall (optional, setFirewall): every step is evaluated
 * when planned and again right before it executes; DENY → not executed
 * (evidence POLICY_DENIED); APPROVAL_REQUIRED → this file's approval gate.
 */
'use strict';

const crypto = require('crypto');
// Layer 6: every persisted / returned value goes through the sensitive-data
// classifier (sensitiveDataFilter + connection strings, cookies, context keys,
// high-entropy secrets).
const { redactActionPayload: baseRedactActionPayload } = require('../../backend-routing/sensitiveDataFilter');
const cls = require('../security/sensitiveClassifier');

const redact = (v, o) => cls.sanitize(v, o);
const redactString = (v, max) => cls.sanitizeString(v, max);
const redactActionPayload = (p) => cls.sanitize(baseRedactActionPayload(p));

const STATUS = Object.freeze({
  CREATED: 'created',
  PLANNING: 'planning',
  WAITING_APPROVAL: 'waiting_approval',
  EXECUTING: 'executing',
  VERIFYING: 'verifying',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
});
const TERMINAL = new Set([STATUS.COMPLETED, STATUS.FAILED, STATUS.CANCELLED]);
const ACTIVE = [STATUS.CREATED, STATUS.PLANNING, STATUS.WAITING_APPROVAL, STATUS.EXECUTING, STATUS.VERIFYING];

const DEFAULTS = Object.freeze({
  maxSteps: 15,                   // same bound as taskPlanner
  maxConsecutiveFailures: 3,      // same bound as taskPlanner
  maxPlannerErrors: 2,
  retryDelayMs: 1500,             // same backoff as taskPlanner's safe retry
  approvalTtlMs: 15 * 60 * 1000,
  executionTimeoutMs: 30 * 60 * 1000,
  maxGoalChars: 2000,
});

// Read actions whose success with EMPTY data means the data is missing.
const DATA_READ_ACTIONS = new Set(['read_text', 'read_tables', 'read_file', 'read_word_document', 'read_excel_rows']);
const APPROVAL_GATE_RE = /blocked pending user approval|approval is required/i;
const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9_.:-]{8,128}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RANK = { member: 1, admin: 2, owner: 3 };
// Layer 4: a workflow step's approval policy raises the tier of every
// action that is not read-only (SAFE_TO_REPEAT) so it goes through the
// existing approval gate. 'required' → YELLOW (creator or admin),
// 'admin' → RED (admin+). Read-only/navigation actions are unaffected.
const APPROVAL_POLICY_TIER = { required: 'yellow', admin: 'red' };
// Layer 7: evidence rows for actions that never reached the executor (not metered).
const NOT_EXECUTED_CODES = new Set(['POLICY_DENIED', 'STALE_APPROVAL', 'QUOTA_EXCEEDED', 'APPROVAL_REQUIRED', 'INVALID_STEP']);
const TIER_RANK = { green: 0, yellow: 1, red: 2 };
const maxTierOf = (a, b) => (TIER_RANK[a] >= TIER_RANK[b] ? a : b);
// Layer 6: parameters that name files a desktop/browser step touches.
const PATH_PARAMS = ['path', 'source', 'destination', 'dest', 'target_path', 'new_path', 'file', 'file_path', 'folder', 'folder_path', 'directory', 'filename'];

class ExecutionError extends Error {
  constructor(status, code, message, extra) {
    super(message);
    this.name = 'ExecutionError';
    this.status = status;
    this.code = code;
    if (extra) this.extra = extra;
  }
}
const notFound = () => new ExecutionError(404, 'EXECUTION_NOT_FOUND', 'Execution not found');

function sha256(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

/** Layer 6: an approval is bound to everything that defines the step it approves. */
function approvalBinding({ workspaceId, executionId, workflowContext, stepIndex, action, stepHash, tier, policyVersion }) {
  return sha256([workspaceId, executionId, stableStringify(workflowContext || null), stepIndex, action, stepHash, tier,
    policyVersion === null || policyVersion === undefined ? 'none' : policyVersion, 'APPROVAL_REQUIRED'].join('|'));
}

function isAdmin(role) {
  return (RANK[role] || 0) >= RANK.admin;
}

function summarizeData(data) {
  if (data === null || data === undefined) return null;
  if (Array.isArray(data)) return { type: 'array', length: data.length, sample: data.slice(0, 3) };
  if (typeof data === 'string') return data.length > 500 ? `${data.slice(0, 500)}…` : data;
  return data;
}

function isEmptyData(data) {
  if (data === null || data === undefined) return true;
  if (typeof data === 'string') return data.trim() === '';
  if (Array.isArray(data)) return data.length === 0;
  if (typeof data === 'object') return Object.keys(data).length === 0;
  return false;
}

function defaultDeps() {
  const taskPlanner = require('../../backend-routing/taskPlanner');
  const { classifyRisk } = require('../../backend-routing/riskModel');
  const { NEXUS_ACTIONS, SAFE_TO_REPEAT_ACTIONS } = require('../../backend-routing/intentRouter');
  const permissions = require('../../security-engine/permissions');
  const { appendAuditLog } = require('../../security-engine/auditLog');
  return {
    decideNextStep: taskPlanner.decideNextStep,
    callNexusWithTimeout: taskPlanner.callNexusWithTimeout,
    diagnoseFailure: taskPlanner.diagnoseFailure,
    isEmergencyStopActive: taskPlanner.isEmergencyStopActive,
    classifyRisk,
    isPermitted: permissions.isPermitted,
    appendAuditLog,
    NEXUS_ACTIONS,
    SAFE_TO_REPEAT_ACTIONS,
  };
}

function createAgentExecutionService({ store, deps, options = {}, logger = console } = {}) {
  if (!store) throw new Error('execution store is required');
  const d = { ...defaultDeps(), ...(deps || {}) };
  const opt = { ...DEFAULTS, ...options };
  const now = options.now || (() => new Date());
  const runnerId = `runner_${crypto.randomBytes(8).toString('hex')}`;

  /** In-process runtime state (raw, unredacted — never persisted or returned). */
  const runtimes = new Map(); // executionId -> runtime
  const leaseMs = Number.isInteger(opt.leaseMs) && opt.leaseMs > 0 ? opt.leaseMs : 0;
  let leaseTimer = null;
  const classifier = cls;
  const fwOn = () => !!(d.firewall && d.firewall.enabled);
  // Layer 10: terminal-state listeners (webhooks, QA runner) and the AI
  // workforce agent resolver. Listeners never affect the execution.
  const finishListeners = [];

  const audit = (userId, action, payload, result) => {
    try {
      // Layer 2: attribute the audit row to its workspace (payload.workspaceId
      // is always the server-resolved workspace of the execution).
      Promise.resolve(d.appendAuditLog(userId, action, redact(payload), result,
        (payload && payload.workspaceId) || null)).catch(() => {});
    } catch { /* audit must never break execution */ }
  };

  // ------------------------------------------------------------------
  // State transitions (compare-and-set on status + version)
  // ------------------------------------------------------------------
  async function transition(workspaceId, id, allowedFrom, patch) {
    for (let attempt = 0; attempt < 4; attempt++) {
      const cur = await store.getExecution(workspaceId, id);
      if (!cur || !(typeof allowedFrom === 'function' ? allowedFrom(cur) : allowedFrom.includes(cur.status))) return null;
      const updated = await store.updateExecution(workspaceId, id, cur.version,
        typeof patch === 'function' ? patch(cur) : patch);
      if (updated) return updated;
    }
    return null;
  }

  async function finish(workspaceId, id, status, patch = {}) {
    const updated = await transition(workspaceId, id, ACTIVE, {
      status,
      pending_approval_id: null,
      finished_at: now().toISOString(),
      ...patch,
    });
    await store.supersedePendingApprovals(workspaceId, id).catch(() => {});
    const rt = runtimes.get(id);
    if (rt) { rt.pending = null; rt.approved = null; rt.finished = true; }
    runtimes.delete(id);
    if (updated && d.usage) {
      // Layer 7: outcome events (not quota-limited; idempotent per execution).
      d.usage.record(workspaceId, `execution_${status}`, 1, `exec_outcome:${id}`, { source: 'agent_execution', sourceId: id, actorId: updated.created_by })
        .catch(() => {});
    }
    if (updated) {
      for (const fn of finishListeners) {
        try { Promise.resolve(fn(updated)).catch((err) => logger.warn?.(`[agentExecution] finish listener failed: ${err.code || err.name}`)); } catch { /* never */ }
      }
      audit(updated.created_by, `agent_execution_${status}`, {
        executionId: id, workspaceId, failureCode: updated.failure_code || null,
      }, { success: status === STATUS.COMPLETED, error: updated.failure_message || null });
    }
    return updated;
  }

  const fail = (ws, id, code, message, extra = {}) =>
    finish(ws, id, STATUS.FAILED, { failure_code: code, failure_message: redactString(message || code, 500), ...extra });

  // Layer 4: in-flight action marker, written ONLY for executions that
  // asked for it (workflow steps: trackInflight). It lives in its own
  // column without a version bump, so it never races the status
  // compare-and-set. Plain Layer 3 executions never write it.
  async function markInflight(workspaceId, id, rt, value) {
    if (!rt || !rt.trackInflight) return true;
    try {
      await store.setInflight(workspaceId, id, value);
      return true;
    } catch (err) {
      logger.warn?.(`[agentExecution] in-flight marker write failed: ${err.message}`);
      return false;
    }
  }

  // Active execution with no runtime in THIS process = interrupted by a
  // restart. It is failed (never silently resumed: raw step payloads and
  // approvals only ever lived in memory).
  async function reconcile(exec) {
    if (!exec || TERMINAL.has(exec.status) || runtimes.has(exec.id)) return exec;
    // Layer 6: owned by another live instance (unexpired lease) → leave it.
    if (exec.lease_expires_at && Date.parse(exec.lease_expires_at) > now().getTime()) return exec;
    const updated = await transition(exec.workspace_id, exec.id, (cur) => ACTIVE.includes(cur.status)
      && !(cur.lease_expires_at && Date.parse(cur.lease_expires_at) > now().getTime()), {
      status: STATUS.FAILED,
      failure_code: 'SERVER_RESTART',
      failure_message: 'Execution was interrupted by a server restart and was not resumed automatically.',
      pending_approval_id: null,
      finished_at: now().toISOString(),
    });
    await store.supersedePendingApprovals(exec.workspace_id, exec.id).catch(() => {});
    if (updated && fwOn()) {
      secEvent(exec.workspace_id, exec.created_by, 'execution_recovered', { executionId: exec.id, outcome: 'failed', code: 'SERVER_RESTART', leased: !!exec.lease_expires_at });
    }
    return updated || (await store.getExecution(exec.workspace_id, exec.id));
  }

  function secEvent(ws, actor, type, payload, extra) {
    try { if (d.firewall && d.firewall.events) d.firewall.events.record(ws, actor, type, payload, extra); } catch { /* never breaks */ }
  }

  // ------------------------------------------------------------------
  // Layer 6: execution ownership lease (multi-instance)
  // ------------------------------------------------------------------
  const leaseUntil = () => new Date(now().getTime() + leaseMs).toISOString();

  async function heartbeatLeases() {
    for (const [id, rt] of runtimes) {
      if (rt.finished || !rt.workspaceId) continue;
      try {
        await store.setLease(rt.workspaceId, id, leaseUntil());
        if (rt.pending) await syncRemoteDecision(rt.workspaceId, id, rt);
      } catch (err) {
        logger.warn?.(`[agentExecution] lease heartbeat failed: ${err.message}`);
      }
    }
  }

  function startLeaseHeartbeat() {
    if (!leaseMs || leaseTimer) return;
    leaseTimer = setInterval(() => { heartbeatLeases().catch(() => {}); }, Math.max(250, Math.floor(leaseMs / 3)));
    if (leaseTimer.unref) leaseTimer.unref();
  }

  /** An approval decided on ANOTHER instance: the owner applies it here. */
  async function syncRemoteDecision(ws, id, rt) {
    const p = rt.pending;
    if (!p) return;
    const a = await store.getApproval(ws, id, p.approvalId);
    if (!a || a.status === 'pending') return;
    if (rt.pending !== p) return;
    rt.pending = null;
    if (a.status === 'approved' && a.step_hash === p.hash && (!p.binding || a.binding_hash === p.binding)) {
      const resumed = await transition(ws, id, [STATUS.WAITING_APPROVAL], { status: STATUS.EXECUTING, pending_approval_id: null });
      if (!resumed) return;
      rt.approved = { step: p.step, tier: p.tier, approvalId: a.id, token: `appr_${crypto.randomBytes(24).toString('hex')}` };
      kick(ws, id);
    } else if (a.status === 'rejected') {
      await fail(ws, id, 'APPROVAL_REJECTED', `Approval for "${a.action}" was rejected.`);
    } else if (a.status === 'expired') {
      await fail(ws, id, 'APPROVAL_EXPIRED', 'The approval request expired before a decision was made.');
    }
  }

  // ------------------------------------------------------------------
  // Layer 6: Agent Firewall hooks
  // ------------------------------------------------------------------
  function plannerResource(step) {
    const params = (step.payload && step.payload.parameters) || {};
    const target = (step.payload && step.payload.target) || {};
    const paths = [];
    for (const k of PATH_PARAMS) {
      if (typeof params[k] === 'string') paths.push(params[k]);
      if (typeof target[k] === 'string') paths.push(target[k]);
    }
    if (Array.isArray(params.paths)) for (const x of params.paths.slice(0, 20)) if (typeof x === 'string') paths.push(x);
    const url = typeof params.url === 'string' ? params.url : (typeof target.url === 'string' ? target.url : null);
    return { paths, ...(url ? { url } : {}) };
  }

  function firewallRequest(workspaceId, id, exec, rt, step, tier) {
    if (step.connector) {
      const spec = step.connector.spec;
      return {
        workspaceId, actorId: exec.created_by, executionId: id, workflowRunId: rt.workflowContext ? rt.workflowContext.runId || null : null,
        integrationId: spec.integrationId, provider: step.connector.provider, action: spec.action, executionType: 'connector',
        baseRisk: tier, readOnly: !!step.connector.readOnly, resource: step.connector.resource || {}, input: spec.input || {},
        tainted: !!rt.tainted, roleCap: rt.roleCap,
      };
    }
    return {
      workspaceId, actorId: exec.created_by, executionId: id, workflowRunId: rt.workflowContext ? rt.workflowContext.runId || null : null,
      action: step.action, executionType: (step.payload && step.payload.platform) === 'browser' ? 'browser' : 'desktop',
      baseRisk: tier, readOnly: d.SAFE_TO_REPEAT_ACTIONS.includes(step.action), resource: plannerResource(step),
      input: { parameters: (step.payload && step.payload.parameters) || {}, value: step.payload ? step.payload.value ?? null : null },
      tainted: !!rt.tainted, roleCap: rt.roleCap,
    };
  }

  /** Records a not-executed evidence row for a firewall denial and fails the execution. */
  async function denyStep(workspaceId, id, rt, step, tier, decision, { code = 'POLICY_DENIED', approvalId = null } = {}) {
    const reasons = (decision.reasons || []).join(', ') || 'denied by workspace policy';
    const by = code === 'QUOTA_EXCEEDED' ? 'the workspace plan limits' : 'the workspace Agent Firewall';
    await recordOutcome(workspaceId, id, rt, {
      step, tier: decision.risk || tier, startedAt: now(), approvalId, countFailure: false,
      outcome: { ok: false, code, message: `Blocked by ${by} (${reasons}).`, attempts: 0, result: null, verification: { status: 'failed', note: 'Not executed.' } },
    });
    await fail(workspaceId, id, code, `Blocked by ${by}: ${reasons}`);
  }

  /**
   * Layer 10: limits of the AI workforce agent running this execution
   * (independent of, and never weaker than, the workspace firewall): an
   * integration outside the agent's allowed list, or a risk tier above the
   * agent's cap, is denied outright — even with a human approval.
   */
  function agentLimit(rt, step, tier) {
    const a = rt && rt.agent;
    if (!a) return null;
    if (step.connector && a.allowedIntegrationIds.length && !a.allowedIntegrationIds.includes(step.connector.spec.integrationId)) return 'AGENT_INTEGRATION_NOT_ALLOWED';
    if (TIER_RANK[tier] === undefined || TIER_RANK[tier] > TIER_RANK[a.maxRisk]) return `AGENT_RISK_CAP:${a.maxRisk}`;
    return null;
  }

  /** Plan-time firewall: null (off) | false (denied; execution failed) | decision. */
  async function planFirewall(workspaceId, id, exec, rt, step, tier) {
    const pre = agentLimit(rt, step, tier);
    if (pre) {
      await denyStep(workspaceId, id, rt, step, tier, { risk: tier, reasons: [pre] });
      return false;
    }
    if (!fwOn()) return null;
    const fwd = await d.firewall.evaluateAgentAction({ ...firewallRequest(workspaceId, id, exec, rt, step, tier), phase: 'plan' });
    rt.lastDecision = fwd;
    if (fwd.decision === 'DENY') {
      await denyStep(workspaceId, id, rt, step, tier, fwd);
      return false;
    }
    const post = agentLimit(rt, step, fwd.risk);
    if (post) {
      await denyStep(workspaceId, id, rt, step, tier, { ...fwd, reasons: [...(fwd.reasons || []), post] });
      return false;
    }
    return fwd;
  }

  /** Layer 6: what the planner (LLM) may see from a tool result. */
  function modelSafeHistoryEntry(entry, rt, workspaceId, id, exec) {
    // Layer 9: secrets are removed from what the planner sees even with the
    // firewall off (injection tainting and untrusted-data wrapping stay firewall features).
    if (!fwOn()) {
      return {
        ...entry,
        error: entry.error ? classifier.sanitizeString(entry.error, 500) : entry.error,
        data: entry.data === undefined || entry.data === null ? entry.data : classifier.sanitize(entry.data, { maxString: 2000 }),
        diagnosis: entry.diagnosis ? classifier.sanitize(entry.diagnosis, { maxString: 500 }) : entry.diagnosis,
      };
    }
    const inj = classifier.detectInjection([entry.data, entry.error, entry.diagnosis]);
    if (inj.suspicious && !rt.tainted) {
      rt.tainted = true;
      secEvent(workspaceId, exec.created_by, 'suspicious_tool_injection', { executionId: id, action: entry.action, signals: inj.signals });
    }
    return {
      ...entry,
      error: entry.error ? classifier.sanitizeString(entry.error, 500) : entry.error,
      data: entry.data == null ? null : classifier.asUntrustedData(entry.data, { maxString: 1000 }),
      diagnosis: entry.diagnosis ? classifier.sanitize(entry.diagnosis, { maxString: 500 }) : entry.diagnosis,
    };
  }

  // ------------------------------------------------------------------
  // Engine
  // ------------------------------------------------------------------
  function kick(workspaceId, id) {
    setImmediate(() => {
      drive(workspaceId, id).catch((err) => logger.error?.(`[agentExecution] drive error: ${err.message}`));
    });
  }

  async function drive(workspaceId, id) {
    const rt = runtimes.get(id);
    if (!rt || rt.finished) return;
    if (rt.running) { rt.rerun = true; return; } // e.g. approved while the loop was still unwinding
    rt.running = true;
    try {
      await loop(workspaceId, id, rt);
    } catch (err) {
      await fail(workspaceId, id, 'ENGINE_ERROR', `Unexpected executor error: ${err.message}`);
    } finally {
      rt.running = false;
      if (rt.rerun && !rt.finished) { rt.rerun = false; kick(workspaceId, id); }
    }
  }

  async function shouldStop(workspaceId, id, rt) {
    if (rt.cancelRequested || rt.finished) return true;
    const cur = await store.getExecution(workspaceId, id);
    return !cur || TERMINAL.has(cur.status);
  }

  async function loop(workspaceId, id, rt) {
    // Hard upper bound on iterations regardless of any other logic.
    for (let guard = 0; guard < opt.maxSteps * 3 + 10; guard++) {
      if (await shouldStop(workspaceId, id, rt)) return;
      const exec = await store.getExecution(workspaceId, id);

      if (d.isEmergencyStopActive()) {
        await finish(workspaceId, id, STATUS.CANCELLED, {
          failure_code: 'EMERGENCY_STOP', failure_message: 'Cancelled by emergency stop.',
        });
        return;
      }
      if (now().getTime() > rt.deadline) {
        await fail(workspaceId, id, 'EXECUTION_TIMEOUT', 'Execution exceeded its time limit.');
        return;
      }
      if (exec.steps_executed >= exec.max_steps) {
        await fail(workspaceId, id, 'MAX_STEPS', `Reached the maximum of ${exec.max_steps} steps without completing the goal.`);
        return;
      }

      let step;
      let approval = null;

      if (rt.approved) {
        ({ step } = rt.approved);
        approval = rt.approved;
        rt.approved = null;
      } else {
        const planning = await transition(workspaceId, id, [STATUS.CREATED, STATUS.PLANNING, STATUS.EXECUTING], {
          status: STATUS.PLANNING,
          started_at: exec.started_at || now().toISOString(),
        });
        if (!planning) return;

        if (rt.fixedStep) {
          // Layer 5: a deterministic connector step (no planner, no LLM —
          // credentials can never reach a prompt). Same gates as planner
          // steps: risk tier, workspace grants, approvals, evidence.
          if (rt.fixedStep.done) {
            await verifyAndComplete(workspaceId, id, rt, rt.fixedStep.doneReason);
            return;
          }
          let prepared;
          try {
            if (!d.connectorGateway) throw Object.assign(new Error('Integrations are not enabled on this server.'), { code: 'INTEGRATIONS_DISABLED' });
            prepared = await d.connectorGateway.prepareAction(workspaceId, exec.created_by, rt.fixedStep.spec);
          } catch (err) {
            await fail(workspaceId, id, err.code || 'CONNECTOR_ERROR', err.message || 'The connector step was rejected.');
            return;
          }
          if (await shouldStop(workspaceId, id, rt)) return;
          step = {
            action: prepared.qualifiedName,
            connector: {
              spec: { ...rt.fixedStep.spec, input: prepared.input }, safeToRepeat: prepared.safeToRepeat,
              provider: prepared.provider, readOnly: !!prepared.readOnly, resource: prepared.resource || {},
            },
            payload: {
              platform: 'connector',
              parameters: { integrationId: prepared.integration.id, integration: prepared.integrationName, action: rt.fixedStep.spec.action, input: prepared.input },
              target: { provider: prepared.provider, resource: prepared.target },
              value: null,
            },
            reason: prepared.label,
          };
          let tier = prepared.tier;
          if (rt.minTier && !prepared.safeToRepeat && TIER_RANK[rt.minTier] > TIER_RANK[tier]) tier = rt.minTier;
          const policyTier = tier;
          const fwd = await planFirewall(workspaceId, id, exec, rt, step, tier);
          if (fwd === false) return;
          if (fwd) tier = maxTierOf(tier, fwd.risk);
          const permitted = await d.isPermitted(exec.created_by, `integration:${prepared.integration.id}`, workspaceId);
          if (tier !== 'green' || !permitted) {
            await requestApproval(workspaceId, id, rt, step, tier,
              !permitted ? 'permission_required' : (tier !== policyTier ? 'workspace_security_policy' : (tier !== prepared.tier ? 'workflow_approval_policy' : `${tier}_risk_action`)), fwd);
            return;
          }
          rt.plannedTier = tier;
        } else {
          let next;
          try {
            next = await d.decideNextStep(rt.goal, rt.history, rt.clarifications);
          } catch (err) {
            next = { plannerError: true, reason: err.message };
          }
          if (await shouldStop(workspaceId, id, rt)) return;

          if (!next || next.plannerError) {
            rt.plannerErrors += 1;
            if (rt.plannerErrors >= opt.maxPlannerErrors) {
              await fail(workspaceId, id, 'PLANNER_ERROR', `Planner unavailable: ${next?.reason || 'no response'}`);
              return;
            }
            continue;
          }
          rt.plannerErrors = 0;

          if (next.needs_clarification) {
            await fail(workspaceId, id, 'NEEDS_INPUT', `More information is needed: ${next.question || 'unspecified'}`, {
              result: redact({ question: next.question || null }),
            });
            return;
          }

          if (next.done) {
            await verifyAndComplete(workspaceId, id, rt, next.reason);
            return;
          }

          if (!next.action || !d.NEXUS_ACTIONS.includes(next.action)) {
            const stop = await recordOutcome(workspaceId, id, rt, {
              step: { action: String(next.action || 'none'), payload: next.payload || {} },
              tier: 'green',
              outcome: { ok: false, code: 'INVALID_STEP', message: 'Planner proposed an unknown action.', attempts: 1, result: null },
              startedAt: now(),
            });
            if (stop) return;
            continue;
          }

          step = { action: next.action, payload: next.payload || { platform: 'desktop', parameters: {}, target: {}, value: null }, reason: next.reason || null };
          const classified = d.classifyRisk(step.action, step.payload);
          let tier = classified;
          if (rt.minTier && !d.SAFE_TO_REPEAT_ACTIONS.includes(step.action) && TIER_RANK[rt.minTier] > TIER_RANK[tier]) {
            tier = rt.minTier; // Layer 4 workflow step approval policy
          }
          const params = step.payload.parameters || {};
          const resource = params.path || params.url || params.app || step.action;
          const policyTier = tier;
          const fwd = await planFirewall(workspaceId, id, exec, rt, step, tier);
          if (fwd === false) return;
          if (fwd) tier = maxTierOf(tier, fwd.risk);
          // Layer 2: only THIS workspace's grants can authorize the step.
          const permitted = await d.isPermitted(exec.created_by, resource, workspaceId);

          if (tier !== 'green' || !permitted) {
            await requestApproval(workspaceId, id, rt, step, tier,
              !permitted ? 'permission_required' : (tier !== policyTier ? 'workspace_security_policy' : (tier !== classified ? 'workflow_approval_policy' : `${tier}_risk_action`)), fwd);
            return;
          }
          rt.plannedTier = tier;
        }
      }

      // ---------------- execute ----------------
      const executing = await transition(workspaceId, id, [STATUS.PLANNING, STATUS.EXECUTING], {
        status: STATUS.EXECUTING,
        current_step: rt.stepIndex,
        pending_approval_id: null,
        ...(leaseMs ? { lease_expires_at: leaseUntil() } : {}),
      });
      if (!executing) return;

      const tier = approval ? approval.tier : (rt.plannedTier || d.classifyRisk(step.action, step.payload));
      rt.plannedTier = null;
      // Layer 6: fresh firewall decision right before the call (policy and
      // role may have changed since planning / approval).
      const tickets = [];
      // Layer 10: the agent's limits are re-checked right before the call too.
      const agentBlock = agentLimit(rt, step, tier);
      if (agentBlock) {
        await denyStep(workspaceId, id, rt, step, tier, { risk: tier, reasons: [agentBlock] }, { code: 'POLICY_DENIED', approvalId: approval ? approval.approvalId : null });
        return;
      }
      if (fwOn()) {
        const fwx = await d.firewall.evaluateAgentAction({ ...firewallRequest(workspaceId, id, exec, rt, step, tier), phase: 'execute', approved: !!approval });
        const fwAgent = fwx.decision !== 'DENY' ? agentLimit(rt, step, fwx.risk) : null;
        if (fwAgent) { fwx.decision = 'DENY'; fwx.reasons = [...(fwx.reasons || []), fwAgent]; delete fwx.ticket; }
        if (fwx.decision === 'DENY' || (approval && TIER_RANK[fwx.risk] > TIER_RANK[approval.tier])) {
          await denyStep(workspaceId, id, rt, step, tier, fwx, {
            code: approval ? 'STALE_APPROVAL' : 'POLICY_DENIED', approvalId: approval ? approval.approvalId : null,
          });
          return;
        }
        if (fwx.ticket) tickets.push(fwx.ticket);
      }
      // Layer 7: connector-call quota (executions in one workspace are
      // serialized by Layer 3, so this check cannot race with itself).
      if (step.connector && d.usage && d.usage.enabled) {
        const q = await d.usage.checkEntitlement(workspaceId, 'connector_calls', 1);
        if (!q.allowed) {
          await denyStep(workspaceId, id, rt, step, tier, { risk: tier, reasons: [q.reason === 'ENTITLEMENT_UNAVAILABLE' ? 'ENTITLEMENT_UNAVAILABLE' : 'CONNECTOR_CALL_QUOTA_EXCEEDED'] }, {
            code: 'QUOTA_EXCEEDED', approvalId: approval ? approval.approvalId : null,
          });
          return;
        }
      }
      rt.currentAction = step.action;
      // Layer 4: persist which action is in flight BEFORE calling the
      // executor, so a crash-recovery can tell whether re-running is safe.
      if (!(await markInflight(workspaceId, id, rt, { stepIndex: rt.stepIndex, action: String(step.action).slice(0, 100), tier }))) {
        // Tracking was requested but could not be recorded: do NOT run an
        // action whose in-flight state a recovery could not see.
        await fail(workspaceId, id, 'ENGINE_ERROR', 'Could not record the in-flight action; it was not executed.');
        return;
      }
      const startedAt = now();
      const outcome = await executeStep(step, tier, approval ? approval.token : null, {
        workspaceId, userId: exec.created_by, executionId: id,
        // A retry of a (safe) connector call needs a NEW single-use ticket.
        nextTicket: async () => {
          if (tickets.length) return tickets.shift();
          if (!fwOn()) return null;
          const again = await d.firewall.evaluateAgentAction({ ...firewallRequest(workspaceId, id, exec, rt, step, tier), phase: 'execute', approved: !!approval });
          return again.decision === 'DENY' ? null : again.ticket || null;
        },
      });
      rt.currentAction = null;

      if (outcome.code === 'APPROVAL_GATE' && !approval) {
        // The executor itself refused without human approval (Nexus
        // ApprovalGate) — ask a human instead of failing the goal.
        const stop = await recordOutcome(workspaceId, id, rt, {
          step, tier, outcome: { ...outcome, code: 'APPROVAL_REQUIRED' }, startedAt, countFailure: false,
        });
        if (stop) return;
        await requestApproval(workspaceId, id, rt, step, tier === 'red' ? 'red' : 'yellow', 'executor_approval_gate');
        return;
      }
      if (outcome.code === 'APPROVAL_GATE') {
        await recordOutcome(workspaceId, id, rt, { step, tier, outcome: { ...outcome, code: 'PERMISSION_DENIED' }, startedAt, approvalId: approval.approvalId, countFailure: false });
        await fail(workspaceId, id, 'PERMISSION_DENIED', 'The executor refused the approved action.');
        return;
      }

      const stop = await recordOutcome(workspaceId, id, rt, { step, tier, outcome, startedAt, approvalId: approval ? approval.approvalId : null });
      if (stop) return;
      if (rt.fixedStep) {
        // One deterministic action: success → verify & complete on the next
        // pass; failure → stop now (never loop a possibly non-idempotent write).
        if (outcome.ok) {
          rt.fixedStep.done = true;
          rt.fixedStep.doneReason = (outcome.result && outcome.result.message) || 'Connector action completed.';
        } else {
          await fail(workspaceId, id, outcome.code, outcome.message);
          return;
        }
      }
    }
    await fail(workspaceId, id, 'MAX_STEPS', 'Execution loop bound reached.');
  }

  async function executeStep(step, tier, approvalToken, xctx = {}) {
    if (step.connector) return executeConnectorStep(step, tier, xctx);
    let attempts = 1;
    let res = await d.callNexusWithTimeout(step.action, step.payload, approvalToken);
    let recovery = null;
    let diagnosis = null;

    const gate = (r) => r && r.success === false && APPROVAL_GATE_RE.test(`${r.error || ''} ${r.message || ''}`);

    if (res && res.success === false && !gate(res)) {
      if (d.SAFE_TO_REPEAT_ACTIONS.includes(step.action)) {
        if (opt.retryDelayMs) await new Promise((r) => setTimeout(r, opt.retryDelayMs));
        attempts = 2;
        res = await d.callNexusWithTimeout(step.action, step.payload, approvalToken);
        recovery = { strategy: 'retry_idempotent', recovered: !!(res && res.success) };
      } else {
        diagnosis = await d.diagnoseFailure(step).catch(() => null);
        recovery = { strategy: 'diagnose_then_replan', diagnosisCaptured: !!diagnosis };
      }
    }

    const base = { attempts, recovery, diagnosis, result: res };
    if (!res || typeof res !== 'object' || typeof res.success !== 'boolean') {
      return { ...base, ok: false, code: 'INVALID_RESULT', message: 'Executor returned an invalid result.' };
    }
    if (gate(res)) return { ...base, ok: false, code: 'APPROVAL_GATE', message: res.error || res.message };
    if (!res.success) {
      const msg = String(res.error || res.message || 'Action failed');
      let code = 'TOOL_FAILURE';
      if (/timed out|timeout/i.test(msg)) code = 'TIMEOUT';
      else if ((step.payload && step.payload.platform) === 'browser') code = 'BROWSER_FAILURE';
      return { ...base, ok: false, code, message: msg };
    }
    if (DATA_READ_ACTIONS.has(step.action) && isEmptyData(res.data)) {
      return { ...base, ok: false, code: 'MISSING_DATA', message: 'The action succeeded but returned no data.', verification: { status: 'failed', note: 'Expected data was missing.' } };
    }
    const verified = res.evidence ? res.evidence.verified : undefined;
    if (tier !== 'green') {
      if (verified === false) {
        return { ...base, ok: false, code: 'VERIFICATION_FAILED', message: 'Action reported success but verification failed.', verification: { status: 'failed', note: 'Executor evidence reported verified=false.' } };
      }
      return { ...base, ok: true, verification: verified === true ? { status: 'verified' } : { status: 'unverified', note: 'No verification evidence returned for a state-changing action.' } };
    }
    if (verified === true) return { ...base, ok: true, verification: { status: 'verified' } };
    if (verified === false) return { ...base, ok: true, verification: { status: 'unverified', note: 'Read-only/low-risk action could not be independently verified.' } };
    return { ...base, ok: true, verification: { status: 'not_applicable' } };
  }

  // Layer 5: connector step. Retried once ONLY when the action is safe to
  // repeat AND the failure is transient; writes are never retried here.
  async function executeConnectorStep(step, tier, xctx) {
    const call = async () => d.connectorGateway.executeAction(xctx.workspaceId, xctx.userId, step.connector.spec, {
      executionId: xctx.executionId, idempotencyKey: step.connector.spec.idempotencyKey,
      firewallTicket: xctx.nextTicket ? await xctx.nextTicket() : undefined,
    });
    let attempts = 1;
    let recovery = null;
    let res = await call();
    if (res && res.success === false) {
      if (step.connector.safeToRepeat && res.retryable) {
        if (opt.retryDelayMs) await new Promise((r) => setTimeout(r, opt.retryDelayMs));
        attempts = 2;
        res = await call();
        recovery = { strategy: 'retry_idempotent', recovered: !!(res && res.success) };
      } else {
        recovery = { strategy: 'none', reason: step.connector.safeToRepeat ? 'non-transient error' : 'not idempotent: never retried automatically' };
      }
    }
    const base = { attempts, recovery, diagnosis: null, result: res };
    if (!res || typeof res !== 'object' || typeof res.success !== 'boolean') {
      return { ...base, ok: false, code: 'INVALID_RESULT', message: 'Connector returned an invalid result.' };
    }
    if (!res.success) {
      let code = `CONNECTOR_${String(res.errorCode || 'ERROR').replace(/[^A-Z0-9_]/g, '').slice(0, 48)}`;
      if (res.errorCode === 'TIMEOUT') code = 'TIMEOUT';
      else if (res.retryable) code = 'TOOL_FAILURE';
      return { ...base, ok: false, code, message: String(res.error || 'Connector action failed') };
    }
    const verified = res.evidence ? res.evidence.verified : undefined;
    if (tier !== 'green') {
      if (verified === false) {
        return { ...base, ok: false, code: 'VERIFICATION_FAILED', message: 'The provider did not confirm the change.', verification: { status: 'failed', note: 'Connector reported verified=false.' } };
      }
      return { ...base, ok: true, verification: verified === true ? { status: 'verified' } : { status: 'unverified', note: 'The provider returned no confirmation.' } };
    }
    return { ...base, ok: true, verification: verified === true ? { status: 'verified' } : { status: 'not_applicable' } };
  }

  // Persists evidence for one attempted step and applies bounded-failure
  // policy. Returns true when the execution has been stopped.
  async function recordOutcome(workspaceId, id, rt, { step, tier, outcome, startedAt, approvalId = null, countFailure = true }) {
    const res = outcome.result;
    const verification = outcome.verification || { status: outcome.ok ? 'not_applicable' : 'failed', note: outcome.ok ? undefined : outcome.message };
    const index = rt.stepIndex;
    rt.stepIndex += 1;

    await store.insertStep({
      id: crypto.randomUUID(),
      execution_id: id,
      workspace_id: workspaceId,
      step_index: index,
      action: String(step.action).slice(0, 100),
      tool: (step.payload && step.payload.platform) || null,
      risk_tier: tier,
      status: outcome.ok ? 'succeeded' : 'failed',
      attempts: Math.min(outcome.attempts || 1, 10),
      output: redact({
        ...(() => { const p = redactActionPayload(step.payload || {}); return { parameters: p.parameters ?? null, target: p.target ?? null }; })(),
        message: res ? res.message || null : null,
        data: res ? summarizeData(res.data) : null,
        evidence: res && res.evidence ? { verified: res.evidence.verified ?? null, artifacts: res.evidence.artifacts || null } : null,
        planner_reason: step.reason || null,
      }),
      verification: redact(verification),
      error_code: outcome.ok ? null : outcome.code,
      error_message: outcome.ok ? null : redactString(outcome.message || '', 500),
      recovery: outcome.recovery ? redact(outcome.recovery) : null,
      approval_id: approvalId,
      started_at: startedAt.toISOString(),
      finished_at: now().toISOString(),
    });
    await markInflight(workspaceId, id, rt, null); // recorded → no longer in flight
    // Layer 7: meter what was actually sent (denied / never-executed steps are free).
    if (d.usage && !NOT_EXECUTED_CODES.has(outcome.code)) {
      d.usage.record(workspaceId, 'execution_step', 1, `step:${id}:${index}`, { source: 'agent_execution', sourceId: id, actorId: rt.createdBy }).catch(() => {});
      if (step.connector) {
        d.usage.record(workspaceId, 'connector_call', Math.max(1, Math.min(outcome.attempts || 1, 10)), `conn:${id}:${index}`, { source: 'connector', sourceId: id, actorId: rt.createdBy }).catch(() => {});
      }
    }

    await transition(workspaceId, id, ACTIVE, (cur) => ({ steps_executed: cur.steps_executed + 1 }));

    // Planner context (raw, in-memory only — same shape taskPlanner uses).
    // Layer 6 (firewall on): tool output reaches the planner only as
    // sanitized, clearly-marked untrusted DATA; injection signals taint the run.
    rt.history.push(modelSafeHistoryEntry({
      action: step.action,
      success: outcome.ok,
      error: outcome.ok ? undefined : `${outcome.code}: ${outcome.message}`,
      evidence: res && res.evidence ? { verified: res.evidence.verified } : null,
      data: res ? res.data || null : null,
      diagnosis: outcome.diagnosis || null,
    }, rt, workspaceId, id, { created_by: rt.createdBy }));

    if (outcome.ok) {
      rt.consecutiveFailures = 0;
      if (tier !== 'green' && verification.status === 'verified') rt.unresolvedVerification = null;
      return false;
    }
    if (outcome.code === 'VERIFICATION_FAILED' || outcome.code === 'MISSING_DATA') {
      rt.unresolvedVerification = { code: outcome.code, action: step.action, stepIndex: index };
    }
    if (!countFailure) return false;
    rt.consecutiveFailures += 1;
    if (rt.consecutiveFailures >= opt.maxConsecutiveFailures) {
      await fail(workspaceId, id, outcome.code,
        `${opt.maxConsecutiveFailures} consecutive failures; last on "${step.action}": ${outcome.message}`);
      return true;
    }
    return false;
  }

  async function verifyAndComplete(workspaceId, id, rt, reason) {
    const verifying = await transition(workspaceId, id, [STATUS.PLANNING], { status: STATUS.VERIFYING });
    if (!verifying) return;
    const steps = await store.listSteps(workspaceId, id);
    const succeeded = steps.filter((s) => s.status === 'succeeded');
    const stateChanging = succeeded.filter((s) => s.risk_tier !== 'green');
    const summary = {
      stepsExecuted: steps.length,
      stepsSucceeded: succeeded.length,
      stepsFailed: steps.length - succeeded.length,
      stateChangingSteps: stateChanging.length,
    };

    if (rt.unresolvedVerification) {
      await fail(workspaceId, id, 'VERIFICATION_FAILED',
        `Planner reported completion, but "${rt.unresolvedVerification.action}" (step ${rt.unresolvedVerification.stepIndex}) failed verification and was never resolved.`,
        { verification: { status: 'failed', ...summary } });
      return;
    }

    let status;
    let note;
    if (succeeded.length === 0) {
      status = 'unverified';
      note = 'Planner reported completion without executing any successful action.';
    } else if (stateChanging.length === 0) {
      status = 'not_applicable';
      note = 'Only read-only / low-risk actions were executed.';
    } else if (stateChanging.every((s) => s.verification && s.verification.status === 'verified')) {
      status = 'verified';
    } else {
      status = 'unverified';
      note = 'Some state-changing actions returned no verification evidence.';
    }

    await finish(workspaceId, id, STATUS.COMPLETED, {
      result: redact({ message: reason || 'Goal achieved.', ...summary }),
      verification: redact({ status, note: note || null, ...summary }),
    });
  }

  async function requestApproval(workspaceId, id, rt, step, tier, reason, decision = null) {
    const approvalId = crypto.randomUUID();
    const stepHash = sha256(stableStringify({ action: step.action, payload: step.payload }));
    const fwd = decision || (fwOn() ? rt.lastDecision : null);
    const policyVersion = fwd ? fwd.policyVersion : null;
    const ttlMs = fwd && fwd.approvalTtlMinutes ? Math.min(opt.approvalTtlMs, fwd.approvalTtlMinutes * 60000) : opt.approvalTtlMs;
    const binding = fwOn() ? approvalBinding({
      workspaceId, executionId: id, workflowContext: rt.workflowContext, stepIndex: rt.stepIndex, action: step.action, stepHash, tier, policyVersion,
    }) : null;
    await store.supersedePendingApprovals(workspaceId, id);
    await store.insertApproval({
      id: approvalId,
      execution_id: id,
      workspace_id: workspaceId,
      step_index: rt.stepIndex,
      action: step.action,
      risk_tier: tier,
      reason,
      step_hash: stepHash,
      step_summary: {
        ...redactActionPayload({ platform: step.payload?.platform || null, parameters: step.payload?.parameters || {}, target: step.payload?.target || {}, value: step.payload?.value ?? null }),
        plannerReason: step.reason ? redactString(step.reason, 500) : null,
      },
      required_role: tier === 'red' ? 'admin' : 'creator_or_admin',
      status: 'pending',
      expires_at: new Date(now().getTime() + ttlMs).toISOString(),
      ...(binding ? { binding_hash: binding, policy_version: policyVersion } : {}),
    });
    // Set BEFORE the status flips so an approval arriving immediately
    // after can never observe waiting_approval without the pending step.
    rt.pending = { step, approvalId, hash: stepHash, tier, binding };
    if (binding) {
      secEvent(workspaceId, rt.createdBy, 'approval_requested', {
        executionId: id, approvalId, action: step.action, risk: tier, reason, policyId: fwd ? fwd.policyId : null,
        reasons: fwd ? fwd.reasons : [],
      });
    }
    const waiting = await transition(workspaceId, id, [STATUS.PLANNING, STATUS.EXECUTING], {
      status: STATUS.WAITING_APPROVAL,
      pending_approval_id: approvalId,
    });
    if (!waiting) {
      rt.pending = null;
      await store.supersedePendingApprovals(workspaceId, id).catch(() => {});
    }
  }

  // ------------------------------------------------------------------
  // Views (never include raw payloads, hashes of steps, or runtime data)
  // ------------------------------------------------------------------
  function approvalView(a) {
    if (!a) return null;
    return {
      id: a.id,
      stepIndex: a.step_index,
      action: a.action,
      riskTier: a.risk_tier,
      reason: a.reason,
      requiredRole: a.required_role,
      status: a.status,
      step: a.step_summary,
      expiresAt: a.expires_at,
      decidedBy: a.decided_by || null,
      decidedAt: a.decided_at || null,
    };
  }

  function stepView(s) {
    return {
      index: s.step_index,
      action: s.action,
      tool: s.tool,
      riskTier: s.risk_tier,
      status: s.status,
      attempts: s.attempts,
      output: s.output,
      verification: s.verification,
      error: s.error_code ? { code: s.error_code, message: s.error_message } : null,
      recovery: s.recovery,
      approvalId: s.approval_id,
      startedAt: s.started_at,
      finishedAt: s.finished_at,
    };
  }

  function evidenceSummary(steps) {
    const by = (st) => steps.filter((s) => s.verification && s.verification.status === st).length;
    return {
      steps: steps.length,
      succeeded: steps.filter((s) => s.status === 'succeeded').length,
      failed: steps.filter((s) => s.status === 'failed').length,
      verified: by('verified'),
      unverified: by('unverified'),
      verificationFailed: by('failed'),
      retriesOrRecoveries: steps.filter((s) => s.recovery).length,
      lastStep: steps.length ? { index: steps[steps.length - 1].step_index, action: steps[steps.length - 1].action, status: steps[steps.length - 1].status } : null,
    };
  }

  async function executionView(e, { withDetails = true } = {}) {
    const rt = runtimes.get(e.id);
    const view = {
      id: e.id,
      workspaceId: e.workspace_id,
      taskId: e.task_id || null,
      agentId: e.agent_id || null, // Layer 10
      status: e.status,
      goal: e.goal,
      createdBy: e.created_by,
      currentStep: e.current_step,
      currentAction: rt && rt.currentAction ? rt.currentAction : null,
      progress: { stepsExecuted: e.steps_executed, maxSteps: e.max_steps },
      waitingForApproval: null,
      result: e.result || null,
      failure: e.failure_code ? { code: e.failure_code, message: e.failure_message } : null,
      verification: e.verification || null,
      createdAt: e.created_at,
      startedAt: e.started_at || null,
      finishedAt: e.finished_at || null,
      updatedAt: e.updated_at,
    };
    if (withDetails) {
      if (e.status === STATUS.WAITING_APPROVAL && e.pending_approval_id) {
        view.waitingForApproval = approvalView(await store.getApproval(e.workspace_id, e.id, e.pending_approval_id));
      }
      view.evidenceSummary = evidenceSummary(await store.listSteps(e.workspace_id, e.id));
    }
    return view;
  }

  // ------------------------------------------------------------------
  // Public API — every method takes a Layer 1 workspace context
  // ({ workspace, role, userId }) resolved server-side from the verified
  // Firebase uid; nothing workspace/user-related is read from the body.
  // ------------------------------------------------------------------
  function requireCtx(ctx) {
    if (!ctx || !ctx.workspace || !ctx.workspace.id || !ctx.userId) {
      throw new ExecutionError(401, 'AUTH_REQUIRED', 'Authentication required');
    }
    return ctx.workspace.id;
  }

  async function loadExecution(ctx, id) {
    const ws = requireCtx(ctx);
    if (typeof id !== 'string' || !UUID_RE.test(id)) throw notFound();
    const e = await store.getExecution(ws, id);
    if (!e) throw notFound();
    return reconcile(e);
  }

  function canManage(ctx, e) {
    return ctx.userId === e.created_by || isAdmin(ctx.role);
  }

  async function createExecution(ctx, { goal, idempotencyKey, taskId, approvalPolicy, trackInflight = false, connectorStep, workflowContext, agentId } = {}) {
    const ws = requireCtx(ctx);
    if (typeof goal !== 'string' || !goal.trim()) throw new ExecutionError(400, 'BAD_REQUEST', 'goal is required');
    const rawGoal = goal.trim();
    if (rawGoal.length > opt.maxGoalChars) throw new ExecutionError(400, 'BAD_REQUEST', `goal must be at most ${opt.maxGoalChars} characters`);
    if (idempotencyKey !== undefined && idempotencyKey !== null && (typeof idempotencyKey !== 'string' || !IDEMPOTENCY_KEY_RE.test(idempotencyKey))) {
      throw new ExecutionError(400, 'BAD_REQUEST', 'Idempotency key must be 8-128 characters of [A-Za-z0-9_.:-]');
    }
    if (d.isEmergencyStopActive()) {
      throw new ExecutionError(409, 'EMERGENCY_STOP_ACTIVE', 'Emergency stop is active; new executions are blocked.');
    }

    // Layer 2: optional link to a workspace task. The caller (taskService)
    // has already verified the task is in this workspace; the composite FK
    // (task_id, workspace_id) enforces it again in the database.
    if (taskId !== undefined && taskId !== null && (typeof taskId !== 'string' || !UUID_RE.test(taskId))) {
      throw new ExecutionError(400, 'BAD_REQUEST', 'Invalid task id');
    }
    if (approvalPolicy !== undefined && approvalPolicy !== null && approvalPolicy !== 'auto' && !APPROVAL_POLICY_TIER[approvalPolicy]) {
      throw new ExecutionError(400, 'BAD_REQUEST', 'Invalid approval policy');
    }
    if (trackInflight && typeof store.setInflight !== 'function') {
      throw new ExecutionError(500, 'INFLIGHT_UNSUPPORTED', 'Execution store cannot track in-flight actions');
    }
    // Layer 5: optional deterministic connector step (references only —
    // integration id, action, safe input; never credentials).
    let fixedSpec = null;
    if (connectorStep !== undefined && connectorStep !== null) {
      const cs = connectorStep;
      if (typeof cs !== 'object' || typeof cs.integrationId !== 'string' || !UUID_RE.test(cs.integrationId)
        || typeof cs.action !== 'string' || !/^[a-z][a-z0-9_]{1,63}$/.test(cs.action)
        || (cs.input !== undefined && (typeof cs.input !== 'object' || cs.input === null || Array.isArray(cs.input)))
        || (cs.idempotencyKey !== undefined && (typeof cs.idempotencyKey !== 'string' || !IDEMPOTENCY_KEY_RE.test(cs.idempotencyKey)))) {
        throw new ExecutionError(400, 'BAD_REQUEST', 'Invalid connector step');
      }
      fixedSpec = { integrationId: cs.integrationId, action: cs.action, input: cs.input || {}, ...(cs.idempotencyKey ? { idempotencyKey: cs.idempotencyKey } : {}) };
    }
    // Layer 6: which workflow run / version / step this execution belongs to
    // (part of every approval binding) and whether its inputs are tainted.
    let wfCtx = null;
    if (workflowContext !== undefined && workflowContext !== null) {
      const w = workflowContext;
      if (typeof w !== 'object' || (w.runId !== undefined && (typeof w.runId !== 'string' || !UUID_RE.test(w.runId)))
        || (w.versionId !== undefined && (typeof w.versionId !== 'string' || !UUID_RE.test(w.versionId)))
        || (w.position !== undefined && !Number.isInteger(w.position)) || (w.tainted !== undefined && typeof w.tainted !== 'boolean')) {
        throw new ExecutionError(400, 'BAD_REQUEST', 'Invalid workflow context');
      }
      wfCtx = { runId: w.runId || null, versionId: w.versionId || null, position: Number.isInteger(w.position) ? w.position : null, tainted: !!w.tainted };
    }
    // Layer 10: optional AI workforce agent (identity, instructions, limits).
    let agent = null;
    if (agentId !== undefined && agentId !== null) {
      if (typeof agentId !== 'string' || !UUID_RE.test(agentId)) throw new ExecutionError(404, 'AGENT_NOT_FOUND', 'Agent not found');
      if (!d.agents) throw new ExecutionError(503, 'AGENTS_UNAVAILABLE', 'AI workforce agents are not available on this server');
      agent = await d.agents.resolve(ws, agentId);
      if (!agent) throw new ExecutionError(404, 'AGENT_NOT_FOUND', 'Agent not found');
      if (agent.status !== 'active') throw new ExecutionError(409, 'AGENT_ARCHIVED', 'This agent is archived');
    }
    const hashBase0 = fixedSpec ? `${rawGoal}\nconnector:${stableStringify(fixedSpec)}` : rawGoal;
    const hashBase = agent ? `${hashBase0}\nagent:${agent.id}` : hashBase0;
    const goalHash = taskId ? sha256(`${ws}\ntask:${taskId}\n${hashBase}`) : sha256(`${ws}\n${hashBase}`);

    const replay = async (existing) => {
      if (existing.goal_hash !== goalHash) {
        throw new ExecutionError(409, 'IDEMPOTENCY_CONFLICT', 'This idempotency key was already used for a different request.');
      }
      return { execution: await executionView(await reconcile(existing)), replayed: true };
    };

    if (idempotencyKey) {
      const existing = await store.findByIdempotencyKey(ws, idempotencyKey);
      if (existing) return replay(existing);
    }

    const newId = crypto.randomUUID();
    // Layer 7: execution quota, reserved atomically BEFORE the execution
    // exists. A workflow step's retries share one key (run + position), so a
    // retried step is never charged twice; a replayed request never reaches here.
    let usageHandle = null;
    // Layer 9: plan concurrency limit (max_concurrent_executions). Layer 3 already
    // allows ONE active execution per workspace (DB unique index), so the plan
    // limit only has to refuse when it is below that (0); an active execution
    // is reported by the existing EXECUTION_IN_PROGRESS path below.
    if (d.usage && d.usage.checkEntitlement) {
      const c = await d.usage.checkEntitlement(ws, 'concurrent_executions', 1);
      const coveredByLayer3 = c.reason === 'LIMIT_REACHED' && c.used >= 1 && c.limit >= 1;
      if (!c.allowed && !coveredByLayer3) {
        if (c.reason === 'ENTITLEMENT_UNAVAILABLE') throw new ExecutionError(503, 'ENTITLEMENT_UNAVAILABLE', 'Usage limits could not be verified; the operation was not started.');
        throw new ExecutionError(402, 'QUOTA_EXCEEDED', "Your plan's limit for concurrent executions has been reached.", { capability: 'concurrent_executions', limit: c.limit, used: c.used, planId: c.planId });
      }
    }
    if (d.usage) {
      const usageKey = wfCtx && wfCtx.runId ? `exec:wf:${wfCtx.runId}:${wfCtx.position}` : `exec:${idempotencyKey || newId}`;
      try {
        usageHandle = await d.usage.begin(ws, 'executions', usageKey);
      } catch (err) {
        throw new ExecutionError(err.status || 503, err.code || 'ENTITLEMENT_UNAVAILABLE', err.message, err.extra);
      }
    }
    const releaseUsage = () => (usageHandle ? d.usage.release(usageHandle).catch(() => {}) : null);

    const row = {
      id: newId,
      workspace_id: ws,
      created_by: ctx.userId,
      goal: redactString(rawGoal, 4000),
      goal_hash: goalHash,
      status: STATUS.CREATED,
      idempotency_key: idempotencyKey || null,
      max_steps: opt.maxSteps,
      runner_id: runnerId,
      ...(taskId ? { task_id: taskId } : {}),
      ...(wfCtx ? { workflow_context: wfCtx } : {}),
      ...(agent ? { agent_id: agent.id } : {}),
      ...(leaseMs ? { lease_expires_at: leaseUntil() } : {}),
    };

    // Runtime is registered BEFORE the row exists, so a concurrent reader
    // can never mistake a just-created execution for an interrupted one.
    const rtInit = {
      // Layer 6 (firewall on): the planner LLM only ever sees a sanitized goal.
      // Layer 9: always sanitized (secrets never reach the model), firewall on or off.
      goal: agent && agent.instructions
        ? classifier.sanitizeString(`[Agent "${agent.name}" (${agent.role}). Standing instructions: ${agent.instructions}]\n\nTask: ${rawGoal}`, opt.maxGoalChars + 2400)
        : classifier.sanitizeString(rawGoal, opt.maxGoalChars + 200),
      agent: agent ? { id: agent.id, name: agent.name, role: agent.role, maxRisk: agent.maxRisk, allowedIntegrationIds: agent.allowedIntegrationIds || [] } : null,
      workspaceId: ws,
      createdBy: ctx.userId,
      workflowContext: wfCtx,
      tainted: !!(wfCtx && wfCtx.tainted),
      roleCap: ctx.apiKeyId ? 'member' : null,
      lastDecision: null,
      history: [],
      clarifications: [],
      consecutiveFailures: 0,
      plannerErrors: 0,
      unresolvedVerification: null,
      stepIndex: 0,
      pending: null,
      approved: null,
      cancelRequested: false,
      running: false,
      rerun: false,
      finished: false,
      currentAction: null,
      plannedTier: null,
      minTier: APPROVAL_POLICY_TIER[approvalPolicy] || null,
      trackInflight: !!trackInflight,
      fixedStep: fixedSpec ? { spec: fixedSpec, done: false, doneReason: null } : null,
      deadline: now().getTime() + opt.executionTimeoutMs,
    };
    runtimes.set(row.id, rtInit);
    let inserted;
    for (let attempt = 0; attempt < 2 && !inserted; attempt++) {
      try {
        inserted = await store.insertExecution(row);
      } catch (err) {
        if (err.code !== '23505') { runtimes.delete(row.id); await releaseUsage(); throw err; }
        runtimes.delete(row.id);
        if (idempotencyKey && /idempotency/i.test(`${err.message} ${err.details || ''}`)) {
          const existing = await store.findByIdempotencyKey(ws, idempotencyKey);
          if (existing) { await releaseUsage(); return replay(existing); }
        }
        const active = await store.findActiveExecution(ws);
        if (active && !runtimes.has(active.id) && attempt === 0) {
          await reconcile(active); // interrupted by a restart → failed, then retry once
          runtimes.set(row.id, rtInit);
          continue;
        }
        await releaseUsage();
        throw new ExecutionError(409, 'EXECUTION_IN_PROGRESS', 'Another execution is already active in this workspace.', active ? { activeExecutionId: active.id } : undefined);
      }
    }
    if (!inserted) { runtimes.delete(row.id); await releaseUsage(); throw new ExecutionError(409, 'EXECUTION_IN_PROGRESS', 'Another execution is already active in this workspace.'); }
    if (usageHandle) {
      // The execution exists → the usage event is final (idempotent by key).
      // A ledger write failure here is logged, never turned into a failed request.
      await d.usage.commit(usageHandle, { source: 'agent_execution', sourceId: inserted.id, actorId: ctx.userId })
        .catch((err) => logger.error?.(`[agentExecution] usage commit failed: ${err.code || err.message}`));
    }

    audit(ctx.userId, 'agent_execution_created', { executionId: inserted.id, workspaceId: ws }, { success: true });
    startLeaseHeartbeat();
    kick(ws, inserted.id);
    return { execution: await executionView(inserted), replayed: false };
  }

  async function getExecution(ctx, id) {
    return executionView(await loadExecution(ctx, id));
  }

  async function listExecutions(ctx, { limit } = {}) {
    const ws = requireCtx(ctx);
    const n = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 100);
    const rows = await store.listExecutions(ws, { limit: n });
    const out = [];
    for (const r of rows) out.push(await executionView(await reconcile(r), { withDetails: false }));
    return out;
  }

  /**
   * Layer 9 (automation API): one page of executions, newest first, list
   * view (no step details). { status?, limit? (1-100), cursor? } → { items, nextCursor }
   */
  async function pageExecutions(ctx, { status, limit, cursor } = {}) {
    const ws = requireCtx(ctx);
    const P = require('../automation/pagination');
    const n = P.parseLimit(limit);
    const before = P.decodeCursor(cursor);
    const STATUSES = ['created', 'planning', 'waiting_approval', 'executing', 'verifying', 'completed', 'failed', 'cancelled'];
    if (status !== undefined && !STATUSES.includes(status)) throw new ExecutionError(400, 'INVALID_FILTER', `status must be one of ${STATUSES.join(', ')}.`);
    const rows = await store.listExecutions(ws, { status, before, limit: n + 1 });
    const more = rows.length > n;
    const items = [];
    for (const r of rows.slice(0, n)) items.push(await executionView(await reconcile(r), { withDetails: false }));
    return { items, nextCursor: more ? P.encodeCursor(rows[n - 1]) : null };
  }

  // Layer 2: executions linked to a workspace task (caller verifies the task).
  async function listTaskExecutions(ctx, taskId, { limit = 20 } = {}) {
    const ws = requireCtx(ctx);
    if (typeof taskId !== 'string' || !UUID_RE.test(taskId)) return [];
    const rows = await store.listExecutionsForTask(ws, taskId, { limit });
    const out = [];
    for (const r of rows) out.push(await executionView(await reconcile(r)));
    return out;
  }

  async function getEvidence(ctx, id) {
    const e = await loadExecution(ctx, id);
    const [steps, approvals] = await Promise.all([
      store.listSteps(e.workspace_id, e.id),
      store.listApprovals(e.workspace_id, e.id),
    ]);
    return {
      execution: await executionView(e),
      steps: steps.map(stepView),
      approvals: approvals.map(approvalView),
    };
  }

  async function decideApproval(ctx, id, approvalId, body = {}) {
    const lim = fwOn() && d.firewall.rateLimiter ? d.firewall.rateLimiter : null;
    const ws = ctx && ctx.workspace ? ctx.workspace.id : null;
    if (lim && ws && ctx.userId && (await lim.peek(['apprfail', ws, ctx.userId], 300)) >= 10) {
      throw new ExecutionError(429, 'TOO_MANY_FAILED_APPROVALS', 'Too many failed approval attempts; try again later.');
    }
    try {
      return await decideApprovalInner(ctx, id, approvalId, body);
    } catch (err) {
      if (lim && ws && ctx.userId && err instanceof ExecutionError && [403, 404, 409, 410].includes(err.status)) {
        await lim.hit(['apprfail', ws, ctx.userId], 300, 10);
        if (err.code === 'STALE_APPROVAL') secEvent(ws, ctx.userId, 'approval_rejected_stale', { executionId: id, approvalId }, { success: false });
      }
      throw err;
    }
  }

  async function decideApprovalInner(ctx, id, approvalId, { decision, note } = {}) {
    if (decision !== 'approve' && decision !== 'reject') {
      throw new ExecutionError(400, 'BAD_REQUEST', "decision must be 'approve' or 'reject'");
    }
    // Layer 6: approvals are human decisions — a workspace API key can never make one.
    if (ctx && ctx.apiKeyId) throw new ExecutionError(403, 'FORBIDDEN', 'API keys cannot decide approvals.');
    const e = await loadExecution(ctx, id);
    if (typeof approvalId !== 'string' || !UUID_RE.test(approvalId)) {
      throw new ExecutionError(404, 'APPROVAL_NOT_FOUND', 'Approval not found');
    }
    const a = await store.getApproval(e.workspace_id, e.id, approvalId);
    if (!a) throw new ExecutionError(404, 'APPROVAL_NOT_FOUND', 'Approval not found');

    // ctx.role is the caller's CURRENT membership role (resolved per request).
    const allowed = a.required_role === 'admin' ? isAdmin(ctx.role) : canManage(ctx, e);
    if (!allowed) {
      throw new ExecutionError(403, 'FORBIDDEN', a.required_role === 'admin'
        ? 'Only a workspace owner or admin can approve a high-risk (RED) action.'
        : 'Only the execution creator or a workspace admin can approve this action.');
    }
    if (a.status !== 'pending') {
      throw new ExecutionError(409, 'APPROVAL_NOT_PENDING', `Approval is already ${a.status}.`);
    }
    if (new Date(a.expires_at).getTime() <= now().getTime()) {
      await store.transitionApproval(e.workspace_id, a.id, 'pending', { status: 'expired', decided_at: now().toISOString() });
      await fail(e.workspace_id, e.id, 'APPROVAL_EXPIRED', 'The approval request expired before a decision was made.');
      throw new ExecutionError(410, 'APPROVAL_EXPIRED', 'This approval request has expired.');
    }
    const rt = runtimes.get(e.id);
    // Layer 6: the execution is owned by another live instance → decide
    // here (DB compare-and-set); the owner applies it on its next heartbeat.
    const remote = !rt && !!leaseMs && !!e.lease_expires_at && Date.parse(e.lease_expires_at) > now().getTime();
    const current = e.status === STATUS.WAITING_APPROVAL && e.pending_approval_id === a.id
      && (remote || (rt && rt.pending && rt.pending.approvalId === a.id && rt.pending.hash === a.step_hash));
    if (!current) {
      await store.transitionApproval(e.workspace_id, a.id, 'pending', { status: 'superseded', decided_at: now().toISOString() });
      throw new ExecutionError(409, 'STALE_APPROVAL', 'This approval no longer matches the execution\'s current step.');
    }
    if (fwOn()) {
      // Binding: workspace, execution, workflow run/version/step, step index,
      // action, exact step payload hash, risk and the policy version it was
      // requested under. Any change (or a tampered row) → stale.
      const expect = approvalBinding({
        workspaceId: e.workspace_id, executionId: e.id, workflowContext: e.workflow_context || null, stepIndex: a.step_index,
        action: a.action, stepHash: a.step_hash, tier: a.risk_tier, policyVersion: a.policy_version,
      });
      let policyVersion = null;
      try { policyVersion = (await d.firewall.loadPolicy(e.workspace_id, { fresh: true })).version; } catch { policyVersion = undefined; }
      const localBinding = rt && rt.pending ? rt.pending.binding : a.binding_hash;
      if (!a.binding_hash || a.binding_hash !== expect || localBinding !== a.binding_hash || policyVersion !== a.policy_version) {
        await store.transitionApproval(e.workspace_id, a.id, 'pending', { status: 'superseded', decided_at: now().toISOString() });
        await fail(e.workspace_id, e.id, 'STALE_APPROVAL', policyVersion !== a.policy_version
          ? 'The workspace security policy changed while this action was waiting for approval.'
          : 'The approval no longer matches the step it was requested for.');
        throw new ExecutionError(409, 'STALE_APPROVAL', 'This approval no longer matches the execution\'s current step or policy.');
      }
    }

    const claimed = await store.transitionApproval(e.workspace_id, a.id, 'pending', {
      status: decision === 'approve' ? 'approved' : 'rejected',
      decided_by: ctx.userId,
      decided_at: now().toISOString(),
      decision_note: note ? redactString(String(note), 500) : null,
    });
    if (!claimed) throw new ExecutionError(409, 'APPROVAL_NOT_PENDING', 'Approval was already decided.');
    audit(ctx.userId, `agent_execution_approval_${decision}`, {
      executionId: e.id, workspaceId: e.workspace_id, approvalId: a.id, action: a.action, riskTier: a.risk_tier,
    }, { success: true });
    secEvent(e.workspace_id, ctx.userId, decision === 'approve' ? 'approval_granted' : 'approval_rejected', {
      executionId: e.id, approvalId: a.id, action: a.action, risk: a.risk_tier, remote,
    });

    if (remote) {
      return { execution: await executionView(await store.getExecution(e.workspace_id, e.id)), approval: approvalView(claimed), remote: true };
    }

    const pending = rt.pending;
    rt.pending = null;

    if (decision === 'reject') {
      await fail(e.workspace_id, e.id, 'APPROVAL_REJECTED', `Approval for "${a.action}" was rejected.`);
      return { execution: await executionView(await store.getExecution(e.workspace_id, e.id)), approval: approvalView(claimed) };
    }

    const resumed = await transition(e.workspace_id, e.id, [STATUS.WAITING_APPROVAL], {
      status: STATUS.EXECUTING,
      pending_approval_id: null,
    });
    if (!resumed) throw new ExecutionError(409, 'STALE_APPROVAL', 'Execution is no longer waiting for this approval.');
    rt.approved = {
      step: pending.step,
      tier: pending.tier,
      approvalId: a.id,
      token: `appr_${crypto.randomBytes(24).toString('hex')}`,
    };
    kick(e.workspace_id, e.id);
    return { execution: await executionView(resumed), approval: approvalView(claimed) };
  }

  async function cancelExecution(ctx, id) {
    const e = await loadExecution(ctx, id);
    if (!canManage(ctx, e)) {
      throw new ExecutionError(403, 'FORBIDDEN', 'Only the execution creator or a workspace admin can cancel it.');
    }
    if (TERMINAL.has(e.status)) {
      throw new ExecutionError(409, 'EXECUTION_FINISHED', `Execution is already ${e.status}.`);
    }
    const rt = runtimes.get(e.id);
    if (rt) rt.cancelRequested = true;
    const updated = await finish(e.workspace_id, e.id, STATUS.CANCELLED, {
      failure_code: 'CANCELLED',
      failure_message: 'Cancelled by a user.',
    });
    if (!updated) throw new ExecutionError(409, 'EXECUTION_FINISHED', 'Execution already finished.');
    audit(ctx.userId, 'agent_execution_cancel', { executionId: e.id, workspaceId: e.workspace_id }, { success: true });
    return executionView(updated);
  }

  // ------------------------------------------------------------------
  // Layer 4 internal hooks (NOT routed; used by the workflow runner,
  // which has already authorized the run in its own workspace).
  // ------------------------------------------------------------------
  function hasRuntime(id) {
    return runtimes.has(id);
  }

  /** Layer 5: attach the integrations gateway (prepareAction / executeAction). */
  function setConnectorGateway(gateway) {
    d.connectorGateway = gateway || null;
  }

  /** Layer 7: attach the usage meter / entitlement service (null detaches it). */
  function setUsageMeter(meter) {
    d.usage = meter || null;
  }

  /** Layer 10: AI workforce agent resolver ({ resolve(ws, id) }) and terminal-state listeners. */
  function setAgentResolver(r) { d.agents = r || null; }
  function addFinishListener(fn) { if (typeof fn === 'function') finishListeners.push(fn); }

  /** Layer 6: attach the Agent Firewall (null detaches it; approvals are unaffected). */
  function setFirewall(firewall) {
    d.firewall = firewall || null;
  }

  function stopLeaseHeartbeat() {
    if (leaseTimer) clearInterval(leaseTimer);
    leaseTimer = null;
  }

  /** Stops an active execution (run cancelled / timed out / approval expired). */
  async function abortExecution(workspaceId, id, { status = STATUS.CANCELLED, code = 'CANCELLED', message = 'Cancelled.' } = {}) {
    if (status !== STATUS.CANCELLED && status !== STATUS.FAILED) throw new Error('abortExecution: invalid status');
    const rt = runtimes.get(id);
    if (rt) rt.cancelRequested = true;
    return finish(workspaceId, id, status, { failure_code: code, failure_message: redactString(message, 500) });
  }

  return {
    createExecution,
    getExecution,
    listExecutions,
    pageExecutions,
    getEvidence,
    listTaskExecutions,
    decideApproval,
    cancelExecution,
    hasRuntime,
    abortExecution,
    setConnectorGateway,
    setFirewall,
    setUsageMeter,
    setAgentResolver,
    addFinishListener,
    stopLeaseHeartbeat,
    // exposed for tests / ops
    _heartbeatLeases: heartbeatLeases,
    _runtimes: runtimes,
    _drive: drive,
    runnerId,
  };
}

module.exports = { createAgentExecutionService, ExecutionError, STATUS, DEFAULTS };
