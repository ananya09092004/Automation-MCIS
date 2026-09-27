/**
 * Layer 10 — background worker for the revenue suite (safe on any number
 * of instances: every job is claimed with a lease in the database).
 *
 *   monitors      claim_due_monitors (SKIP LOCKED, fence) → runCheck with the
 *                 check key `check:<monitor>:<fence>` (a crashed check is
 *                 re-claimed with a NEW fence; the old key is never reused)
 *   QA results    claim_qa_result → qaService.processResult (non-blocking)
 *   webhooks      claim_webhook_deliveries → signed delivery with backoff
 *   housekeeping  (every few minutes) stale-monitor sweep and stuck alert
 *                 deliveries → failed (never re-sent), per workspace
 * Heartbeats: kind 'revenue' (readiness / metrics).
 */
'use strict';

const crypto = require('crypto');

function createRevenueWorker({
  store, monitoring, alerts = null, qa = null, webhooks = null, listWorkspaceIds = null, workerHealth = null, metrics = null, logger = console, options = {},
} = {}) {
  const workerId = options.workerId || `rev_${crypto.randomBytes(6).toString('hex')}`;
  const intervalMs = options.intervalMs || 5000;
  const housekeepingMs = options.housekeepingMs || 5 * 60000;
  const monitorBatch = options.monitorBatch || 10;
  let timer = null;
  let running = false;
  let lastHousekeeping = 0;
  let stopped = false;
  const inc = (name, by = 1) => { try { if (metrics && by) metrics.inc(name, by); } catch { /* never */ } };

  async function monitorsTick() {
    const rows = await store.rpc('claim_due_monitors', { p_worker: workerId, p_lease_seconds: 120, p_limit: monitorBatch });
    let n = 0;
    for (const m of rows || []) {
      try {
        const r = await monitoring.runCheck(m, { checkKey: `check:${m.id}:${m.lease_fence}`, fence: m.lease_fence });
        n += 1;
        inc('nexus_monitoring_checks_total');
        if (r && r.changes && r.changes.length) inc('nexus_monitoring_changes_total', r.changes.length);
        if (r && r.observation && r.observation.status === 'UNAVAILABLE') inc('nexus_monitoring_unavailable_total');
      } catch (err) {
        logger.error?.(`[revenue-worker] monitor check failed (${err.code || err.name})`);
      }
    }
    return n;
  }

  async function housekeeping() {
    if (!listWorkspaceIds) return { workspaces: 0 };
    let after = null;
    let count = 0;
    let stale = 0;
    for (let page = 0; page < 100; page++) {
      const ids = await listWorkspaceIds(after, 100);
      if (!ids.length) break;
      for (const ws of ids) {
        count += 1;
        try {
          stale += await monitoring.sweepStale(ws);
          if (alerts) await alerts.expireStuckDeliveries(ws);
        } catch (err) { logger.warn?.(`[revenue-worker] housekeeping failed for a workspace (${err.code || err.name})`); }
      }
      after = ids[ids.length - 1];
    }
    inc('nexus_monitoring_stale_total', stale);
    return { workspaces: count, stale };
  }

  async function tick() {
    if (running) return null;
    running = true;
    const out = { monitors: 0, qa: 0, webhooks: null, housekeeping: null };
    try {
      out.monitors = await monitorsTick();
      if (qa) out.qa = await qa.tick({ max: 3 });
      if (webhooks) {
        out.webhooks = await webhooks.tick({ limit: 20 });
        inc('nexus_webhook_deliveries_total', out.webhooks.delivered);
        inc('nexus_webhook_failures_total', out.webhooks.failed + out.webhooks.dead);
      }
      if (Date.now() - lastHousekeeping > housekeepingMs) {
        lastHousekeeping = Date.now();
        out.housekeeping = await housekeeping();
      }
    } catch (err) {
      logger.error?.(`[revenue-worker] tick failed (${err.code || err.name})`);
    } finally {
      running = false;
      if (workerHealth) { try { Promise.resolve(workerHealth.beat({ workerId, kind: 'revenue', runningJobs: 0 })).catch(() => {}); } catch { /* never */ } }
    }
    return out;
  }

  function start() {
    if (timer) return;
    stopped = false;
    const loop = async () => {
      if (stopped) return;
      await tick();
      if (!stopped) { timer = setTimeout(loop, intervalMs); if (timer.unref) timer.unref(); }
    };
    timer = setTimeout(loop, 1000);
    if (timer.unref) timer.unref();
  }
  async function stop() {
    stopped = true;
    if (timer) clearTimeout(timer);
    timer = null;
    if (workerHealth) await workerHealth.remove(workerId);
  }

  return { start, stop, tick, monitorsTick, housekeeping, workerId };
}

module.exports = { createRevenueWorker };
