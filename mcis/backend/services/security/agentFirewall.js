/**
 * Layer 6 — Agent Firewall: the ONE decision point in front of every
 * external / tool action an agent takes in a workspace.
 *
 *   evaluateAgentAction({ workspaceId, actorId, executionId, workflowRunId,
 *                         integrationId, action, resource, input, … })
 *     → { decision: ALLOW | APPROVAL_REQUIRED | DENY, risk, reasons,
 *         policyId, policyVersion, requiredRole, ticket? }
 *
 * Called by Layer 3 for EVERY step (planner browser/desktop/file actions
 * and Layer 5 connector actions) twice: when the step is planned (to
 * decide deny / approval) and again right before it executes (fresh
 * policy, fresh role — a decision that got stricter since the approval
 * stops the step). Layer 3's approval gate remains the only approval
 * mechanism; the firewall only decides WHETHER one is needed.
 *
 * Connector bypass protection: an ALLOW / approved execute-time decision
 * for a connector carries a short-lived, single-use HMAC ticket bound to
 * workspace + actor + integration + action + exact input. The Layer 5
 * gateway refuses to execute without a valid ticket, so no code path can
 * reach a connector without passing through here.
 *
 * Trust: the policy is read from the database by workspace id; the
 * actor's role is re-read from membership (never from the caller); API-key
 * actors are capped at `member`. External content (tool output, web pages,
 * connector results) never flows into this function except as the boolean
 * `tainted`, which can only make decisions STRICTER.
 *
 * Fail closed: if the policy cannot be loaded or is corrupt, every action
 * is denied (POLICY_UNAVAILABLE).
 */
'use strict';

const crypto = require('crypto');
const { decide, effectivePolicy, DECISION } = require('./policyEngine');
const { findSecrets } = require('./sensitiveClassifier');

const DEFAULTS = Object.freeze({
  policyCacheMs: 5000,
  ticketTtlMs: 60 * 1000,
  connectorLimit: { limit: 120, windowSeconds: 60 },    // connector executions / workspace
  denyBurst: { limit: 10, windowSeconds: 300 },          // denials / actor before throttling
});

function stable(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stable(value[k])}`).join(',')}}`;
}
const sha = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');

