/**
 * Layer 10 — Supabase persistence for the revenue product suite
 * (migrations/20261002_layer10_revenue.up.sql).
 *
 * A small table gateway: services express WHAT they read/write; every
 * tenant query is filtered by workspace_id (the gateway refuses a query
 * without one). The only cross-workspace operations are the worker RPCs
 * (lease claims), whose rows are then processed strictly inside their own
 * workspace.
 *
 * Filter values: scalar → eq; null → is null; { in: [] }, { neq }, { lt },
 * { lte }, { gt }, { gte }, { contains: [] } (array column ⊇).
 * Unique violations surface as err.code '23505' (tryInsert returns null).
 */
'use strict';

const { createClient } = require('@supabase/supabase-js');

const TABLES = new Set([
  'workspace_agents', 'monitors', 'monitor_observations', 'monitor_snapshots', 'monitor_changes',
  'ci_products', 'ci_competitor_products', 'ci_recommendations', 'alert_rules', 'alerts', 'alert_deliveries',
  'qa_projects', 'qa_suites', 'qa_scenarios', 'qa_runs', 'qa_results', 'workspace_webhooks', 'webhook_deliveries',
]);
const RPCS = new Set([
  'claim_due_monitors', 'claim_qa_result', 'claim_webhook_deliveries', 'enforce_monitored_product_limit',
  'enforce_integration_limit', 'retention_purge_revenue', 'purge_workspace_audit',
]);

let client = null;
function db() {
  if (!client) client = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
  return client;
}

function unwrap({ data, error }) {
  if (error) {
    const err = new Error(error.message || 'Database error');
    err.code = error.code;
    err.details = error.details;
    err.dbError = true;
    throw err;
  }
  return data;
}
const first = (rows) => (Array.isArray(rows) ? rows[0] || null : rows || null);

function checkTable(t) { if (!TABLES.has(t)) throw new Error(`revenue store: unknown table ${t}`); }
function checkWs(ws) { if (typeof ws !== 'string' || !ws) throw new Error('revenue store: workspace id is required'); }

function applyFilter(q, filter = {}) {
  for (const [col, v] of Object.entries(filter)) {
    if (v === null) q = q.is(col, null);
    else if (v && typeof v === 'object' && !Array.isArray(v)) {
      if ('in' in v) q = q.in(col, v.in);
      if ('neq' in v) q = q.neq(col, v.neq);
      if ('lt' in v) q = q.lt(col, v.lt);
      if ('lte' in v) q = q.lte(col, v.lte);
      if ('gt' in v) q = q.gt(col, v.gt);
      if ('gte' in v) q = q.gte(col, v.gte);
      if ('contains' in v) q = q.contains(col, v.contains);
      if ('notNull' in v) q = q.not(col, 'is', null);
    } else q = q.eq(col, v);
  }
  return q;
}

function createSupabaseRevenueStore() {
  const nowIso = () => new Date().toISOString();
  return {
    async insert(table, row) {
      checkTable(table); checkWs(row.workspace_id);
      return unwrap(await db().from(table).insert(row).select('*').single());
    },
    /** Insert; a unique violation returns null (idempotent writes). */
    async tryInsert(table, row) {
      try { return await this.insert(table, row); } catch (err) { if (err.code === '23505') return null; throw err; }
    },
    async get(table, ws, id) {
      checkTable(table); checkWs(ws);
      return first(unwrap(await db().from(table).select('*').eq('workspace_id', ws).eq('id', id).limit(1)));
    },
    async find(table, ws, filter) {
      checkTable(table); checkWs(ws);
      return first(unwrap(await applyFilter(db().from(table).select('*').eq('workspace_id', ws), filter).limit(1)));
    },
    async list(table, ws, { filter = {}, order = ['created_at', false], limit = 100, offset = 0 } = {}) {
      checkTable(table); checkWs(ws);
      let q = applyFilter(db().from(table).select('*').eq('workspace_id', ws), filter);
      if (order) q = q.order(order[0], { ascending: !!order[1] });
      return unwrap(await q.range(offset, offset + Math.min(limit, 1000) - 1));
    },
    async count(table, ws, filter = {}) {
      checkTable(table); checkWs(ws);
      const { count, error } = await applyFilter(db().from(table).select('id', { count: 'exact', head: true }).eq('workspace_id', ws), filter);
      if (error) unwrap({ error });
      return count || 0;
    },
    /** Optimistic concurrency when `expectVersion` is given (mismatch → null). */
    async update(table, ws, id, patch, { expectVersion = null, touch = true } = {}) {
      checkTable(table); checkWs(ws);
      const p = { ...patch };
      if (expectVersion !== null) p.version = expectVersion + 1;
      if (touch && ['monitors', 'ci_products', 'ci_competitor_products', 'alert_rules', 'qa_projects', 'qa_scenarios', 'qa_results', 'workspace_agents', 'workspace_webhooks'].includes(table)) p.updated_at = nowIso();
      let q = db().from(table).update(p).eq('workspace_id', ws).eq('id', id);
      if (expectVersion !== null) q = q.eq('version', expectVersion);
      return first(unwrap(await q.select('*')));
    },
    async updateWhere(table, ws, filter, patch) {
      checkTable(table); checkWs(ws);
      return unwrap(await applyFilter(db().from(table).update(patch).eq('workspace_id', ws), filter).select('*'));
    },
    async remove(table, ws, id) {
      checkTable(table); checkWs(ws);
      return unwrap(await db().from(table).delete().eq('workspace_id', ws).eq('id', id).select('id')).length > 0;
    },
    async removeWhere(table, ws, filter) {
      checkTable(table); checkWs(ws);
      return unwrap(await applyFilter(db().from(table).delete().eq('workspace_id', ws), filter).select('id')).length;
    },
    async rpc(name, args) {
      if (!RPCS.has(name)) throw new Error(`revenue store: unknown rpc ${name}`);
      return unwrap(await db().rpc(name, args));
    },
  };
}

module.exports = { createSupabaseRevenueStore, TABLES, RPCS };
