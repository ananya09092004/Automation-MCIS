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
  const isDemoRow = (p) => !!(p && p.attributes && p.attributes.demo === true);
  const productView = (p) => ({
    id: p.id, name: p.name, sku: p.sku, gtin: p.gtin, mpn: p.mpn, brand: p.brand, model: p.model, attributes: p.attributes, currency: p.currency,
    cost: C.dbNum(p.cost), sellingPrice: C.dbNum(p.selling_price), feesFixed: C.dbNum(p.fees_fixed), feesPct: C.dbNum(p.fees_pct),
    targetMarginPct: C.dbNum(p.target_margin_pct), minMarginPct: C.dbNum(p.min_margin_pct), ownMonitorId: p.own_monitor_id,
    version: p.version, createdAt: p.created_at, updatedAt: p.updated_at,
    // Commercial pass: demo/sample data (see seedDemo below) is marked here
    // so it can NEVER be confused for a real customer's product in any
    // view that reuses productView — isDemo is derived, never client-set.
    isDemo: isDemoRow(p),
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
    // Only re-match undecided competitors: a human's confirm/reject is
    // final (P2-4) and must never be silently overridden just because the
    // product's own identifiers changed.
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
      
      for (const ch of changes || []) {
        if (ch.verification !== 'VERIFIED') continue;
        if (competitor.match_status !== 'VERIFIED') continue;
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

  async function listProducts(ctx, { limit, includeDemo = false } = {}) {
    const ws = C.requireCtx(ctx);
    const rows = await store.list('ci_products', ws, { limit: Math.min(Math.max(parseInt(limit, 10) || 100, 1), 500) });
    const out = [];
    // Commercial pass: demo/sample data is excluded from every normal read
    // model by default (dashboard, insights, value, reports) so it can
    // never be mixed into what looks like real customer/market data.
    // Only the dedicated demo endpoints pass includeDemo: true.
    for (const p of rows.filter((r) => includeDemo || !isDemoRow(r))) out.push(await buildProduct(p));
    return out;
  }

  /** Demo product + monitor ids currently in this workspace (for excluding them from aggregates that aren't product-scoped). */
  async function demoScope(ws) {
    const rows = await store.list('ci_products', ws, { limit: 500 });
    const demo = rows.filter(isDemoRow);
    const productIds = new Set(demo.map((p) => p.id));
    const monitorIds = new Set(demo.map((p) => p.own_monitor_id).filter(Boolean));
    if (productIds.size) {
      const comps = await store.list('ci_competitor_products', ws, { limit: 500 });
      for (const c of comps) if (productIds.has(c.product_id) && c.monitor_id) monitorIds.add(c.monitor_id);
    }
    return { productIds, monitorIds };
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

  // ------------------------------------------------------------------
  // Commercial pass: AI business-analysis digest + customer value view.
  //
  // Both are deterministic over data this service has already verified
  // (recommendations only ever exist for VERIFIED matches + VERIFIED
  // changes — see recommend() above) or already computed (marginImpact).
  // Neither calls an LLM and neither invents a number: every figure here
  // is a count, a sum, or a percentage derived from stored rows, with the
  // evidence (ids/timestamps) attached so a customer can check it. This
  // is a deliberate choice over free-form AI prose, which could phrase an
  // uncertain pattern as a confident claim — see insightsDigest's comment
  // on day-of-week/behavioral patterns for the specific thing this
  // intentionally does NOT claim.
  // ------------------------------------------------------------------
  function sinceIso(days) {
    const d = Math.min(Math.max(parseInt(days, 10) || 7, 1), 90);
    return { since: new Date(now().getTime() - d * 86400000).toISOString(), days: d };
  }

  /**
   * Narrative insights a business user can read in seconds, each with the
   * evidence behind it. Deliberately NOT included: any claim about a
   * recurring behavioral pattern ("this competitor lowers price on
   * weekends") — that needs real time-series statistics this service does
   * not compute, and guessing would be exactly the kind of fabricated
   * confidence this product's house rules forbid.
   */
  async function insightsDigest(ctx, { days = 7 } = {}) {
    const ws = C.requireCtx(ctx);
    const { since, days: d } = sinceIso(days);
    const { productIds: demoIds } = await demoScope(ws);
    const recent = (await store.list('ci_recommendations', ws, { filter: { created_at: { gte: since } }, limit: 500 }))
      .filter((r) => !demoIds.has(r.product_id)); // never let demo/sample data shape a "real" insight
    const byChangeType = (t) => recent.filter((r) => r.rationale && r.rationale.change && r.rationale.change.type === t);
    const insights = [];
    const priceDrops = byChangeType('price_decrease');
    if (priceDrops.length) {
      insights.push({
        id: 'price_decreases', severity: 'medium',
        text: `${priceDrops.length} verified competitor price decrease${priceDrops.length === 1 ? '' : 's'} detected in the last ${d} day${d === 1 ? '' : 's'}.`,
        evidence: { count: priceDrops.length, periodDays: d, recommendationIds: priceDrops.map((r) => r.id) },
      });
    }
    const outOfStock = byChangeType('out_of_stock');
    if (outOfStock.length) {
      insights.push({
        id: 'out_of_stock', severity: 'low',
        text: `${outOfStock.length} verified competitor${outOfStock.length === 1 ? '' : 's'} went out of stock in the last ${d} day${d === 1 ? '' : 's'}.`,
        evidence: { count: outOfStock.length, periodDays: d, recommendationIds: outOfStock.map((r) => r.id) },
      });
    }
    const biggestGap = recent
      .filter((r) => r.rationale && r.rationale.gap && typeof r.rationale.gap.pct === 'number')
      .sort((a, b) => b.rationale.gap.pct - a.rationale.gap.pct)[0];
    if (biggestGap) {
      const comp = biggestGap.rationale.competitor;
      insights.push({
        id: 'biggest_gap', severity: biggestGap.priority === 'high' ? 'high' : 'medium',
        text: `Competitor "${comp.name}" is currently ${biggestGap.rationale.gap.pct}% cheaper (gap ${biggestGap.rationale.gap.absolute}, detected ${biggestGap.rationale.change.detectedAt}).`,
        evidence: { recommendationId: biggestGap.id, competitorId: comp.id, productId: biggestGap.product_id, changeId: biggestGap.change_id, pct: biggestGap.rationale.gap.pct },
      });
    }
    const sources = (await dashboard(ctx)).totals.sources;
    const staleOrUnavailable = sources.stale + sources.unavailable;
    if (staleOrUnavailable) {
      insights.push({
        id: 'stale_sources', severity: 'low',
        text: `${staleOrUnavailable} monitored source${staleOrUnavailable === 1 ? '' : 's'} ${staleOrUnavailable === 1 ? 'is' : 'are'} currently stale or unavailable and excluded from this digest — no recommendation is made from a source that can't currently be trusted.`,
        evidence: { stale: sources.stale, unavailable: sources.unavailable },
      });
    }
    if (!insights.length) {
      insights.push({ id: 'none', severity: 'info', text: `No verified competitor changes in the last ${d} day${d === 1 ? '' : 's'}.`, evidence: { periodDays: d } });
    }
    return { periodDays: d, generatedAt: iso(), insights };
  }

  /**
   * What the customer got from this product, as plain counts — not
   * invented money. The one monetary figure here (openPriceGapTotal) is a
   * sum of gaps this service already computed and is labeled as exactly
   * that: a snapshot of flagged gaps awaiting human review, never "money
   * saved" or a performance claim.
   */
  async function value(ctx, { days = 30 } = {}) {
    const ws = C.requireCtx(ctx);
    const { since, days: d } = sinceIso(days);
    const { productIds: demoIds, monitorIds: demoMonitorIds } = await demoScope(ws);
    const [allChanges, demoChanges, alertsDelivered, recommendationsActedOn, openRecsAll] = await Promise.all([
      store.count('monitor_changes', ws, { detected_at: { gte: since } }),
      demoMonitorIds.size ? store.count('monitor_changes', ws, { detected_at: { gte: since }, monitor_id: { in: [...demoMonitorIds] } }) : 0,
      store.count('alert_deliveries', ws, { status: 'delivered', created_at: { gte: since } }),
      store.count('ci_recommendations', ws, { status: 'actioned', decided_at: { gte: since } }),
      store.list('ci_recommendations', ws, { filter: { status: 'open' }, limit: 500 }),
    ]);
    const changesDetected = allChanges - demoChanges; // demo/sample monitors never inflate a real customer's value numbers
    const openRecs = openRecsAll.filter((r) => !demoIds.has(r.product_id));
    const sources = (await dashboard(ctx)).totals.sources; // dashboard() already excludes demo products
    const totalSources = sources.verified + sources.unverified + sources.stale + sources.unavailable + sources.pending;
    const openPriceGapTotal = openRecs.reduce((a, r) => a + ((r.rationale && r.rationale.gap && typeof r.rationale.gap.absolute === 'number') ? r.rationale.gap.absolute : 0), 0);
    return {
      periodDays: d, generatedAt: iso(),
      changesDetected, alertsDelivered, recommendationsActedOn,
      monitoringCoverage: { verified: sources.verified, total: totalSources, pct: totalSources ? Math.round((sources.verified / totalSources) * 10000) / 100 : null },
      openPriceGapTotal: { value: Math.round(openPriceGapTotal * 100) / 100, note: 'Sum of price gaps on currently OPEN recommendations awaiting review — a snapshot, not money saved.', openRecommendationCount: openRecs.length },
    };
  }

  // ------------------------------------------------------------------
  // Commercial pass: explicit DEMO / SAMPLE DATA for first-value
  // onboarding. Seeded directly (not through createProduct/addCompetitor)
  // so it can be built in one deterministic, idempotent call; every row is
  // tagged attributes.demo = true (products) or carries a demo monitor id
  // reachable only from such a product, and every read model above
  // (listProducts, dashboard, insightsDigest, value) excludes it unless
  // explicitly asked for. It is never passed through a live monitor check
  // or treated as real market data anywhere.
  // ------------------------------------------------------------------
  const DEMO_NOTE = 'DEMO / SAMPLE DATA — for exploring Nexus. Not a real product, competitor, or market condition.';

  async function seedDemo(ctx) {
    const ws = C.requireCtx(ctx);
    C.requireAdmin(ctx, 'demo data');
    const rows = await store.list('ci_products', ws, { limit: 500 });
    const existing = rows.find(isDemoRow);
    if (existing) return demoDetail(ctx);

    const t = iso();
    const product = await store.insert('ci_products', {
      workspace_id: ws, created_by: ctx.userId, name: 'Sample Product — Wireless Earbuds (DEMO)',
      attributes: { demo: true, notes: DEMO_NOTE }, currency: 'INR',
      cost: 900, selling_price: 1499, fees_fixed: 20, fees_pct: 8, min_margin_pct: 10, target_margin_pct: 20,
    });
    // source_type 'api_submission' needs no connected integration — right for
    // directly-seeded sample data, which was never fetched from a real source.
    const mkMonitor = (name) => store.insert('monitors', {
      workspace_id: ws, name, kind: 'product', source_type: 'api_submission', source: { demo: true },
      health: 'VERIFIED', current: { price: 1399, currency: 'INR', present: true, inStock: true }, last_check_at: t, last_success_at: t, check_interval_minutes: 1440,
    });
    const m1 = await mkMonitor('DEMO — Competitor A listing');
    await mkMonitor('DEMO — Competitor B listing');
    const c1 = await store.insert('ci_competitor_products', {
      workspace_id: ws, product_id: product.id, competitor_name: 'Demo Competitor A', marketplace: 'other', monitor_id: m1.id,
      match_status: 'VERIFIED', match_confidence: 1, match_method: 'demo_seed', match_evidence: { demo: true },
      confirmed_by: ctx.userId, confirmed_at: t,
    });
    const change = await store.insert('monitor_changes', {
      workspace_id: ws, monitor_id: m1.id, change_type: 'price_decrease',
      old_value: 1499, new_value: 1399, detected_at: t, confidence: 1, verification: 'VERIFIED', source: 'demo_seed',
    });
    await store.insert('ci_recommendations', {
      workspace_id: ws, product_id: product.id, competitor_id: c1.id, change_id: change.id,
      rec_type: 'review_pricing', priority: 'medium', status: 'open',
      rationale: {
        demo: true, change: { type: 'price_decrease', oldValue: 1499, newValue: 1399, detectedAt: t, verification: 'VERIFIED' },
        competitor: { id: c1.id, name: 'Demo Competitor A' }, gap: { absolute: 100, pct: 7.1 },
      },
    });
    audit(ctx.userId, 'ci_demo_seeded', { workspaceId: ws, productId: product.id }, ws);
    return demoDetail(ctx);
  }

  async function demoDetail(ctx) {
    const ws = C.requireCtx(ctx);
    const rows = await store.list('ci_products', ws, { limit: 500 });
    const product = rows.find(isDemoRow);
    if (!product) return { exists: false, isDemo: true, label: DEMO_NOTE };
    const detail = await buildProduct(product);
    return { ...detail, exists: true, isDemo: true, label: DEMO_NOTE };
  }

  async function clearDemo(ctx) {
    const ws = C.requireCtx(ctx);
    C.requireAdmin(ctx, 'demo data');
    const rows = await store.list('ci_products', ws, { limit: 500 });
    const demo = rows.filter(isDemoRow);
    for (const p of demo) await deleteProduct(ctx, p.id);
    audit(ctx.userId, 'ci_demo_cleared', { workspaceId: ws, count: demo.length }, ws);
    return { cleared: demo.length };
  }

  // ------------------------------------------------------------------
  // Commercial pass: reports/export. Thin read models over the SAME
  // authorization/workspace-scoping as every other revenue read — no
  // secrets, no raw page content, demo data excluded by construction
  // (see demoScope), metered through the existing billing ledger (the
  // `reports_generated` capability) exactly like monitoring_checks.
  // ------------------------------------------------------------------
  const REPORT_TYPES = ['monitoring_summary', 'price_changes', 'stock_changes', 'recommendations', 'alerts'];

  function toCsv(rows, columns) {
    const esc = (v) => { const s = v === null || v === undefined ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    return [columns.map((c) => c.header).join(','), ...rows.map((r) => columns.map((c) => esc(c.value(r))).join(','))].join('\n');
  }

  async function report(ctx, { type, days = 30, format = 'json' } = {}) {
    const ws = C.requireCtx(ctx);
    const t = C.oneOf(type, 'type', REPORT_TYPES);
    const fmt = C.oneOf(format || 'json', 'format', ['json', 'csv']);
    const { since, days: d } = sinceIso(days);
    const { monitorIds: demoMonitorIds } = await demoScope(ws);

    let handle = null;
    if (usage && usage.begin) {
      try { handle = await usage.begin(ws, 'reports_generated', `report:${t}:${ctx.userId}:${Date.now()}`); } catch (err) {
        throw new C.WorkspaceError(err.status || 402, err.code || 'QUOTA_EXCEEDED', err.message);
      }
    }
    try {
      let rows, columns, title;
      if (t === 'monitoring_summary') {
        const products = await listProducts(ctx, { limit: 200 });
        title = 'Competitor monitoring summary';
        rows = products.flatMap((p) => p.competitors.map((c) => ({
          product: p.product.name, competitor: c.competitorName, marketplace: c.marketplace,
          matchStatus: c.match.status, sourceHealth: c.monitor ? c.monitor.health : 'PENDING',
          currentPrice: c.monitor && c.monitor.current ? c.monitor.current.price : null, currency: p.product.currency,
        })));
        columns = [
          { header: 'Product', value: (r) => r.product }, { header: 'Competitor', value: (r) => r.competitor },
          { header: 'Marketplace', value: (r) => r.marketplace }, { header: 'Match status', value: (r) => r.matchStatus },
          { header: 'Source health', value: (r) => r.sourceHealth }, { header: 'Current price', value: (r) => r.currentPrice },
          { header: 'Currency', value: (r) => r.currency },
        ];
      } else if (t === 'price_changes' || t === 'stock_changes') {
        const wantTypes = t === 'price_changes' ? ['price_increase', 'price_decrease'] : ['in_stock', 'out_of_stock', 'product_disappeared', 'product_reappeared'];
        title = t === 'price_changes' ? 'Price-change report' : 'Stock-change report';
        const all = await store.list('monitor_changes', ws, { filter: { detected_at: { gte: since } }, order: ['detected_at', false], limit: 500 });
        const kept = all.filter((c) => wantTypes.includes(c.change_type) && !demoMonitorIds.has(c.monitor_id));
        const resolved = [];
        for (const c of kept) {
          const links = (await linksForMonitor(ws, c.monitor_id)).filter((l) => l.competitor);
          const l = links[0];
          resolved.push({
            detectedAt: c.detected_at, product: l ? l.product.name : '(unlinked monitor)', competitor: l && l.competitor ? l.competitor.competitor_name : '—',
            changeType: c.change_type, before: c.old_value, after: c.new_value,
          });
        }
        rows = resolved;
        columns = [
          { header: 'Detected at', value: (r) => r.detectedAt }, { header: 'Product', value: (r) => r.product },
          { header: 'Competitor', value: (r) => r.competitor }, { header: 'Change', value: (r) => r.changeType },
          { header: 'Before', value: (r) => (r.before === null || r.before === undefined ? '' : JSON.stringify(r.before)) },
          { header: 'After', value: (r) => (r.after === null || r.after === undefined ? '' : JSON.stringify(r.after)) },
        ];
      } else if (t === 'recommendations') {
        title = 'Recommendations / insight summary';
        const { productIds: demoIds } = await demoScope(ws);
        rows = (await store.list('ci_recommendations', ws, { filter: { created_at: { gte: since } }, order: ['created_at', false], limit: 500 }))
          .filter((r) => !demoIds.has(r.product_id));
        columns = [
          { header: 'Created at', value: (r) => r.created_at }, { header: 'Type', value: (r) => r.rec_type },
          { header: 'Priority', value: (r) => r.priority }, { header: 'Status', value: (r) => r.status },
          { header: 'Rationale', value: (r) => (r.rationale ? JSON.stringify(r.rationale) : '') },
        ];
      } else { // alerts
        title = 'Alert history';
        rows = (await store.list('alerts', ws, { filter: { created_at: { gte: since } }, order: ['created_at', false], limit: 500 }))
          .filter((a) => !demoMonitorIds.has(a.monitor_id));
        columns = [
          { header: 'Created at', value: (r) => r.created_at }, { header: 'Type', value: (r) => r.alert_type },
          { header: 'Severity', value: (r) => r.severity }, { header: 'Title', value: (r) => r.title },
          { header: 'Acknowledged', value: (r) => !!r.acknowledged_at },
        ];
      }
      const result = fmt === 'csv'
        ? { type: t, format: 'csv', periodDays: d, generatedAt: iso(), title, csv: toCsv(rows, columns) }
        : { type: t, format: 'json', periodDays: d, generatedAt: iso(), title, count: rows.length, rows };
      if (handle) await usage.commit(handle, { source: 'report_generated', sourceId: t, actorId: ctx.userId }).catch(() => {});
      audit(ctx.userId, 'ci_report_generated', { workspaceId: ws, type: t, format: fmt, rows: rows.length }, ws);
      return result;
    } catch (err) {
      if (handle) await usage.release(handle).catch(() => {});
      throw err;
    }
  }

  return {
    createProduct, updateProduct, deleteProduct, listProducts, productDetail, addCompetitor, removeCompetitor, decideMatch,
    listRecommendations, setRecommendationStatus, actOnRecommendation, dashboard, onMonitorChecked, linksForMonitor,
    insightsDigest, value, seedDemo, demoDetail, clearDemo, report, REPORT_TYPES,
  };
}

module.exports = { createCompetitorService, MARKETPLACES };
