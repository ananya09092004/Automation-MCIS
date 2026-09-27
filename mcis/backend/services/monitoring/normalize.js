/**
 * Layer 10 — observation normalization and deterministic change detection.
 *
 * normalizeProduct(raw)  → { present, title, price, listPrice, currency,
 *                            discountPct, availability, seller, identifiers }
 * normalizeValues(raw)   → generic flat { field: scalar } for page / API monitors
 * valueHash(values)      → stable hash of the comparable fields (dedupe key)
 * diffProduct(old, new)  → [{ changeType, field, oldValue, newValue, meta }]
 * diffValues(old, new)   → value_changed per field
 *
 * Rules that keep alerts honest:
 *   - UNKNOWN availability never produces a stock transition (neither to
 *     nor from it);
 *   - a missing price is "unknown", never 0;
 *   - equal normalized values never produce a change (dedupe).
 */
'use strict';

const crypto = require('crypto');

const AVAILABILITY = Object.freeze(['IN_STOCK', 'OUT_OF_STOCK', 'LIMITED', 'UNKNOWN']);
const SYMBOLS = [['₹', 'INR'], ['Rs.', 'INR'], ['Rs', 'INR'], ['US$', 'USD'], ['$', 'USD'], ['€', 'EUR'], ['£', 'GBP'], ['¥', 'JPY'], ['A$', 'AUD'], ['C$', 'CAD']];

/** Money string / number → number (2 dp) or null. Handles "1,299.00", "1.299,00", "₹ 1,299". */
function parsePrice(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) && v >= 0 ? Math.round(v * 100) / 100 : null;
  let s = String(v).trim();
  if (s.length > 40) return null;
  s = s.replace(/[^0-9.,-]/g, '');
  if (!s || s.startsWith('-')) return null;
  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');
  if (lastComma > -1 && lastDot > -1) {
    s = lastComma > lastDot ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  } else if (lastComma > -1) {
    // "1,299" (thousands) vs "12,99" (decimal): two digits after the only comma = decimal
    s = /,\d{2}$/.test(s) && (s.match(/,/g) || []).length === 1 ? s.replace(',', '.') : s.replace(/,/g, '');
  }
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}

function parseCurrency(v, priceText) {
  if (typeof v === 'string' && /^[A-Za-z]{3}$/.test(v.trim())) return v.trim().toUpperCase();
  const t = String(priceText || '');
  for (const [sym, code] of SYMBOLS) if (t.includes(sym)) return code;
  return null;
}

/** schema.org / Shopify / free-form availability → one of AVAILABILITY. */
function normalizeAvailability(v) {
  if (v === true) return 'IN_STOCK';
  if (v === false) return 'OUT_OF_STOCK';
  if (typeof v === 'number') return v > 0 ? 'IN_STOCK' : 'OUT_OF_STOCK';
  if (typeof v !== 'string' || !v.trim()) return 'UNKNOWN';
  const s = v.trim().replace(/^https?:\/\/schema\.org\//i, '').replace(/[\s_-]/g, '').toLowerCase();
  if (['instock', 'instoreonly', 'onlineonly', 'available', 'yes', 'true'].includes(s)) return 'IN_STOCK';
  if (['outofstock', 'soldout', 'discontinued', 'unavailable', 'no', 'false', 'notavailable'].includes(s)) return 'OUT_OF_STOCK';
  if (['limitedavailability', 'limited', 'lowstock', 'fewleft'].includes(s)) return 'LIMITED';
  return 'UNKNOWN';
}

const cleanText = (v, max = 300) => (v === null || v === undefined ? null : String(v).replace(/\s+/g, ' ').trim().slice(0, max) || null);

function normalizeGtin(v) {
  if (v === null || v === undefined) return null;
  const d = String(v).replace(/\D/g, '');
  if (![8, 12, 13, 14].includes(d.length)) return null;
  return d.padStart(14, '0');
}

/** GS1 check digit (GTIN-8/12/13/14). */
function validGtin(v) {
  const g = normalizeGtin(v);
  if (!g) return false;
  const digits = g.split('').map(Number);
  const check = digits.pop();
  const sum = digits.reverse().reduce((a, d, i) => a + d * (i % 2 === 0 ? 3 : 1), 0);
  return (10 - (sum % 10)) % 10 === check;
}

function normalizeProduct(raw, { present = true, currencyDefault = null } = {}) {
  if (!present) return { present: false };
  const r = raw || {};
  const price = parsePrice(r.price);
  const listPrice = parsePrice(r.listPrice);
  const currency = parseCurrency(r.currency, r.price) || (price !== null ? currencyDefault : null);
  const discountPct = price !== null && listPrice !== null && listPrice > price
    ? Math.round(((listPrice - price) / listPrice) * 10000) / 100 : null;
  const gtin = normalizeGtin(r.gtin);
  return {
    present: true,
    title: cleanText(r.title),
    price,
    listPrice: listPrice !== null && price !== null && listPrice > price ? listPrice : null,
    currency,
    discountPct,
    availability: normalizeAvailability(r.availability),
    seller: cleanText(r.seller, 120),
    identifiers: {
      ...(cleanText(r.sku, 100) ? { sku: cleanText(r.sku, 100) } : {}),
      ...(gtin && validGtin(gtin) ? { gtin } : {}),
      ...(cleanText(r.mpn, 100) ? { mpn: cleanText(r.mpn, 100) } : {}),
      ...(cleanText(r.brand, 100) ? { brand: cleanText(r.brand, 100) } : {}),
      ...(cleanText(r.model, 100) ? { model: cleanText(r.model, 100) } : {}),
    },
  };
}

function normalizeValues(raw) {
  const out = {};
  for (const [k, v] of Object.entries(raw || {}).slice(0, 30)) {
    if (!/^[a-z][a-z0-9_]{0,59}$/.test(k)) continue;
    if (v === null || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v))) out[k] = v;
    else if (typeof v === 'string') out[k] = v.slice(0, 300);
  }
  return out;
}

