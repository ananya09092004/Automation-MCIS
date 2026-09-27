/**
 * In-memory double of services/revenue/revenueStore.js, mirroring the
 * Layer 10 migration: defaults, unique constraints (23505), composite FK
 * cascades / restrict (23503) / set null, and the worker / limit /
 * retention RPCs. Used by the deterministic test suites; the PostgreSQL
 * runs exercise the real SQL.
 */
'use strict';

const crypto = require('crypto');

const err = (code, message) => Object.assign(new Error(message), { code });
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v), (k, x) => (k === '_seq' ? undefined : x)));

const DEFAULTS = {
  workspace_agents: { description: '', instructions: '', max_risk: 'yellow', allowed_integration_ids: [], status: 'active' },
  monitors: {
    integration_id: null, source: {}, check_interval_minutes: 360, stale_after_minutes: 1440, status: 'active', health: 'PENDING', health_reason: null,
    current: null, current_hash: null, last_check_at: null, last_success_at: null, last_observation_id: null, consecutive_failures: 0,
    lease_owner: null, lease_expires_at: null, lease_fence: 0,
  },
  monitor_observations: { values: null, value_hash: null, method: null, evidence: {}, error_code: null },
  monitor_snapshots: { observation_count: 1 },
  monitor_changes: { old_value: null, new_value: null, confidence: 1, source: null },
  ci_products: {
    sku: null, gtin: null, mpn: null, brand: null, model: null, attributes: {}, currency: 'INR', cost: null, selling_price: null,
    fees_fixed: null, fees_pct: null, target_margin_pct: null, min_margin_pct: null, own_monitor_id: null,
  },
  ci_competitor_products: {
    source_url: null, marketplace_product_id: null, identifiers: {}, title: null, brand: null, model: null, monitor_id: null,
    match_status: 'UNVERIFIED', match_confidence: 0, match_method: null, match_evidence: {}, confirmed_by: null, confirmed_at: null,
  },
  ci_recommendations: { competitor_id: null, change_id: null, priority: 'medium', rationale: {}, status: 'open', decided_by: null, decided_at: null },
  alert_rules: { monitor_id: null, product_id: null, threshold: null, channels: [{ type: 'in_app' }], cooldown_minutes: 60, enabled: true },
  alerts: { monitor_id: null, change_id: null, severity: 'warning', details: {}, acknowledged_by: null, acknowledged_at: null },
  alert_deliveries: { integration_id: null, status: 'pending', error_code: null, attempts: 0, last_attempt_at: null, delivered_at: null },
  qa_projects: { description: '', agent_label: 'Nexus agent', agent_id: null, environment: {} },
  qa_suites: { description: '' },
  qa_scenarios: { goal: null, workflow_id: null, inputs: {}, expected: {}, timeout_seconds: 600 },
  qa_runs: { suite_id: null, status: 'queued', trigger: 'app', idempotency_key: null, scenario_count: 0, summary: {}, started_at: null, finished_at: null },
  qa_results: {
    status: 'pending', execution_id: null, workflow_run_id: null, verdict: null, failure_category: null, classification_evidence: null, verified: null,
    evidence_complete: null, duration_ms: null, retries: 0, recovered: false, policy_denials: 0, injection_detections: 0,
    lease_owner: null, lease_expires_at: null, lease_fence: 0, started_at: null, finished_at: null,
  },
  workspace_webhooks: { status: 'active', failure_count: 0, last_delivery_at: null },
  webhook_deliveries: { status: 'pending', attempts: 0, last_status_code: null, last_error: null, lease_owner: null, lease_expires_at: null, delivered_at: null },
};
const VERSIONED = new Set(['workspace_agents', 'monitors', 'ci_products', 'ci_competitor_products', 'alert_rules', 'qa_projects', 'qa_scenarios', 'qa_runs', 'qa_results', 'workspace_webhooks']);
const UPDATED_AT = new Set(['monitors', 'ci_products', 'ci_competitor_products', 'alert_rules', 'qa_projects', 'qa_scenarios', 'qa_results', 'workspace_agents', 'workspace_webhooks']);

