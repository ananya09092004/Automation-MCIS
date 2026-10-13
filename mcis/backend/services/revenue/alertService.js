/**
 * Layer 10 — alert rules, alerts and per-channel delivery state.
 *
 * Rules (scope: one monitor, one product, or the whole workspace):
 *   price_below        a price change ends below `threshold`
 *   price_drop_pct     a price decrease of at least `threshold` %
 *   out_of_stock       stock became OUT_OF_STOCK        (never from UNKNOWN)
 *   back_in_stock      stock came back from OUT_OF_STOCK
 *   margin_below       matching a competitor's new price would put the
 *                      product's margin below `threshold` % (needs cost and
 *                      fees; never computed from missing inputs)
 *   product_disappeared, source_stale, source_unavailable, any_change
 * Product-scoped rules only consider competitors whose match is VERIFIED.
 *
 * Alerts are de-duplicated per (rule, change) and throttled per
 * (rule, monitor) by cooldown_minutes. Channels:
 *   in_app   the alert row itself (delivered when stored)
 *   slack    slack.notify through the connector gateway + Agent Firewall
 *   email    email.notify (fixed recipients) through the same path
 * Each channel's outcome is stored (delivered / failed / blocked /
 * skipped) — a failed or blocked delivery is never reported as sent, and
 * sends are never retried automatically (a retry could post twice); an
 * admin can retry a failed delivery explicitly. Workspace webhooks
 * subscribed to `alert.created` receive every alert with their own
 * delivery records.
 */
'use strict';

const C = require('./common');
const { marginAt } = require('./margin');

const RULE_TYPES = ['price_below', 'price_drop_pct', 'out_of_stock', 'back_in_stock', 'margin_below', 'product_disappeared', 'source_stale', 'source_unavailable', 'any_change'];
const NEEDS_THRESHOLD = new Set(['price_below', 'price_drop_pct', 'margin_below']);
const PRICE_CHANGES = new Set(['price_decrease', 'price_increase', 'price_restored']);
const SEVERITY = {
  price_below: 'warning', price_drop_pct: 'warning', out_of_stock: 'warning', back_in_stock: 'info', margin_below: 'critical',
  product_disappeared: 'warning', source_stale: 'warning', source_unavailable: 'warning', any_change: 'info',
};

