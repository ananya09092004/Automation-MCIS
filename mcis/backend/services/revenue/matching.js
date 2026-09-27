/**
 * Layer 10 — deterministic product matching (pure).
 *
 *   evidence                                   confidence  status
 *   same valid GTIN/UPC/EAN (GS1 check digit)  0.99        VERIFIED
 *   same marketplace id (ASIN / FSN / …)       0.97        VERIFIED
 *   same known product URL                     0.97        VERIFIED
 *   same brand + MPN                           0.95        VERIFIED
 *   same brand + model                         0.85        UNVERIFIED
 *   same SKU (sellers' SKUs differ)            0.70        UNVERIFIED
 *   title similarity (+ brand)                 ≤ 0.60      UNVERIFIED
 * A contradiction (different valid GTINs, different brands, different
 * MPNs for the same brand) forces confidence 0 and UNVERIFIED: a person
 * decides. Only VERIFIED matches feed recommendations and product alerts;
 * a human confirmation or rejection is final (re-matching never
 * overrides it).
 */
'use strict';

const { normalizeGtin, validGtin } = require('../monitoring/normalize');

const norm = (v) => (v === null || v === undefined ? null : String(v).toLowerCase().replace(/[^a-z0-9]/g, '') || null);
const tokens = (s) => new Set(String(s || '').toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 1));

function normUrl(u) {
  try {
    const x = new URL(u);
    return `${x.hostname.replace(/^www\./, '').toLowerCase()}${x.pathname.replace(/\/+$/, '').toLowerCase()}`;
  } catch { return null; }
}

function jaccard(a, b) {
  const A = tokens(a); const B = tokens(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter += 1;
  return inter / (A.size + B.size - inter);
}

/**
 * product:   { gtin, sku, mpn, brand, model, name, attributes: { marketplaceIds?: {amazon: …}, knownUrls?: [] } }
 * candidate: { marketplace, marketplace_product_id, source_url, identifiers: { gtin, sku, mpn, brand, model }, title, brand, model }
 */
function matchProduct(product, candidate) {
  const pid = { gtin: product.gtin ? normalizeGtin(product.gtin) : null, mpn: norm(product.mpn), brand: norm(product.brand), model: norm(product.model), sku: norm(product.sku) };
  const ci = candidate.identifiers || {};
  const cid = {
    gtin: ci.gtin ? normalizeGtin(ci.gtin) : null,
    mpn: norm(ci.mpn), brand: norm(ci.brand || candidate.brand), model: norm(ci.model || candidate.model), sku: norm(ci.sku),
  };
  const conflicts = [];
  const signals = [];
  const pGtinOk = pid.gtin && validGtin(pid.gtin);
  const cGtinOk = cid.gtin && validGtin(cid.gtin);
  if (pGtinOk && cGtinOk) {
    if (pid.gtin === cid.gtin) signals.push({ method: 'gtin', confidence: 0.99 });
    else conflicts.push('gtin');
  }
  if (pid.brand && cid.brand && pid.brand !== cid.brand && !pid.brand.includes(cid.brand) && !cid.brand.includes(pid.brand)) conflicts.push('brand');
  if (pid.mpn && cid.mpn && pid.brand && cid.brand && pid.brand === cid.brand && pid.mpn !== cid.mpn) conflicts.push('mpn');

  const attrs = product.attributes || {};
  const mpIds = attrs.marketplaceIds && typeof attrs.marketplaceIds === 'object' ? attrs.marketplaceIds : {};
  if (candidate.marketplace_product_id && mpIds[candidate.marketplace] && norm(mpIds[candidate.marketplace]) === norm(candidate.marketplace_product_id)) {
    signals.push({ method: 'marketplace_id', confidence: 0.97 });
  }
  const known = Array.isArray(attrs.knownUrls) ? attrs.knownUrls.map(normUrl).filter(Boolean) : [];
  if (candidate.source_url && known.includes(normUrl(candidate.source_url))) signals.push({ method: 'url', confidence: 0.97 });
  if (pid.brand && cid.brand && pid.brand === cid.brand && pid.mpn && cid.mpn && pid.mpn === cid.mpn) signals.push({ method: 'brand_mpn', confidence: 0.95 });
  if (pid.brand && cid.brand && pid.brand === cid.brand && pid.model && cid.model && pid.model === cid.model) signals.push({ method: 'brand_model', confidence: 0.85 });
  if (pid.sku && cid.sku && pid.sku === cid.sku) signals.push({ method: 'sku', confidence: 0.7 });
  const title = candidate.title || '';
  if (title && product.name) {
    const sim = jaccard(product.name, title);
    const brandBoost = pid.brand && tokens(title).has(String(product.brand).toLowerCase()) ? 0.1 : 0;
    const c = Math.min(0.6, Math.round((sim * 0.5 + brandBoost) * 1000) / 1000);
    if (c > 0) signals.push({ method: 'title', confidence: c, similarity: Math.round(sim * 1000) / 1000 });
  }
  const best = signals.reduce((a, b) => (b.confidence > a.confidence ? b : a), { method: null, confidence: 0 });
  const evidence = {
    signals, conflicts,
    compared: {
      product: { gtin: pid.gtin, mpn: product.mpn || null, brand: product.brand || null, model: product.model || null },
      candidate: { gtin: cid.gtin, mpn: ci.mpn || null, brand: ci.brand || candidate.brand || null, model: ci.model || candidate.model || null, marketplaceProductId: candidate.marketplace_product_id || null },
    },
  };
  if (conflicts.length) return { status: 'UNVERIFIED', confidence: 0, method: `conflict:${conflicts.join('+')}`, evidence };
  return { status: best.confidence >= 0.95 ? 'VERIFIED' : 'UNVERIFIED', confidence: best.confidence, method: best.method, evidence };
}

module.exports = { matchProduct, jaccard, normUrl };
