/**
 * Caller identity for the voice / command surface.
 *
 * Single source of truth for "who is calling" on routes that are exempt
 * from the global Firebase middleware (middleware/auth.js
 * publicApiPaths) because the local voice client authenticates with a
 * shared device secret instead of a Firebase ID token:
 *
 *   POST /api/command                       (backend-routing/commandRoute.js)
 *   GET  /api/command/goal/:planId/status
 *   POST /api/command/goal/:planId/answer
 *   POST /api/permissions/grant             (routes/permissions.js)
 *   POST /api/emergency/stop|resume         (routes/emergencyStop.js)
 *
 * The resolution logic below was MOVED verbatim from commandRoute.js
 * (resolveVoiceDeviceUserId / resolveUserId) so every one of these
 * routes identifies callers exactly the same way. Order:
 *   1. X-Device-Token == NEXUS_VOICE_DEVICE_TOKEN  → 'voice-device:<deviceId>'
 *      (no network — keeps the voice hot path fast)
 *   2. Bearer Firebase ID token                    → Firebase uid (cached 5 min)
 *   3. Bearer paired-device token (device_tokens)  → that row's user_id
 *   4. dev bypass: NODE_ENV !== 'production' AND ALLOW_UNAUTHENTICATED_API === 'true'
 *                                                  → 'test-user-123'
 *      Never active in production.
 */
'use strict';

const { createClient } = require('@supabase/supabase-js');
const getFirebaseAdmin = require('../config/firebaseAdmin');

const DEV_BYPASS_USER_ID = 'test-user-123';
const VOICE_DEVICE_PREFIX = 'voice-device:';

let supabase = null;
function db() {
  if (!supabase) supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
  return supabase;
}

const USER_ID_CACHE_TTL_MS = 5 * 60 * 1000;
const userIdCache = new Map();

// Read at module load, exactly as commandRoute.js did before the move.
const VOICE_DEVICE_TOKEN = process.env.NEXUS_VOICE_DEVICE_TOKEN || null;

function resolveVoiceDeviceUserId(req) {
  if (!VOICE_DEVICE_TOKEN) return null;
  const provided = req.headers['x-device-token'];
  if (!provided || provided !== VOICE_DEVICE_TOKEN) return null;
  const deviceId = req.body?.deviceId || 'voice-device';
  return `${VOICE_DEVICE_PREFIX}${deviceId}`;
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

  const { data, error } = await db()
    .from('device_tokens')
    .select('user_id')
    .eq('token', token)
    .single();

  if (error || !data) return null;
  userIdCache.set(token, { userId: data.user_id, at: Date.now() });
  return data.user_id;
}

function isDevBypassAllowed() {
  return process.env.NODE_ENV !== 'production' && process.env.ALLOW_UNAUTHENTICATED_API === 'true';
}

// Full resolution incl. the dev bypass — same result /api/command computes.
async function resolveCaller(req) {
  let userId = resolveVoiceDeviceUserId(req);
  if (!userId) {
    try {
      userId = await resolveUserId(req);
    } catch {
      userId = null;
    }
  }
  if (!userId && isDevBypassAllowed()) userId = DEV_BYPASS_USER_ID;
  return userId || null;
}

// Express middleware: sets req.callerId or responds 401.
async function requireCaller(req, res, next) {
  const callerId = await resolveCaller(req);
  if (!callerId) return res.status(401).json({ error: 'Unauthorized' });
  req.callerId = callerId;
  return next();
}

function isVoiceDevice(userId) {
  return typeof userId === 'string' && userId.startsWith(VOICE_DEVICE_PREFIX);
}

/**
 * Do two resolved identities denote the same principal?
 * All holders of NEXUS_VOICE_DEVICE_TOKEN are ONE principal: the
 * `deviceId` suffix is client-supplied and unauthenticated (and the
 * voice client omits it on grant/status/answer calls), so it must not
 * be treated as a security boundary in either direction.
 */
function isSamePrincipal(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  return isVoiceDevice(a) && isVoiceDevice(b);
}

module.exports = {
  resolveVoiceDeviceUserId,
  resolveUserId,
  resolveCaller,
  requireCaller,
  isDevBypassAllowed,
  isVoiceDevice,
  isSamePrincipal,
  DEV_BYPASS_USER_ID,
  VOICE_DEVICE_PREFIX,
};
