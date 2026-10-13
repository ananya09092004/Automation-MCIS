/**
 * Layer 6 — reusable OAuth `state` service.
 *
 *   create({ workspaceId, userId, provider, purpose }) → opaque state string
 *   consume(state, { provider, purpose, userId?, workspaceId? }) → bound row
 *
 * The state is 32 random bytes (base64url) with a 2-character purpose
 * prefix ("u." per-user connect, "w." workspace connect) so the public
 * callback can route without a lookup. Only its SHA-256 is stored, with
 * the user, workspace, provider, purpose and a short expiry (10 minutes).
 * Consumption is a single atomic UPDATE … WHERE consumed_at IS NULL AND
 * expires_at > now() (consume_oauth_state RPC) → single use, even across
 * instances. A state is consumed BEFORE its binding is compared, so a
 * wrong-user / wrong-workspace / wrong-provider attempt also burns it.
 *
 * Errors are generic (OAUTH_STATE_INVALID) — the caller never learns
 * whether a state was unknown, expired, reused or bound elsewhere. The
 * reason goes only to the workspace security events.
 */
'use strict';

const crypto = require('crypto');

const STATE_RE = /^[uw]\.[A-Za-z0-9_-]{43}$/;
const PURPOSE_PREFIX = { user_connect: 'u', workspace_connect: 'w' };
const PROVIDER_RE = /^[a-z][a-z0-9_]{1,31}$/;

class OAuthStateError extends Error {
  constructor(reason) {
    super('The authorization request is invalid or has expired. Please start again.');
    this.name = 'OAuthStateError';
    this.status = 400;
    this.code = 'OAUTH_STATE_INVALID';
    this.reason = reason; // internal only — never sent to clients
  }
}

const hashState = (s) => crypto.createHash('sha256').update(String(s), 'utf8').digest('hex');

function purposeOf(state) {
  if (typeof state !== 'string' || !STATE_RE.test(state)) return null;
  return state[0] === 'u' ? 'user_connect' : 'workspace_connect';
}

function createOAuthStateService({ store, events = null, rateLimiter = null, logger = console, options = {} } = {}) {
  if (!store) throw new Error('oauth state service: store is required');
  const ttlMs = options.ttlMs || 10 * 60 * 1000;
  const now = options.now || (() => new Date());

  async function create({ workspaceId, userId, provider, purpose }) {
    if (!workspaceId || !userId || !PROVIDER_RE.test(String(provider)) || !PURPOSE_PREFIX[purpose]) throw new Error('oauth state: invalid binding');
    if (rateLimiter && !(await rateLimiter.hit(['oauth', userId], 600, 20))) {
      events && events.record(workspaceId, userId, 'rate_limited', { bucket: 'oauth_attempts', provider }, { success: false });
      const e = new Error('Too many authorization attempts; try again later.');
      e.status = 429;
      e.code = 'RATE_LIMITED';
      throw e;
    }
    const state = `${PURPOSE_PREFIX[purpose]}.${crypto.randomBytes(32).toString('base64url')}`;
    await store.insertOAuthState({
      id: crypto.randomUUID(),
      state_hash: hashState(state),
      workspace_id: workspaceId,
      user_id: userId,
      provider,
      purpose,
      expires_at: new Date(now().getTime() + ttlMs).toISOString(),
    });
    return state;
  }

  async function consume(state, expect = {}) {
    const reject = (reason, row) => {
      const ws = row ? row.workspace_id : (expect.workspaceId || null);
      if (events && ws) events.record(ws, (row && row.user_id) || expect.userId || 'anonymous', 'oauth_state_rejected', { provider: expect.provider || null, reason }, { success: false });
      else logger.warn?.(`[oauth] state rejected (${reason})`);
      throw new OAuthStateError(reason);
    };
    const purpose = purposeOf(state);
    if (!purpose) reject('malformed');
    if (expect.purpose && purpose !== expect.purpose) reject('wrong_purpose');
    const row = await store.consumeOAuthState(hashState(state));
    if (!row) reject('unknown_expired_or_reused');
    if (row.purpose !== purpose) reject('wrong_purpose', row);
    if (expect.provider && row.provider !== expect.provider) reject('wrong_provider', row);
    if (expect.userId !== undefined && row.user_id !== expect.userId) reject('wrong_user', row);
    if (expect.workspaceId !== undefined && row.workspace_id !== expect.workspaceId) reject('wrong_workspace', row);
    return { workspaceId: row.workspace_id, userId: row.user_id, provider: row.provider, purpose: row.purpose };
  }

  return { create, consume, purposeOf };
}

module.exports = { createOAuthStateService, OAuthStateError, hashState, purposeOf, STATE_RE };
