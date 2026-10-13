/**
 * Layer 2 — request-scoped workspace data scope.
 *
 * middleware/workspaceDataScope.js resolves (server-side, from the verified
 * Firebase uid + Layer 1 membership) which workspace a request operates in
 * and runs the rest of the request inside an AsyncLocalStorage scope.
 * Data-access code (services/database.js, services/memory.js,
 * memoryManager, goals) calls the helpers below, so existing function
 * signatures — and every caller outside a scoped request — stay unchanged.
 *
 * Semantics
 *   scope = { userId, workspaceId, isPersonal, role }
 *   - team workspace:     rows with workspace_id = W
 *   - personal workspace: rows with workspace_id = P  OR  workspace_id IS NULL
 *     (NULL = legacy rows and rows written by unscoped callers such as the
 *     voice pipeline, which is deliberately untouched)
 *   - no scope (voice, jobs, dev-bypass): legacy behaviour, no filter, and
 *     writes leave workspace_id NULL.
 *
 * The workspace id in a scope ALWAYS comes from the server (membership
 * check), never from the client, and is validated as a UUID before it is
 * interpolated into a PostgREST filter.
 */
'use strict';

const { AsyncLocalStorage } = require('async_hooks');

const als = new AsyncLocalStorage();
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function runWithScope(scope, fn) {
  if (!scope || !UUID_RE.test(String(scope.workspaceId)) || !scope.userId) {
    throw new Error('runWithScope: invalid scope');
  }
  return als.run(Object.freeze({
    userId: String(scope.userId),
    workspaceId: String(scope.workspaceId),
    isPersonal: !!scope.isPersonal,
    role: scope.role || null,
  }), fn);
}

function currentScope() {
  return als.getStore() || null;
}

/** Adds the workspace filter to a supabase-js query builder. */
function applyScope(query, scope = currentScope()) {
  if (!scope) return query;
  if (!UUID_RE.test(scope.workspaceId)) throw new Error('invalid workspace scope');
  return scope.isPersonal
    ? query.or(`workspace_id.eq.${scope.workspaceId},workspace_id.is.null`)
    : query.eq('workspace_id', scope.workspaceId);
}

/** Fields to merge into an INSERT so the row belongs to the scope's workspace. */
function scopeFields(scope = currentScope()) {
  return scope ? { workspace_id: scope.workspaceId } : {};
}

/** In-memory check with the same semantics as applyScope(). */
function rowInScope(row, scope = currentScope()) {
  if (!scope) return true;
  if (!row) return false;
  const ws = row.workspace_id ?? null;
  return ws === scope.workspaceId || (scope.isPersonal && ws === null);
}

/** True when the row is owned by the scope's user AND is in its workspace. */
function ownedInScope(row, scope = currentScope()) {
  if (!scope) return !!row;
  return !!row && String(row.user_id) === scope.userId && rowInScope(row, scope);
}

module.exports = { runWithScope, currentScope, applyScope, scopeFields, rowInScope, ownedInScope, UUID_RE };
