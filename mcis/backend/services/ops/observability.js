/**
 * Layer 9 — observability primitives.
 *
 *   requestId()         middleware: X-Request-Id correlation id (accepts a
 *                       safe inbound id, otherwise generates one; echoed on
 *                       the response, available as req.requestId)
 *   createMetrics()     in-process counters + latency histogram, Prometheus
 *                       text format; labels are route GROUPS and status
 *                       classes only (no ids, paths, users or payloads)
 *   metricsHandler()    GET /metrics, only with a Bearer METRICS_TOKEN
 *                       (disabled → 404); constant-time comparison
 *   createWorkerHealth(store)  heartbeat writer + liveness summary
 */
'use strict';

const crypto = require('crypto');

const REQUEST_ID_RE = /^[A-Za-z0-9._:-]{8,128}$/;

function requestId() {
  return (req, res, next) => {
    const inbound = req.get ? req.get('x-request-id') : req.headers['x-request-id'];
    const id = typeof inbound === 'string' && REQUEST_ID_RE.test(inbound) ? inbound : crypto.randomUUID();
    req.requestId = id;
    res.setHeader('X-Request-Id', id);
    next();
  };
}

// Route groups: first two segments after /api, with ids never included.
function routeGroup(path) {
  const p = String(path || '').split('?')[0];
  if (p === '/health' || p.startsWith('/health/')) return 'health';
  const m = p.match(/^\/api\/(workspaces\/[^/]+\/)?([a-z][a-z0-9-]{0,40})/);
  if (!m) return 'other';
  if (m[1]) return `workspace:${m[2]}`;
  if (m[2] === 'automation') return 'automation';
  return m[2];
}

const BUCKETS = [0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

function createMetrics({ now = () => process.hrtime.bigint() } = {}) {
  const requests = new Map(); // `${group}|${method}|${class}` → count
  const latency = new Map(); // group → { buckets[], sum, count }
  const counters = new Map(); // name → count (e.g. retention runs)
  const startedAt = Date.now();

  function observe(group, method, status, seconds) {
    const cls = `${Math.floor(status / 100)}xx`;
    const k = `${group}|${method}|${cls}`;
    requests.set(k, (requests.get(k) || 0) + 1);
    let h = latency.get(group);
    if (!h) { h = { buckets: BUCKETS.map(() => 0), sum: 0, count: 0 }; latency.set(group, h); }
    BUCKETS.forEach((b, i) => { if (seconds <= b) h.buckets[i] += 1; });
    h.sum += seconds;
    h.count += 1;
  }

  function middleware() {
    return (req, res, next) => {
      const t0 = now();
      res.on('finish', () => {
        const s = Number(now() - t0) / 1e9;
        observe(routeGroup(req.originalUrl || req.url), /^[A-Z]{3,7}$/.test(req.method) ? req.method : 'OTHER', res.statusCode, s);
      });
      next();
    };
  }

  const esc = (v) => String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  function render(extra = {}) {
    const lines = [];
    lines.push('# HELP nexus_http_requests_total HTTP requests by route group, method and status class.');
    lines.push('# TYPE nexus_http_requests_total counter');
    for (const [k, v] of requests) {
      const [g, m, c] = k.split('|');
      lines.push(`nexus_http_requests_total{group="${esc(g)}",method="${m}",status="${c}"} ${v}`);
    }
    lines.push('# HELP nexus_http_request_duration_seconds Request latency by route group.');
    lines.push('# TYPE nexus_http_request_duration_seconds histogram');
    for (const [g, h] of latency) {
      BUCKETS.forEach((b, i) => lines.push(`nexus_http_request_duration_seconds_bucket{group="${esc(g)}",le="${b}"} ${h.buckets[i]}`));
      lines.push(`nexus_http_request_duration_seconds_bucket{group="${esc(g)}",le="+Inf"} ${h.count}`);
      lines.push(`nexus_http_request_duration_seconds_sum{group="${esc(g)}"} ${h.sum.toFixed(6)}`);
      lines.push(`nexus_http_request_duration_seconds_count{group="${esc(g)}"} ${h.count}`);
    }
    for (const [name, v] of counters) {
      lines.push(`# TYPE ${name} counter`);
      lines.push(`${name} ${v}`);
    }
    for (const [name, v] of Object.entries(extra)) {
      if (!/^[a-z_][a-z0-9_]*$/.test(name) || !Number.isFinite(v)) continue;
      lines.push(`# TYPE ${name} gauge`);
      lines.push(`${name} ${v}`);
    }
    lines.push('# TYPE nexus_process_uptime_seconds gauge');
    lines.push(`nexus_process_uptime_seconds ${Math.floor((Date.now() - startedAt) / 1000)}`);
    return `${lines.join('\n')}\n`;
  }

  return {
    middleware, observe, render, routeGroup,
    inc(name, by = 1) { if (/^[a-z_][a-z0-9_]*$/.test(name)) counters.set(name, (counters.get(name) || 0) + by); },
  };
}

function tokenMatches(presented, expected) {
  if (typeof presented !== 'string' || typeof expected !== 'string' || !expected) return false;
  const a = crypto.createHash('sha256').update(presented).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

/** GET /metrics — 404 unless METRICS_TOKEN is set; 401 without the right Bearer token. */
function metricsHandler({ metrics, token = process.env.METRICS_TOKEN, gauges = async () => ({}) }) {
  return async (req, res) => {
    if (!token) return res.status(404).json({ success: false, error: 'Route not found' });
    const auth = String(req.headers.authorization || '');
    const presented = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (!tokenMatches(presented, token)) return res.status(401).json({ success: false, error: 'Unauthorized' });
    let extra = {};
    try { extra = await gauges(); } catch { extra = { nexus_metrics_gauge_errors: 1 }; }
    res.set('Cache-Control', 'no-store');
    res.type('text/plain; version=0.0.4');
    return res.send(metrics.render(extra));
  };
}

/**
 * Worker liveness. A worker is LIVE when its last heartbeat is younger than
 * staleAfterMs. Summaries contain counts and ages only — never job data.
 */
function createWorkerHealth({ store, version = process.env.APP_VERSION || null, staleAfterMs = 60000, now = () => Date.now(), logger = console } = {}) {
  let lastErrorLog = 0;
  return {
    async beat({ workerId, kind = 'workflow', runningJobs = 0 }) {
      try { await store.upsertHeartbeat({ workerId, kind, runningJobs, version }); } catch (err) {
        if (now() - lastErrorLog > 60000) { lastErrorLog = now(); logger.warn?.(`[workers] heartbeat write failed: ${err.code || err.message}`); }
      }
    },
    async remove(workerId) {
      try { await store.deleteHeartbeat(workerId); } catch { /* the row just goes stale */ }
    },
    async summary() {
      const rows = await store.listHeartbeats(200);
      const t = now();
      const workers = rows.map((r) => {
        const age = t - Date.parse(r.last_seen_at);
        return { kind: r.kind, live: age <= staleAfterMs, lastSeenSecondsAgo: Math.max(0, Math.round(age / 1000)), runningJobs: r.running_jobs, version: r.version || null };
      });
      return {
        live: workers.filter((w) => w.live).length,
        stale: workers.filter((w) => !w.live).length,
        runningJobs: workers.filter((w) => w.live).reduce((a, w) => a + (w.runningJobs || 0), 0),
        workers,
      };
    },
  };
}

module.exports = { requestId, createMetrics, metricsHandler, createWorkerHealth, routeGroup, tokenMatches, REQUEST_ID_RE };
