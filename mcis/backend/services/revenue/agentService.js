/**
 * Layer 10 — AI workforce: named agents of a workspace.
 *
 * An agent is an identity + standing instructions + LIMITS layered on top
 * of the workspace's Agent Firewall (never instead of it):
 *   maxRisk                 actions above it are denied, even with approval
 *   allowedIntegrationIds   connector actions on any other integration are denied
 * Executions record agent_id (evidence: which agent did what). Agents run
 * as the human who started the work (their role is re-checked for every
 * action); an agent never has permissions of its own.
 *
 * Roles: research | data | spreadsheet | reviewer | custom. The "reviewer"
 * role is a label for review queues; approvals are always given by people.
 */
'use strict';

const C = require('./common');

const ROLES = ['research', 'data', 'spreadsheet', 'reviewer', 'custom'];
const DEFAULT_AGENTS = [
  { name: 'Research Agent', role: 'research', maxRisk: 'green', description: 'Finds and summarizes information from approved sources.', instructions: 'Collect facts only from the sources you are given or allowed to read. Cite where each fact came from. Never invent numbers.' },
  { name: 'Data Agent', role: 'data', maxRisk: 'green', description: 'Extracts and validates structured data.', instructions: 'Extract exactly the requested fields. Mark any field you could not find as missing instead of guessing.' },
  { name: 'Spreadsheet Agent', role: 'spreadsheet', maxRisk: 'yellow', description: 'Builds tables and summaries from extracted data.', instructions: 'Produce clean tabular output with one row per record and consistent units. Do not change source values.' },
  { name: 'Reviewer Agent', role: 'reviewer', maxRisk: 'green', description: 'Checks outputs against the task before a human signs off.', instructions: 'Check the previous output against the task. List problems precisely. You cannot approve; a person does.' },
];