function createAgentFirewall({ store, getMemberRole, events, rateLimiter, logger = console, options = {} } = {}) {
  if (!store || !getMemberRole) throw new Error('agent firewall: store and getMemberRole are required');
  const opt = { ...DEFAULTS, ...options };
  const now = opt.now || (() => new Date());
  const ticketKey = crypto.randomBytes(32);
  const usedTickets = new Map(); // nonce -> expiry
  const cache = new Map(); // ws -> { at, value }

  async function loadPolicy(workspaceId, { fresh = false } = {}) {
    const c = cache.get(workspaceId);
    if (!fresh && c && now().getTime() - c.at < opt.policyCacheMs) return c.value;
    const row = await store.getPolicy(workspaceId);
    const value = {
      policy: effectivePolicy(row ? row.policy : null), // re-validated: corrupt → throws → fail closed
      version: row ? row.version : 0,
      policyId: row ? `ws:${workspaceId}:v${row.version}` : 'builtin-default',
      isDefault: !row,
    };
    cache.set(workspaceId, { at: now().getTime(), value });
    return value;
  }
  function invalidate(workspaceId) { cache.delete(workspaceId); }

  function ticketPayload(t) {
    return [t.workspaceId, t.actorId, t.integrationId, t.action, sha(stable(t.input || {})), t.exp, t.nonce].join('|');
  }
  function issueTicket(t) {
    const exp = now().getTime() + opt.ticketTtlMs;
    const nonce = crypto.randomBytes(12).toString('hex');
    const mac = crypto.createHmac('sha256', ticketKey).update(ticketPayload({ ...t, exp, nonce })).digest('hex');
    return `fwt1.${exp}.${nonce}.${mac}`;
  }
  /** Single use; bound to the exact action + input. */
  function consumeTicket(ticket, t) {
    if (typeof ticket !== 'string') return false;
    const m = /^fwt1\.(\d{10,16})\.([0-9a-f]{24})\.([0-9a-f]{64})$/.exec(ticket);
    if (!m) return false;
    const exp = Number(m[1]);
    const nonce = m[2];
    if (exp <= now().getTime() || usedTickets.has(nonce)) return false;
    const expect = crypto.createHmac('sha256', ticketKey).update(ticketPayload({ ...t, exp, nonce })).digest();
    const got = Buffer.from(m[3], 'hex');
    if (got.length !== expect.length || !crypto.timingSafeEqual(got, expect)) return false;
    usedTickets.set(nonce, exp);
    if (usedTickets.size > 5000) for (const [n, e] of usedTickets) if (e <= now().getTime()) usedTickets.delete(n);
    return true;
  }

  const record = (ws, actor, type, payload, extra) => { try { events && events.record(ws, actor, type, payload, extra); } catch { /* never breaks */ } };

  /**
   * phase: 'plan' (before approval) | 'execute' (right before the call).
   * approved: true when Layer 3 holds a valid, bound approval for this step.
   */
  async function evaluateAgentAction(req = {}) {
    const {
      workspaceId, actorId, executionId = null, workflowRunId = null, integrationId = null, provider = null,
      action, executionType, baseRisk = 'red', readOnly = false, resource = {}, input = {}, tainted = false,
      roleCap = null, phase = 'plan', approved = false,
    } = req;
    const base = { workspaceId, actorId, executionId, workflowRunId, integrationId, provider, action, executionType, phase };
    const deny = (reason, risk = 'red', extra = {}) => ({
      decision: DECISION.DENY, risk, reasons: [reason], policyId: extra.policyId || null, policyVersion: extra.policyVersion || 0, requiredRole: 'owner',
    });
    let result;
    if (!workspaceId || !actorId || !action || !executionType) {
      result = deny('INVALID_FIREWALL_REQUEST');
    } else {
      let pol;
      let role;
      try {
        pol = await loadPolicy(workspaceId, { fresh: phase === 'execute' });
        role = await getMemberRole(workspaceId, actorId);
      } catch (err) {
        logger.error?.(`[firewall] policy/role unavailable: ${err.code || err.name}`);
        result = deny('POLICY_UNAVAILABLE');
      }
      if (!result) {
        if (role && roleCap === 'member') role = 'member';
        result = decide({
          workspaceId, role, executionType, action, provider, integrationId, baseRisk, readOnly, resource, input, tainted,
          inputSecretKinds: findSecrets(input).map((f) => f.kind), now: now(),
        }, pol.policy, { policyId: pol.policyId, policyVersion: pol.version });
        result.approvalTtlMinutes = pol.policy.approval.ttlMinutes;

        // Suspicious repeated denials → throttle further state-changing actions.
        if (rateLimiter && result.decision !== DECISION.DENY && !readOnly) {
          const n = await rateLimiter.peek(['deny', workspaceId, actorId], opt.denyBurst.windowSeconds);
          if (n > opt.denyBurst.limit) result = { ...result, decision: DECISION.DENY, reasons: [...result.reasons, 'SUSPICIOUS_ACTIVITY_THROTTLED'] };
        }
        // Connector execution rate (execute phase only: one count per real call).
        if (rateLimiter && executionType === 'connector' && phase === 'execute' && result.decision !== DECISION.DENY) {
          const ok = await rateLimiter.hit(['conn', workspaceId], opt.connectorLimit.windowSeconds, opt.connectorLimit.limit);
          if (!ok) {
            result = { ...result, decision: DECISION.DENY, reasons: [...result.reasons, 'RATE_LIMITED'] };
            record(workspaceId, actorId, 'rate_limited', { ...base, bucket: 'connector_executions' }, { success: false });
          }
        }
      }
    }

    if (result.decision === DECISION.DENY) {
      record(workspaceId, actorId, 'policy_deny', { ...base, risk: result.risk, reasons: result.reasons, policyId: result.policyId }, { success: false });
      if (result.reasons.some((r) => r === 'CREDENTIAL_EXTRACTION_BLOCKED')) record(workspaceId, actorId, 'credential_access_denied', { ...base }, { success: false });
      if (result.reasons.includes('SENSITIVE_DATA_IN_INPUT')) record(workspaceId, actorId, 'sensitive_data_blocked', { ...base }, { success: false });
      if (executionType === 'connector') record(workspaceId, actorId, 'connector_blocked', { ...base, reasons: result.reasons }, { success: false });
      if (rateLimiter && workspaceId && actorId) {
        const within = await rateLimiter.hit(['deny', workspaceId, actorId], opt.denyBurst.windowSeconds, opt.denyBurst.limit);
        if (!within && (await rateLimiter.hit(['susp', workspaceId, actorId], opt.denyBurst.windowSeconds, 1))) {
          record(workspaceId, actorId, 'suspicious_activity', { ...base, reason: 'repeated policy denials' }, { success: false });
        }
      }
      return result;
    }
    if (phase === 'execute') {
      if (result.decision === DECISION.APPROVAL_REQUIRED && !approved) {
        // Stricter than when the step was planned (policy/role changed): stop.
        const r = { ...result, decision: DECISION.DENY, reasons: [...result.reasons, 'APPROVAL_REQUIRED_BUT_NOT_APPROVED'] };
        record(workspaceId, actorId, 'policy_deny', { ...base, risk: r.risk, reasons: r.reasons, policyId: r.policyId }, { success: false });
        return r;
      }
      record(workspaceId, actorId, 'policy_allow', { ...base, risk: result.risk, reasons: result.reasons, policyId: result.policyId, approved: !!approved });
      if (executionType === 'connector') {
        result.ticket = issueTicket({ workspaceId, actorId, integrationId, action, input });
      }
    }
    return result;
  }

  return {
    enabled: true,
    evaluateAgentAction,
    consumeTicket,
    loadPolicy,
    invalidate,
    events,
    rateLimiter,
  };
}

module.exports = { createAgentFirewall, DECISION, DEFAULTS: DEFAULTS, stable };
