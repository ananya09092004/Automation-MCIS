/**
 * Layer 10 — deterministic structured extraction for monitoring.
 *
 * Nothing here calls an LLM or keeps raw page content: a fetched page is
 * reduced to a small set of typed fields taken from machine-readable
 * markup the site itself publishes:
 *
 *   json-ld    <script type="application/ld+json"> schema.org Product / Offer
 *   microdata  itemprop="price|priceCurrency|availability|sku|gtin…"
 *   meta       <meta property="product:price:amount" …> / og:price:*
 *   shopify    Shopify storefront product JSON (/products/<handle>.js or .json)
 *   json_paths JSON Pointer fields configured by the workspace admin
 *
 * If none is present the result is `found:false, method:null` and the
 * caller records the check as UNAVAILABLE (NO_STRUCTURED_DATA) — values are
 * never guessed from free text.
 */
'use strict';

const MAX_SCRIPTS = 20;
const MAX_SCRIPT_BYTES = 200 * 1024;

const decodeEntities = (s) => String(s)
  .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&#(\d{1,6});/g, (_, n) => { const c = Number(n); return c > 0 && c < 0x110000 ? String.fromCodePoint(c) : ''; })
  .replace(/&amp;/g, '&');

function attr(tag, name) {
  const m = new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag);
  if (!m) return null;
  return decodeEntities(m[2] ?? m[3] ?? m[4] ?? '');
}

const asArray = (v) => (Array.isArray(v) ? v : v === undefined || v === null ? [] : [v]);
const typeIs = (node, t) => asArray(node && node['@type']).some((x) => String(x).toLowerCase() === t.toLowerCase());
const textOf = (v) => {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string' || typeof v === 'number') return String(v).trim().slice(0, 300) || null;
  if (typeof v === 'object' && v.name) return textOf(v.name);
  return null;
};

function productNodes(json) {
  const out = [];
  const visit = (n, depth) => {
    if (!n || typeof n !== 'object' || depth > 6 || out.length > 20) return;
    if (Array.isArray(n)) { n.forEach((x) => visit(x, depth + 1)); return; }
    if (typeIs(n, 'Product') || typeIs(n, 'ProductGroup')) out.push(n);
    if (n['@graph']) visit(n['@graph'], depth + 1);
    if (n.mainEntity) visit(n.mainEntity, depth + 1);
  };
  visit(json, 0);
  return out;
}

function offerOf(product, { sku = null } = {}) {
  let offers = asArray(product.offers);
  // ProductGroup: variants carry their own offers
  if (!offers.length && product.hasVariant) {
    const variants = asArray(product.hasVariant);
    const v = (sku && variants.find((x) => textOf(x.sku) === sku)) || variants[0];
    if (v) offers = asArray(v.offers);
  }
  const flat = [];
  for (const o of offers) {
    if (typeIs(o, 'AggregateOffer')) {
      if (o.offers) flat.push(...asArray(o.offers));
      else flat.push({ price: o.lowPrice ?? o.price, priceCurrency: o.priceCurrency, availability: o.availability, seller: o.seller, aggregate: true });
    } else flat.push(o);
  }
  if (!flat.length) return null;
  const chosen = (sku && flat.find((o) => textOf(o.sku) === sku)) || flat[0];
  const spec = asArray(chosen.priceSpecification);
  const listSpec = spec.find((s) => /ListPrice|StrikethroughPrice|MSRP/i.test(String(s.priceType || '')));
  return {
    price: chosen.price ?? (spec[0] && spec[0].price) ?? null,
    currency: chosen.priceCurrency ?? (spec[0] && spec[0].priceCurrency) ?? null,
    listPrice: listSpec ? listSpec.price : null,
    availability: chosen.availability ?? null,
    seller: textOf(chosen.seller) ?? null,
    aggregate: !!chosen.aggregate,
  };
}

function fromJsonLd(html, opts) {
  const re = /<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  let n = 0;
  while ((m = re.exec(html)) && n < MAX_SCRIPTS) {
    n += 1;
    const body = m[1].slice(0, MAX_SCRIPT_BYTES).trim();
    let json;
    try { json = JSON.parse(body); } catch { continue; }
    for (const p of productNodes(json)) {
      const offer = offerOf(p, opts);
      if (!offer && !p.name) continue;
      return {
        title: textOf(p.name),
        brand: textOf(p.brand),
        sku: textOf(p.sku),
        gtin: textOf(p.gtin13 || p.gtin14 || p.gtin12 || p.gtin8 || p.gtin),
        mpn: textOf(p.mpn),
        model: textOf(p.model),
        price: offer ? offer.price : null,
        currency: offer ? offer.currency : null,
        listPrice: offer ? offer.listPrice : null,
        availability: offer ? offer.availability : null,
        seller: offer ? offer.seller : null,
        aggregateOffer: offer ? offer.aggregate : false,
      };
    }
  }
  return null;
}

function metaMap(html) {
  const map = {};
  const re = /<meta\b[^>]*>/gi;
  let m;
  let n = 0;
  while ((m = re.exec(html)) && n < 500) {
    n += 1;
    const tag = m[0];
    const key = (attr(tag, 'property') || attr(tag, 'name') || attr(tag, 'itemprop') || '').toLowerCase();
    const val = attr(tag, 'content');
    if (key && val !== null && !(key in map)) map[key] = val.slice(0, 300);
  }
  return map;
}

