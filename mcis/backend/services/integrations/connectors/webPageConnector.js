/**
 * Layer 10 — public web page / JSON document connector (provider "web_page").
 * READ-ONLY. Used by monitoring (competitor prices, stock, page values) and
 * available to workflows like any other connector.
 *
 * NOT an open proxy: an admin lists the hosts the integration may read
 * (exact names or "*.suffix"). Requests go through the SSRF-safe client
 * (public addresses only, DNS pinning, redirect re-validation against the
 * same allowlist, size / time / content-type limits).
 *
 * Privacy / cost: raw page content is NEVER returned. `fetch_product`
 * returns only structured fields published by the site (schema.org JSON-LD,
 * microdata, product meta tags, Shopify storefront JSON) plus a content hash;
 * `fetch_json` returns only the JSON Pointer fields configured in the call.
 *
 * Actions           risk    retry
 *   fetch_product   GREEN   safe (read-only)
 *   fetch_json      GREEN   safe (read-only)
 *
 * Site terms: many marketplaces forbid automated access to their pages; use
 * sources you are permitted to read (your own store, partner feeds, sites
 * that allow it) or their official APIs through the HTTP connector. A source
 * that blocks access shows up as UNAVAILABLE — never as fabricated data.
 */
'use strict';

const crypto = require('crypto');
const { validateInput, InputError, ConnectorError } = require('./schema');
const { isInternalHostname, hostAllowed } = require('../safeHttp');
const { extractProduct, fromJsonPaths } = require('../../monitoring/extract');
const { redact } = require('../../../backend-routing/sensitiveDataFilter');

