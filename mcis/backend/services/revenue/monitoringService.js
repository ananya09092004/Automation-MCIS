/**
 * Layer 10 — generic monitoring engine.
 *
 *   monitor (source + schedule) → check (connector action through the
 *   firewall) → structured extraction → normalized observation (VERIFIED /
 *   UNVERIFIED / UNAVAILABLE) → de-duplicated snapshot → deterministic
 *   changes → events (alerts, competitor recommendations, webhooks)
 *
 * Sources
 *   web_page         product | page    web_page.fetch_product {url, sku?, variant_id?}
 *   shopify_product  product           web_page.fetch_product on a /products/<handle>.js(on) URL
 *   json_api         api_value|product web_page.fetch_json {url, fields}  or  http.get {path, query} + fields
 *   api_submission   any               values pushed through the automation API (always UNVERIFIED:
 *                                      Nexus did not observe them itself)
 *
 * Health (monitor.health):  PENDING → VERIFIED | UNVERIFIED | UNAVAILABLE | STALE
 *   VERIFIED     last check read structured data from the source itself
 *   UNVERIFIED   partial data (e.g. no price published) or API-submitted
 *   UNAVAILABLE  last check failed / was blocked; `current` is the last
 *                good value and is shown as such, never as fresh
 *   STALE        no successful check within stale_after_minutes
 *
 * Honesty rules: a failed or blocked check never changes `current`; an
 * UNKNOWN stock state never produces a stock change; a missing price is
 * null, never 0; identical observations never produce changes (hash
 * dedupe); every check is idempotent by its check key (a retried check
 * with the same key records nothing twice and is metered once).
 */
'use strict';

const crypto = require('crypto');
const C = require('./common');
const { normalizeProduct, normalizeValues, valueHash, diffProduct, diffValues } = require('../monitoring/normalize');
const { sanitize } = require('../security/sensitiveClassifier');

const KINDS = ['product', 'page', 'api_value'];
const SOURCE_TYPES = ['web_page', 'shopify_product', 'json_api', 'api_submission'];
const COMBOS = {
  web_page: ['product', 'page'],
  shopify_product: ['product'],
  json_api: ['api_value', 'product'],
  api_submission: ['product', 'page', 'api_value'],
};
const PRODUCT_FIELDS = ['price', 'currency', 'listPrice', 'availability', 'seller', 'title', 'sku', 'gtin', 'mpn', 'brand', 'model'];
const MAX_MONITORS_PER_WORKSPACE_HARD = 5000;