function fromMeta(html) {
  const mm = metaMap(html);
  const price = mm['product:price:amount'] || mm['og:price:amount'] || mm['product:sale_price:amount'];
  if (price === undefined) return null;
  return {
    title: mm['og:title'] || null,
    brand: mm['product:brand'] || null,
    sku: mm['product:retailer_item_id'] || null,
    gtin: mm['product:gtin'] || mm['product:ean'] || null,
    mpn: mm['product:mfr_part_no'] || null,
    price,
    currency: mm['product:price:currency'] || mm['og:price:currency'] || null,
    listPrice: mm['product:original_price:amount'] || null,
    availability: mm['product:availability'] || mm['og:availability'] || null,
    seller: null,
  };
}

function fromMicrodata(html) {
  const get = (prop) => {
    const re = new RegExp(`<[a-z][^>]*\\bitemprop\\s*=\\s*["']${prop}["'][^>]*>`, 'i');
    const m = re.exec(html);
    if (!m) return null;
    const tag = m[0];
    return attr(tag, 'content') ?? attr(tag, 'href') ?? null;
  };
  const price = get('price');
  if (price === null) return null;
  return {
    title: get('name'), brand: get('brand'), sku: get('sku'), gtin: get('gtin13') || get('gtin'), mpn: get('mpn'),
    price, currency: get('priceCurrency'), listPrice: null, availability: get('availability'), seller: null,
  };
}

/** Shopify storefront product JSON. `.js` prices are in minor units; `.json` prices are decimal strings. */
function fromShopify(json, { variantId = null, sku = null } = {}) {
  const p = json && (json.product || json);
  if (!p || typeof p !== 'object' || !Array.isArray(p.variants) || !p.variants.length) return null;
  const v = (variantId && p.variants.find((x) => String(x.id) === String(variantId)))
    || (sku && p.variants.find((x) => x.sku === sku)) || p.variants[0];
  const minor = json.product ? false : Number.isInteger(v.price); // .js format
  const conv = (x) => (x === null || x === undefined || x === '' ? null : (minor ? Number(x) / 100 : x));
  return {
    title: textOf(p.title),
    brand: textOf(p.vendor),
    sku: textOf(v.sku),
    gtin: textOf(v.barcode),
    mpn: null,
    price: conv(v.price),
    currency: null,
    listPrice: conv(v.compare_at_price),
    availability: typeof v.available === 'boolean' ? (v.available ? 'InStock' : 'OutOfStock') : null,
    seller: textOf(p.vendor),
    variantId: v.id !== undefined ? String(v.id) : null,
  };
}

/** RFC 6901 JSON Pointer (read-only). */
function pointer(obj, ptr) {
  if (ptr === '' || ptr === '/') return obj;
  if (typeof ptr !== 'string' || !ptr.startsWith('/')) return undefined;
  let cur = obj;
  for (const raw of ptr.slice(1).split('/')) {
    const k = raw.replace(/~1/g, '/').replace(/~0/g, '~');
    if (cur === null || typeof cur !== 'object' || ['__proto__', 'constructor', 'prototype'].includes(k)) return undefined;
    cur = Object.prototype.hasOwnProperty.call(cur, k) ? cur[k] : undefined;
    if (cur === undefined) return undefined;
  }
  return cur;
}

function fromJsonPaths(json, fields) {
  const out = {};
  let any = false;
  for (const [name, ptr] of Object.entries(fields || {})) {
    const v = pointer(json, ptr);
    if (v !== undefined && (v === null || ['string', 'number', 'boolean'].includes(typeof v))) {
      out[name] = typeof v === 'string' ? v.slice(0, 300) : v;
      any = true;
    }
  }
  return any ? out : null;
}

/**
 * Page or JSON document → { found, method, fields }.
 * `contentType` decides the parser; HTML tries json-ld → microdata → meta.
 */
function extractProduct({ body, contentType }, opts = {}) {
  const ct = String(contentType || '').toLowerCase();
  if (ct.includes('json') || /^\s*[{[]/.test(body || '')) {
    let json;
    try { json = JSON.parse(body); } catch { return { found: false, method: null, fields: null }; }
    const s = fromShopify(json, opts);
    if (s) return { found: true, method: 'shopify', fields: s };
    const ld = productNodes(json)[0];
    if (ld) {
      const offer = offerOf(ld, opts);
      return {
        found: true,
        method: 'json-ld',
        fields: { title: textOf(ld.name), brand: textOf(ld.brand), sku: textOf(ld.sku), gtin: textOf(ld.gtin13 || ld.gtin), mpn: textOf(ld.mpn), model: textOf(ld.model), ...(offer || {}) },
      };
    }
    return { found: false, method: null, fields: null };
  }
  const html = String(body || '');
  const ld = fromJsonLd(html, opts);
  if (ld) return { found: true, method: 'json-ld', fields: ld };
  const md = fromMicrodata(html);
  if (md) return { found: true, method: 'microdata', fields: md };
  const mt = fromMeta(html);
  if (mt) return { found: true, method: 'meta', fields: mt };
  return { found: false, method: null, fields: null };
}

module.exports = { extractProduct, fromJsonPaths, pointer, fromShopify, fromJsonLd, fromMeta, fromMicrodata };
