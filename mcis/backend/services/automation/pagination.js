/**
 * Layer 9 — keyset pagination for list endpoints (newest first).
 *
 * The cursor is opaque to clients: base64url of "<created_at ISO>|<uuid>" of
 * the last item of the previous page. It is validated strictly; it carries
 * no workspace (the workspace always comes from the caller's context), so a
 * cursor from another workspace can only select rows of the CALLER's
 * workspace older than that point.
 */
'use strict';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/;

class PaginationError extends Error {
  constructor(message) { super(message); this.name = 'PaginationError'; this.status = 400; this.code = 'INVALID_CURSOR'; }
}

function encodeCursor(row) {
  if (!row || !row.created_at || !row.id) return null;
  return Buffer.from(`${new Date(row.created_at).toISOString()}|${row.id}`, 'utf8').toString('base64url');
}

function decodeCursor(cursor) {
  if (cursor === undefined || cursor === null || cursor === '') return null;
  if (typeof cursor !== 'string' || cursor.length > 200 || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw new PaginationError('Invalid cursor.');
  const raw = Buffer.from(cursor, 'base64url').toString('utf8');
  const [t, id, extra] = raw.split('|');
  if (extra !== undefined || !ISO_RE.test(t || '') || Number.isNaN(Date.parse(t)) || !UUID_RE.test(id || '')) throw new PaginationError('Invalid cursor.');
  return { createdAt: new Date(t).toISOString(), id: id.toLowerCase() };
}

function parseLimit(v, def = 20, max = 100) {
  if (v === undefined || v === null || v === '') return def;
  const n = typeof v === 'number' ? v : (/^\d+$/.test(String(v)) ? Number(v) : NaN);
  if (!Number.isInteger(n) || n < 1 || n > max) {
    const e = new PaginationError(`limit must be between 1 and ${max}.`);
    e.code = 'INVALID_LIMIT';
    throw e;
  }
  return n;
}

/** Rows newer-first → page of `limit` + next cursor (fetch limit+1 rows). */
function page(rows, limit, view) {
  const more = rows.length > limit;
  const items = rows.slice(0, limit);
  return { items: items.map(view), nextCursor: more ? encodeCursor(items[items.length - 1]) : null };
}

/** In-memory keyset comparison (memory stores): true when row is strictly after the cursor in DESC order. */
function olderThan(row, before) {
  if (!before) return true;
  const a = Date.parse(row.created_at);
  const b = Date.parse(before.createdAt);
  return a < b || (a === b && String(row.id) < before.id);
}

module.exports = { encodeCursor, decodeCursor, parseLimit, page, olderThan, PaginationError };