const HOST_RE = /^(\*\.)?([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const URL_FIELD = { type: 'string', required: true, maxLength: 2000, pattern: /^https?:\/\/[^\s]+$/, description: 'Page or JSON URL on an allowed host' };
const bad = (m) => { throw new InputError(m); };

function validateConfig(raw = {}) {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) bad('config must be an object');
  for (const k of Object.keys(raw)) if (!['allowedHosts', 'defaultCurrency', 'maxResponseKb'].includes(k)) bad(`unknown config "${k}"`);
  const hosts = raw.allowedHosts;
  if (!Array.isArray(hosts) || !hosts.length || hosts.length > 50) bad('config.allowedHosts must list 1-50 hostnames (e.g. shop.example.com or *.example.com)');
  const out = [];
  for (const h of hosts) {
    const v = String(h).toLowerCase().trim();
    if (!HOST_RE.test(v) || isInternalHostname(v.replace(/^\*\./, ''))) bad(`config.allowedHosts: "${String(h).slice(0, 80)}" is not a public hostname`);
    if (!out.includes(v)) out.push(v);
  }
  let defaultCurrency = null;
  if (raw.defaultCurrency !== undefined && raw.defaultCurrency !== null) {
    if (typeof raw.defaultCurrency !== 'string' || !/^[A-Z]{3}$/.test(raw.defaultCurrency)) bad('config.defaultCurrency must be an ISO currency code such as INR');
    defaultCurrency = raw.defaultCurrency;
  }
  const maxResponseKb = raw.maxResponseKb === undefined ? 2048 : raw.maxResponseKb;
  if (!Number.isInteger(maxResponseKb) || maxResponseKb < 16 || maxResponseKb > 4096) bad('config.maxResponseKb must be 16-4096');
  return { allowedHosts: out, defaultCurrency, maxResponseKb };
}

function checkUrl(raw, config, { allowInsecureHttpForTests }) {
  let u;
  try { u = new URL(raw); } catch { throw new InputError('url must be a valid URL'); }
  const schemeOk = u.protocol === 'https:' || (allowInsecureHttpForTests && u.protocol === 'http:');
  if (!schemeOk || u.username || u.password || (u.port && !allowInsecureHttpForTests)) throw new InputError('url must be a plain https URL');
  if (!hostAllowed(u.hostname.toLowerCase(), config.allowedHosts)) throw new InputError(`Host ${u.hostname} is not on this integration's allowlist`);
  u.hash = '';
  return u;
}

const ACTIONS = {
  fetch_product: {
    label: 'Read product data', description: 'Price, currency, stock, seller and identifiers from the structured data a product page publishes.',
    risk: 'green', readOnly: true, defaultEnabled: true, permission: 'web:read',
    fields: {
      url: URL_FIELD,
      sku: { type: 'string', maxLength: 100, description: 'Pick this SKU when the page lists several variants' },
      variant_id: { type: 'string', maxLength: 40, pattern: /^[0-9A-Za-z_-]{1,40}$/, description: 'Shopify variant id' },
    },
    output: '{ httpStatus, found, notFound, method, fields, contentHash }',
  },
  fetch_json: {
    label: 'Read JSON values', description: 'Selected values (JSON Pointers) from a public JSON document.',
    risk: 'green', readOnly: true, defaultEnabled: true, permission: 'web:read',
    fields: {
      url: URL_FIELD,
      fields: { type: 'object', required: true, stringValues: true, maxKeys: 20, description: 'name → JSON Pointer, e.g. { "price": "/data/price" }' },
    },
    output: '{ httpStatus, values, contentHash }',
  },
};
for (const a of Object.values(ACTIONS)) {
  a.safeToRepeat = () => true;
  a.timeoutMs = 20000;
  a.retry = 'Safe to retry (read-only).';
}

function statusError(status) {
  if (status === 429) return new ConnectorError('RATE_LIMITED', 'The site rate limit was reached (HTTP 429)', { retryable: true });
  if (status === 401 || status === 403) return new ConnectorError('ACCESS_BLOCKED', `The site refused automated access (HTTP ${status})`);
  if (status >= 500) return new ConnectorError('PROVIDER_ERROR', `The site returned HTTP ${status}`, { retryable: true });
  return new ConnectorError(`HTTP_${status}`, `The site returned HTTP ${status}`);
}

/** `allowInsecureHttpForTests` exists ONLY for the local test double; production never sets it. */
function createWebPageConnector({ allowInsecureHttpForTests = false } = {}) {
  const opts = { allowInsecureHttpForTests };
  async function get(http, url, config, accept) {
    const res = await http.request({
      url: url.toString(), method: 'GET', allowedMethods: ['GET'], allowedHosts: config.allowedHosts,
      headers: { Accept: accept, 'User-Agent': 'NexusMonitor/1.0 (+structured-data reader)' },
      timeoutMs: 15000, maxBytes: config.maxResponseKb * 1024, maxRedirects: 3,
      allowedContentTypes: ['text/html', 'application/xhtml+xml', 'application/json', 'application/ld+json', 'text/javascript', 'application/javascript', 'text/plain'],
    });
    return res;
  }
  const hash = (s) => crypto.createHash('sha256').update(String(s || '')).digest('hex');
  return {
    provider: 'web_page',
    displayName: 'Web pages (read-only)',
    description: 'Read structured product data and JSON values from public pages on hosts you approve.',
    credentialFields: [],
    actions: ACTIONS,
    validateConfig,
    validateCredential: (raw) => { if (raw && Object.keys(raw).length) bad('This integration takes no credential'); return null; },
    requiresCredential: () => false,
    connect({ config }) { return { config: validateConfig(config), credential: null }; },
    disconnect() {},
    validateAction(action, input, config) {
      const a = ACTIONS[action];
      if (!a) throw new InputError(`Action "${action}" is not available for this integration`);
      const v = validateInput(a.fields, input);
      checkUrl(v.url, config, opts);
      if (action === 'fetch_json') {
        for (const [k, p] of Object.entries(v.fields)) {
          if (!/^[a-z][a-z0-9_]{0,59}$/.test(k) || typeof p !== 'string' || !/^\/[^\s]{0,200}$/.test(p)) throw new InputError('fields must map simple names to JSON Pointers like /data/price');
        }
      }
      return v;
    },
    describeTarget(action, input, config) {
      const u = checkUrl(input.url, config, opts);
      return `GET ${u.host}${u.pathname}`;
    },
    async healthCheck() { return { ok: true, detail: 'no credential; each request is checked against the host allowlist' }; },
    async execute({ action, input, config, http }) {
      const u = checkUrl(input.url, config, opts);
      if (action === 'fetch_product') {
        const res = await get(http, u, config, 'text/html,application/xhtml+xml,application/json;q=0.9');
        if (res.status === 404 || res.status === 410) {
          return { data: { httpStatus: res.status, found: false, notFound: true, method: null, fields: null, contentHash: null }, summary: `Product page gone (HTTP ${res.status})`, verified: true };
        }
        if (res.status < 200 || res.status >= 300) throw statusError(res.status);
        const ex = extractProduct({ body: res.body, contentType: res.contentType }, { sku: input.sku || null, variantId: input.variant_id || null });
        return {
          data: { httpStatus: res.status, found: ex.found, notFound: false, method: ex.method, fields: ex.fields, contentHash: hash(res.body), defaultCurrency: config.defaultCurrency },
          summary: ex.found ? `Read product data (${ex.method}) from ${u.host}` : `No structured product data on ${u.host}${u.pathname}`,
          verified: ex.found,
        };
      }
      if (action === 'fetch_json') {
        const res = await get(http, u, config, 'application/json');
        if (res.status < 200 || res.status >= 300) throw statusError(res.status);
        let json;
        try { json = JSON.parse(res.body); } catch { throw new ConnectorError('INVALID_RESPONSE', 'The document is not JSON'); }
        const values = fromJsonPaths(json, input.fields);
        return { data: { httpStatus: res.status, values, contentHash: hash(res.body) }, summary: values ? `Read ${Object.keys(values).length} value(s) from ${u.host}` : 'None of the requested fields were present', verified: !!values };
      }
      throw new InputError(`Action "${action}" is not available`);
    },
    redactResult(data) { return redact(data); },
  };
}

module.exports = { createWebPageConnector, validateConfig };