function createMonitoringService({
  store, connectorActions = null, integrations = null, usage = null, events = null, appendAuditLog = null, logger = console, options = {},
} = {}) {
  if (!store) throw new Error('monitoring service: store is required');
  const now = options.now || (() => new Date());
  const iso = () => now().toISOString();
  const minutes = (n) => new Date(now().getTime() + n * 60000).toISOString();

  const audit = (actor, action, payload, ws, success = true) => {
    if (!appendAuditLog) return;
    try { Promise.resolve(appendAuditLog(actor, action, sanitize(payload), { success, error: null }, ws)).catch(() => {}); } catch { /* never */ }
  };
  const emit = (type, payload) => (events ? events.emit(type, payload) : Promise.resolve());

  // ------------------------------------------------------------------
  // Views
  // ------------------------------------------------------------------
  function isStale(m) {
    if (!m.last_success_at) return m.health !== 'PENDING' && m.health !== 'UNVERIFIED';
    return now().getTime() - Date.parse(m.last_success_at) > m.stale_after_minutes * 60000;
  }
  function monitorView(m) {
    return {
      id: m.id,
      name: m.name,
      kind: m.kind,
      sourceType: m.source_type,
      integrationId: m.integration_id,
      source: m.source,
      checkIntervalMinutes: m.check_interval_minutes,
      staleAfterMinutes: m.stale_after_minutes,
      status: m.status,
      health: m.health,
      healthReason: m.health_reason,
      // `current` is the last GOOD observation; `currentIsFresh` says whether it may be treated as current.
      current: m.current,
      currentIsFresh: !!m.current && (m.health === 'VERIFIED' || m.health === 'UNVERIFIED') && !isStale(m),
      lastCheckAt: m.last_check_at,
      lastSuccessAt: m.last_success_at,
      nextCheckAt: m.status === 'active' && m.source_type !== 'api_submission' ? m.next_check_at : null,
      consecutiveFailures: m.consecutive_failures,
      createdBy: m.created_by,
      version: m.version,
      createdAt: m.created_at,
      updatedAt: m.updated_at,
    };
  }
  const observationView = (o) => ({
    id: o.id, observedAt: o.observed_at, status: o.status, values: o.values, method: o.method, errorCode: o.error_code, evidence: o.evidence,
  });
  const changeView = (c) => ({
    id: c.id, monitorId: c.monitor_id, observationId: c.observation_id, changeType: c.change_type, field: c.field,
    oldValue: c.old_value, newValue: c.new_value, detectedAt: c.detected_at, confidence: C.dbNum(c.confidence), verification: c.verification, source: c.source,
  });

  // ------------------------------------------------------------------
  // Validation
  // ------------------------------------------------------------------
  async function validateSource(ws, sourceType, kind, integrationId, raw) {
    const src = C.onlyKeys(raw || {}, ['url', 'sku', 'variantId', 'fields', 'path', 'query'], 'source');
    if (sourceType === 'api_submission') {
      if (integrationId) throw C.bad('api_submission monitors take no integration');
      if (src.fields !== undefined) {
        if (!Array.isArray(src.fields) || src.fields.length > 30 || src.fields.some((f) => typeof f !== 'string' || !/^[a-z][a-z0-9_]{0,59}$/.test(f))) throw C.bad('source.fields must list at most 30 field names');
        return { fields: src.fields };
      }
      return {};
    }
    if (!C.isUuid(integrationId)) throw C.bad('integrationId is required for this source type');
    if (!integrations) throw C.bad('Integrations are not enabled on this server', 'INTEGRATIONS_DISABLED');
    const i = await integrations.getIntegrationRow(ws, integrationId);
    if (!i) throw C.notFound('Integration');
    const out = {};
    if (sourceType === 'web_page' || sourceType === 'shopify_product' || (sourceType === 'json_api' && i.provider === 'web_page')) {
      if (i.provider !== 'web_page') throw C.bad('This source type needs a "Web pages" integration');
      if (typeof src.url !== 'string' || src.url.length > 2000) throw C.bad('source.url is required');
      out.url = src.url.trim();
      if (sourceType === 'shopify_product' && !/\/products\/[^/?#]+\.(js|json)(\?|$)/.test(new URL(out.url).pathname + (new URL(out.url).search || ''))) {
        throw C.bad('source.url must be a Shopify product JSON URL (…/products/<handle>.js or .json)');
      }
      if (src.sku !== undefined) out.sku = C.str(src.sku, 'source.sku', { max: 100 });
      if (src.variantId !== undefined) {
        if (typeof src.variantId !== 'string' || !/^[0-9A-Za-z_-]{1,40}$/.test(src.variantId)) throw C.bad('source.variantId is invalid');
        out.variantId = src.variantId;
      }
    } else if (sourceType === 'json_api') {
      if (i.provider !== 'http') throw C.bad('json_api sources need a "Web pages" or "HTTP / REST API" integration');
      if (typeof src.path !== 'string' || !/^\/(?!\/)[^\s?#\\]{0,999}$/.test(src.path)) throw C.bad('source.path must be an absolute path under the API base URL');
      out.path = src.path;
      if (src.query !== undefined) {
        C.onlyKeys(src.query, Object.keys(src.query), 'source.query');
        if (Object.keys(src.query).length > 20 || Object.values(src.query).some((v) => typeof v !== 'string' || v.length > 500)) throw C.bad('source.query must map at most 20 names to strings');
        out.query = src.query;
      }
    }
    if (sourceType === 'json_api') {
      const f = src.fields;
      if (!f || typeof f !== 'object' || Array.isArray(f) || !Object.keys(f).length || Object.keys(f).length > 20) throw C.bad('source.fields must map 1-20 names to JSON Pointers');
      for (const [k, p] of Object.entries(f)) {
        if (!/^[a-z][a-z0-9_]{0,59}$/.test(k) && !(kind === 'product' && PRODUCT_FIELDS.includes(k))) throw C.bad(`source.fields: invalid name "${String(k).slice(0, 60)}"`);
        if (typeof p !== 'string' || !/^\/[^\s]{0,200}$/.test(p)) throw C.bad(`source.fields.${k} must be a JSON Pointer like /data/price`);
      }
      if (kind === 'product' && !f.price && !f.availability) throw C.bad('A product source must map at least price or availability');
      out.fields = f;
    }
    // Validate the action input with the connector itself (host allowlist etc.) without running it.
    const spec = connectorSpec({ source_type: sourceType, kind, integration_id: integrationId, source: out }, i.provider);
    try { integrations.validateActionInput(i, spec.action, spec.input); } catch (err) { throw C.bad(err.message || 'Invalid source'); }
    return out;
  }

  function connectorSpec(m, provider) {
    const s = m.source || {};
    if (m.source_type === 'json_api') {
      if (provider === 'http') return { action: 'get', input: { path: s.path, ...(s.query ? { query: s.query } : {}) }, fields: s.fields };
      return { action: 'fetch_json', input: { url: s.url, fields: s.fields }, fields: null };
    }
    return { action: 'fetch_product', input: { url: s.url, ...(s.sku ? { sku: s.sku } : {}), ...(s.variantId ? { variant_id: s.variantId } : {}) } };
  }

  // ------------------------------------------------------------------
  // CRUD
  // ------------------------------------------------------------------
  async function load(ctx, id) {
    const ws = C.requireCtx(ctx);
    const m = await store.get('monitors', ws, C.uuidOr404(id, 'Monitor'));
    if (!m) throw C.notFound('Monitor');
    return m;
  }

  async function createMonitor(ctx, body = {}, { internal = false } = {}) {
    const ws = C.requireCtx(ctx);
    if (!internal) C.requireAdmin(ctx, 'monitors');
    C.onlyKeys(body, ['name', 'kind', 'sourceType', 'integrationId', 'source', 'checkIntervalMinutes', 'staleAfterMinutes', 'status']);
    const kind = C.oneOf(body.kind, 'kind', KINDS);
    const sourceType = C.oneOf(body.sourceType, 'sourceType', SOURCE_TYPES);
    if (!COMBOS[sourceType].includes(kind)) throw C.bad(`A ${sourceType} source cannot be a ${kind} monitor`);
    const interval = C.int(body.checkIntervalMinutes, 'checkIntervalMinutes', { min: 15, max: 10080, dflt: 360 });
    const stale = C.int(body.staleAfterMinutes, 'staleAfterMinutes', { min: 30, max: 43200, dflt: Math.min(43200, Math.max(30, interval * 3)) });
    if (stale < interval && sourceType !== 'api_submission') throw C.bad('staleAfterMinutes must be at least checkIntervalMinutes');
    const source = await validateSource(ws, sourceType, kind, body.integrationId || null, body.source);
    if ((await store.count('monitors', ws)) >= MAX_MONITORS_PER_WORKSPACE_HARD) throw C.conflict('This workspace has too many monitors', 'MONITOR_LIMIT');
    const row = await store.insert('monitors', {
      workspace_id: ws, name: C.str(body.name, 'name', { max: 200 }), kind, source_type: sourceType,
      integration_id: sourceType === 'api_submission' ? null : body.integrationId, source,
      check_interval_minutes: interval, stale_after_minutes: stale,
      status: C.oneOf(body.status, 'status', ['active', 'paused'], 'active'), next_check_at: iso(), created_by: ctx.userId,
    });
    audit(ctx.userId, 'monitor_created', { workspaceId: ws, monitorId: row.id, kind, sourceType }, ws);
    return monitorView(row);
  }

  async function updateMonitor(ctx, id, body = {}) {
    const m = await load(ctx, id);
    C.requireAdmin(ctx, 'monitors');
    C.onlyKeys(body, ['version', 'name', 'source', 'checkIntervalMinutes', 'staleAfterMinutes', 'status']);
    if (!Number.isInteger(body.version) || body.version !== m.version) throw C.conflict('version is required and must match the current version', 'MONITOR_CONFLICT');
    const patch = {};
    if (body.name !== undefined) patch.name = C.str(body.name, 'name', { max: 200 });
    if (body.checkIntervalMinutes !== undefined) patch.check_interval_minutes = C.int(body.checkIntervalMinutes, 'checkIntervalMinutes', { min: 15, max: 10080 });
    if (body.staleAfterMinutes !== undefined) patch.stale_after_minutes = C.int(body.staleAfterMinutes, 'staleAfterMinutes', { min: 30, max: 43200 });
    if (body.status !== undefined) {
      patch.status = C.oneOf(body.status, 'status', ['active', 'paused']);
      if (patch.status === 'active' && m.status === 'paused') patch.next_check_at = iso();
    }
    if (body.source !== undefined) {
      patch.source = await validateSource(m.workspace_id, m.source_type, m.kind, m.integration_id, body.source);
      // A new source is a new series: the old value is no longer "current".
      Object.assign(patch, { current: null, current_hash: null, health: 'PENDING', health_reason: null, next_check_at: iso(), consecutive_failures: 0 });
    }
    const interval = patch.check_interval_minutes ?? m.check_interval_minutes;
    const stale = patch.stale_after_minutes ?? m.stale_after_minutes;
    if (stale < interval && m.source_type !== 'api_submission') throw C.bad('staleAfterMinutes must be at least checkIntervalMinutes');
    if (!Object.keys(patch).length) throw C.bad('Nothing to update');
    const u = await store.update('monitors', m.workspace_id, m.id, patch, { expectVersion: m.version });
    if (!u) throw C.conflict('The monitor was changed concurrently; reload and retry.', 'MONITOR_CONFLICT');
    audit(ctx.userId, 'monitor_updated', { workspaceId: m.workspace_id, monitorId: m.id, fields: Object.keys(patch) }, m.workspace_id);
    return monitorView(u);
  }

  async function deleteMonitor(ctx, id) {
    const m = await load(ctx, id);
    C.requireAdmin(ctx, 'monitors');
    try {
      await store.remove('monitors', m.workspace_id, m.id);
    } catch (err) {
      if (err.code === '23503') throw C.conflict('This monitor tracks a product or competitor; remove it there first.', 'MONITOR_IN_USE');
      throw err;
    }
    audit(ctx.userId, 'monitor_deleted', { workspaceId: m.workspace_id, monitorId: m.id }, m.workspace_id);
    return { deleted: true };
  }

  async function listMonitors(ctx, { kind, health, limit } = {}) {
    const ws = C.requireCtx(ctx);
    const filter = {};
    if (kind) filter.kind = C.oneOf(kind, 'kind', KINDS);
    if (health) filter.health = C.oneOf(health, 'health', ['PENDING', 'VERIFIED', 'UNVERIFIED', 'STALE', 'UNAVAILABLE']);
    const rows = await store.list('monitors', ws, { filter, limit: Math.min(Math.max(parseInt(limit, 10) || 200, 1), 1000) });
    return rows.map(monitorView);
  }

  async function getMonitor(ctx, id) {
    const m = await load(ctx, id);
    const [observations, changes, snapshots] = await Promise.all([
      store.list('monitor_observations', m.workspace_id, { filter: { monitor_id: m.id }, order: ['observed_at', false], limit: 20 }),
      store.list('monitor_changes', m.workspace_id, { filter: { monitor_id: m.id }, order: ['detected_at', false], limit: 50 }),
      store.list('monitor_snapshots', m.workspace_id, { filter: { monitor_id: m.id }, order: ['first_seen_at', false], limit: 50 }),
    ]);
    return {
      ...monitorView(m),
      observations: observations.map(observationView),
      changes: changes.map(changeView),
      history: snapshots.map((s) => ({ values: s.values, firstSeenAt: s.first_seen_at, lastSeenAt: s.last_seen_at, observations: s.observation_count })),
    };
  }

  async function listChanges(ctx, { monitorId, since, limit } = {}) {
    const ws = C.requireCtx(ctx);
    const filter = {};
    if (monitorId) filter.monitor_id = C.uuidOr404(monitorId, 'Monitor');
    if (since) {
      const t = Date.parse(since);
      if (!Number.isFinite(t)) throw C.bad('since must be an ISO date');
      filter.detected_at = { gte: new Date(t).toISOString() };
    }
    const rows = await store.list('monitor_changes', ws, { filter, order: ['detected_at', false], limit: Math.min(Math.max(parseInt(limit, 10) || 100, 1), 500) });
    return rows.map(changeView);
  }

  // ------------------------------------------------------------------
  // Observation pipeline (shared by checks and API submissions)
  // ------------------------------------------------------------------
  function normalizeFor(m, raw, { present = true, currencyDefault = null } = {}) {
    if (m.kind === 'product') return normalizeProduct(raw, { present, currencyDefault });
    return normalizeValues(raw);
  }

  /**
   * Record one observation and everything derived from it. Idempotent by
   * checkKey. `outcome`: { status, values?, method?, errorCode?, evidence }.
   * Returns { observation, changes, replayed }.
   */
  const monitorLocks = new Map(); // monitorId -> tail of its apply queue
  function withMonitorLock(id, fn) {
    const prev = monitorLocks.get(id) || Promise.resolve();
    const run = prev.then(fn, fn);
    const tail = run.catch(() => {});
    monitorLocks.set(id, tail);
    tail.then(() => { if (monitorLocks.get(id) === tail) monitorLocks.delete(id); });
    return run;
  }

  async function recordObservation(m, checkKey, outcome0, { fence = null } = {}) {
    const ws = m.workspace_id;
    // Values come from outside (pages, APIs, API clients): secrets are redacted before anything is stored.
    const outcome = outcome0.values ? { ...outcome0, values: sanitize(outcome0.values, { maxString: 300 }) } : outcome0;
    const hash = outcome.values ? valueHash(outcome.values, m.kind) : null;
    const obs = await store.tryInsert('monitor_observations', {
      workspace_id: ws, monitor_id: m.id, check_key: checkKey, observed_at: iso(), status: outcome.status,
      values: outcome.values || null, value_hash: hash, method: outcome.method || null,
      evidence: sanitize(outcome.evidence || {}, { maxString: 300 }), error_code: outcome.errorCode || null,
    });
    if (!obs) {
      const existing = await store.find('monitor_observations', ws, { monitor_id: m.id, check_key: checkKey });
      return { observation: existing, changes: [], replayed: true };
    }
    // Re-read the monitor: diff against the latest state (another check may have landed).
    // Applying is serialized per monitor inside this process (many concurrent
    // submissions to ONE monitor otherwise starve each other's optimistic
    // update); the version check still guards against other instances.
    return withMonitorLock(m.id, async () => {
    for (let attempt = 0; attempt < 25; attempt++) {
      if (attempt) await new Promise((r) => setTimeout(r, 5 + Math.floor(Math.random() * 20 * Math.min(attempt, 5))));
      const cur = await store.get('monitors', ws, m.id);
      if (!cur) return { observation: obs, changes: [], replayed: false }; // deleted meanwhile
      if (fence !== null && cur.lease_fence !== fence) {
        logger.warn?.('[monitoring] lease lost; result recorded without state update');
        return { observation: obs, changes: [], replayed: false, leaseLost: true };
      }
      const ok = outcome.status !== 'UNAVAILABLE' && outcome.values;
      const changes = [];
      const patch = { last_check_at: obs.observed_at, last_observation_id: obs.id };
      if (ok) {
        const diffs = cur.current && cur.current_hash !== hash
          ? (m.kind === 'product' ? diffProduct(cur.current, outcome.values) : diffValues(cur.current, outcome.values)) : [];
        if (cur.health === 'UNAVAILABLE' || cur.health === 'STALE') changes.push({ changeType: 'source_recovered', field: 'health', oldValue: cur.health, newValue: outcome.status });
        changes.push(...diffs);
        Object.assign(patch, {
          current: outcome.values, current_hash: hash, health: outcome.status, health_reason: outcome.reason || null,
          last_success_at: obs.observed_at, consecutive_failures: 0,
        });
      } else {
        if (cur.health !== 'UNAVAILABLE' && cur.health !== 'PENDING') changes.push({ changeType: 'source_unavailable', field: 'health', oldValue: cur.health, newValue: 'UNAVAILABLE', meta: { errorCode: outcome.errorCode } });
        Object.assign(patch, { health: 'UNAVAILABLE', health_reason: String(outcome.reason || outcome.errorCode || 'Unavailable').slice(0, 300), consecutive_failures: cur.consecutive_failures + 1 });
      }
      if (fence !== null) {
        const interval = cur.check_interval_minutes;
        const next = ok ? interval : Math.min(interval, 15 * 2 ** Math.min(cur.consecutive_failures, 6));
        Object.assign(patch, { next_check_at: minutes(next), lease_owner: null, lease_expires_at: null });
      }
      const updated = await store.update('monitors', ws, m.id, patch, { expectVersion: cur.version });
      if (!updated) continue; // concurrent edit: re-read and re-diff
      if (ok) await upsertSnapshot(updated, obs, hash, outcome.values);
      const saved = [];
      for (const c of changes) {
        const row = await store.tryInsert('monitor_changes', {
          workspace_id: ws, monitor_id: m.id, observation_id: obs.id, change_type: c.changeType, field: c.field,
          old_value: c.oldValue === undefined ? null : c.oldValue, new_value: c.newValue === undefined ? null : c.newValue,
          detected_at: obs.observed_at, confidence: outcome.status === 'VERIFIED' || c.changeType.startsWith('source_') ? 1 : 0.6,
          verification: outcome.status === 'VERIFIED' || c.changeType.startsWith('source_') ? 'VERIFIED' : 'UNVERIFIED',
          source: outcome.sourceLabel || null,
        });
        if (row) saved.push({ ...changeView(row), meta: c.meta || null });
      }
      await emit('monitor.checked', { workspaceId: ws, monitor: monitorView(updated), monitorRow: updated, observation: observationView(obs), changes: saved });
      return { observation: obs, changes: saved, replayed: false, monitor: updated };
    }
    throw C.conflict('The monitor is being changed concurrently; the observation was recorded but not applied.', 'MONITOR_CONFLICT');
    });
  }

  async function upsertSnapshot(m, obs, hash, values) {
    const ws = m.workspace_id;
    const last = (await store.list('monitor_snapshots', ws, { filter: { monitor_id: m.id }, order: ['last_seen_at', false], limit: 1 }))[0];
    if (last && last.value_hash === hash) {
      await store.update('monitor_snapshots', ws, last.id, { last_observation_id: obs.id, last_seen_at: obs.observed_at, observation_count: last.observation_count + 1 }, { touch: false });
      return;
    }
    await store.insert('monitor_snapshots', {
      workspace_id: ws, monitor_id: m.id, value_hash: hash, values, first_observation_id: obs.id, last_observation_id: obs.id,
      first_seen_at: obs.observed_at, last_seen_at: obs.observed_at,
    });
  }

  /** Turn a connector result into an observation outcome (no raw content kept). */
  function outcomeFromConnector(m, res, provider, spec) {
    if (!res.ok) {
      return { status: 'UNAVAILABLE', errorCode: String(res.code || 'CONNECTOR_ERROR').slice(0, 80), reason: res.message, evidence: { blocked: !!res.blocked, code: res.code } };
    }
    const d = res.data || {};
    const evidence = { target: res.target || null, httpStatus: d.httpStatus ?? d.status ?? null, contentHash: d.contentHash || null, method: d.method || null };
    const currencyDefault = d.defaultCurrency || null;
    if (spec.action === 'fetch_product') {
      if (d.notFound) return { status: 'VERIFIED', values: normalizeFor(m, null, { present: false }), method: 'http_status', evidence, sourceLabel: res.target };
      if (!d.found) return { status: 'UNAVAILABLE', errorCode: 'NO_STRUCTURED_DATA', reason: 'The page publishes no structured product data', evidence };
      const values = m.kind === 'product'
        ? normalizeProduct(d.fields, { currencyDefault })
        : normalizeValues({ title: d.fields.title ?? null, price: d.fields.price ?? null, currency: d.fields.currency ?? null, availability: d.fields.availability ?? null });
      const partial = m.kind === 'product' && values.price === null;
      return { status: partial ? 'UNVERIFIED' : 'VERIFIED', values, method: d.method, reason: partial ? 'The source did not publish a price' : null, evidence, sourceLabel: res.target };
    }
    // JSON sources
    let raw = null;
    if (spec.action === 'fetch_json') raw = d.values;
    else {
      const { fromJsonPaths } = require('../monitoring/extract');
      raw = d.data && typeof d.data === 'object' ? fromJsonPaths(d.data, spec.fields) : null;
    }
    if (!raw) return { status: 'UNAVAILABLE', errorCode: 'FIELDS_NOT_FOUND', reason: 'None of the configured fields were present', evidence };
    const values = normalizeFor(m, raw, { currencyDefault });
    const partial = m.kind === 'product' ? values.price === null : Object.keys(raw).length < Object.keys(spec.fields || m.source.fields || {}).length;
    return { status: partial ? 'UNVERIFIED' : 'VERIFIED', values, method: 'json_pointer', reason: partial ? 'Some configured fields were missing' : null, evidence, sourceLabel: res.target };
  }

  /**
   * Run one check. `checkKey` makes it idempotent (worker: lease fence;
   * manual: request id). Metered as one monitoring check.
   */
  async function runCheck(m, { checkKey, fence = null, actorId = null } = {}) {
    if (m.source_type === 'api_submission') throw C.bad('This monitor receives values through the API; it cannot be checked', 'NOT_CHECKABLE');
    const ws = m.workspace_id;
    const prior = await store.find('monitor_observations', ws, { monitor_id: m.id, check_key: checkKey });
    if (prior) return { observation: prior, changes: [], replayed: true };
    let handle = null;
    if (usage) {
      try {
        handle = await usage.begin(ws, 'monitoring_checks', `mon:${checkKey}`.slice(0, 200));
      } catch (err) {
        return recordObservation(m, checkKey, { status: 'UNAVAILABLE', errorCode: err.code || 'QUOTA_EXCEEDED', reason: err.message, evidence: { quota: true } }, { fence });
      }
    }
    let res;
    let spec;
    let provider = null;
    try {
      const i = integrations ? await integrations.getIntegrationRow(ws, m.integration_id) : null;
      provider = i ? i.provider : null;
      if (!i || !connectorActions) res = { ok: false, blocked: true, code: 'INTEGRATION_UNAVAILABLE', message: 'The monitor\'s integration is not available' };
      else {
        spec = connectorSpec(m, provider);
        res = await connectorActions.run({
          workspaceId: ws, actorId: actorId || m.created_by, integrationId: m.integration_id, action: spec.action, input: spec.input, sourceId: checkKey,
        });
      }
    } catch (err) {
      logger.error?.(`[monitoring] check failed unexpectedly (${err.code || err.name})`);
      res = { ok: false, code: 'CHECK_FAILED', message: 'The check failed' };
    }
    const outcome = outcomeFromConnector(m, res, provider, spec || {});
    if (handle) {
      // A check that never reached the source (blocked / not connected) is not charged.
      if (res.blocked) await usage.release(handle);
      else await usage.commit(handle, { source: 'monitoring_check', sourceId: m.id, actorId: m.created_by }).catch(() => {});
    }
    return recordObservation(m, checkKey, outcome, { fence });
  }

  async function checkNow(ctx, id, { requestId } = {}) {
    const m = await load(ctx, id);
    C.requireAdmin(ctx, 'monitors');
    const key = `manual:${requestId && /^[A-Za-z0-9_.:-]{8,100}$/.test(requestId) ? requestId : crypto.randomUUID()}`;
    const r = await runCheck(m, { checkKey: key, actorId: ctx.userId });
    return { replayed: r.replayed, observation: r.observation ? observationView(r.observation) : null, changes: r.changes, monitor: monitorView(r.monitor || (await store.get('monitors', m.workspace_id, m.id))) };
  }

  /**
   * Values pushed by an API client (automation API, scope monitoring:write).
   * Always UNVERIFIED: Nexus did not observe them. Idempotent by key.
   */
  async function submitObservation(ctx, id, body = {}) {
    const m = await load(ctx, id);
    if (m.source_type !== 'api_submission') throw C.bad('Only api_submission monitors accept submitted values', 'NOT_API_SUBMISSION');
    C.onlyKeys(body, ['idempotencyKey', 'values', 'present', 'observedAt']);
    if (typeof body.idempotencyKey !== 'string' || !/^[A-Za-z0-9_.:-]{8,128}$/.test(body.idempotencyKey)) throw C.bad('idempotencyKey must be 8-128 characters of [A-Za-z0-9_.:-]');
    const present = body.present !== false;
    if (present && (!body.values || typeof body.values !== 'object' || Array.isArray(body.values))) throw C.bad('values must be an object');
    const raw = body.values || {};
    if (JSON.stringify(raw).length > 8000) throw C.bad('values are too large');
    if (m.source.fields) for (const k of Object.keys(raw)) if (!m.source.fields.includes(k)) throw C.bad(`values.${k} is not one of this monitor's fields`);
    if (m.kind === 'product') for (const k of Object.keys(raw)) if (!PRODUCT_FIELDS.includes(k)) throw C.bad(`values.${k} is not a product field`);
    const checkKey = `api:${body.idempotencyKey}`;
    const prior = await store.find('monitor_observations', m.workspace_id, { monitor_id: m.id, check_key: checkKey });
    if (prior) return { replayed: true, observation: observationView(prior), changes: [] };
    let handle = null;
    if (usage) {
      try { handle = await usage.begin(m.workspace_id, 'monitoring_checks', `mon:${checkKey}`.slice(0, 200)); } catch (err) { throw new C.WorkspaceError(err.status || 402, err.code || 'QUOTA_EXCEEDED', err.message); }
    }
    const values = normalizeFor(m, raw, { present });
    const r = await recordObservation(m, checkKey, {
      status: 'UNVERIFIED', values, method: 'api_submission', reason: 'Submitted by an API client; not observed by Nexus',
      evidence: { submittedBy: ctx.apiKeyId ? `api_key:${ctx.apiKeyId}` : ctx.userId }, sourceLabel: 'api_submission',
    });
    if (handle) await usage.commit(handle, { source: 'monitoring_check', sourceId: m.id, actorId: ctx.userId }).catch(() => {});
    return { replayed: r.replayed, observation: observationView(r.observation), changes: r.changes };
  }

  /** Stale sweep for ONE workspace's monitors (worker; idempotent per staleness episode). */
  async function sweepStale(ws) {
    // Only monitors whose `current` could be mistaken for fresh data; an
    // UNAVAILABLE monitor already says its value is not current.
    const rows = await store.list('monitors', ws, { filter: { health: { in: ['VERIFIED', 'UNVERIFIED'] } }, limit: 1000 });
    let n = 0;
    for (const m of rows) {
      if (!m.last_success_at) continue;
      const ref = m.last_success_at;
      if (now().getTime() - Date.parse(ref) <= m.stale_after_minutes * 60000) continue;
      const key = `stale:${ref}`;
      const obs = await store.tryInsert('monitor_observations', {
        workspace_id: ws, monitor_id: m.id, check_key: key, observed_at: iso(), status: 'UNAVAILABLE', values: null, value_hash: null,
        method: 'stale_sweep', evidence: { lastSuccessAt: m.last_success_at }, error_code: 'STALE',
      });
      if (!obs) continue;
      const u = await store.update('monitors', ws, m.id, { health: 'STALE', health_reason: `No successful check since ${m.last_success_at || 'creation'}` }, { expectVersion: m.version });
      if (!u) continue;
      const ch = await store.tryInsert('monitor_changes', {
        workspace_id: ws, monitor_id: m.id, observation_id: obs.id, change_type: 'source_stale', field: 'health', old_value: m.health, new_value: 'STALE',
        detected_at: obs.observed_at, confidence: 1, verification: 'VERIFIED', source: 'stale_sweep',
      });
      n += 1;
      await emit('monitor.checked', { workspaceId: ws, monitor: monitorView(u), monitorRow: u, observation: observationView(obs), changes: ch ? [changeView(ch)] : [] });
    }
    return n;
  }

  return {
    createMonitor, updateMonitor, deleteMonitor, listMonitors, getMonitor, listChanges, checkNow, submitObservation, runCheck, sweepStale,
    monitorView, changeView, observationView, isStale, loadRow: (ws, id) => store.get('monitors', ws, id), connectorSpec,
  };
}

module.exports = { createMonitoringService, KINDS, SOURCE_TYPES, COMBOS };
