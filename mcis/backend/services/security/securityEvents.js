/**
 * Layer 6 — security events + rate limiting primitives.
 *
 * Security events are rows in the existing workspace-scoped audit_log with
 * action `security.<type>`. Payloads pass through the sensitive-data
 * classifier (sanitize) before they are written, so no secret, token,
 * password or authorization header can reach the audit trail even if a
 * caller passes one by mistake.
 *
 * Rate limiting: fixed windows. `createDbRateLimiter` uses the
 * security_rate_limit_hit RPC (atomic upsert → correct across any number
 * of backend instances). `createProcessRateLimiter` is in-memory (per
 * instance) and is only used for the pre-authentication per-IP throttle,
 * so an unauthenticated flood cannot turn into database writes.
 */
'use strict';

const crypto = require('crypto');
const { sanitize, sanitizeString } = require('./sensitiveClassifier');

const EVENT_TYPES = Object.freeze([
  'policy_allow', 'policy_deny', 'policy_updated', 'approval_requested', 'approval_granted', 'approval_rejected', 'approval_rejected_stale',
  'connector_blocked', 'api_key_created', 'api_key_revoked', 'api_key_rotated', 'api_key_auth_failed', 'oauth_state_rejected',
  'oauth_connected', 'credential_access_denied', 'ssrf_blocked', 'sensitive_data_blocked', 'suspicious_tool_injection',
  'suspicious_activity', 'rate_limited', 'worker_fenced', 'execution_recovered', 'structured_output_rejected', 'legacy_token_migrated',
]);

function createSecurityEvents({ appendAuditLog, logger = console } = {}) {
  function record(workspaceId, actorId, type, payload = {}, { success = true, error = null } = {}) {
    if (!EVENT_TYPES.includes(type)) throw new Error(`unknown security event type ${type}`);
    if (!appendAuditLog || !workspaceId) return;
    try {
      Promise.resolve(appendAuditLog(actorId || 'system', `security.${type}`,
        sanitize({ ...payload, workspaceId }, { maxString: 300 }),
        { success, error: error ? sanitizeString(String(error), 300) : null }, workspaceId)).catch(() => {});
    } catch (e) {
      logger.warn?.(`[security] event write failed (${type})`);
    }
  }
  return { record, EVENT_TYPES };
}

const safeBucket = (parts) => {
  const s = parts.map((p) => String(p)).join(':');
  return s.length <= 120 ? s : `${s.slice(0, 60)}#${crypto.createHash('sha256').update(s).digest('hex').slice(0, 32)}`;
};

/** DB-backed limiter; fails CLOSED (returns false) if the counter cannot be written. */
function createDbRateLimiter({ store, logger = console }) {
  return {
    async hit(parts, windowSeconds, limit) {
      try { return await store.rateLimitHit(safeBucket(parts), windowSeconds, limit); } catch (e) {
        logger.error?.(`[security] rate limiter unavailable: ${e.message}`);
        return false;
      }
    },
    async peek(parts, windowSeconds) {
      try { return await store.rateLimitPeek(safeBucket(parts), windowSeconds); } catch { return Number.MAX_SAFE_INTEGER; }
    },
  };
}

/** Per-process limiter (pre-auth IP throttling only). */
function createProcessRateLimiter({ now = () => Date.now(), maxBuckets = 10000 } = {}) {
  const m = new Map();
  return {
    hit(parts, windowSeconds, limit) {
      const w = Math.floor(now() / 1000 / windowSeconds);
      const k = `${safeBucket(parts)}@${w}`;
      if (m.size > maxBuckets) m.clear();
      const n = (m.get(k) || 0) + 1;
      m.set(k, n);
      return n <= limit;
    },
    peek(parts, windowSeconds) {
      return m.get(`${safeBucket(parts)}@${Math.floor(now() / 1000 / windowSeconds)}`) || 0;
    },
  };
}

module.exports = { createSecurityEvents, createDbRateLimiter, createProcessRateLimiter, EVENT_TYPES, safeBucket };
