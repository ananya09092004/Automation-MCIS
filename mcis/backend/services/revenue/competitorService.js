/**
 * Layer 10 — e-commerce competitor intelligence.
 *
 *   product (own catalogue item, cost / price / fees / margin targets,
 *            optional own-listing monitor)
 *     └─ competitor products (marketplace listing + monitor + match)
 *          └─ monitor observations / changes (monitoringService)
 *               → recommendations (deterministic, VERIFIED matches only)
 *               → alerts (alertService, product-scoped rules)
 *
 * Nothing here changes a price. A recommendation is advice with its full
 * rationale; turning it into work goes through existing, governed paths:
 * a workspace task for a person, or a Layer 4 workflow run (whose steps
 * pass the Agent Firewall, approvals and evidence).
 *
 * Plan limit: max_monitored_products (race-free: enforced in the database
 * after the insert, an over-limit insert is removed).
 */
'use strict';

const C = require('./common');
const { matchProduct } = require('./matching');
const { marginAt, marginImpact } = require('./margin');
const { validGtin, normalizeGtin } = require('../monitoring/normalize');

const MARKETPLACES = ['amazon', 'flipkart', 'shopify', 'website', 'other'];
const REC_STATUSES = ['open', 'acknowledged', 'dismissed', 'actioned'];

