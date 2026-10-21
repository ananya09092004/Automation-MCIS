// Side-by-side comparison logic (pure, no I/O). Inputs are product monitors from
// GET /monitoring/monitors (values extracted from structured data the product
// page itself publishes). Rules keep the comparison honest:
//   - only fresh VERIFIED values take part in "best" marks and scores;
//   - prices in different currencies are never compared;
//   - a missing value is "not published", never 0;
//   - a score is plain arithmetic over the criteria and weights the user chose.

export const CRITERIA = [
  { key: 'price', label: 'Lower price', hint: 'Lowest current price wins (same currency only).' },
  { key: 'availability', label: 'In stock', hint: 'In stock > limited > out of stock.' },
  { key: 'discount', label: 'Discount', hint: 'Higher published discount wins.' },
];

const AVAIL_RANK = { IN_STOCK: 1, LIMITED: 0.5, OUT_OF_STOCK: 0 };

/** A monitor's current values may be compared only when fresh and VERIFIED. */
export function isComparable(m) {
  return !!(m && m.current && m.current.present !== false && m.currentIsFresh && m.health === 'VERIFIED');
}

/** Hostname of a monitor's source URL, or null. */
export function sourceHost(m) {
  try { return new URL(m.source.url).hostname; } catch { return null; }
}

/** Only http(s) URLs are ever rendered as links. */
export function safeHref(url) {
  try { const u = new URL(url); return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : null; } catch { return null; }
}

/** Does a web_page integration's allowlist cover this host? (exact or *.suffix) */
export function hostAllowed(integration, host) {
  const hosts = (integration && integration.config && integration.config.allowedHosts) || [];
  const h = String(host || '').toLowerCase();
  return hosts.some((a) => (a.startsWith('*.') ? h === a.slice(2) || h.endsWith(a.slice(1)) : h === a));
}

/** Per criterion: raw values for comparable monitors, and the winner ids (only with ≥ 2 comparable values). */
export function analyse(monitors) {
  const comp = monitors.filter(isComparable);
  const currencies = [...new Set(comp.filter((m) => m.current.price !== null && m.current.price !== undefined).map((m) => m.current.currency || '?'))];
  const mixedCurrency = currencies.length > 1;
  const out = { mixedCurrency, currencies, best: {}, values: {} };

  const priced = mixedCurrency ? [] : comp.filter((m) => typeof m.current.price === 'number');
  out.values.price = Object.fromEntries(priced.map((m) => [m.id, m.current.price]));
  if (priced.length >= 2) {
    const min = Math.min(...priced.map((m) => m.current.price));
    out.best.price = priced.filter((m) => m.current.price === min).map((m) => m.id);
  }
  const avail = comp.filter((m) => m.current.availability in AVAIL_RANK);
  out.values.availability = Object.fromEntries(avail.map((m) => [m.id, AVAIL_RANK[m.current.availability]]));
  if (avail.length >= 2) {
    const max = Math.max(...avail.map((m) => AVAIL_RANK[m.current.availability]));
    out.best.availability = avail.filter((m) => AVAIL_RANK[m.current.availability] === max).map((m) => m.id);
  }
  const disc = comp.filter((m) => typeof m.current.discountPct === 'number');
  out.values.discount = Object.fromEntries(disc.map((m) => [m.id, m.current.discountPct]));
  if (disc.length >= 2) {
    const max = Math.max(...disc.map((m) => m.current.discountPct));
    out.best.discount = disc.filter((m) => m.current.discountPct === max).map((m) => m.id);
  }
  return out;
}

/**
 * Weighted score per monitor over the chosen criteria. Each criterion is scaled
 * 0–1 across the monitors that have a comparable value; a monitor without a
 * value for a criterion is not scored on it (reported in `missing`). Monitors
 * whose data is not fresh and VERIFIED are never scored (`unverified: true`),
 * so missing or doubtful data can never rank a product above a verified one.
 * weights: { price: 0–5, availability: 0–5, discount: 0–5 }.
 */
export function score(monitors, weights) {
  const a = analyse(monitors);
  const active = CRITERIA.filter((c) => (weights[c.key] || 0) > 0);
  const scaled = {};
  for (const c of active) {
    const vals = a.values[c.key] || {};
    const nums = Object.values(vals);
    if (nums.length < 2) { scaled[c.key] = {}; continue; } // nothing to compare against
    const min = Math.min(...nums); const max = Math.max(...nums);
    scaled[c.key] = Object.fromEntries(Object.entries(vals).map(([id, v]) => {
      if (max === min) return [id, 1];
      const t = (v - min) / (max - min);
      return [id, c.key === 'price' ? 1 - t : t]; // lower price is better
    }));
  }
  const result = {};
  for (const m of monitors) {
    if (!isComparable(m)) { result[m.id] = { score: null, parts: [], missing: [], unverified: true }; continue; }
    let sum = 0; let w = 0; const parts = []; const missing = [];
    for (const c of active) {
      const v = scaled[c.key][m.id];
      if (v === undefined) { missing.push(c.key); continue; }
      sum += v * weights[c.key]; w += weights[c.key];
      parts.push({ key: c.key, value: v, weight: weights[c.key] });
    }
    result[m.id] = { score: w ? Math.round((sum / w) * 100) : null, parts, missing };
  }
  return { ...a, scores: result, criteria: active.map((c) => c.key) };
}

const FIELDS = [
  ['Product', (m) => m.current && m.current.title],
  ['Price', (m) => (m.current && typeof m.current.price === 'number' ? m.current.price : null)],
  ['Currency', (m) => m.current && m.current.currency],
  ['List price', (m) => m.current && m.current.listPrice],
  ['Discount %', (m) => m.current && m.current.discountPct],
  ['Availability', (m) => m.current && m.current.availability],
  ['Seller', (m) => m.current && m.current.seller],
  ['Brand', (m) => m.current && m.current.identifiers && m.current.identifiers.brand],
  ['Model', (m) => m.current && m.current.identifiers && m.current.identifiers.model],
  ['MPN', (m) => m.current && m.current.identifiers && m.current.identifiers.mpn],
  ['GTIN', (m) => m.current && m.current.identifiers && m.current.identifiers.gtin],
  ['SKU', (m) => m.current && m.current.identifiers && m.current.identifiers.sku],
  ['Verification', (m) => m.health],
  ['Fresh', (m) => (m.currentIsFresh ? 'yes' : 'no')],
  ['Last read (UTC)', (m) => m.lastSuccessAt],
  ['Source URL', (m) => m.source && m.source.url],
];

/** CSV cell: quoted, and formula-like text neutralised (CSV injection). */
export function csvCell(v) {
  if (v === null || v === undefined || v === '') return '""';
  let s = String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

/** The comparison as CSV: one row per field, one column per product, plus scores. */
export function toCsv(monitors, scored) {
  const head = ['Field', ...monitors.map((m) => m.name)];
  const rows = FIELDS.map(([label, get]) => [label, ...monitors.map((m) => {
    const v = get(m);
    return v === null || v === undefined || v === '' ? 'not published' : v;
  })]);
  if (scored && scored.criteria.length) {
    rows.push(['Score (0-100)', ...monitors.map((m) => (scored.scores[m.id].unverified ? 'not scored (data not verified)' : scored.scores[m.id].score === null ? 'not scored' : scored.scores[m.id].score))]);
    rows.push(['Score criteria', ...monitors.map(() => scored.criteria.join(' + '))]);
  }
  rows.push(['Note', ...monitors.map(() => 'Values read from structured data published on the source page; not verified by Nexus beyond that.')]);
  return [head, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n');
}
