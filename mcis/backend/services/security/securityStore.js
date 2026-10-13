/**
 * Layer 6 — Supabase persistence for security policies, workspace API
 * keys, OAuth states, rate-limit counters and security-event reads.
 * Tables/RPCs: migrations/20260928_layer6_security.up.sql
 *
 * Every workspace query is filtered by workspace_id. API-key rows carry
 * only a SHA-256 hash; OAuth states only a SHA-256 hash of the state.
 */
'use strict';

const { createClient } = require('@supabase/supabase-js');

let client = null;
function db() {
  if (!client) client = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
  return client;
}
function unwrap({ data, error }) {
  if (error) {
    const err = new Error(error.message || 'Database error');
    err.code = error.code;
    err.dbError = true;
    throw err;
  }
  return data;
}
const first = (rows) => (Array.isArray(rows) ? rows[0] || null : rows || null);
const nowIso = () => new Date().toISOString();
const KEY_COLS = 'id, workspace_id, name, prefix, key_hash, scopes, workflow_ids, created_by, created_at, expires_at, last_used_at, revoked_at, revoked_by, rotated_from';

function createSupabaseSecurityStore() {
  return {
    // ---------------- policy ----------------
    async getPolicy(workspaceId) {
      return first(unwrap(await db().from('workspace_security_policies').select('*').eq('workspace_id', workspaceId).limit(1)));
    },
    /** CAS: expectedVersion 0 = create (fails if a row exists). Returns the row or null on conflict. */
    async savePolicy(workspaceId, expectedVersion, policy, updatedBy) {
      if (expectedVersion === 0) {
        const { data, error } = await db().from('workspace_security_policies')
          .insert({ workspace_id: workspaceId, version: 1, policy, updated_by: updatedBy }).select('*');
        if (error && error.code === '23505') return null;
        return first(unwrap({ data, error }));
      }
      return first(unwrap(await db().from('workspace_security_policies')
        .update({ policy, version: expectedVersion + 1, updated_by: updatedBy, updated_at: nowIso() })
        .eq('workspace_id', workspaceId).eq('version', expectedVersion).select('*')));
    },

    // ---------------- API keys ----------------
    async insertApiKey(row) {
      return unwrap(await db().from('workspace_api_keys').insert(row).select(KEY_COLS).single());
    },
    async getApiKeyByPrefix(prefix) {
      return first(unwrap(await db().from('workspace_api_keys').select(KEY_COLS).eq('prefix', prefix).limit(1)));
    },
    async getApiKey(workspaceId, id) {
      return first(unwrap(await db().from('workspace_api_keys').select(KEY_COLS).eq('workspace_id', workspaceId).eq('id', id).limit(1)));
    },
    async listApiKeys(workspaceId) {
      return unwrap(await db().from('workspace_api_keys').select(KEY_COLS).eq('workspace_id', workspaceId).order('created_at', { ascending: false }).limit(200));
    },
    /** Revokes only a key that is not revoked yet (single transition). */
    async revokeApiKey(workspaceId, id, revokedBy) {
      return first(unwrap(await db().from('workspace_api_keys').update({ revoked_at: nowIso(), revoked_by: revokedBy })
        .eq('workspace_id', workspaceId).eq('id', id).is('revoked_at', null).select(KEY_COLS)));
    },
    async touchApiKey(workspaceId, id) {
      unwrap(await db().from('workspace_api_keys').update({ last_used_at: nowIso() }).eq('workspace_id', workspaceId).eq('id', id));
    },

    // ---------------- OAuth state ----------------
    async insertOAuthState(row) {
      unwrap(await db().from('oauth_states').insert(row));
    },
    async consumeOAuthState(stateHash) {
      return first(unwrap(await db().rpc('consume_oauth_state', { p_state_hash: stateHash })));
    },

    // ---------------- rate limits ----------------
    async rateLimitHit(bucket, windowSeconds, limit) {
      return unwrap(await db().rpc('security_rate_limit_hit', { p_bucket: bucket, p_window_seconds: windowSeconds, p_limit: limit })) === true;
    },
    async rateLimitPeek(bucket, windowSeconds) {
      const w = new Date(Math.floor(Date.now() / 1000 / windowSeconds) * windowSeconds * 1000).toISOString();
      const row = first(unwrap(await db().from('security_rate_limits').select('hits').eq('bucket', bucket).eq('window_start', w).limit(1)));
      return row ? row.hits : 0;
    },

    // ---------------- security events (audit_log, workspace-scoped) ----------------
    async listSecurityEvents(workspaceId, { limit = 50 } = {}) {
      return unwrap(await db().from('audit_log').select('id, user_id, action, payload, success, error, created_at')
        .eq('workspace_id', workspaceId).like('action', 'security.%')
        .order('created_at', { ascending: false }).limit(Math.min(Math.max(limit, 1), 200)));
    },
  };
}

module.exports = { createSupabaseSecurityStore };
