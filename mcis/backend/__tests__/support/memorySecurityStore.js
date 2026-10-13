/**
 * TEST-ONLY in-memory implementation of services/security/securityStore.js.
 * Mirrors migrations/20260928_layer6_security.up.sql:
 *   - policy CAS on version (insert when expectedVersion 0 → null if exists)
 *   - api key prefix / key_hash unique (23505), revoke only once
 *   - consume_oauth_state: single use, unexpired (clock = options.now)
 *   - security_rate_limit_hit: fixed windows, atomic
 * Every method yields to the event loop so concurrent callers interleave.
 */
'use strict';

const tick = () => new Promise((r) => setImmediate(r));
const clone = (o) => (o == null ? null : JSON.parse(JSON.stringify(o)));
const err = (code, message) => Object.assign(new Error(message), { code });

function createMemorySecurityStore({ now = () => new Date(), auditRows = null } = {}) {
  const policies = new Map();
  const keys = new Map();
  const states = new Map();
  const limits = new Map();
  const iso = () => now().toISOString();
  const windowStart = (sec) => Math.floor(now().getTime() / 1000 / sec) * sec;

  return {
    _policies: policies, _keys: keys, _states: states, _limits: limits,
    async getPolicy(ws) { await tick(); return clone(policies.get(ws) || null); },
    async savePolicy(ws, expectedVersion, policy, updatedBy) {
      await tick();
      const cur = policies.get(ws);
      if (expectedVersion === 0) {
        if (cur) return null;
        const row = { workspace_id: ws, version: 1, policy: clone(policy), updated_by: updatedBy, updated_at: iso() };
        policies.set(ws, row);
        return clone(row);
      }
      if (!cur || cur.version !== expectedVersion) return null;
      Object.assign(cur, { policy: clone(policy), version: expectedVersion + 1, updated_by: updatedBy, updated_at: iso() });
      return clone(cur);
    },
    async insertApiKey(row) {
      await tick();
      for (const k of keys.values()) {
        if (k.prefix === row.prefix || k.key_hash === row.key_hash) throw err('23505', 'duplicate key value violates unique constraint');
      }
      if (!/^nxk_[a-z0-9]{12}$/.test(row.prefix) || !/^[0-9a-f]{64}$/.test(row.key_hash)) throw err('23514', 'check constraint');
      const full = { last_used_at: null, revoked_at: null, revoked_by: null, rotated_from: null, expires_at: null, workflow_ids: null, created_at: iso(), ...clone(row) };
      keys.set(full.id, full);
      return clone(full);
    },
    async getApiKeyByPrefix(prefix) { await tick(); return clone([...keys.values()].find((k) => k.prefix === prefix) || null); },
    async getApiKey(ws, id) { await tick(); const k = keys.get(id); return k && k.workspace_id === ws ? clone(k) : null; },
    async listApiKeys(ws) { await tick(); return [...keys.values()].filter((k) => k.workspace_id === ws).map(clone); },
    async revokeApiKey(ws, id, by) {
      await tick();
      const k = keys.get(id);
      if (!k || k.workspace_id !== ws || k.revoked_at) return null;
      Object.assign(k, { revoked_at: iso(), revoked_by: by });
      return clone(k);
    },
    async touchApiKey(ws, id) { await tick(); const k = keys.get(id); if (k && k.workspace_id === ws) k.last_used_at = iso(); },
    async insertOAuthState(row) {
      await tick();
      if ([...states.values()].some((s) => s.state_hash === row.state_hash)) throw err('23505', 'duplicate');
      states.set(row.id, { consumed_at: null, created_at: iso(), ...clone(row) });
    },
    async consumeOAuthState(hash) {
      await tick();
      const s = [...states.values()].find((x) => x.state_hash === hash);
      if (!s || s.consumed_at || Date.parse(s.expires_at) <= now().getTime()) return null;
      s.consumed_at = iso();
      return clone(s);
    },
    async rateLimitHit(bucket, windowSeconds, limit) {
      await tick();
      const k = `${bucket}@${windowStart(windowSeconds)}`;
      const n = (limits.get(k) || 0) + 1;
      limits.set(k, n);
      return n <= limit;
    },
    async rateLimitPeek(bucket, windowSeconds) { await tick(); return limits.get(`${bucket}@${windowStart(windowSeconds)}`) || 0; },
    async listSecurityEvents(ws, { limit = 50 } = {}) {
      await tick();
      return (auditRows || []).filter((r) => r.workspace_id === ws && String(r.action).startsWith('security.')).slice(-limit).reverse().map(clone);
    },
  };
}

module.exports = { createMemorySecurityStore };