const lc = (v) => (typeof v === 'string' ? v.toLowerCase() : v);
const UNIQUE = {
  workspace_agents: [(r) => `${r.workspace_id}|${lc(r.name)}`],
  monitor_observations: [(r) => `${r.monitor_id}|${r.check_key}`],
  monitor_changes: [(r) => `${r.monitor_id}|${r.observation_id}|${r.change_type}|${r.field}`],
  ci_products: [(r) => (r.sku ? `${r.workspace_id}|${lc(r.sku)}` : null)],
  ci_recommendations: [(r) => `${r.workspace_id}|${r.dedup_key}`],
  alerts: [(r) => `${r.workspace_id}|${r.dedup_key}`],
  alert_deliveries: [(r) => `${r.alert_id}|${r.channel_key}`],
  qa_runs: [(r) => (r.idempotency_key ? `${r.workspace_id}|${r.idempotency_key}` : null)],
  qa_results: [(r) => `${r.run_id}|${r.scenario_id}`],
  webhook_deliveries: [(r) => `${r.webhook_id}|${r.event_id}`],
};
// parent table → [child table, fk column, action]
const REFS = {
  monitors: [['monitor_observations', 'monitor_id', 'cascade'], ['monitor_snapshots', 'monitor_id', 'cascade'], ['monitor_changes', 'monitor_id', 'cascade'],
    ['alert_rules', 'monitor_id', 'cascade'], ['alerts', 'monitor_id', 'cascade'], ['ci_products', 'own_monitor_id', 'restrict'], ['ci_competitor_products', 'monitor_id', 'restrict']],
  monitor_observations: [['monitor_changes', 'observation_id', 'cascade']],
  monitor_changes: [['ci_recommendations', 'change_id', 'set_null'], ['alerts', 'change_id', 'set_null']],
  ci_products: [['ci_competitor_products', 'product_id', 'cascade'], ['ci_recommendations', 'product_id', 'cascade'], ['alert_rules', 'product_id', 'cascade']],
  ci_competitor_products: [['ci_recommendations', 'competitor_id', 'cascade']],
  alert_rules: [['alerts', 'rule_id', 'cascade']],
  alerts: [['alert_deliveries', 'alert_id', 'cascade']],
  workspace_agents: [['qa_projects', 'agent_id', 'restrict']],
  qa_projects: [['qa_suites', 'project_id', 'cascade'], ['qa_scenarios', 'project_id', 'cascade'], ['qa_runs', 'project_id', 'cascade']],
  qa_suites: [['qa_scenarios', 'suite_id', 'cascade'], ['qa_runs', 'suite_id', 'cascade']],
  qa_scenarios: [['qa_results', 'scenario_id', 'cascade']],
  qa_runs: [['qa_results', 'run_id', 'cascade']],
  workspace_webhooks: [['webhook_deliveries', 'webhook_id', 'cascade']],
};

function matches(row, filter = {}) {
  for (const [col, v] of Object.entries(filter)) {
    const x = row[col];
    if (v === null) { if (x !== null && x !== undefined) return false; continue; }
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      if ('in' in v && !v.in.includes(x)) return false;
      if ('neq' in v && x === v.neq) return false;
      if ('lt' in v && !(x !== null && x !== undefined && x < v.lt)) return false;
      if ('lte' in v && !(x !== null && x !== undefined && x <= v.lte)) return false;
      if ('gt' in v && !(x !== null && x !== undefined && x > v.gt)) return false;
      if ('gte' in v && !(x !== null && x !== undefined && x >= v.gte)) return false;
      if ('contains' in v && !(Array.isArray(x) && v.contains.every((c) => x.includes(c)))) return false;
      if ('notNull' in v && (x === null || x === undefined)) return false;
      continue;
    }
    if (x !== v) return false;
  }
  return true;
}

