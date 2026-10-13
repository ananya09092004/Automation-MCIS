/**
 * Layer 10 — server-initiated connector actions (monitoring checks, alert
 * notifications, QA verification probes) through the SAME security path as
 * agent steps:
 *
 *   gateway.prepareAction   integration ∈ workspace, connected, action
 *                           enabled, actor's CURRENT role ≥ minRole, input valid
 *   firewall (plan)         workspace policy: deny / approval
 *   firewall (execute)      fresh policy + role, single-use ticket bound to
 *                           this exact action + input
 *   gateway.executeAction   consumes the ticket, decrypts the credential only
 *                           here, SSRF-safe client, secret scrubbing, audit
 *
 * Background jobs cannot wait for a human, so APPROVAL_REQUIRED is reported
 * as `blocked` (never executed) exactly like DENY — the caller records it
 * (monitor UNAVAILABLE / delivery `blocked`) instead of pretending success.
 *
 * When no firewall is attached (SECURITY_FIREWALL_ENABLED=false) only
 * GREEN actions run; anything that would need approval is blocked.
 */
'use strict';

const crypto = require('crypto');

function createConnectorActions({ integrationService, getFirewall = () => null, logger = console } = {}) {
  if (!integrationService || !integrationService.gateway) throw new Error('connector actions: integrationService is required');
  const gw = integrationService.gateway;

  /**
   * @returns {Promise<{ ok, blocked?, code?, message?, data?, verified?, decision?, retryable? }>}
   */
  async function run({ workspaceId, actorId, integrationId, action, input = {}, idempotencyKey = null, sourceId = null, tainted = false }) {
    const spec = { integrationId, action, input };
    let prepared;
    try {
      prepared = await gw.prepareAction(workspaceId, actorId, spec);
    } catch (err) {
      return { ok: false, blocked: true, code: err.code || 'CONNECTOR_UNAVAILABLE', message: String(err.message || 'Connector unavailable').slice(0, 300) };
    }
    const fw = getFirewall();
    let ticket;
    if (fw) {
      const req = {
        workspaceId, actorId, executionId: null, workflowRunId: null, integrationId, provider: prepared.provider,
        action, executionType: 'connector', baseRisk: prepared.tier, readOnly: prepared.readOnly, resource: prepared.resource || {},
        input: prepared.input, tainted: !!tainted, roleCap: null,
      };
      const plan = await fw.evaluateAgentAction({ ...req, phase: 'plan' });
      if (plan.decision !== 'ALLOW') {
        return { ok: false, blocked: true, code: plan.decision === 'DENY' ? 'POLICY_DENIED' : 'APPROVAL_REQUIRED', message: `Blocked by the workspace Agent Firewall (${(plan.reasons || []).join(', ') || plan.decision}).`, decision: plan };
      }
      const exec = await fw.evaluateAgentAction({ ...req, phase: 'execute', approved: false });
      if (exec.decision !== 'ALLOW' || !exec.ticket) {
        return { ok: false, blocked: true, code: 'POLICY_DENIED', message: `Blocked by the workspace Agent Firewall (${(exec.reasons || []).join(', ') || exec.decision}).`, decision: exec };
      }
      ticket = exec.ticket;
    } else if (prepared.tier !== 'green') {
      return { ok: false, blocked: true, code: 'APPROVAL_REQUIRED', message: 'This action needs approval and cannot run unattended.' };
    }
    // The gateway re-validates the input: pass exactly what the ticket was bound to.
    const out = await gw.executeAction(workspaceId, actorId, { integrationId, action, input: prepared.input }, {
      executionId: null, idempotencyKey: idempotencyKey || `nexus-${sourceId || crypto.randomUUID()}`.slice(0, 200), firewallTicket: ticket,
    });
    if (!out.success) {
      if (out.errorCode === 'FIREWALL_BYPASS_BLOCKED') logger.error?.('[connector-actions] firewall ticket rejected by gateway');
      return { ok: false, blocked: false, code: out.errorCode || 'CONNECTOR_ERROR', message: out.error, retryable: !!out.retryable };
    }
    return { ok: true, data: out.data, message: out.message, verified: !!(out.evidence && out.evidence.verified), provider: prepared.provider, target: prepared.target };
  }

  return { run };
}

module.exports = { createConnectorActions };
