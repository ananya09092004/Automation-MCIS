'use strict';

/**
 * Shared authenticated-identity resolution, factored out of
 * commandRoute.js so every route that needs to know "who is actually
 * calling" (permissions.js's /grant, emergencyStop.js, the goal status/
 * answer routes) uses the exact same Firebase-token / voice-device-token
 * / dev-bypass resolution commandRoute.js's POST / already used --
 * instead of trusting a request-body userId or a hardcoded sentinel.
 *
 * This is deliberately NOT a new authorization framework: it is the
 * same three checks (voice device secret, Firebase ID token, dev-only
 * bypass) that already existed inline in commandRoute.js, just made
 * reusable so other routes stop inventing their own (or skipping auth
 * entirely).
 */

const getFirebaseAdmin = require('../config/firebaseAdmin');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// Same shared secret voice_controller.py sends as X-Device-Token for
// /api/command, /api/permissions/grant (approval retries), and
// /api/emergency/stop|resume (the mute/unmute hotkey) -- a local voice
// device is never a Firebase user, so this path has to exist alongside
// Firebase auth, not instead of it.
const VOICE_DEVICE_TOKEN = process.env.NEXUS_VOICE_DEVICE_TOKEN || null;

// P2.15 -- rotation support: during a rotation window, set the NEW
// token in NEXUS_VOICE_DEVICE_TOKEN and put the OLD one(s) in
// NEXUS_VOICE_DEVICE_TOKEN_PREVIOUS (comma-separated) so an
// already-paired device using the old token isn't suddenly locked out
// the moment the backend restarts with a new token -- it keeps
// working until it's re-paired with the new one. Unset, this behaves
// exactly as before (a single accepted token).
const VOICE_DEVICE_TOKENS_ACCEPTED = [
  VOICE_DEVICE_TOKEN,
  ...(process.env.NEXUS_VOICE_DEVICE_TOKEN_PREVIOUS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
].filter(Boolean);

// P-SEC-9 (security hardening, public-launch pass): NEXUS_VOICE_DEVICE_TOKEN
// is ONE shared secret for every voice device talking to this backend --
// there was previously no way to shut off a single compromised/lost
// physical device without rotating the token for every other device that
// shares it. deviceId (the client-asserted label a device sends) is
// unauthenticated on its own, so it was never safe to use alone as a
// revocation key -- but combined with the already-required valid secret,
// it lets an operator who knows a SPECIFIC device's id (e.g. from its
// pairing/setup record) block exactly that id while every other device
// keeps working, which is the real gap: identity-by-deviceId already
// existed, revocation of one did not.
const VOICE_DEVICE_REVOKED_IDS = new Set(
  (process.env.NEXUS_VOICE_DEVICE_REVOKED_IDS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
);

const USER_ID_CACHE_TTL_MS = 5 * 60 * 1000;
const userIdCache = new Map();

function resolveVoiceDeviceUserId(req) {
  if (!VOICE_DEVICE_TOKEN) return null;
  const provided = req.headers['x-device-token'];
  if (!provided || !VOICE_DEVICE_TOKENS_ACCEPTED.includes(provided)) return null;
  const deviceId = req.body?.deviceId || 'voice-device';
  // Fail closed: a revoked device id is rejected even with an otherwise
  // valid shared secret -- this is checked AFTER the token check (never
  // leaks whether a device id is revoked to a caller with the wrong
  // secret) and before any identity is returned.
  if (VOICE_DEVICE_REVOKED_IDS.has(deviceId)) return null;
  return `voice-device:${deviceId}`;
}

async function resolveUserId(req) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) return null;

  const cached = userIdCache.get(token);
  if (cached && Date.now() - cached.at < USER_ID_CACHE_TTL_MS) {
    return cached.userId;
  }

  try {
    const admin = getFirebaseAdmin();
    const decoded = await admin.auth().verifyIdToken(token);
    userIdCache.set(token, { userId: decoded.uid, at: Date.now() });
    return decoded.uid;
  } catch {
    // not a valid Firebase token — fall through to device token check
  }

  const { data, error } = await supabase
    .from('device_tokens')
    .select('user_id')
    .eq('token', token)
    .single();

  if (error || !data) return null;
  userIdCache.set(token, { userId: data.user_id, at: Date.now() });
  return data.user_id;
}

/** Voice-device secret first (no network round trip), then Firebase/device-token. */
async function resolveAuthenticatedUserId(req) {
  return resolveVoiceDeviceUserId(req) || (await resolveUserId(req));
}

// Explicit, narrow, already-existing dev-only escape hatch (unchanged
// semantics from what commandRoute.js already did inline) -- never
// used unless NODE_ENV!=='production' AND the operator opted in via
// ALLOW_UNAUTHENTICATED_API=true. Kept here too so every route that
// needs it applies the exact same rule instead of re-deriving it.
function devBypassUserId() {
  const allowed = process.env.NODE_ENV !== 'production' && process.env.ALLOW_UNAUTHENTICATED_API === 'true';
  return allowed ? 'test-user-123' : null;
}

module.exports = {
  resolveUserId,
  resolveVoiceDeviceUserId,
  resolveAuthenticatedUserId,
  devBypassUserId,
};