function createMemoryRevenueStore({ now = () => new Date(), integrationCount = null, auditPurge = null } = {}) {
  const tables = new Map(Object.keys(DEFAULTS).map((t) => [t, new Map()]));
  const iso = () => now().toISOString();
  const t = (name) => { const m = tables.get(name); if (!m) throw new Error(`unknown table ${name}`); return m; };
  const failNext = new Map(); // op → error (fault injection)
  let seq = 0;

  function uniqueCheck(table, row, exceptId = null) {
    for (const key of UNIQUE[table] || []) {
      const k = key(row);
      if (k === null) continue;
      for (const r of t(table).values()) if (r.id !== exceptId && key(r) === k) throw err('23505', `duplicate key value violates unique constraint on ${table}`);
    }
  }
  function maybeFail(op) {
    if (failNext.has(op)) { const e = failNext.get(op); failNext.delete(op); throw e; }
  }

  function deleteRow(table, row) {
    for (const [child, col, action] of REFS[table] || []) {
      const kids = [...t(child).values()].filter((r) => r[col] === row.id && r.workspace_id === row.workspace_id);
      if (!kids.length) continue;
      if (action === 'restrict') throw err('23503', `update or delete on ${table} violates foreign key constraint from ${child}`);
    }
    for (const [child, col, action] of REFS[table] || []) {
      for (const k of [...t(child).values()].filter((r) => r[col] === row.id && r.workspace_id === row.workspace_id)) {
        if (action === 'cascade') deleteRow(child, k);
        else if (action === 'set_null') k[col] = null;
      }
    }
    t(table).delete(row.id);
  }

  const store = {
    tables, failNext,
    async insert(table, row) {
      maybeFail(`insert:${table}`);
      if (!row.workspace_id) throw new Error('workspace id is required');
      const r = { ...clone(DEFAULTS[table]), ...clone(row) };
      r.id = r.id || crypto.randomUUID();
      r.created_at = r.created_at || iso();
      seq += 1; r._seq = seq;
      if (VERSIONED.has(table)) r.version = r.version ?? 0;
      if (UPDATED_AT.has(table)) r.updated_at = r.updated_at || r.created_at;
      if (table === 'monitors' && !r.next_check_at) r.next_check_at = r.created_at;
      if (table === 'monitors' && r.source_type !== 'api_submission' && !r.integration_id) throw err('23514', 'monitors check violated');
      if (table === 'qa_scenarios' && ((r.executor === 'workflow') !== !!r.workflow_id || (r.executor === 'nexus_agent' && !r.goal))) throw err('23514', 'qa_scenarios check violated');
      uniqueCheck(table, r);
      t(table).set(r.id, r);
      return clone(r);
    },
    async tryInsert(table, row) {
      try { return await store.insert(table, row); } catch (e) { if (e.code === '23505') return null; throw e; }
    },
    async get(table, ws, id) {
      maybeFail(`get:${table}`);
      const r = t(table).get(id);
      return r && r.workspace_id === ws ? clone(r) : null;
    },
    async find(table, ws, filter) {
      const r = [...t(table).values()].sort((a, b) => a._seq - b._seq).find((x) => x.workspace_id === ws && matches(x, filter));
      return r ? clone(r) : null;
    },
    async list(table, ws, { filter = {}, order = ['created_at', false], limit = 100, offset = 0 } = {}) {
      maybeFail(`list:${table}`);
      let rows = [...t(table).values()].filter((x) => x.workspace_id === ws && matches(x, filter));
      if (order) {
        const [col, asc] = order;
        rows.sort((a, b) => {
          const va = a[col]; const vb = b[col];
          if (va === vb) return asc ? a._seq - b._seq : b._seq - a._seq;
          if (va === null || va === undefined) return 1;
          if (vb === null || vb === undefined) return -1;
          return (va < vb ? -1 : 1) * (asc ? 1 : -1);
        });
      }
      rows = rows.slice(offset, offset + Math.min(limit, 1000));
      return rows.map(clone);
    },
    async count(table, ws, filter = {}) {
      return [...t(table).values()].filter((x) => x.workspace_id === ws && matches(x, filter)).length;
    },
    async update(table, ws, id, patch, { expectVersion = null, touch = true } = {}) {
      maybeFail(`update:${table}`);
      const r = t(table).get(id);
      if (!r || r.workspace_id !== ws) return null;
      if (expectVersion !== null && r.version !== expectVersion) return null;
      const next = { ...r, ...clone(patch) };
      if (expectVersion !== null) next.version = expectVersion + 1;
      if (touch && UPDATED_AT.has(table)) next.updated_at = iso();
      uniqueCheck(table, next, id);
      t(table).set(id, next);
      return clone(next);
    },
    async updateWhere(table, ws, filter, patch) {
      const out = [];
      for (const r of t(table).values()) {
        if (r.workspace_id === ws && matches(r, filter)) { Object.assign(r, clone(patch)); out.push(clone(r)); }
      }
      return out;
    },
    async remove(table, ws, id) {
      maybeFail(`remove:${table}`);
      const r = t(table).get(id);
      if (!r || r.workspace_id !== ws) return false;
      deleteRow(table, r);
      return true;
    },
    async removeWhere(table, ws, filter) {
      const rows = [...t(table).values()].filter((x) => x.workspace_id === ws && matches(x, filter));
      for (const r of rows) if (t(table).has(r.id)) deleteRow(table, r);
      return rows.length;
    },
    async rpc(name, a) {
      maybeFail(`rpc:${name}`);
      const nowMs = now().getTime();
      const leaseFree = (r) => !r.lease_expires_at || Date.parse(r.lease_expires_at) < nowMs;
      if (name === 'claim_due_monitors') {
        if (!a.p_worker || a.p_lease_seconds < 5 || a.p_lease_seconds > 3600 || a.p_limit < 1 || a.p_limit > 200) throw err('22023', 'invalid arguments');
        const due = [...t('monitors').values()]
          .filter((m) => m.status === 'active' && m.source_type !== 'api_submission' && Date.parse(m.next_check_at) <= nowMs && leaseFree(m))
          .sort((x, y) => Date.parse(x.next_check_at) - Date.parse(y.next_check_at)).slice(0, a.p_limit);
        for (const m of due) { m.lease_owner = a.p_worker; m.lease_expires_at = new Date(nowMs + a.p_lease_seconds * 1000).toISOString(); m.lease_fence += 1; }
        return due.map(clone);
      }
      if (name === 'claim_qa_result') {
        if (!a.p_worker || a.p_lease_seconds < 5 || a.p_lease_seconds > 7200) throw err('22023', 'invalid arguments');
        const scen = t('qa_scenarios');
        const r = [...t('qa_results').values()]
          .filter((q) => { const s = scen.get(q.scenario_id); return s && s.executor !== 'external_agent' && (q.status === 'pending' || (q.status === 'running' && q.lease_expires_at && Date.parse(q.lease_expires_at) < nowMs)); })
          .sort((x, y) => (x.created_at === y.created_at ? x.position - y.position : (x.created_at < y.created_at ? -1 : 1)))[0];
        if (!r) return [];
        Object.assign(r, { lease_owner: a.p_worker, lease_expires_at: new Date(nowMs + a.p_lease_seconds * 1000).toISOString(), lease_fence: r.lease_fence + 1, status: 'running', started_at: r.started_at || iso(), updated_at: iso(), version: r.version + 1 });
        return [clone(r)];
      }
      if (name === 'claim_webhook_deliveries') {
        if (!a.p_worker || a.p_lease_seconds < 5 || a.p_lease_seconds > 600 || a.p_limit < 1 || a.p_limit > 200) throw err('22023', 'invalid arguments');
        const due = [...t('webhook_deliveries').values()]
          .filter((d) => ['pending', 'failed'].includes(d.status) && Date.parse(d.next_attempt_at) <= nowMs && leaseFree(d))
          .sort((x, y) => Date.parse(x.next_attempt_at) - Date.parse(y.next_attempt_at)).slice(0, a.p_limit);
        for (const d of due) { d.lease_owner = a.p_worker; d.lease_expires_at = new Date(nowMs + a.p_lease_seconds * 1000).toISOString(); }
        return due.map(clone);
      }
      if (name === 'enforce_monitored_product_limit') {
        const n = [...t('ci_products').values()].filter((p) => p.workspace_id === a.p_workspace).length;
        if (n <= a.p_limit) return true;
        const row = t('ci_products').get(a.p_product);
        if (row && row.workspace_id === a.p_workspace) deleteRow('ci_products', row);
        return false;
      }
      if (name === 'enforce_integration_limit') {
        if (!integrationCount) throw err('XX000', 'integration counter not wired');
        return integrationCount(a.p_workspace, a.p_integration, a.p_limit);
      }
      if (name === 'retention_purge_revenue') {
        const floor = nowMs - 7 * 86400000;
        if (a.p_monitoring_before && Date.parse(a.p_monitoring_before) > floor) throw err('22023', 'monitoring retention below the 7-day floor');
        if (a.p_qa_before && Date.parse(a.p_qa_before) > floor) throw err('22023', 'QA retention below the 7-day floor');
        const ws = a.p_workspace;
        const out = { observations: 0, snapshots: 0, alerts: 0, qaRuns: 0, webhookDeliveries: 0 };
        if (a.p_monitoring_before) {
          const b = a.p_monitoring_before;
          for (const r of [...t('alerts').values()]) if (r.workspace_id === ws && r.created_at < b) { deleteRow('alerts', r); out.alerts += 1; }
          const keepObs = new Set([...t('monitors').values()].map((m) => m.last_observation_id).filter(Boolean));
          for (const r of [...t('monitor_observations').values()]) if (r.workspace_id === ws && r.observed_at < b && !keepObs.has(r.id)) { deleteRow('monitor_observations', r); out.observations += 1; }
          for (const r of [...t('monitor_snapshots').values()]) {
            const m = t('monitors').get(r.monitor_id);
            if (r.workspace_id === ws && r.last_seen_at < b && !(m && m.current_hash === r.value_hash)) { deleteRow('monitor_snapshots', r); out.snapshots += 1; }
          }
          for (const r of [...t('webhook_deliveries').values()]) if (r.workspace_id === ws && r.created_at < b && ['delivered', 'dead'].includes(r.status)) { deleteRow('webhook_deliveries', r); out.webhookDeliveries += 1; }
        }
        if (a.p_qa_before) {
          for (const r of [...t('qa_runs').values()]) if (r.workspace_id === ws && ['completed', 'cancelled'].includes(r.status) && r.created_at < a.p_qa_before) { deleteRow('qa_runs', r); out.qaRuns += 1; }
        }
        return out;
      }
      if (name === 'purge_workspace_audit') return auditPurge ? auditPurge(a.p_workspace) : 0;
      throw new Error(`unknown rpc ${name}`);
    },
    /** Test helper: every row of a workspace across all tables. */
    rowsOf(ws) {
      const out = {};
      for (const [name, m] of tables) out[name] = [...m.values()].filter((r) => r.workspace_id === ws).map(clone);
      return out;
    },
    dropWorkspace(ws) {
      for (const m of tables.values()) for (const [id, r] of [...m]) if (r.workspace_id === ws) m.delete(id);
    },
  };
  return store;
}

module.exports = { createMemoryRevenueStore };
