/**
 * Layer 10 — workspace export and deletion.
 *
 * Export (owner): one JSON document of the workspace's business data from
 * every layer — never secrets: credential material, signing secrets, key
 * hashes and tokens are removed by construction (safe views) AND by a
 * final key scrub. Each section is capped and says when it was truncated.
 *
 * Delete (owner, team workspaces only): the owner types the workspace
 * name; refused while a paid online subscription is active (cancel it
 * first, so billing never outlives the workspace) or while an agent
 * execution is running. Then: the workspace's audit rows are purged, the
 * workspace row is deleted (every workspace table cascades from it),
 * caches are invalidated, and ONE content-free audit row records who
 * deleted which workspace id and when.
 */
'use strict';

const C = require('./common');

const SECRET_KEY_RE = /(secret|ciphertext|auth_tag|^iv$|_iv$|token|password|key_hash|credential(?!s?_?meta)|private_key|refresh)/i;
const EXPORT_CAP = 10000;

function scrub(v, depth = 0) {
  if (depth > 12) return null;
  if (Array.isArray(v)) return v.map((x) => scrub(x, depth + 1));
  if (v && typeof v === 'object') {
    const o = {};
    for (const [k, x] of Object.entries(v)) {
      if (SECRET_KEY_RE.test(k) && !/^(has|secretNotice)/.test(k)) continue;
      o[k] = scrub(x, depth + 1);
    }
    return o;
  }
  return v;
}

const REVENUE_TABLES = [
  'workspace_agents', 'monitors', 'monitor_observations', 'monitor_snapshots', 'monitor_changes', 'ci_products', 'ci_competitor_products',
  'ci_recommendations', 'alert_rules', 'alerts', 'alert_deliveries', 'qa_projects', 'qa_suites', 'qa_scenarios', 'qa_runs', 'qa_results',
  'workspace_webhooks', 'webhook_deliveries',
];

function createWorkspaceLifecycle({
  store, workspaceService, sources = {}, getSubscription = null, hasActiveExecution = null, onDeleted = [], appendAuditLog = null, logger = console, options = {},
} = {}) {
  if (!store || !workspaceService) throw new Error('workspace lifecycle: store and workspaceService are required');
  const now = options.now || (() => new Date());

  async function exportWorkspace(ctx) {
    const ws = C.requireCtx(ctx);
    if (ctx.role !== 'owner') throw C.forbidden('Only the workspace owner can export it.');
    const out = {
      format: 'nexus-workspace-export', version: 1, exportedAt: now().toISOString(), exportedBy: ctx.userId,
      workspace: { id: ws, name: ctx.workspace.name, isPersonal: !!ctx.workspace.is_personal, createdAt: ctx.workspace.created_at || null },
      sections: {}, truncated: [],
    };
    for (const [name, fn] of Object.entries(sources)) {
      try {
        const rows = await fn(ws, ctx);
        const list = Array.isArray(rows) ? rows : [rows];
        if (list.length > EXPORT_CAP) out.truncated.push(name);
        out.sections[name] = scrub(list.slice(0, EXPORT_CAP));
      } catch (err) {
        logger.warn?.(`[export] section ${name} unavailable (${err.code || err.name})`);
        out.sections[name] = { error: 'unavailable' };
      }
    }
    for (const t of REVENUE_TABLES) {
      const rows = [];
      for (let offset = 0; offset < EXPORT_CAP; offset += 1000) {
        const page = await store.list(t, ws, { order: t === 'monitor_snapshots' ? ['first_seen_at', true] : ['created_at', true], limit: 1000, offset });
        rows.push(...page);
        if (page.length < 1000) break;
      }
      if (rows.length >= EXPORT_CAP) out.truncated.push(t);
      out.sections[t] = scrub(rows);
    }
    if (appendAuditLog) {
      try { Promise.resolve(appendAuditLog(ctx.userId, 'workspace_exported', { workspaceId: ws, sections: Object.keys(out.sections).length }, { success: true }, ws)).catch(() => {}); } catch { /* never */ }
    }
    return out;
  }

  async function deleteWorkspace(ctx, body = {}) {
    const ws = C.requireCtx(ctx);
    if (ctx.role !== 'owner') throw C.forbidden('Only the workspace owner can delete it.');
    if (ctx.workspace.is_personal) throw C.bad('A personal workspace cannot be deleted');
    if (typeof body.confirmName !== 'string' || body.confirmName !== ctx.workspace.name) throw C.bad('Type the workspace name exactly to confirm deletion', 'CONFIRMATION_REQUIRED');
    if (getSubscription) {
      const sub = await getSubscription(ws);
      const online = sub && sub.provider && !['none', 'manual'].includes(sub.provider) && sub.external_subscription_id;
      if (online && ['trialing', 'active', 'past_due'].includes(sub.status) && !sub.cancel_at_period_end) {
        throw C.conflict('Cancel the workspace subscription before deleting the workspace.', 'SUBSCRIPTION_ACTIVE');
      }
    }
    if (hasActiveExecution && (await hasActiveExecution(ws))) throw C.conflict('An agent execution is running; cancel it before deleting the workspace.', 'WORK_IN_PROGRESS');
    const purged = await store.rpc('purge_workspace_audit', { p_workspace: ws }).catch((err) => { logger.warn?.(`[delete] audit purge failed (${err.code})`); return null; });
    await workspaceService.deleteWorkspace(ctx);
    for (const fn of onDeleted) { try { await fn(ws); } catch { /* cache invalidation is best effort */ } }
    if (appendAuditLog) {
      // Content-free: who deleted which workspace id, when. Nothing else survives.
      try { await appendAuditLog(ctx.userId, 'workspace_deleted', { workspaceId: ws }, { success: true }, null); } catch { /* never */ }
    }
    return { deleted: true, id: ws, auditRowsPurged: typeof purged === 'number' ? purged : null };
  }

  return { exportWorkspace, deleteWorkspace, scrub };
}

module.exports = { createWorkspaceLifecycle, scrub, REVENUE_TABLES };
