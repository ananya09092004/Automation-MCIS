'use strict';

/**
 * P1.10 -- startup configuration validation.
 *
 * Previously nothing checked required configuration at startup: a
 * missing SUPABASE_URL, for example, would only surface the first time
 * some request happened to touch Supabase, as an unhelpful runtime
 * error deep in a request handler. This runs once at boot and fails
 * loudly and immediately in production if something genuinely required
 * is missing, instead of letting a half-configured deployment serve
 * traffic and fail unpredictably later.
 *
 * Deliberately conservative: this does NOT invent new required config
 * or change any existing fail-open/fail-closed behavior elsewhere
 * (e.g. Firebase Admin already has its own documented dev-only
 * fallback in middleware/auth.js; this does not override that). It
 * only checks the handful of variables every deployment of this
 * backend genuinely cannot function without, and treats everything
 * else as "missing means that one feature is degraded," which is
 * reported but not fatal.
 */

// Missing any of these means the backend cannot do its core job at
// all (no datastore, no voice/action execution path).
const REQUIRED_IN_PRODUCTION = [
  'SUPABASE_URL',
  'SUPABASE_KEY',
];

// Missing any of these disables a specific feature but the server can
// still run -- reported as a warning, never fatal.
const RECOMMENDED = [
  'GROQ_API_KEY',
  'GEMINI_API_KEY',
  'GITHUB_TOKEN_ENCRYPTION_KEY',
  'NEXUS_VOICE_DEVICE_TOKEN',
  'SENTRY_DSN',
];

// P-SEC-4 (security hardening, pre-launch): security on/off switches
// that genuinely change the security posture of a production
// deployment, but whose *correct* value is a real operational decision
// (not something this file should silently pick for every deployment).
// security-engine/permissions.js's PERMISSIONS_ENFORCED is the first
// one: leaving it unset in production used to silently mean "first-
// time resource approval is disabled" -- a real, security-relevant
// choice made by omission, logged only as a warning nobody necessarily
// sees. The fix here is NOT to hardcode it to "true" (that would be
// its own bug: the documented voice-client limitation in
// permissions.js means some deployments legitimately need it off), but
// to require that production deployments say so EXPLICITLY -- "true"
// or "false", not merely absent -- the same "fail closed on an unsafe
// implicit default, fail loud, never silently proceed" treatment
// SUPABASE_URL/SUPABASE_KEY already get above. Each entry names the
// variable and the values production will accept as an explicit
// decision.
const EXPLICIT_IN_PRODUCTION = [
  { name: 'PERMISSIONS_ENFORCED', allowed: ['true', 'false'] },
];

function validateConfig({ exitOnFailure = true } = {}) {
  const missingRequired = REQUIRED_IN_PRODUCTION.filter((name) => !process.env[name]);
  const missingRecommended = RECOMMENDED.filter((name) => !process.env[name]);
  const production = process.env.NODE_ENV === 'production';

  // Unset (never configured either way) and set-but-not-one-of-the-
  // allowed-explicit-values (a typo, e.g. "True" or "1") are both
  // "not an explicit decision" -- treated the same way: fatal in
  // production, a warning everywhere else.
  const unexplicitSwitches = EXPLICIT_IN_PRODUCTION.filter(
    ({ name, allowed }) => !allowed.includes(process.env[name])
  ).map(({ name }) => name);

  if (production && missingRequired.length > 0) {
    console.error(
      `[config] FATAL: missing required production configuration: ${missingRequired.join(', ')}. ` +
      'Refusing to start with an incomplete production configuration -- see .env.example.'
    );
    if (exitOnFailure) {
      process.exit(1);
    }
    return { ok: false, missingRequired, missingRecommended, unexplicitSwitches };
  }

  if (production && unexplicitSwitches.length > 0) {
    console.error(
      `[config] FATAL: ${unexplicitSwitches.join(', ')} must be explicitly set to "true" or "false" in production -- ` +
      'an unset or unrecognized value would silently decide the security posture by omission. ' +
      'Refusing to start -- see .env.example.'
    );
    if (exitOnFailure) {
      process.exit(1);
    }
    return { ok: false, missingRequired, missingRecommended, unexplicitSwitches };
  }

  if (missingRequired.length > 0) {
    // Non-production: warn, don't block -- local dev/test commonly
    // runs with a subset of real config (tests mock these out).
    console.warn(
      `[config] Missing (non-fatal outside production): ${missingRequired.join(', ')}. ` +
      'Some features will not work until these are set -- see .env.example.'
    );
  }

  if (missingRecommended.length > 0) {
    console.warn(
      `[config] Optional config not set, related features disabled: ${missingRecommended.join(', ')}.`
    );
  }

  if (unexplicitSwitches.length > 0) {
    console.warn(
      `[config] ${unexplicitSwitches.join(', ')} not explicitly set to "true"/"false" -- using its documented ` +
      'default outside production; this will be a fatal startup error in production -- see .env.example.'
    );
  }

  return { ok: true, missingRequired, missingRecommended, unexplicitSwitches };
}

module.exports = { validateConfig, REQUIRED_IN_PRODUCTION, RECOMMENDED, EXPLICIT_IN_PRODUCTION };
