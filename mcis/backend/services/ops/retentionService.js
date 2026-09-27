/**
 * Layer 9 — data retention (real deletion, auditable, one workspace at a time).
 *
 *   getPolicy(ctx)                 admin+   effective settings + hard floors
 *   setPolicy(ctx, {executionsDays, auditDays})   owner   (null = keep forever)
 *   purgeNow(ctx)                  owner    purge THIS workspace now (audited)
 *   sweep({ maxWorkspaces })       system   periodic purge of every workspace
 *
 * What is deleted (retention_purge_workspace RPC, one transaction per workspace):
 *   usage ledger + settled reservations older than USAGE_RETENTION_DAYS
 *     (server setting, min 35 days; unset = keep) — the ledger stays
 *     immutable for everything else;
 *   finished workflow runs (steps, jobs cascade) and finished executions
 *     (evidence, approvals cascade) older than executionsDays (min 7);
 *   audit rows older than auditDays (min 90).
 * Layer 10: monitoring history (observations, snapshots, changes, alerts,
 *   delivered webhook deliveries) and finished QA runs follow executionsDays
 *   too (same 7-day floor; a monitor's latest observation and current
 *   snapshot are always kept).
 * Running / waiting runs and executions are never deleted. Every call is
 * bound to ONE workspace id taken from the caller's Layer 1 context (or,
 * for the sweep, from the workspaces table) — never from the client body.
 * Each purge writes an audit row with the counts (never the data).
 */
'use strict';

const { WorkspaceError, hasRole } = require('../workspaceService');

const FLOORS = Object.freeze({ usageDays: 35, executionsDays: 7, auditDays: 90 });
const MAX_DAYS = 3650;
const DAY = 86400000;

function parseDays(v, name, floor) {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : (typeof v === 'string' && /^\d+$/.test(v.trim()) ? Number(v) : NaN);
  if (!Number.isInteger(n) || n < floor || n > MAX_DAYS) {
    throw new WorkspaceError(400, 'INVALID_RETENTION', `${name} must be a whole number of days between ${floor} and ${MAX_DAYS}, or null to keep forever.`);
  }
  return n;
}

function usageDaysFromEnv(env = process.env) {
  const v = env.USAGE_RETENTION_DAYS;
  if (v === undefined || v === '') return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < FLOORS.usageDays || n > MAX_DAYS) return undefined; // invalid → check-config reports it; nothing purged
  return n;
}

function createRetentionService({ store, appendAuditLog = null, logger = console, now = () => new Date(), env = process.env } = {}) {
  if (!store) throw new Error('retention service: store is required');
  const audit = (userId, action, payload, workspaceId, success = true, error = null) => {
    if (!appendAuditLog) return;
    try { Promise.resolve(appendAuditLog(userId, action, payload, { success, error }, workspaceId)).catch(() => {}); } catch { /* never */ }
  };
  const human = (ctx) => ctx && !ctx.apiKeyId;
  let revenuePurge = null; // Layer 10: (ws, { monitoringBefore, qaBefore }) → counts
  const requireRole = (ctx, role) => {
    if (!human(ctx) || !hasRole(ctx.role, role)) {
      throw new WorkspaceError(403, 'FORBIDDEN', role === 'owner' ? 'Only the workspace owner can change data retention.' : 'Only owners and admins can view data retention.');
    }
  };

  function view(row) {
    const usage = usageDaysFromEnv(env);
    return {
      executionsDays: row ? row.executions_days : null,
      auditDays: row ? row.audit_days : null,
      usageDays: usage === undefined ? null : usage,
      floors: FLOORS,
      updatedAt: row ? row.updated_at : null,
    };
  }

  function cutoffs(row) {
    const t = now().getTime();
    const usage = usageDaysFromEnv(env);
    const c = {
      usageBefore: usage ? new Date(t - usage * DAY).toISOString() : null,
      execBefore: row && row.executions_days ? new Date(t - Math.max(row.executions_days, FLOORS.executionsDays) * DAY).toISOString() : null,
      auditBefore: row && row.audit_days ? new Date(t - Math.max(row.audit_days, FLOORS.auditDays) * DAY).toISOString() : null,
    };
    return c;
  }

  async function purgeOne(workspaceId, actor) {
    const row = await store.getRetentionPolicy(workspaceId);
    const c = cutoffs(row);
    if (!c.usageBefore && !c.execBefore && !c.auditBefore) return { workspaceId, skipped: true };
    try {
      const counts = await store.purgeWorkspace(workspaceId, c);
      if (revenuePurge && c.execBefore) counts.revenue = await revenuePurge(workspaceId, { monitoringBefore: c.execBefore, qaBefore: c.execBefore });
      audit(actor, 'retention_purged', { workspaceId, counts, cutoffs: c }, workspaceId);
      return { workspaceId, counts, cutoffs: c };
    } catch (err) {
      audit(actor, 'retention_purged', { workspaceId, cutoffs: c }, workspaceId, false, err.code || 'PURGE_FAILED');
      throw err;
    }
  }

  return {
    FLOORS,
    setRevenuePurge(fn) { revenuePurge = typeof fn === 'function' ? fn : null; },
    async getPolicy(ctx) {
      requireRole(ctx, 'admin');
      return view(await store.getRetentionPolicy(ctx.workspace.id));
    },
    async setPolicy(ctx, body = {}) {
      requireRole(ctx, 'owner');
      if (!body || typeof body !== 'object') throw new WorkspaceError(400, 'INVALID_RETENTION', 'Body must be an object.');
      for (const k of Object.keys(body)) if (!['executionsDays', 'auditDays'].includes(k)) throw new WorkspaceError(400, 'INVALID_RETENTION', `Unknown setting "${k}".`);
      const executionsDays = parseDays(body.executionsDays, 'executionsDays', FLOORS.executionsDays);
      const auditDays = parseDays(body.auditDays, 'auditDays', FLOORS.auditDays);
      const row = await store.saveRetentionPolicy(ctx.workspace.id, { executionsDays, auditDays, updatedBy: ctx.userId });
      audit(ctx.userId, 'retention_policy_updated', { workspaceId: ctx.workspace.id, executionsDays, auditDays }, ctx.workspace.id);
      return view(row);
    },
    async purgeNow(ctx) {
      requireRole(ctx, 'owner');
      return purgeOne(ctx.workspace.id, ctx.userId);
    },
    /** Periodic sweep over all workspaces (bounded; one failure never stops the rest). */
    async sweep({ maxWorkspaces = 1000, pageSize = 100 } = {}) {
      const out = { workspaces: 0, purged: 0, failed: 0 };
      let after = null;
      while (out.workspaces < maxWorkspaces) {
        const ids = await store.listWorkspaceIds(after, Math.min(pageSize, maxWorkspaces - out.workspaces));
        if (!ids.length) break;
        for (const id of ids) {
          out.workspaces += 1;
          try {
            const r = await purgeOne(id, 'system:retention');
            if (!r.skipped) out.purged += 1;
          } catch (err) {
            out.failed += 1;
            logger.error?.(`[retention] purge failed for a workspace: ${err.code || err.message}`);
          }
        }
        after = ids[ids.length - 1];
      }
      return out;
    },
  };
}

module.exports = { createRetentionService, FLOORS, usageDaysFromEnv };