function stable(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`;
}

/** Hash of the fields a change can be detected on (title / identifiers excluded: cosmetic). */
function valueHash(values, kind = 'product') {
  const v = values || {};
  const comparable = kind === 'product'
    ? { present: v.present !== false, price: v.price ?? null, listPrice: v.listPrice ?? null, currency: v.currency ?? null, availability: v.availability || 'UNKNOWN', seller: v.seller ?? null }
    : v;
  return crypto.createHash('sha256').update(stable(comparable)).digest('hex');
}

const pct = (a, b) => (a > 0 ? Math.round(((b - a) / a) * 10000) / 100 : null);

/**
 * Deterministic product diff. `old` is the monitor's last known state
 * (null on the first observation → no changes: nothing to compare with).
 */
function diffProduct(old, cur) {
  if (!old || !cur) return [];
  const changes = [];
  const oldPresent = old.present !== false;
  const curPresent = cur.present !== false;
  if (oldPresent && !curPresent) return [{ changeType: 'product_disappeared', field: 'present', oldValue: true, newValue: false }];
  if (!oldPresent && curPresent) changes.push({ changeType: 'product_reappeared', field: 'present', oldValue: false, newValue: true });
  if (!curPresent) return changes;

  const sameCurrency = !old.currency || !cur.currency || old.currency === cur.currency;
  if (old.price !== null && old.price !== undefined && cur.price !== null && cur.price !== undefined && sameCurrency && old.price !== cur.price) {
    if (cur.price < old.price) {
      changes.push({ changeType: 'price_decrease', field: 'price', oldValue: old.price, newValue: cur.price, meta: { changePct: pct(old.price, cur.price), currency: cur.currency || old.currency || null } });
    } else {
      const restored = old.listPrice && cur.price >= old.listPrice && !cur.listPrice;
      changes.push({ changeType: restored ? 'price_restored' : 'price_increase', field: 'price', oldValue: old.price, newValue: cur.price, meta: { changePct: pct(old.price, cur.price), currency: cur.currency || old.currency || null } });
    }
  }
  const oldDisc = old.discountPct || null;
  const curDisc = cur.discountPct || null;
  if (!oldDisc && curDisc) changes.push({ changeType: 'new_discount', field: 'discountPct', oldValue: null, newValue: curDisc, meta: { listPrice: cur.listPrice } });
  else if (oldDisc && !curDisc && !changes.some((c) => c.changeType === 'price_restored')) changes.push({ changeType: 'discount_removed', field: 'discountPct', oldValue: oldDisc, newValue: null });

  const oa = old.availability || 'UNKNOWN';
  const ca = cur.availability || 'UNKNOWN';
  if (oa !== ca && oa !== 'UNKNOWN' && ca !== 'UNKNOWN') {
    let type = 'stock_changed';
    if (ca === 'OUT_OF_STOCK') type = 'out_of_stock';
    else if (oa === 'OUT_OF_STOCK' && (ca === 'IN_STOCK' || ca === 'LIMITED')) type = 'back_in_stock';
    else if (ca === 'LIMITED') type = 'limited_stock';
    changes.push({ changeType: type, field: 'availability', oldValue: oa, newValue: ca });
  }
  if (old.seller && cur.seller && old.seller !== cur.seller) changes.push({ changeType: 'seller_changed', field: 'seller', oldValue: old.seller, newValue: cur.seller });
  return changes;
}

function diffValues(old, cur) {
  if (!old || !cur) return [];
  const keys = [...new Set([...Object.keys(old), ...Object.keys(cur)])].sort();
  return keys.filter((k) => stable(old[k] ?? null) !== stable(cur[k] ?? null))
    .map((k) => ({ changeType: 'value_changed', field: k.slice(0, 60), oldValue: old[k] ?? null, newValue: cur[k] ?? null }));
}

module.exports = {
  AVAILABILITY, parsePrice, parseCurrency, normalizeAvailability, normalizeGtin, validGtin, normalizeProduct, normalizeValues,
  valueHash, diffProduct, diffValues, stable,
};
