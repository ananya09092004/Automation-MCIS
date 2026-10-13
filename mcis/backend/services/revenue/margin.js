/**
 * Layer 10 — margin math (pure). Nothing is ever assumed: a margin is
 * `complete` only when the product has a cost AND explicitly configured
 * fees (0 is a valid configuration; "not set" is not), and the price is in
 * the product's currency. Otherwise the result lists what is missing.
 */
'use strict';

const r2 = (n) => Math.round(n * 100) / 100;
const num = (v) => (v === null || v === undefined ? null : Number(v));

function missingInputs(product, price, currency) {
  const missing = [];
  if (num(product.cost) === null) missing.push('cost');
  if (num(product.fees_fixed) === null && num(product.fees_pct) === null) missing.push('fees');
  if (typeof price !== 'number' || !Number.isFinite(price) || price <= 0) missing.push('price');
  if (currency && product.currency && currency !== product.currency) missing.push('currency_mismatch');
  return missing;
}

/** Margin if the product sold at `price`. */
function marginAt(product, price, currency = null) {
  const missing = missingInputs(product, price, currency);
  if (missing.length) return { complete: false, missing, price: typeof price === 'number' ? price : null };
  const cost = num(product.cost);
  const fees = (num(product.fees_fixed) || 0) + ((num(product.fees_pct) || 0) / 100) * price;
  const profit = price - cost - fees;
  return { complete: true, price: r2(price), cost: r2(cost), fees: r2(fees), profit: r2(profit), marginPct: r2((profit / price) * 100), currency: product.currency };
}

/** Lowest price that still earns `marginPct` (null if impossible or inputs missing). */
function priceForMargin(product, marginPct) {
  if (marginPct === null || marginPct === undefined) return null;
  const cost = num(product.cost);
  if (cost === null || (num(product.fees_fixed) === null && num(product.fees_pct) === null)) return null;
  const denom = 1 - (num(product.fees_pct) || 0) / 100 - Number(marginPct) / 100;
  if (denom <= 0) return null;
  return r2((cost + (num(product.fees_fixed) || 0)) / denom);
}

/**
 * Margin impact of the competitive position.
 * ownPrice: { value, source: 'configured'|'monitor', fresh }
 * competitorPrices: [{ competitorId, name, price, currency, fresh, verification }]
 */
function marginImpact(product, ownPrice, competitorPrices) {
  const usable = competitorPrices.filter((c) => c.fresh && typeof c.price === 'number' && (!c.currency || c.currency === product.currency));
  const lowest = usable.length ? usable.reduce((a, b) => (b.price < a.price ? b : a)) : null;
  const own = ownPrice && typeof ownPrice.value === 'number' ? ownPrice.value : null;
  const atOwn = own !== null ? marginAt(product, own, product.currency) : { complete: false, missing: ['price'] };
  const atLowest = lowest ? marginAt(product, lowest.price, lowest.currency || product.currency) : null;
  const minM = num(product.min_margin_pct);
  const target = num(product.target_margin_pct);
  return {
    currency: product.currency,
    ownPrice: own,
    ownPriceSource: ownPrice ? ownPrice.source : null,
    lowestCompetitor: lowest ? { competitorId: lowest.competitorId, name: lowest.name, price: lowest.price } : null,
    priceGap: own !== null && lowest ? r2(own - lowest.price) : null,
    priceGapPct: own !== null && lowest && lowest.price > 0 ? r2(((own - lowest.price) / lowest.price) * 100) : null,
    marginAtOwnPrice: atOwn,
    marginIfMatchLowest: atLowest,
    minMarginPct: minM,
    targetMarginPct: target,
    floorPrice: priceForMargin(product, minM),
    targetPrice: priceForMargin(product, target),
    matchWouldBreachMinimum: atLowest && atLowest.complete && minM !== null ? atLowest.marginPct < minM : null,
    excludedCompetitors: competitorPrices.length - usable.length,
  };
}

module.exports = { marginAt, marginImpact, priceForMargin, missingInputs };
