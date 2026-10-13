/**
 * Layer 8 — workspace overview + customer-safe operational visibility.
 *
 * GET /api/workspaces/:ws/overview (member+). Built ONLY from existing
 * records — the Layer 7 usage ledger (authoritative counts / success rate),
 * the most recent Layer 3 executions and Layer 4 runs (latency, approval
 * waits), Layer 5 integrations (connector health), Layer 2 tasks and, for
 * owners/admins, the audit log (quota and billing failures) and Layer 6
 * security events. A fixed number of bounded queries, run in parallel
 * (no per-row lookups, no full-history scans).
 *
 * What members see: counts, rates, latencies, their own tasks, connector
 * health as numbers. What only owners/admins see: which connectors fail
 * and why, quota / billing / security failure counts. Never: credentials,
 * secrets, raw inputs, audit payloads or security rule details.
 */
'use strict';

const { WorkspaceError, hasRole } = require('../workspaceService');
const { sanitizeString } = require('../security/sensitiveClassifier');

const RECENT = 50;
const DAY = 86400000;

function pct(a, b) { return b ? Math.round((a / b) * 1000) / 10 : null; }
function percentile(sorted, p) {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

function createOverviewService({
  billingService = null, execStore = null, wfStore = null, integrationStore = null, dataStore = null,
  getWorkspaceAuditLog = null, securityStore = null, logger = console, options = {},
} = {}) {
  const now = options.now || (() => new Date());

  const safe = async (label, fn, fallback = null) => {
    try { return await fn(); } catch (err) {
      logger.warn?.(`[overview] ${label} unavailable (${err.code || err.name})`);
      return fallback;
    }
  };

  function executionStats(rows) {
    const byStatus = {};
    const durations = [];
    let waiting = 0;
    let oldestWaitMs = null;
    for (const e of rows) {
      byStatus[e.status] = (byStatus[e.status] || 0) + 1;
      if (e.finished_at && (e.status === 'completed' || e.status === 'failed')) {
        const d = new Date(e.finished_at).getTime() - new Date(e.started_at || e.created_at).getTime();
        if (Number.isFinite(d) && d >= 0) durations.push(d);
      }
      if (e.status === 'waiting_approval') {
        waiting++;
        const w = now().getTime() - new Date(e.updated_at || e.created_at).getTime();
        if (oldestWaitMs === null || w > oldestWaitMs) oldestWaitMs = w;
      }
    }
    durations.sort((a, b) => a - b);
    const finished = (byStatus.completed || 0) + (byStatus.failed || 0) + (byStatus.cancelled || 0);
    return {
      sample: rows.length,
      byStatus,
      successRate: pct(byStatus.completed || 0, finished),
      latencyMs: {
        avg: durations.length ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : null,
        p50: percentile(durations, 50),
        p95: percentile(durations, 95),
      },
      waitingApproval: waiting,
      oldestApprovalWaitMinutes: oldestWaitMs === null ? null : Math.round(oldestWaitMs / 60000),
      recent: rows.slice(0, 5).map((e) => ({
        id: e.id, status: e.status, goal: sanitizeString(String(e.goal || ''), 120), createdAt: e.created_at, finishedAt: e.finished_at || null,
      })),
    };
  }

  function runStats(rows) {
    const byStatus = {};
    let waiting = 0;
    let oldestWaitMs = null;
    for (const r of rows) {
      byStatus[r.status] = (byStatus[r.status] || 0) + 1;
      if (r.status === 'waiting_approval') {
        waiting++;
        const w = now().getTime() - new Date(r.updated_at || r.created_at).getTime();
        if (oldestWaitMs === null || w > oldestWaitMs) oldestWaitMs = w;
      }
    }
    const finished = (byStatus.completed || 0) + (byStatus.failed || 0) + (byStatus.cancelled || 0) + (byStatus.needs_review || 0);
    return {
      sample: rows.length, byStatus, successRate: pct(byStatus.completed || 0, finished),
      waitingApproval: waiting, oldestApprovalWaitMinutes: oldestWaitMs === null ? null : Math.round(oldestWaitMs / 60000),
    };
  }

  async function overview(ctx) {
    if (!ctx || !ctx.workspace || !ctx.workspace.id || !ctx.userId) throw new WorkspaceError(401, 'AUTH_REQUIRED', 'Authentication required');
    const ws = ctx.workspace.id;
    const isAdmin = hasRole(ctx.role, 'admin');
    const since = now().getTime() - 30 * DAY;

    const [usage, execs, runs, integrations, tasks, audit, security] = await Promise.all([
      billingService ? safe('usage', () => billingService.dashboard(ctx, { days: 30 })) : null,
      execStore ? safe('executions', () => execStore.listExecutions(ws, { limit: RECENT }), []) : [],
      wfStore ? safe('runs', () => wfStore.listRuns(ws, { limit: RECENT }), []) : [],
      integrationStore ? safe('integrations', () => integrationStore.listIntegrations(ws), []) : [],
      dataStore ? safe('tasks', () => dataStore.listTasks(ws, { limit: RECENT }), []) : [],
      isAdmin && getWorkspaceAuditLog ? safe('audit', () => getWorkspaceAuditLog(ws, { limit: 200 }), []) : null,
      isAdmin && securityStore ? safe('security', () => securityStore.listSecurityEvents(ws, { limit: 100 }), []) : null,
    ]);

    const failing = (integrations || []).filter((i) => i.status !== 'connected' || i.last_error);
    const connectors = {
      total: (integrations || []).length,
      connected: (integrations || []).filter((i) => i.status === 'connected').length,
      needsAttention: failing.length,
      ...(isAdmin ? {
        failing: failing.slice(0, 10).map((i) => ({ id: i.id, name: i.name, provider: i.provider, status: i.status, lastError: i.last_error ? sanitizeString(String(i.last_error), 200) : null })),
      } : {}),
    };

    const openTasks = (tasks || []).filter((t) => t.status !== 'done' && t.status !== 'cancelled');
    const taskView = {
      open: openTasks.length,
      assignedToMe: openTasks.filter((t) => t.assignee_type === 'human' && t.assignee_user_id === ctx.userId).length,
      assignedToAgent: openTasks.filter((t) => t.assignee_type === 'agent').length,
    };

    const out = {
      workspace: { id: ws, name: ctx.workspace.name, isPersonal: !!ctx.workspace.is_personal, role: ctx.role },
      generatedAt: now().toISOString(),
      usage: usage ? {
        window: usage.window, executions: usage.executions, workflowRuns: usage.workflowRuns, steps: usage.steps,
        connectorCalls: usage.connectorCalls, apiCalls: usage.apiCalls, outcomes: usage.outcomes,
        successRate: usage.successRate, failureRate: usage.failureRate,
      } : null,
      executions: executionStats(execs || []),
      workflowRuns: runStats(runs || []),
      approvals: null,
      connectors,
      tasks: taskView,
      detail: isAdmin ? 'admin' : 'member',
    };

    out.approvals = {
      waiting: out.executions.waitingApproval + out.workflowRuns.waitingApproval,
      oldestWaitMinutes: [out.executions.oldestApprovalWaitMinutes, out.workflowRuns.oldestApprovalWaitMinutes].filter((x) => x !== null).reduce((a, b) => Math.max(a, b), null),
    };
    if (isAdmin) {
      const recentAudit = (audit || []).filter((a) => new Date(a.created_at).getTime() >= since);
      const countOf = (...actions) => recentAudit.filter((a) => actions.includes(a.action)).length;
      out.failures = {
        windowDays: 30,
        quotaDenials: countOf('billing.quota_exceeded', 'billing.feature_denied'),
        billingFailures: countOf('billing.payment_failed', 'billing.webhook_rejected'),
        connectorFailures: failing.length,
        securityDenials: (security || []).filter((e) => new Date(e.created_at).getTime() >= since && e.success === false).length,
        auditSampleSize: (audit || []).length,
      };
    }
    return out;
  }

  return { overview };
}

module.exports = { createOverviewService };