function createAlertService({ store, connectorActions = null, integrations = null, events = null, appendAuditLog = null, logger = console, options = {} } = {}) {
  if (!store) throw new Error('alert service: store is required');
  const now = options.now || (() => new Date());
  const iso = () => now().toISOString();
  let productResolver = async () => []; // (ws, monitorId) → [{ product, competitor|null }]
  const emit = (type, payload) => (events ? events.emit(type, payload) : Promise.resolve());
  const audit = (actor, action, payload, ws) => {
    if (!appendAuditLog) return;
    try { Promise.resolve(appendAuditLog(actor, action, payload, { success: true, error: null }, ws)).catch(() => {}); } catch { /* never */ }
  };

  const ruleView = (r) => ({
    id: r.id, name: r.name, ruleType: r.rule_type, monitorId: r.monitor_id, productId: r.product_id, threshold: C.dbNum(r.threshold),
    channels: r.channels, cooldownMinutes: r.cooldown_minutes, enabled: r.enabled, createdBy: r.created_by, version: r.version, createdAt: r.created_at,
  });
  const deliveryView = (d) => ({ id: d.id, channel: d.channel, integrationId: d.integration_id, status: d.status, errorCode: d.error_code, attempts: d.attempts, lastAttemptAt: d.last_attempt_at, deliveredAt: d.delivered_at });
  const alertView = (a, deliveries = null) => ({
    id: a.id, ruleId: a.rule_id, monitorId: a.monitor_id, changeId: a.change_id, type: a.alert_type, severity: a.severity, title: a.title,
    details: a.details, acknowledged: !!a.acknowledged_at, acknowledgedBy: a.acknowledged_by, acknowledgedAt: a.acknowledged_at, createdAt: a.created_at,
    ...(deliveries ? { deliveries: deliveries.map(deliveryView) } : {}),
  });

  async function validateChannels(ws, raw) {
    const list = raw === undefined ? [{ type: 'in_app' }] : raw;
    if (!Array.isArray(list) || !list.length || list.length > 5) throw C.bad('channels must list 1-5 channels');
    const out = [];
    const seen = new Set();
    for (const ch of list) {
      C.onlyKeys(ch, ['type', 'integrationId'], 'channel');
      const type = C.oneOf(ch.type, 'channel.type', ['in_app', 'slack', 'email']);
      if (type === 'in_app') { if (seen.has('in_app')) continue; seen.add('in_app'); out.push({ type }); continue; }
      if (!C.isUuid(ch.integrationId)) throw C.bad(`${type} channels need an integrationId`);
      const i = integrations ? await integrations.getIntegrationRow(ws, ch.integrationId) : null;
      if (!i) throw C.notFound('Integration');
      if (i.provider !== type) throw C.bad(`Integration ${i.name} is not a ${type} integration`);
      const key = `${type}:${ch.integrationId}`;
      if (!seen.has(key)) { seen.add(key); out.push({ type, integrationId: ch.integrationId }); }
    }
    return out;
  }

  async function validateScope(ws, monitorId, productId) {
    if (monitorId && productId) throw C.bad('A rule is scoped to a monitor OR a product, not both');
    if (monitorId && !(await store.get('monitors', ws, C.uuidOr404(monitorId, 'Monitor')))) throw C.notFound('Monitor');
    if (productId && !(await store.get('ci_products', ws, C.uuidOr404(productId, 'Product')))) throw C.notFound('Product');
  }

  async function createRule(ctx, body = {}) {
    const ws = C.requireCtx(ctx);
    C.requireAdmin(ctx, 'alert rules');
    C.onlyKeys(body, ['name', 'ruleType', 'monitorId', 'productId', 'threshold', 'channels', 'cooldownMinutes', 'enabled']);
    const ruleType = C.oneOf(body.ruleType, 'ruleType', RULE_TYPES);
    const threshold = C.num(body.threshold, 'threshold', { min: ruleType === 'margin_below' ? -100 : 0, max: ruleType === 'price_below' ? 1e10 : 100, optional: !NEEDS_THRESHOLD.has(ruleType) });
    if (!NEEDS_THRESHOLD.has(ruleType) && threshold !== null) throw C.bad(`${ruleType} rules take no threshold`);
    if (ruleType === 'margin_below' && !body.productId) throw C.bad('margin_below rules must be scoped to a product');
    await validateScope(ws, body.monitorId || null, body.productId || null);
    const row = await store.insert('alert_rules', {
      workspace_id: ws, name: C.str(body.name, 'name', { max: 120 }), rule_type: ruleType, monitor_id: body.monitorId || null, product_id: body.productId || null,
      threshold, channels: await validateChannels(ws, body.channels), cooldown_minutes: C.int(body.cooldownMinutes, 'cooldownMinutes', { min: 0, max: 10080, dflt: 60 }),
      enabled: body.enabled === undefined ? true : !!body.enabled, created_by: ctx.userId,
    });
    audit(ctx.userId, 'alert_rule_created', { workspaceId: ws, ruleId: row.id, ruleType }, ws);
    return ruleView(row);
  }

  async function loadRule(ctx, id) {
    const ws = C.requireCtx(ctx);
    const r = await store.get('alert_rules', ws, C.uuidOr404(id, 'Alert rule'));
    if (!r) throw C.notFound('Alert rule');
    return r;
  }

  async function updateRule(ctx, id, body = {}) {
    const r = await loadRule(ctx, id);
    C.requireAdmin(ctx, 'alert rules');
    C.onlyKeys(body, ['version', 'name', 'threshold', 'channels', 'cooldownMinutes', 'enabled']);
    if (body.version !== r.version) throw C.conflict('version is required and must match the current version', 'RULE_CONFLICT');
    const patch = {};
    if (body.name !== undefined) patch.name = C.str(body.name, 'name', { max: 120 });
    if (body.threshold !== undefined) {
      if (!NEEDS_THRESHOLD.has(r.rule_type)) throw C.bad(`${r.rule_type} rules take no threshold`);
      patch.threshold = C.num(body.threshold, 'threshold', { min: r.rule_type === 'margin_below' ? -100 : 0, max: r.rule_type === 'price_below' ? 1e10 : 100, optional: false });
    }
    if (body.channels !== undefined) patch.channels = await validateChannels(r.workspace_id, body.channels);
    if (body.cooldownMinutes !== undefined) patch.cooldown_minutes = C.int(body.cooldownMinutes, 'cooldownMinutes', { min: 0, max: 10080 });
    if (body.enabled !== undefined) { if (typeof body.enabled !== 'boolean') throw C.bad('enabled must be boolean'); patch.enabled = body.enabled; }
    const u = await store.update('alert_rules', r.workspace_id, r.id, patch, { expectVersion: r.version });
    if (!u) throw C.conflict('The rule was changed concurrently; reload and retry.', 'RULE_CONFLICT');
    return ruleView(u);
  }

  async function deleteRule(ctx, id) {
    const r = await loadRule(ctx, id);
    C.requireAdmin(ctx, 'alert rules');
    await store.remove('alert_rules', r.workspace_id, r.id);
    audit(ctx.userId, 'alert_rule_deleted', { workspaceId: r.workspace_id, ruleId: r.id }, r.workspace_id);
    return { deleted: true };
  }

  async function listRules(ctx) {
    const ws = C.requireCtx(ctx);
    return (await store.list('alert_rules', ws, { limit: 500 })).map(ruleView);
  }

  async function listAlerts(ctx, { acknowledged, monitorId, limit } = {}) {
    const ws = C.requireCtx(ctx);
    const filter = {};
    if (acknowledged === 'false' || acknowledged === false) filter.acknowledged_at = null;
    if (acknowledged === 'true' || acknowledged === true) filter.acknowledged_at = { notNull: true };
    if (monitorId) filter.monitor_id = C.uuidOr404(monitorId, 'Monitor');
    const rows = await store.list('alerts', ws, { filter, limit: Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200) });
    const out = [];
    for (const a of rows) out.push(alertView(a, await store.list('alert_deliveries', ws, { filter: { alert_id: a.id }, order: ['created_at', true], limit: 10 })));
    return out;
  }

  async function acknowledge(ctx, id) {
    const ws = C.requireCtx(ctx);
    const a = await store.get('alerts', ws, C.uuidOr404(id, 'Alert'));
    if (!a) throw C.notFound('Alert');
    if (a.acknowledged_at) return alertView(a);
    const [u] = await store.updateWhere('alerts', ws, { id: a.id, acknowledged_at: null }, { acknowledged_by: ctx.userId, acknowledged_at: iso() });
    return alertView(u || (await store.get('alerts', ws, a.id)));
  }

  // ------------------------------------------------------------------
  // Evaluation
  // ------------------------------------------------------------------
  function matchRule(rule, change, ctx) {
    const t = change.changeType;
    const v = C.dbNum(rule.threshold);
    switch (rule.rule_type) {
      case 'price_below':
        return PRICE_CHANGES.has(t) && typeof change.newValue === 'number' && change.newValue < v && !(typeof change.oldValue === 'number' && change.oldValue < v);
      case 'price_drop_pct': {
        if (t !== 'price_decrease' || typeof change.oldValue !== 'number' || change.oldValue <= 0) return false;
        const drop = ((change.oldValue - change.newValue) / change.oldValue) * 100;
        return drop >= v;
      }
      case 'out_of_stock': return t === 'out_of_stock';
      case 'back_in_stock': return t === 'back_in_stock';
      case 'product_disappeared': return t === 'product_disappeared';
      case 'source_stale': return t === 'source_stale';
      case 'source_unavailable': return t === 'source_unavailable';
      case 'any_change': return true;
      case 'margin_below': {
        if (!PRICE_CHANGES.has(t) || typeof change.newValue !== 'number' || !ctx.product || !ctx.competitor) return false;
        const m = marginAt(ctx.product, change.newValue, ctx.currency);
        if (!m.complete) return false; // never alert on invented inputs
        ctx.margin = m;
        return m.marginPct < v;
      }
      default: return false;
    }
  }

  function describe(rule, change, monitor, ctx) {
    const name = monitor.name;
    const fmt = (x) => (typeof x === 'number' ? x.toLocaleString('en-IN', { maximumFractionDigits: 2 }) : String(x));
    const cur = (monitor.current && monitor.current.currency) || '';
    switch (change.changeType) {
      case 'price_decrease': return `${name}: price dropped ${fmt(change.oldValue)} → ${fmt(change.newValue)} ${cur}`.trim();
      case 'price_increase': return `${name}: price rose ${fmt(change.oldValue)} → ${fmt(change.newValue)} ${cur}`.trim();
      case 'price_restored': return `${name}: price restored to ${fmt(change.newValue)} ${cur}`.trim();
      case 'out_of_stock': return `${name}: out of stock`;
      case 'back_in_stock': return `${name}: back in stock`;
      case 'limited_stock': return `${name}: limited stock`;
      case 'product_disappeared': return `${name}: product page no longer exists`;
      case 'product_reappeared': return `${name}: product page is back`;
      case 'source_unavailable': return `${name}: source unavailable`;
      case 'source_recovered': return `${name}: source available again`;
      case 'source_stale': return `${name}: data is stale`;
      case 'new_discount': return `${name}: new discount ${fmt(change.newValue)}%`;
      case 'discount_removed': return `${name}: discount removed`;
      case 'seller_changed': return `${name}: seller changed to ${change.newValue}`;
      default: return `${name}: ${change.field} changed`;
    }
  }

  async function onMonitorChecked({ workspaceId: ws, monitorRow: monitor, changes }) {
    if (!changes || !changes.length) return [];
    const rules = (await store.list('alert_rules', ws, { filter: { enabled: true }, limit: 500 }));
    if (!rules.length) return [];
    const links = await productResolver(ws, monitor.id); // [{ product, competitor|null }]
    const created = [];
    for (const rule of rules) {
      let ctxs;
      if (rule.monitor_id) ctxs = rule.monitor_id === monitor.id ? [{}] : [];
      else if (rule.product_id) {
        ctxs = links.filter((l) => l.product.id === rule.product_id && (!l.competitor || l.competitor.match_status === 'VERIFIED'))
          .map((l) => ({ product: l.product, competitor: l.competitor, currency: monitor.current && monitor.current.currency }));
      } else ctxs = [{}];
      for (const cx of ctxs) {
        for (const change of changes) {
          if (!matchRule(rule, change, cx)) continue;
          const a = await raise(rule, monitor, change, cx);
          if (a) created.push(a);
        }
      }
    }
    return created;
  }

  async function raise(rule, monitor, change, cx) {
    const ws = rule.workspace_id;
    if (rule.cooldown_minutes > 0) {
      const since = new Date(now().getTime() - rule.cooldown_minutes * 60000).toISOString();
      const recent = await store.find('alerts', ws, { rule_id: rule.id, monitor_id: monitor.id, alert_type: change.changeType, created_at: { gte: since } });
      if (recent) return null; // throttled
    }
    const details = {
      change: { type: change.changeType, field: change.field, oldValue: change.oldValue, newValue: change.newValue, verification: change.verification, confidence: change.confidence },
      monitor: { id: monitor.id, name: monitor.name, health: monitor.health },
      ...(cx.product ? { product: { id: cx.product.id, name: cx.product.name, sku: cx.product.sku } } : {}),
      ...(cx.competitor ? { competitor: { id: cx.competitor.id, name: cx.competitor.competitor_name, matchStatus: cx.competitor.match_status } } : {}),
      ...(cx.margin ? { margin: cx.margin } : {}),
      ...(rule.threshold !== null ? { threshold: C.dbNum(rule.threshold) } : {}),
    };
    const alert = await store.tryInsert('alerts', {
      workspace_id: ws, rule_id: rule.id, monitor_id: monitor.id, change_id: change.id || null, alert_type: change.changeType,
      severity: SEVERITY[rule.rule_type] || 'info', title: describe(rule, change, monitor, cx).slice(0, 300), details,
      dedup_key: `${rule.id}:${change.id || change.changeType}:${cx.competitor ? cx.competitor.id : '-'}`.slice(0, 300),
    });
    if (!alert) return null; // already raised for this change
    await deliver(rule, alert);
    await emit('alert.created', { workspaceId: ws, alert: alertView(alert) });
    return alert;
  }

  async function deliver(rule, alert) {
    const ws = alert.workspace_id;
    for (const ch of rule.channels || []) {
      const key = ch.type === 'in_app' ? 'in_app' : `${ch.type}:${ch.integrationId}`;
      const d = await store.tryInsert('alert_deliveries', { workspace_id: ws, alert_id: alert.id, channel: ch.type, channel_key: key, integration_id: ch.integrationId || null, status: 'pending' });
      if (!d) continue;
      if (ch.type === 'in_app') {
        await store.update('alert_deliveries', ws, d.id, { status: 'delivered', attempts: 1, last_attempt_at: iso(), delivered_at: iso() }, { touch: false });
        continue;
      }
      await attempt(rule, alert, d);
    }
  }

  async function attempt(rule, alert, d) {
    const ws = alert.workspace_id;
    if (!connectorActions) {
      return store.update('alert_deliveries', ws, d.id, { status: 'skipped', error_code: 'INTEGRATIONS_DISABLED', attempts: d.attempts, last_attempt_at: iso() }, { touch: false });
    }
    const input = d.channel === 'slack'
      ? { title: alert.title, text: summaryText(alert), severity: alert.severity }
      : { subject: `[Nexus] ${alert.title}`.slice(0, 200), text: summaryText(alert) };
    let res;
    try {
      res = await connectorActions.run({ workspaceId: ws, actorId: rule.created_by, integrationId: d.integration_id, action: 'notify', input, sourceId: `alert-${d.id}` });
    } catch (err) {
      res = { ok: false, code: 'DELIVERY_ERROR' };
    }
    const patch = { attempts: d.attempts + 1, last_attempt_at: iso() };
    if (res.ok) Object.assign(patch, { status: 'delivered', delivered_at: iso(), error_code: null });
    else Object.assign(patch, { status: res.blocked ? 'blocked' : 'failed', error_code: String(res.code || 'DELIVERY_FAILED').slice(0, 80) });
    return store.update('alert_deliveries', ws, d.id, patch, { touch: false });
  }

  function summaryText(alert) {
    const d = alert.details || {};
    const lines = [alert.title];
    if (d.change) lines.push(`Change: ${d.change.type} (${d.change.verification || 'VERIFIED'})`);
    if (d.product) lines.push(`Product: ${d.product.name}${d.product.sku ? ` (${d.product.sku})` : ''}`);
    if (d.margin && d.margin.complete) lines.push(`Margin at this price: ${d.margin.marginPct}%`);
    lines.push(`Detected: ${alert.created_at}`);
    return lines.join('\n').slice(0, 2900);
  }

  /** Admin retry of ONE failed delivery (never automatic). */
  async function retryDelivery(ctx, alertId, deliveryId) {
    const ws = C.requireCtx(ctx);
    C.requireAdmin(ctx, 'alert deliveries');
    const a = await store.get('alerts', ws, C.uuidOr404(alertId, 'Alert'));
    if (!a) throw C.notFound('Alert');
    const d = await store.get('alert_deliveries', ws, C.uuidOr404(deliveryId, 'Delivery'));
    if (!d || d.alert_id !== a.id) throw C.notFound('Delivery');
    if (!['failed', 'blocked'].includes(d.status)) throw C.conflict(`A ${d.status} delivery cannot be retried`, 'NOT_RETRYABLE');
    const rule = await store.get('alert_rules', ws, a.rule_id);
    if (!rule) throw C.notFound('Alert rule');
    // Claim the retry (CAS on the status) so two clicks never send twice.
    const [claimed] = await store.updateWhere('alert_deliveries', ws, { id: d.id, status: d.status, attempts: d.attempts }, { status: 'pending', last_attempt_at: iso() });
    if (!claimed) throw C.conflict('The delivery is already being retried', 'RETRY_IN_PROGRESS');
    return deliveryView(await attempt({ ...rule, created_by: ctx.userId }, a, claimed));
  }

  /** Worker: deliveries stuck in `pending` (process died mid-send) are marked failed, never re-sent. */
  async function expireStuckDeliveries(ws, olderThanMinutes = 15) {
    const before = new Date(now().getTime() - olderThanMinutes * 60000).toISOString();
    const a = await store.updateWhere('alert_deliveries', ws, { status: 'pending', last_attempt_at: null, created_at: { lt: before } }, { status: 'failed', error_code: 'INTERRUPTED' });
    const b = await store.updateWhere('alert_deliveries', ws, { status: 'pending', last_attempt_at: { lt: before } }, { status: 'failed', error_code: 'INTERRUPTED' });
    return a.length + b.length;
  }

  return {
    createRule, updateRule, deleteRule, listRules, listAlerts, acknowledge, retryDelivery, onMonitorChecked, expireStuckDeliveries,
    setProductResolver(fn) { productResolver = fn; }, ruleView, alertView, RULE_TYPES,
  };
}

module.exports = { createAlertService, RULE_TYPES };
