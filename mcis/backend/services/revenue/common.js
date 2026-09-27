/**
 * Layer 10 — shared helpers for the revenue services: context checks,
 * input validation, an in-process event bus (alerts, recommendations,
 * webhooks subscribe to monitoring / execution / QA events) and a
 * bounded-concurrency helper.
 */
'use strict';

const { WorkspaceError, hasRole } = require('../workspaceService');
const { sanitizeString } = require('../security/sensitiveClassifier');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const bad = (message, code = 'BAD_REQUEST') => new WorkspaceError(400, code, message);
const notFound = (what = 'Resource') => new WorkspaceError(404, 'NOT_FOUND', `${what} not found`);
const conflict = (message, code = 'CONFLICT') => new WorkspaceError(409, code, message);
const forbidden = (message) => new WorkspaceError(403, 'FORBIDDEN', message);

function requireCtx(ctx) {
  if (!ctx || !ctx.workspace || !ctx.workspace.id || !ctx.userId) throw new WorkspaceError(401, 'AUTH_REQUIRED', 'Authentication required');
  return ctx.workspace.id;
}
function requireAdmin(ctx, what = 'this') {
  if (!hasRole(ctx.role, 'admin')) throw forbidden(`Only a workspace admin or owner can change ${what}.`);
}
const isUuid = (v) => typeof v === 'string' && UUID_RE.test(v);
function uuidOr404(v, what) { if (!isUuid(v)) throw notFound(what); return v; }

function str(v, field, { min = 1, max = 200, optional = false } = {}) {
  if (v === undefined || v === null || v === '') {
    if (optional) return null;
    throw bad(`${field} is required`);
  }
  if (typeof v !== 'string') throw bad(`${field} must be a string`);
  const s = v.trim();
  if (s.length < min || s.length > max) throw bad(`${field} must be ${min}-${max} characters`);
  return sanitizeString(s, max);
}
function int(v, field, { min, max, dflt }) {
  if (v === undefined || v === null) return dflt;
  if (!Number.isInteger(v) || v < min || v > max) throw bad(`${field} must be an integer ${min}-${max}`);
  return v;
}
function num(v, field, { min = 0, max = 1e12, optional = true } = {}) {
  if (v === undefined || v === null || v === '') { if (optional) return null; throw bad(`${field} is required`); }
  const n = typeof v === 'string' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isFinite(n) || n < min || n > max) throw bad(`${field} must be a number ${min}-${max}`);
  return Math.round(n * 10000) / 10000;
}
function oneOf(v, field, options, dflt) {
  if (v === undefined || v === null) { if (dflt !== undefined) return dflt; throw bad(`${field} is required`); }
  if (!options.includes(v)) throw bad(`${field} must be one of ${options.join(', ')}`);
  return v;
}
function onlyKeys(obj, keys, field = 'body') {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw bad(`${field} must be an object`);
  for (const k of Object.keys(obj)) if (!keys.includes(k)) throw bad(`unknown field "${k}" in ${field}`);
  return obj;
}
const dbNum = (v) => (v === null || v === undefined ? null : Number(v));

/** In-process event bus. Handlers never break the emitter. */
function createEventBus({ logger = console } = {}) {
  const handlers = new Map();
  return {
    on(type, fn) {
      if (!handlers.has(type)) handlers.set(type, []);
      handlers.get(type).push(fn);
    },
    async emit(type, payload) {
      for (const fn of [...(handlers.get(type) || []), ...(handlers.get('*') || [])]) {
        try { await fn(payload, type); } catch (err) { logger.error?.(`[events] ${type} handler failed: ${err.code || err.name}`); }
      }
    },
  };
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); }
  });
  await Promise.all(workers);
  return out;
}

module.exports = {
  UUID_RE, bad, notFound, conflict, forbidden, requireCtx, requireAdmin, isUuid, uuidOr404, str, int, num, oneOf, onlyKeys, dbNum,
  createEventBus, mapLimit, hasRole, WorkspaceError,
};