function createCompetitorService({
  store, monitoring, usage = null, tasks = null, workflows = null, events = null, appendAuditLog = null, logger = console, options = {},
} = {}) {
  if (!store || !monitoring) throw new Error('competitor service: store and monitoring are required');
  const now = options.now || (() => new Date());
  const iso = () => now().toISOString();
  const emit = (type, payload) => (events ? events.emit(type, payload) : Promise.resolve());
  const audit = (actor, action, payload, ws) => {
    if (!appendAuditLog) return;
    try { Promise.resolve(appendAuditLog(actor, action, payload, { success: true, error: null }, ws)).catch(() => {}); } catch { /* never */ }
  };

  // ------------------------------------------------------------------
  // Views
  // ------------------------------------------------------------------
  const productView = (p) => ({
    id: p.id, name: p.name, sku: p.sku, gtin: p.gtin, mpn: p.mpn, brand: p.brand, model: p.model, attributes: p.attributes, currency: p.currency,
    cost: C.dbNum(p.cost), sellingPrice: C.dbNum(p.selling_price), feesFixed: C.dbNum(p.fees_fixed), feesPct: C.dbNum(p.fees_pct),
    targetMarginPct: C.dbNum(p.target_margin_pct), minMarginPct: C.dbNum(p.min_margin_pct), ownMonitorId: p.own_monitor_id,
    version: p.version, createdAt: p.created_at, updatedAt: p.updated_at,
  });
  const competitorView = (c, monitor = null) => ({
    id: c.id, productId: c.product_id, competitorName: c.competitor_name, marketplace: c.marketplace, sourceUrl: c.source_url,
    marketplaceProductId: c.marketplace_product_id, identifiers: c.identifiers, title: c.title, brand: c.brand, model: c.model,
    monitorId: c.monitor_id,
    match: { status: c.match_status, confidence: C.dbNum(c.match_confidence), method: c.match_method, evidence: c.match_evidence, confirmedBy: c.confirmed_by, confirmedAt: c.confirmed_at },
    ...(monitor ? { monitor: monitoring.monitorView(monitor) } : {}),
    version: c.version, createdAt: c.created_at,
  });
  const recView = (r) => ({
    id: r.id, productId: r.product_id, competitorId: r.competitor_id, changeId: r.change_id, type: r.rec_type, priority: r.priority,
    rationale: r.rationale, status: r.status, decidedBy: r.decided_by, decidedAt: r.decided_at, createdAt: r.created_at,
  });

  // ------------------------------------------------------------------
  // Products
  // ------------------------------------------------------------------
  function productFields(body, { partial = false } = {}) {
    const out = {};
    const has = (k) => body[k] !== undefined;
    if (!partial || has('name')) out.name = C.str(body.name, 'name', { max: 200 });
    if (has('sku')) out.sku = C.str(body.sku, 'sku', { max: 100, optional: true });
    if (has('gtin')) {
      if (body.gtin === null || body.gtin === '') out.gtin = null;
      else {
        if (!validGtin(body.gtin)) throw C.bad('gtin must be a valid GTIN-8/12/13/14 (UPC/EAN) with a correct check digit');
        out.gtin = normalizeGtin(body.gtin);
      }
    }
    for (const [k, col] of [['mpn', 'mpn'], ['brand', 'brand'], ['model', 'model']]) if (has(k)) out[col] = C.str(body[k], k, { max: 100, optional: true });
    if (has('currency')) { if (typeof body.currency !== 'string' || !/^[A-Z]{3}$/.test(body.currency)) throw C.bad('currency must be an ISO code such as INR'); out.currency = body.currency; }
    for (const [k, col, lim] of [['cost', 'cost', {}], ['sellingPrice', 'selling_price', {}], ['feesFixed', 'fees_fixed', {}], ['feesPct', 'fees_pct', { max: 99.99 }],
      ['targetMarginPct', 'target_margin_pct', { min: -100, max: 100 }], ['minMarginPct', 'min_margin_pct', { min: -100, max: 100 }]]) {
      if (has(k)) out[col] = C.num(body[k], k, lim);
    }
    if (has('attributes')) {
      const a = C.onlyKeys(body.attributes || {}, ['marketplaceIds', 'knownUrls', 'category', 'notes'], 'attributes');
      const clean = {};
      if (a.marketplaceIds !== undefined) {
        C.onlyKeys(a.marketplaceIds, MARKETPLACES, 'attributes.marketplaceIds');
        clean.marketplaceIds = {};
        for (const [m, v] of Object.entries(a.marketplaceIds)) clean.marketplaceIds[m] = C.str(v, `attributes.marketplaceIds.${m}`, { max: 100 });
      }
      if (a.knownUrls !== undefined) {
        if (!Array.isArray(a.knownUrls) || a.knownUrls.length > 20) throw C.bad('attributes.knownUrls must list at most 20 URLs');
        clean.knownUrls = a.knownUrls.map((u) => { try { return new URL(u).toString(); } catch { throw C.bad('attributes.knownUrls must be URLs'); } });
      }
      if (a.category !== undefined) clean.category = C.str(a.category, 'attributes.category', { max: 100, optional: true });
      if (a.notes !== undefined) clean.notes = C.str(a.notes, 'attributes.notes', { max: 1000, optional: true });
      out.attributes = clean;
    }
    return out;
  }

  async function loadProduct(ctx, id) {
    const ws = C.requireCtx(ctx);
    const p = await store.get('ci_products', ws, C.uuidOr404(id, 'Product'));
    if (!p) throw C.notFound('Product');
    return p;
  }

  async function createProduct(ctx, body = {}) {
    const ws = C.requireCtx(ctx);
    C.requireAdmin(ctx, 'products');
    C.onlyKeys(body, ['name', 'sku', 'gtin', 'mpn', 'brand', 'model', 'attributes', 'currency', 'cost', 'sellingPrice', 'feesFixed', 'feesPct', 'targetMarginPct', 'minMarginPct', 'ownListing']);
    const fields = productFields(body);
    let row;
    try {
      row = await store.insert('ci_products', { workspace_id: ws, created_by: ctx.userId, ...fields });
    } catch (err) {
      if (err.code === '23505') throw C.conflict('A product with this SKU already exists', 'PRODUCT_EXISTS');
      throw err;
    }
    if (usage && usage.enforceCount) {
      try {
        await usage.enforceCount(ws, 'monitored_products', (limit) => store.rpc('enforce_monitored_product_limit', { p_workspace: ws, p_product: row.id, p_limit: limit }));
      } catch (err) {
        if (err.code === 'ENTITLEMENT_UNAVAILABLE') await store.remove('ci_products', ws, row.id).catch(() => {});
        throw new C.WorkspaceError(err.status || 402, err.code || 'QUOTA_EXCEEDED', err.message);
      }
    }
    if (body.ownListing) {
      try {
        const m = await monitoring.createMonitor(ctx, monitorBody(`${fields.name} (own listing)`, body.ownListing), { internal: true });
        row = await store.update('ci_products', ws, row.id, { own_monitor_id: m.id }, { expectVersion: row.version });
      } catch (err) {
        await store.remove('ci_products', ws, row.id).catch(() => {});
        throw err;
      }
    }
    audit(ctx.userId, 'ci_product_created', { workspaceId: ws, productId: row.id }, ws);
    return productView(row);
  }

  function monitorBody(name, src) {
    C.onlyKeys(src, ['integrationId', 'sourceType', 'source', 'checkIntervalMinutes', 'staleAfterMinutes'], 'monitor');
    return { name: name.slice(0, 200), kind: 'product', sourceType: src.sourceType || 'web_page', integrationId: src.integrationId, source: src.source, checkIntervalMinutes: src.checkIntervalMinutes, staleAfterMinutes: src.staleAfterMinutes };
  }

  async function updateProduct(ctx, id, body = {}) {
    const p = await loadProduct(ctx, id);
    C.requireAdmin(ctx, 'products');
    C.onlyKeys(body, ['version', 'name', 'sku', 'gtin', 'mpn', 'brand', 'model', 'attributes', 'currency', 'cost', 'sellingPrice', 'feesFixed', 'feesPct', 'targetMarginPct', 'minMarginPct']);
    if (body.version !== p.version) throw C.conflict('version is required and must match the current version', 'PRODUCT_CONFLICT');
    const patch = productFields(body, { partial: true });
    if (!Object.keys(patch).length) throw C.bad('Nothing to update');
    let u;
    try { u = await store.update('ci_products', p.workspace_id, p.id, patch, { expectVersion: p.version }); } catch (err) {
      if (err.code === '23505') throw C.conflict('A product with this SKU already exists', 'PRODUCT_EXISTS');
      throw err;
    }
    if (!u) throw C.conflict('The product was changed concurrently; reload and retry.', 'PRODUCT_CONFLICT');
    // Identifiers changed → re-match competitors that no person has decided on.
    if (['gtin', 'mpn', 'brand', 'model', 'sku', 'attributes', 'name'].some((k) => k in patch)) await rematchProduct(u);
    return productView(u);
  }

  async function deleteProduct(ctx, id) {
    const p = await loadProduct(ctx, id);
    C.requireAdmin(ctx, 'products');
    const comps = await store.list('ci_competitor_products', p.workspace_id, { filter: { product_id: p.id }, limit: 1000 });
    await store.remove('ci_products', p.workspace_id, p.id); // cascades competitors, recommendations, product rules
    for (const mid of [p.own_monitor_id, ...comps.map((c) => c.monitor_id)].filter(Boolean)) {
      await store.remove('monitors', p.workspace_id, mid).catch((err) => logger.warn?.(`[ci] monitor cleanup failed (${err.code})`));
    }
    audit(ctx.userId, 'ci_product_deleted', { workspaceId: p.workspace_id, productId: p.id }, p.workspace_id);
    return { deleted: true };
  }

  // ------------------------------------------------------------------
  // Competitors + matching
  // ------------------------------------------------------------------
  function competitorFields(body) {
    const out = {
      competitor_name: C.str(body.competitorName, 'competitorName', { max: 120 }),
      marketplace: C.oneOf(body.marketplace, 'marketplace', MARKETPLACES),
    };
    if (body.sourceUrl !== undefined && body.sourceUrl !== null) {
      try { out.source_url = new URL(body.sourceUrl).toString().slice(0, 2000); } catch { throw C.bad('sourceUrl must be a URL'); }
    }
    if (body.marketplaceProductId !== undefined) out.marketplace_product_id = C.str(body.marketplaceProductId, 'marketplaceProductId', { max: 100, optional: true });
    if (body.title !== undefined) out.title = C.str(body.title, 'title', { max: 300, optional: true });
    if (body.brand !== undefined) out.brand = C.str(body.brand, 'brand', { max: 100, optional: true });
    if (body.model !== undefined) out.model = C.str(body.model, 'model', { max: 100, optional: true });
    if (body.identifiers !== undefined) {
      const i = C.onlyKeys(body.identifiers || {}, ['gtin', 'sku', 'mpn', 'brand', 'model'], 'identifiers');
      out.identifiers = {};
      for (const [k, v] of Object.entries(i)) {
        if (v === null || v === '') continue;
        if (k === 'gtin') { if (!validGtin(v)) throw C.bad('identifiers.gtin must be a valid GTIN'); out.identifiers.gtin = normalizeGtin(v); } else out.identifiers[k] = C.str(v, `identifiers.${k}`, { max: 100 });
      }
    }
    return out;
  }

  async function addCompetitor(ctx, productId, body = {}) {
    const p = await loadProduct(ctx, productId);
    C.requireAdmin(ctx, 'competitors');
    C.onlyKeys(body, ['competitorName', 'marketplace', 'sourceUrl', 'marketplaceProductId', 'identifiers', 'title', 'brand', 'model', 'monitor']);
    const fields = competitorFields(body);
    let monitorId = null;
    if (body.monitor) {
      const src = { ...body.monitor };
      if (src.source === undefined && fields.source_url) src.source = { url: fields.source_url };
      const m = await monitoring.createMonitor(ctx, monitorBody(`${fields.competitor_name} — ${p.name}`, src), { internal: true });
      monitorId = m.id;
    }
    const match = matchProduct(p, { ...fields, identifiers: fields.identifiers || {} });
    let row;
    try {
      row = await store.insert('ci_competitor_products', {
        workspace_id: p.workspace_id, product_id: p.id, ...fields, monitor_id: monitorId, created_by: ctx.userId,
        match_status: match.status, match_confidence: match.confidence, match_method: match.method, match_evidence: match.evidence,
      });
    } catch (err) {
      if (monitorId) await store.remove('monitors', p.workspace_id, monitorId).catch(() => {});
      throw err;
    }
    audit(ctx.userId, 'ci_competitor_added', { workspaceId: p.workspace_id, productId: p.id, competitorId: row.id, match: match.status }, p.workspace_id);
    return competitorView(row);
  }

  async function loadCompetitor(ctx, productId, competitorId) {
    const p = await loadProduct(ctx, productId);
    const c = await store.get('ci_competitor_products', p.workspace_id, C.uuidOr404(competitorId, 'Competitor'));
    if (!c || c.product_id !== p.id) throw C.notFound('Competitor');
    return { p, c };
  }

  async function removeCompetitor(ctx, productId, competitorId) {
    const { p, c } = await loadCompetitor(ctx, productId, competitorId);
    C.requireAdmin(ctx, 'competitors');
    await store.remove('ci_competitor_products', p.workspace_id, c.id);
    if (c.monitor_id) await store.remove('monitors', p.workspace_id, c.monitor_id).catch(() => {});
    return { deleted: true };
  }

  /** Human decision on a match: final (automatic re-matching never overrides it). */
  async function decideMatch(ctx, productId, competitorId, body = {}) {
    const { p, c } = await loadCompetitor(ctx, productId, competitorId);
    C.requireAdmin(ctx, 'competitor matches');
    const decision = C.oneOf(body.decision, 'decision', ['confirm', 'reject']);
    if (body.version !== c.version) throw C.conflict('version is required and must match the current version', 'COMPETITOR_CONFLICT');
    const u = await store.update('ci_competitor_products', p.workspace_id, c.id, {
      match_status: decision === 'confirm' ? 'VERIFIED' : 'REJECTED', match_method: `human_${decision}`,
      match_evidence: { ...(c.match_evidence || {}), human: { decision, by: ctx.userId, at: iso(), previous: { status: c.match_status, confidence: C.dbNum(c.match_confidence), method: c.match_method } } },
      confirmed_by: ctx.userId, confirmed_at: iso(),
    }, { expectVersion: c.version });
    if (!u) throw C.conflict('The competitor was changed concurrently; reload and retry.', 'COMPETITOR_CONFLICT');
    audit(ctx.userId, 'ci_match_decided', { workspaceId: p.workspace_id, productId: p.id, competitorId: c.id, decision }, p.workspace_id);
    return competitorView(u);
  }

  async function rematchProduct(p) {
    const comps = await store.list('ci_competitor_products', p.workspace_id, { filter: { product_id: p.id, confirmed_by: null }, limit: 1000 });
    for (const c of comps) await rematch(p, c);
  }
  async function rematch(p, c, extra = {}) {
    const cand = { ...c, ...extra };
    const m = matchProduct(p, cand);
    if (m.status === c.match_status && m.confidence === C.dbNum(c.match_confidence) && m.method === c.match_method && !Object.keys(extra).length) return c;
    return store.update('ci_competitor_products', p.workspace_id, c.id, {
      ...extra, match_status: m.status, match_confidence: m.confidence, match_method: m.method, match_evidence: m.evidence,
    }, { expectVersion: c.version });
  }

  // ------------------------------------------------------------------
  // Monitoring events → identifiers, re-match, recommendations
  // ------------------------------------------------------------------
  async function linksForMonitor(ws, monitorId) {
    const out = [];
    for (const p of await store.list('ci_products', ws, { filter: { own_monitor_id: monitorId }, limit: 50 })) out.push({ product: p, competitor: null });
    for (const c of await store.list('ci_competitor_products', ws, { filter: { monitor_id: monitorId }, limit: 50 })) {
      const p = await store.get('ci_products', ws, c.product_id);
      if (p) out.push({ product: p, competitor: c });
    }
    return out;
  }

  async function onMonitorChecked({ workspaceId: ws, monitorRow: monitor, observation, changes }) {
    const links = await linksForMonitor(ws, monitor.id);
    for (const link of links) {
      let { competitor } = link;
      if (!competitor) continue;
      // Observed identifiers / title refine an undecided match.
      const v = observation && observation.values;
      if (v && v.present !== false && !competitor.confirmed_by && observation.status !== 'UNAVAILABLE') {
        const ids = { ...(competitor.identifiers || {}), ...(v.identifiers || {}) };
        const extra = {};
        if (JSON.stringify(ids) !== JSON.stringify(competitor.identifiers || {})) extra.identifiers = ids;
        if (v.title && v.title !== competitor.title) extra.title = String(v.title).slice(0, 300);
        if (Object.keys(extra).length) competitor = (await rematch(link.product, competitor, extra)) || competitor;
      }
      if (competitor.match_status !== 'VERIFIED') continue;
      for (const ch of changes || []) {
        if (ch.verification !== 'VERIFIED') continue;
        await recommend(ws, link.product, competitor, monitor, ch);
      }
    }
  }

  async function ownPriceOf(p) {
    if (p.own_monitor_id) {
      const m = await store.get('monitors', p.workspace_id, p.own_monitor_id);
      if (m && m.current && typeof m.current.price === 'number' && monitoring.monitorView(m).currentIsFresh) {
        return { value: m.current.price, source: 'monitor', fresh: true, currency: m.current.currency };
      }
    }
    return p.selling_price !== null && p.selling_price !== undefined ? { value: Number(p.selling_price), source: 'configured', fresh: true } : null;
  }

  async function recommend(ws, p, c, monitor, ch) {
    const own = await ownPriceOf(p);
    let type = null;
    let priority = 'medium';
    const rationale = {
      change: { type: ch.changeType, oldValue: ch.oldValue, newValue: ch.newValue, detectedAt: ch.detectedAt, verification: ch.verification },
      competitor: { id: c.id, name: c.competitor_name, marketplace: c.marketplace, match: { status: c.match_status, method: c.match_method, confidence: C.dbNum(c.match_confidence) } },
      ownPrice: own ? { value: own.value, source: own.source } : null,
      autoPricing: false,
    };
    const currency = monitor.current && monitor.current.currency;
    if (['price_decrease', 'price_increase', 'price_restored'].includes(ch.changeType) && typeof ch.newValue === 'number') {
      if (currency && currency !== p.currency) return null; // not comparable
      const atMatch = marginAt(p, ch.newValue, currency || p.currency);
      rationale.marginIfMatched = atMatch;
      if (!own) {
        type = 'review_pricing'; priority = 'low';
        rationale.note = 'Your selling price is not configured or observed; the gap cannot be computed.';
      } else if (ch.changeType === 'price_decrease' && own.value > ch.newValue) {
        const gapPct = Math.round(((own.value - ch.newValue) / ch.newValue) * 10000) / 100;
        rationale.gap = { absolute: Math.round((own.value - ch.newValue) * 100) / 100, pct: gapPct };
        const minM = C.dbNum(p.min_margin_pct);
        if (atMatch.complete && minM !== null && atMatch.marginPct < minM) {
          type = 'investigate_margin'; priority = 'high';
          rationale.note = `Matching ${ch.newValue} would put your margin at ${atMatch.marginPct}% (minimum ${minM}%).`;
        } else {
          type = 'review_pricing';
          priority = gapPct > 10 ? 'high' : (gapPct > 3 ? 'medium' : 'low');
          if (!atMatch.complete) rationale.note = `Margin impact unknown: missing ${atMatch.missing.join(', ')}.`;
        }
      } else if (ch.changeType !== 'price_decrease' && own.value < ch.newValue) {
        type = 'review_pricing'; priority = 'low';
        rationale.gap = { absolute: Math.round((ch.newValue - own.value) * 100) / 100, pct: Math.round(((ch.newValue - own.value) / own.value) * 10000) / 100 };
        rationale.note = 'The competitor is now priced above you; there may be room to review your price.';
      } else return null;
    } else if (ch.changeType === 'out_of_stock') {
      type = 'review_promotion'; priority = 'medium';
      rationale.note = 'A verified competitor is out of stock.';
    } else if (ch.changeType === 'new_discount') {
      type = 'review_promotion'; priority = 'low';
      rationale.note = `A verified competitor started a ${ch.newValue}% discount.`;
    } else if (ch.changeType === 'product_disappeared') {
      type = 'monitor_competitor'; priority = 'low';
      rationale.note = 'The competitor listing no longer exists; update or remove it.';
    } else return null;
    const row = await store.tryInsert('ci_recommendations', {
      workspace_id: ws, product_id: p.id, competitor_id: c.id, change_id: ch.id || null, rec_type: type, priority, rationale,
      dedup_key: `${ch.id}:${c.id}:${type}`.slice(0, 300),
    });
    if (row) await emit('recommendation.created', { workspaceId: ws, recommendation: recView(row) });
    return row;
  }

  // ------------------------------------------------------------------
  // Recommendations
  // ------------------------------------------------------------------
  async function listRecommendations(ctx, { status, productId, limit } = {}) {
    const ws = C.requireCtx(ctx);
    const filter = {};
    if (status) filter.status = C.oneOf(status, 'status', REC_STATUSES);
    if (productId) filter.product_id = C.uuidOr404(productId, 'Product');
    return (await store.list('ci_recommendations', ws, { filter, limit: Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200) })).map(recView);
  }

  async function loadRec(ctx, id) {
    const ws = C.requireCtx(ctx);
    const r = await store.get('ci_recommendations', ws, C.uuidOr404(id, 'Recommendation'));
    if (!r) throw C.notFound('Recommendation');
    return r;
  }

  async function setRecommendationStatus(ctx, id, body = {}) {
    const r = await loadRec(ctx, id);
    const status = C.oneOf(body.status, 'status', ['acknowledged', 'dismissed']);
    if (r.status === 'actioned' || r.status === 'dismissed') throw C.conflict(`The recommendation is already ${r.status}`, 'RECOMMENDATION_CLOSED');
    const [u] = await store.updateWhere('ci_recommendations', r.workspace_id, { id: r.id, status: r.status }, { status, decided_by: ctx.userId, decided_at: iso() });
    if (!u) throw C.conflict('The recommendation was changed concurrently', 'RECOMMENDATION_CONFLICT');
    return recView(u);
  }

  /**
   * Turn a recommendation into governed work:
   *   { action: 'task', assignee? }                → a workspace task (Layer 2)
   *   { action: 'workflow', workflowId, inputs? }  → a Layer 4 run (approvals / firewall / evidence)
   * Nothing is executed on the recommendation's say-so alone.
   */
  async function actOnRecommendation(ctx, id, body = {}) {
    const r = await loadRec(ctx, id);
    if (r.status === 'dismissed' || r.status === 'actioned') throw C.conflict(`The recommendation is already ${r.status}`, 'RECOMMENDATION_CLOSED');
    C.onlyKeys(body, ['action', 'assignee', 'workflowId', 'inputs', 'idempotencyKey']);
    const action = C.oneOf(body.action, 'action', ['task', 'workflow']);
    const p = await store.get('ci_products', r.workspace_id, r.product_id);
    const title = `${r.rec_type.replace(/_/g, ' ')}: ${p ? p.name : 'product'}`.slice(0, 200);
    const description = [
      r.rationale.note || '',
      r.rationale.change ? `Competitor change: ${r.rationale.change.type} ${r.rationale.change.oldValue ?? ''} → ${r.rationale.change.newValue ?? ''}` : '',
      r.rationale.gap ? `Price gap: ${r.rationale.gap.absolute} (${r.rationale.gap.pct}%)` : '',
      r.rationale.marginIfMatched && r.rationale.marginIfMatched.complete ? `Margin if matched: ${r.rationale.marginIfMatched.marginPct}%` : '',
      'Generated by Nexus competitor intelligence. No price was changed automatically.',
    ].filter(Boolean).join('\n');
    let result;
    if (action === 'task') {
      if (!tasks) throw new C.WorkspaceError(503, 'TASKS_UNAVAILABLE', 'Tasks are unavailable');
      result = { task: await tasks.createTask(ctx, { title, description: description.slice(0, 5000), priority: r.priority === 'low' ? 'low' : (r.priority === 'high' ? 'high' : 'medium'), assignee: body.assignee }) };
    } else {
      if (!workflows) throw new C.WorkspaceError(503, 'WORKFLOWS_UNAVAILABLE', 'Workflows are unavailable');
      const inputs = { ...(body.inputs || {}) };
      const out = await workflows.startRun(ctx, body.workflowId, { inputs, trigger: 'manual' }, { idempotencyKey: body.idempotencyKey || `rec-${r.id}` });
      result = { run: out.run, replayed: out.replayed };
    }
    await store.updateWhere('ci_recommendations', r.workspace_id, { id: r.id }, { status: 'actioned', decided_by: ctx.userId, decided_at: iso() });
    audit(ctx.userId, 'ci_recommendation_actioned', { workspaceId: r.workspace_id, recommendationId: r.id, action }, r.workspace_id);
    return { recommendation: recView({ ...r, status: 'actioned', decided_by: ctx.userId, decided_at: iso() }), ...result };
  }

  // ------------------------------------------------------------------
  // Read models
  // ------------------------------------------------------------------
  async function productDetail(ctx, id) {
    const p = await loadProduct(ctx, id);
    return buildProduct(p);
  }

  async function buildProduct(p) {
    const ws = p.workspace_id;
    const comps = await store.list('ci_competitor_products', ws, { filter: { product_id: p.id }, order: ['created_at', true], limit: 200 });
    const monitors = new Map();
    for (const id of [p.own_monitor_id, ...comps.map((c) => c.monitor_id)].filter(Boolean)) {
      const m = await store.get('monitors', ws, id);
      if (m) monitors.set(id, m);
    }
    const own = await ownPriceOf(p);
    const competitorPrices = comps.filter((c) => c.match_status === 'VERIFIED' && c.monitor_id && monitors.get(c.monitor_id)).map((c) => {
      const m = monitors.get(c.monitor_id);
      const v = monitoring.monitorView(m);
      return {
        competitorId: c.id, name: c.competitor_name, price: m.current && m.current.present !== false ? m.current.price : null,
        currency: m.current ? m.current.currency : null, fresh: v.currentIsFresh, verification: m.health,
      };
    });
    const openRecs = await store.count('ci_recommendations', ws, { product_id: p.id, status: 'open' });
    return {
      product: productView(p),
      ownPrice: own,
      ownListing: p.own_monitor_id && monitors.get(p.own_monitor_id) ? monitoring.monitorView(monitors.get(p.own_monitor_id)) : null,
      competitors: comps.map((c) => competitorView(c, c.monitor_id ? monitors.get(c.monitor_id) : null)),
      marginImpact: marginImpact(p, own, competitorPrices),
      openRecommendations: openRecs,
    };
  }

  async function listProducts(ctx, { limit } = {}) {
    const ws = C.requireCtx(ctx);
    const rows = await store.list('ci_products', ws, { limit: Math.min(Math.max(parseInt(limit, 10) || 100, 1), 500) });
    const out = [];
    for (const p of rows) out.push(await buildProduct(p));
    return out;
  }

  async function dashboard(ctx) {
    const ws = C.requireCtx(ctx);
    const products = await listProducts(ctx, { limit: 200 });
    const comps = products.flatMap((x) => x.competitors);
    const health = (h) => comps.filter((c) => c.monitor && c.monitor.health === h).length;
    const changes = await store.list('monitor_changes', ws, { order: ['detected_at', false], limit: 20 });
    return {
      totals: {
        products: products.length,
        competitors: comps.length,
        verifiedMatches: comps.filter((c) => c.match.status === 'VERIFIED').length,
        unverifiedMatches: comps.filter((c) => c.match.status === 'UNVERIFIED').length,
        rejectedMatches: comps.filter((c) => c.match.status === 'REJECTED').length,
        sources: { verified: health('VERIFIED'), unverified: health('UNVERIFIED'), stale: health('STALE'), unavailable: health('UNAVAILABLE'), pending: health('PENDING') },
        openRecommendations: products.reduce((a, x) => a + x.openRecommendations, 0),
        undercutBy: products.filter((x) => x.marginImpact.priceGap !== null && x.marginImpact.priceGap > 0).length,
      },
      products,
      recentChanges: changes.map(monitoring.changeView),
      generatedAt: iso(),
    };
  }

  return {
    createProduct, updateProduct, deleteProduct, listProducts, productDetail, addCompetitor, removeCompetitor, decideMatch,
    listRecommendations, setRecommendationStatus, actOnRecommendation, dashboard, onMonitorChecked, linksForMonitor,
  };
}

module.exports = { createCompetitorService, MARKETPLACES };
