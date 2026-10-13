/**
 * TEST-ONLY minimal PostgREST/supabase-js emulator for the legacy MCIS
 * tables (chats, conversations, user_memories, memory_vectors, goals, …).
 *
 * Implements exactly the query-builder surface those modules use:
 *   from(t).select(cols,{count,head}) | insert | update | delete | upsert
 *   .eq .neq .lt .gt .in .is .ilike .or('a.eq.x,b.is.null,c.ilike.%t%')
 *   .order .limit .single .maybeSingle, thenable
 *   rpc('search_memories' | 'search_memories_scoped', params)
 * Real-DB coverage of the same code runs with WORKSPACE_TEST_STORE=supabase.
 */
'use strict';

const crypto = require('crypto');

function cosine(a, b) {
  let dot = 0; let na = 0; let nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

const toStr = (v) => (v === null || v === undefined ? null : String(v));

function likeToRegex(pattern) {
  const esc = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*').replace(/_/g, '.');
  return new RegExp(`^${esc}$`, 'is');
}

function orColumns(expr) {
  return expr.split(',').map((t) => t.split('.')[0]);
}

function parseOr(expr) {
  // top-level comma split (no nested groups needed by the code under test)
  return expr.split(',').map((term) => {
    const m = term.match(/^([a-zA-Z_]+)\.(eq|neq|is|ilike)\.(.*)$/s);
    if (!m) throw new Error(`fakeSupabase: unsupported or() term "${term}"`);
    const [, col, op, val] = m;
    if (op === 'eq') return (r) => toStr(r[col]) === val;
    if (op === 'neq') return (r) => toStr(r[col]) !== val;
    if (op === 'is') return (r) => (val === 'null' ? r[col] === null || r[col] === undefined : String(r[col]) === val);
    const re = likeToRegex(val);
    return (r) => r[col] != null && re.test(String(r[col]));
  });
}

function createFakeSupabase({ tables = {}, unique = {}, serialTables = [] } = {}) {
  const seq = {};
  const rowsOf = (t) => (tables[t] || (tables[t] = []));
  let queryCount = 0;

  function builder(table) {
    const st = { op: 'select', filters: [], orders: [], limit: null, returning: false, cols: '*', count: null, head: false, payload: null, orCols: [] };

    const run = () => {
      queryCount++;
      const rows = rowsOf(table);
      const match = (r) => st.filters.every((f) => f(r));
      const project = (r) => {
        if (st.cols === '*' || !st.cols) return { ...r };
        const out = {};
        for (const c of st.cols.split(',').map((x) => x.trim()).filter(Boolean)) out[c] = r[c] === undefined ? null : r[c];
        return out;
      };
      if (st.op === 'insert' || st.op === 'upsert') {
        const list = Array.isArray(st.payload) ? st.payload : [st.payload];
        const inserted = [];
        for (const raw of list) {
          const row = { ...raw };
          if (row.id === undefined) {
            if (serialTables.includes(table)) { seq[table] = (seq[table] || 0) + 1; row.id = seq[table]; } else row.id = crypto.randomUUID();
          }
          if (row.created_at === undefined) row.created_at = new Date().toISOString();
          for (const key of unique[table] || []) {
            const cols = key.split(',');
            const clash = rows.find((r) => cols.every((c) => toStr(r[c]) === toStr(row[c])));
            if (clash) {
              if (st.op === 'upsert') { Object.assign(clash, row); inserted.push(clash); continue; }
              return { data: null, error: { code: '23505', message: `duplicate key value violates unique constraint (${key})` } };
            }
          }
          rows.push(row);
          inserted.push(row);
        }
        return { data: st.returning ? inserted.map(project) : null, error: null };
      }
      // Real PostgREST (v12) evaluates or() of a mutation against the
      // RETURNED columns: an or() column missing from select() is a 42703.
      if ((st.op === 'update' || st.op === 'delete') && st.returning && st.cols !== '*') {
        const selected = st.cols.split(',').map((c) => c.trim());
        const missing = st.orCols.find((c) => !selected.includes(c));
        if (missing) return { data: null, error: { code: '42703', message: `column ${table}.${missing} does not exist` } };
      }
      let matched = rows.filter(match);
      if (st.op === 'update') {
        matched.forEach((r) => Object.assign(r, st.payload));
        return { data: st.returning ? matched.map(project) : null, error: null };
      }
      if (st.op === 'delete') {
        tables[table] = rows.filter((r) => !match(r));
        return { data: st.returning ? matched.map(project) : null, error: null };
      }
      for (const [col, asc] of st.orders.slice().reverse()) {
        matched = matched.slice().sort((a, b) => (String(a[col]) < String(b[col]) ? -1 : String(a[col]) > String(b[col]) ? 1 : 0) * (asc ? 1 : -1));
      }
      if (st.count && st.head) return { data: null, count: matched.length, error: null };
      if (st.limit !== null) matched = matched.slice(0, st.limit);
      return { data: matched.map(project), error: null, count: st.count ? matched.length : undefined };
    };

    const b = {
      select(cols = '*', opts = {}) {
        if (st.op === 'select') { st.cols = cols; st.count = opts.count || null; st.head = !!opts.head; } else { st.returning = true; st.cols = cols; }
        return b;
      },
      insert(p) { st.op = 'insert'; st.payload = p; return b; },
      upsert(p) { st.op = 'upsert'; st.payload = p; return b; },
      update(p) { st.op = 'update'; st.payload = p; return b; },
      delete() { st.op = 'delete'; return b; },
      eq(c, v) { st.filters.push((r) => toStr(r[c]) === toStr(v)); return b; },
      neq(c, v) { st.filters.push((r) => toStr(r[c]) !== toStr(v)); return b; },
      lt(c, v) { st.filters.push((r) => r[c] < v); return b; },
      gt(c, v) { st.filters.push((r) => r[c] > v); return b; },
      in(c, arr) { const s = new Set((arr || []).map(toStr)); st.filters.push((r) => s.has(toStr(r[c]))); return b; },
      is(c, v) { st.filters.push((r) => (v === null ? r[c] == null : r[c] === v)); return b; },
      ilike(c, p) { const re = likeToRegex(p); st.filters.push((r) => r[c] != null && re.test(String(r[c]))); return b; },
      or(expr) { const terms = parseOr(expr); st.orCols.push(...orColumns(expr)); st.filters.push((r) => terms.some((t) => t(r))); return b; },
      order(c, { ascending = true } = {}) { st.orders.push([c, ascending]); return b; },
      limit(n) { st.limit = n; return b; },
      async single() {
        const r = run(); if (r.error) return r;
        const d = Array.isArray(r.data) ? r.data : [];
        return d.length === 1 ? { data: d[0], error: null } : { data: null, error: { code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned' } };
      },
      async maybeSingle() {
        const r = run(); if (r.error) return r;
        const d = Array.isArray(r.data) ? r.data : [];
        return { data: d[0] || null, error: null };
      },
      then(resolve, reject) { try { resolve(run()); } catch (e) { reject(e); } },
    };
    return b;
  }

  const vectorsFor = (filterFn, queryEmbedding, count) => {
    const q = JSON.parse(queryEmbedding);
    return rowsOf('memory_vectors').filter(filterFn)
      .map((m) => ({ content: m.content, similarity: cosine(q, typeof m.embedding === 'string' ? JSON.parse(m.embedding) : m.embedding) }))
      .sort((a, b) => b.similarity - a.similarity).slice(0, count);
  };

  const client = {
    from: (t) => builder(t),
    async rpc(name, p) {
      queryCount++;
      if (name === 'search_memories') {
        return { data: vectorsFor((m) => toStr(m.user_id) === toStr(p.match_user_id), p.query_embedding, p.match_count || 8), error: null };
      }
      if (name === 'search_memories_scoped') {
        return {
          data: vectorsFor((m) => toStr(m.user_id) === toStr(p.match_user_id)
            && (m.workspace_id === p.match_workspace_id || (p.include_unscoped && m.workspace_id == null)), p.query_embedding, p.match_count || 8),
          error: null,
        };
      }
      return { data: [], error: null };
    },
  };

  return { client, tables, get queryCount() { return queryCount; } };
}

module.exports = { createFakeSupabase };