function createAgentService({ store, integrations = null, appendAuditLog = null, options = {} } = {}) {
  if (!store) throw new Error('agent service: store is required');
  const audit = (actor, action, payload, ws) => {
    if (!appendAuditLog) return;
    try { Promise.resolve(appendAuditLog(actor, action, payload, { success: true, error: null }, ws)).catch(() => {}); } catch { /* never */ }
  };
  const view = (a) => ({
    id: a.id, name: a.name, role: a.role, description: a.description, instructions: a.instructions, maxRisk: a.max_risk,
    allowedIntegrationIds: a.allowed_integration_ids || [], status: a.status, createdBy: a.created_by, version: a.version, createdAt: a.created_at, updatedAt: a.updated_at,
  });

  async function checkIntegrations(ws, ids) {
    if (ids === undefined) return [];
    if (!Array.isArray(ids) || ids.length > 20 || ids.some((x) => !C.isUuid(x))) throw C.bad('allowedIntegrationIds must list at most 20 integration ids');
    const uniq = [...new Set(ids.map((x) => x.toLowerCase()))];
    for (const id of uniq) {
      const i = integrations ? await integrations.getIntegrationRow(ws, id) : null;
      if (!i) throw C.bad('allowedIntegrationIds: integration not found in this workspace');
    }
    return uniq;
  }

  async function create(ctx, body = {}) {
    const ws = C.requireCtx(ctx);
    C.requireAdmin(ctx, 'agents');
    C.onlyKeys(body, ['name', 'role', 'description', 'instructions', 'maxRisk', 'allowedIntegrationIds']);
    try {
      const row = await store.insert('workspace_agents', {
        workspace_id: ws, name: C.str(body.name, 'name', { max: 80 }), role: C.oneOf(body.role, 'role', ROLES),
        description: C.str(body.description, 'description', { max: 1000, optional: true }) || '',
        instructions: C.str(body.instructions, 'instructions', { max: 2000, optional: true }) || '',
        max_risk: C.oneOf(body.maxRisk, 'maxRisk', ['green', 'yellow', 'red'], 'yellow'),
        allowed_integration_ids: await checkIntegrations(ws, body.allowedIntegrationIds), created_by: ctx.userId,
      });
      audit(ctx.userId, 'agent_created', { workspaceId: ws, agentId: row.id, role: row.role, maxRisk: row.max_risk }, ws);
      return view(row);
    } catch (err) {
      if (err.code === '23505') throw C.conflict('An agent with this name already exists', 'AGENT_EXISTS');
      throw err;
    }
  }

  async function load(ctx, id) {
    const ws = C.requireCtx(ctx);
    const a = await store.get('workspace_agents', ws, C.uuidOr404(id, 'Agent'));
    if (!a) throw C.notFound('Agent');
    return a;
  }

  async function update(ctx, id, body = {}) {
    const a = await load(ctx, id);
    C.requireAdmin(ctx, 'agents');
    C.onlyKeys(body, ['version', 'name', 'description', 'instructions', 'maxRisk', 'allowedIntegrationIds', 'status']);
    if (body.version !== a.version) throw C.conflict('version is required and must match the current version', 'AGENT_CONFLICT');
    const patch = {};
    if (body.name !== undefined) patch.name = C.str(body.name, 'name', { max: 80 });
    if (body.description !== undefined) patch.description = C.str(body.description, 'description', { max: 1000, optional: true }) || '';
    if (body.instructions !== undefined) patch.instructions = C.str(body.instructions, 'instructions', { max: 2000, optional: true }) || '';
    if (body.maxRisk !== undefined) patch.max_risk = C.oneOf(body.maxRisk, 'maxRisk', ['green', 'yellow', 'red']);
    if (body.allowedIntegrationIds !== undefined) patch.allowed_integration_ids = await checkIntegrations(a.workspace_id, body.allowedIntegrationIds);
    if (body.status !== undefined) patch.status = C.oneOf(body.status, 'status', ['active', 'archived']);
    if (!Object.keys(patch).length) throw C.bad('Nothing to update');
    let u;
    try { u = await store.update('workspace_agents', a.workspace_id, a.id, patch, { expectVersion: a.version }); } catch (err) {
      if (err.code === '23505') throw C.conflict('An agent with this name already exists', 'AGENT_EXISTS');
      throw err;
    }
    if (!u) throw C.conflict('The agent was changed concurrently; reload and retry.', 'AGENT_CONFLICT');
    audit(ctx.userId, 'agent_updated', { workspaceId: a.workspace_id, agentId: a.id, fields: Object.keys(patch) }, a.workspace_id);
    return view(u);
  }

  async function list(ctx, { status } = {}) {
    const ws = C.requireCtx(ctx);
    const filter = status ? { status: C.oneOf(status, 'status', ['active', 'archived']) } : {};
    return (await store.list('workspace_agents', ws, { filter, order: ['created_at', true], limit: 200 })).map(view);
  }

  async function get(ctx, id) { return view(await load(ctx, id)); }

  /** Idempotent: creates the four standard agents that do not exist yet. */
  async function provisionDefaults(ctx) {
    const ws = C.requireCtx(ctx);
    C.requireAdmin(ctx, 'agents');
    const out = [];
    for (const d of DEFAULT_AGENTS) {
      const row = await store.tryInsert('workspace_agents', {
        workspace_id: ws, name: d.name, role: d.role, description: d.description, instructions: d.instructions, max_risk: d.maxRisk, allowed_integration_ids: [], created_by: ctx.userId,
      });
      out.push(view(row || (await store.list('workspace_agents', ws, { limit: 200 })).find((a) => a.name.toLowerCase() === d.name.toLowerCase())));
    }
    return out;
  }

  /** Layer 3 / 4 / tasks resolver (server-side; workspace-scoped). */
  async function resolve(ws, id) {
    if (!C.isUuid(id)) return null;
    const a = await store.get('workspace_agents', ws, id);
    return a ? { id: a.id, name: a.name, role: a.role, instructions: a.instructions, maxRisk: a.max_risk, allowedIntegrationIds: a.allowed_integration_ids || [], status: a.status } : null;
  }

  return { create, update, list, get, provisionDefaults, resolve, view, ROLES, DEFAULT_AGENTS };
}

module.exports = { createAgentService, ROLES, DEFAULT_AGENTS };
