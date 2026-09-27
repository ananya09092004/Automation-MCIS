/**
 * Layer 8 — workflow templates on top of the Layer 4 workflow service.
 *
 *   listTemplates(ctx)                      catalogue + per-workspace integration availability
 *   getTemplate(ctx, id)
 *   instantiate(ctx, id, { name?, integrations?, publish? })
 *     → a normal Layer 4 DRAFT workflow created by the caller (optionally
 *       published by the caller, under Layer 4's own publish rules)
 *
 * Security:
 *   - the client picks a template id, an optional name and (for connector
 *     steps) which of ITS workspace's integrations to use. It can never
 *     supply steps, approvals or policies: the definition comes only from
 *     the frozen catalogue, so a template cannot be used to lower approval
 *     requirements or add actions.
 *   - integration references are validated against the caller's workspace
 *     (Layer 5 validateStepReference) and must match the template's
 *     provider + action; other workspaces' integrations are invisible (404).
 *   - everything the workflow later does runs through Layer 3/4/5/6/7
 *     unchanged (firewall, approvals, quotas, evidence, audit).
 *   - plan feature `workflow_templates` (Layer 8 plan features) is honoured
 *     when billing is enforced.
 */
'use strict';

const { WorkspaceError } = require('../workspaceService');
const { CATALOG, CATEGORIES, USE_CASES } = require('./catalog');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function createTemplateService({ workflowService, integrationStore = null, integrationResolver = null, entitlements = null, appendAuditLog = null, enabled = true, logger = console, agents = null } = {}) {
  if (!workflowService) throw new Error('template service: workflowService is required');
  let agentService = agents; // Layer 10: AI workforce agents for agentTemplate steps
  const byId = new Map(CATALOG.map((t) => [t.id, t]));

  const requireCtx = (ctx) => {
    if (!ctx || !ctx.workspace || !ctx.workspace.id || !ctx.userId) throw new WorkspaceError(401, 'AUTH_REQUIRED', 'Authentication required');
    if (!enabled) throw new WorkspaceError(404, 'TEMPLATES_DISABLED', 'Workflow templates are not enabled on this server.');
    return ctx.workspace.id;
  };
  const audit = (ctx, action, payload, success = true) => {
    if (!appendAuditLog) return;
    try { Promise.resolve(appendAuditLog(ctx.userId, action, payload, { success }, ctx.workspace.id)).catch(() => {}); } catch { /* never breaks the request */ }
  };

  /** Connected integrations of THIS workspace (one query; no secrets). */
  async function connectedIntegrations(ws) {
    if (!integrationStore || !integrationResolver) return [];
    try {
      return (await integrationStore.listIntegrations(ws)).filter((i) => i.status === 'connected').map((i) => ({ id: i.id, name: i.name, provider: i.provider }));
    } catch (err) {
      logger.warn?.(`[templates] integrations unavailable (${err.code || err.name})`);
      return [];
    }
  }

  function view(t, integrations) {
    const required = t.requiredIntegrations.map((r) => {
      const candidates = integrations.filter((i) => i.provider === r.provider).map((i) => ({ id: i.id, name: i.name }));
      return { provider: r.provider, action: r.action, label: r.label, available: candidates.length > 0, candidates };
    });
    return {
      id: t.id,
      name: t.name,
      description: t.description,
      category: t.category,
      useCases: t.useCases,
      riskLevel: t.riskLevel,
      expectedOutput: t.expectedOutput,
      inputs: t.definition.variables.map((v) => ({ name: v.name, label: v.label, type: v.type, required: v.required !== false, ...(v.options ? { options: v.options } : {}), ...(v.default !== undefined ? { default: v.default } : {}) })),
      steps: t.definition.steps.map((s) => ({
        key: s.key, name: s.name, approval: s.approval || 'auto', verification: s.verification || 'best_effort',
        kind: s.type === 'review' ? 'review' : (s.connectorTemplate ? 'connector' : 'agent'), ...(s.connectorTemplate ? { provider: s.connectorTemplate.provider, action: s.connectorTemplate.action } : {}),
        ...(s.agentTemplate ? { agentRole: s.agentTemplate } : {}),
      })),
      requiresApproval: t.definition.steps.some((s) => s.approval && s.approval !== 'auto'),
      // Layer 10: what running it involves, derived from the steps themselves (never hand-written claims).
      requiresHumanReview: t.definition.steps.some((s) => s.type === 'review'),
      requiredAgents: t.requiredAgents || [],
      permissions: [
        ...new Set(t.definition.steps.map((s) => (s.connectorTemplate ? `${s.connectorTemplate.provider}.${s.connectorTemplate.action}` : (s.type === 'review' ? 'human review' : 'agent actions on the connected computer / browser (Agent Firewall)')))),
      ],
      expectedEvidence: t.definition.steps.map((s) => ({
        step: s.key,
        evidence: s.type === 'review' ? 'reviewer decision, reviewer id, time and note'
          : (s.connectorTemplate ? 'connector request target, response summary and provider acknowledgement' : 'executed actions with per-step verification'),
        verification: s.type === 'review' ? 'human' : (s.verification || 'best_effort'),
      })),
      failureBehavior: 'A failed step fails the run and blocks its task; a step whose retry is not safe (possible duplicate write) pauses the run for a person to decide.',
      retryBehavior: t.definition.steps.map((s) => ({ step: s.key, automaticRetries: s.type === 'review' ? 0 : ((s.retry && s.retry.maxAttempts) || 0) })),
      requiredIntegrations: required,
      available: required.every((r) => r.available),
      onboarding: !!t.onboarding,
    };
  }

  async function listTemplates(ctx, { category, useCase } = {}) {
    const ws = requireCtx(ctx);
    const integrations = await connectedIntegrations(ws);
    return CATALOG
      .filter((t) => (!category || t.category === category) && (!useCase || t.useCases.includes(useCase)))
      .map((t) => view(t, integrations));
  }

  async function getTemplate(ctx, id) {
    const ws = requireCtx(ctx);
    const t = typeof id === 'string' ? byId.get(id) : null;
    if (!t) throw new WorkspaceError(404, 'TEMPLATE_NOT_FOUND', 'Template not found');
    return view(t, await connectedIntegrations(ws));
  }

  /** Builds the Layer 4 definition, binding connector steps to THIS workspace's integrations. */
  async function buildDefinition(ws, t, integrations = {}, agentChoice = {}, ctx = null) {
    const def = JSON.parse(JSON.stringify(t.definition));
    // Layer 10: bind agentTemplate steps to this workspace's AI workforce agents.
    const agentSteps = def.steps.filter((s) => s.agentTemplate);
    if (agentSteps.length) {
      if (!agentService) throw new WorkspaceError(409, 'AGENTS_UNAVAILABLE', 'This template needs AI workforce agents, which are not enabled on this server.');
      const active = await agentService.list(ctx, { status: 'active' });
      for (const s of agentSteps) {
        const role = s.agentTemplate;
        const chosen = agentChoice && typeof agentChoice === 'object' ? agentChoice[role] : undefined;
        const agent = chosen !== undefined ? active.find((a) => a.id === String(chosen).toLowerCase()) : active.find((a) => a.role === role);
        if (!agent) throw new WorkspaceError(409, 'AGENT_REQUIRED', `This template needs an active ${role} agent. Create one (or add the default agents) in AI Workforce.`);
        if (chosen !== undefined && agent.role !== role) throw new WorkspaceError(400, 'AGENT_UNSUITABLE', `steps "${s.key}" needs a ${role} agent`);
        delete s.agentTemplate;
        s.agentId = agent.id;
      }
    }
    for (const [i, s] of def.steps.entries()) {
      if (!s.connectorTemplate) continue;
      const { provider, action, input } = s.connectorTemplate;
      if (!integrationResolver) throw new WorkspaceError(409, 'INTEGRATIONS_DISABLED', 'This template needs integrations, which are not enabled on this server.');
      const chosen = integrations && typeof integrations === 'object' ? integrations[provider] : undefined;
      if (typeof chosen !== 'string' || !UUID_RE.test(chosen)) {
        throw new WorkspaceError(409, 'INTEGRATION_REQUIRED', `This template needs a connected ${provider} integration. Connect one in Integrations, then choose it here.`);
      }
      let ref;
      try { ref = await integrationResolver.validateStepReference(ws, chosen, action); } catch (err) {
        if (err.status === 404) throw new WorkspaceError(404, 'INTEGRATION_NOT_FOUND', 'Integration not found in this workspace');
        throw new WorkspaceError(400, 'INTEGRATION_UNSUITABLE', err.message);
      }
      if (ref.provider !== provider) throw new WorkspaceError(400, 'INTEGRATION_UNSUITABLE', `steps[${i}] needs a ${provider} integration`);
      delete s.connectorTemplate;
      s.connector = { integrationId: chosen.toLowerCase(), action, input };
    }
    return def;
  }

  async function instantiate(ctx, id, body = {}) {
    const ws = requireCtx(ctx);
    const t = typeof id === 'string' ? byId.get(id) : null;
    if (!t) throw new WorkspaceError(404, 'TEMPLATE_NOT_FOUND', 'Template not found');
    if (entitlements && entitlements.assertFeature) {
      try { await entitlements.assertFeature(ws, 'workflow_templates'); } catch (err) {
        throw Object.assign(new WorkspaceError(err.status || 503, err.code || 'ENTITLEMENT_UNAVAILABLE', err.message), err.extra ? { extra: err.extra } : {});
      }
    }
    const definition = await buildDefinition(ws, t, body.integrations, body.agents, ctx);
    const name = typeof body.name === 'string' && body.name.trim() ? body.name : t.name;
    const workflow = await workflowService.createWorkflow(ctx, {
      name, description: `From template "${t.name}". ${t.description}`.slice(0, 1000), definition,
    });
    audit(ctx, 'workflow_template_used', { workspaceId: ws, templateId: t.id, workflowId: workflow.id });
    let published = null;
    if (body.publish === true) published = await workflowService.publishWorkflow(ctx, workflow.id, {});
    return { templateId: t.id, workflow: published && published.workflow ? published.workflow : (published || workflow), published: !!published };
  }

  return { listTemplates, getTemplate, instantiate, catalog: CATALOG, categories: CATEGORIES, useCases: USE_CASES, setAgentService(a) { agentService = a || null; } };
}

module.exports = { createTemplateService };
