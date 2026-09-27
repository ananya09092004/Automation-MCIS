/**
 * Layer 8 — production configuration checker (pure; used by
 * scripts/check-config.js and the test suite).
 *
 * checkConfig(env) → { ok, errors: [..], warnings: [..], items: [{ name, group, area, status, note }] }
 *
 * It reports setting NAMES and a status (set / missing / invalid /
 * dev_only_enabled) — NEVER a value, a prefix of a value or its length.
 * Groups: required · conditional (required when a feature is on) ·
 * optional · development-only (must be off in production).
 */
'use strict';

const B64_OR_HEX_32 = (v) => {
  const s = String(v || '').trim();
  if (/^[0-9a-f]{64}$/i.test(s)) return true;
  try { return Buffer.from(s, 'base64').length === 32 && /^[A-Za-z0-9+/=_-]+$/.test(s); } catch { return false; }
};
const isHttpsUrl = (v) => { try { return new URL(v).protocol === 'https:'; } catch { return false; } };
const isUrl = (v) => { try { return ['https:', 'http:'].includes(new URL(v).protocol); } catch { return false; } };
const jwtRole = (v) => {
  const parts = String(v || '').split('.');
  if (parts.length !== 3) return null;
  try { return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')).role || null; } catch { return null; }
};

function checkConfig(env = process.env) {
  const items = [];
  const errors = [];
  const warnings = [];
  const production = env.NODE_ENV === 'production';
  const has = (k) => typeof env[k] === 'string' && env[k].trim() !== '';
  const add = (name, group, area, status, note = '') => {
    items.push({ name, group, area, status, note });
    if (status === 'missing' || status === 'invalid' || status === 'dev_only_enabled') {
      if (group === 'required' || group === 'conditional' || group === 'development-only') errors.push(`${name}: ${note || status}`);
      else warnings.push(`${name}: ${note || status}`);
    }
  };
  const warn = (name, group, area, note) => { items.push({ name, group, area, status: 'warning', note }); warnings.push(`${name}: ${note}`); };

  // ---------------- required ----------------
  add('NODE_ENV', 'required', 'runtime', production ? 'set' : 'invalid', production ? '' : 'must be "production" on a production server');
  add('SUPABASE_URL', 'required', 'database', !has('SUPABASE_URL') ? 'missing' : (isHttpsUrl(env.SUPABASE_URL) ? 'set' : 'invalid'), has('SUPABASE_URL') && !isHttpsUrl(env.SUPABASE_URL) ? 'must be an https URL' : 'Supabase project URL');
  if (!has('SUPABASE_KEY')) add('SUPABASE_KEY', 'required', 'database', 'missing', 'service-role key (server only)');
  else {
    const role = jwtRole(env.SUPABASE_KEY);
    if (role === 'anon' || role === 'authenticated') add('SUPABASE_KEY', 'required', 'database', 'invalid', 'is a public (anon) key; the backend needs the service-role key');
    else add('SUPABASE_KEY', 'required', 'database', 'set', role === 'service_role' ? 'service-role key' : 'set (role could not be read; make sure it is the service-role key)');
  }
  const firebase = has('FIREBASE_SERVICE_ACCOUNT_JSON') || has('FIREBASE_SERVICE_ACCOUNT_PATH') || has('GOOGLE_APPLICATION_CREDENTIALS')
    || (has('FIREBASE_PROJECT_ID') && has('FIREBASE_CLIENT_EMAIL') && has('FIREBASE_PRIVATE_KEY'));
  add('FIREBASE_SERVICE_ACCOUNT_JSON | FIREBASE_SERVICE_ACCOUNT_PATH | FIREBASE_PROJECT_ID+FIREBASE_CLIENT_EMAIL+FIREBASE_PRIVATE_KEY', 'required', 'auth',
    firebase ? 'set' : 'missing', 'Firebase Admin credentials (verifies user sign-in tokens)');
  const origins = String(env.ALLOWED_ORIGINS || env.FRONTEND_URL || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!origins.length) add('ALLOWED_ORIGINS', 'required', 'http', 'missing', 'comma-separated https origins of the web app');
  else if (origins.some((o) => o === '*' || (production && !isHttpsUrl(o)))) add('ALLOWED_ORIGINS', 'required', 'http', 'invalid', 'every origin must be an explicit https origin (no "*")');
  else if (production && origins.some((o) => { try { return ['localhost', '127.0.0.1', '[::1]'].includes(new URL(o).hostname); } catch { return true; } })) {
    add('ALLOWED_ORIGINS', 'required', 'http', 'invalid', 'contains a localhost origin on a production server'); // Layer 9
  } else add('ALLOWED_ORIGINS', 'required', 'http', 'set');
  add('GEMINI_API_KEY', 'required', 'agent', has('GEMINI_API_KEY') ? 'set' : 'missing', 'planner model for agent executions');
  add('GROQ_API_KEY', 'required', 'legacy', has('GROQ_API_KEY') ? 'set' : 'missing', 'loaded at start-up by legacy chat modules');

  // ---------------- security switches ----------------
  if (env.SECURITY_FIREWALL_ENABLED === 'false') warn('SECURITY_FIREWALL_ENABLED', 'optional', 'security', 'Agent Firewall is OFF (Layer 3 approvals still apply). Keep it on in production.');
  else if (has('SECURITY_FIREWALL_ENABLED') && env.SECURITY_FIREWALL_ENABLED !== 'true') add('SECURITY_FIREWALL_ENABLED', 'required', 'security', 'invalid', 'must be "true" or "false" (the server refuses to start otherwise)');
  else add('SECURITY_FIREWALL_ENABLED', 'optional', 'security', 'set', 'Agent Firewall on (default)');
  if (env.PERMISSIONS_ENFORCED !== 'true') warn('PERMISSIONS_ENFORCED', 'optional', 'security', 'first-time resource approval for the desktop agent is disabled; set "true" in production');
  if (env.WORKSPACE_INVITES_REQUIRE_VERIFIED_EMAIL === 'false') warn('WORKSPACE_INVITES_REQUIRE_VERIFIED_EMAIL', 'optional', 'security', 'invitations can be accepted without a verified email');
  if (env.WORKSPACE_DATA_SCOPING === 'off') warn('WORKSPACE_DATA_SCOPING', 'optional', 'security', 'workspace data scoping is OFF (legacy behaviour)');

  // ---------------- development-only ----------------
  if (env.ALLOW_UNAUTHENTICATED_API === 'true') add('ALLOW_UNAUTHENTICATED_API', 'development-only', 'auth', 'dev_only_enabled', 'disables authentication — never set in production');
  else add('ALLOW_UNAUTHENTICATED_API', 'development-only', 'auth', 'set', 'off');

  // ---------------- conditional: integrations ----------------
  if (env.INTEGRATIONS_ENABLED === 'true') {
    add('INTEGRATION_ENCRYPTION_KEY', 'conditional', 'integrations', !has('INTEGRATION_ENCRYPTION_KEY') ? 'missing' : (B64_OR_HEX_32(env.INTEGRATION_ENCRYPTION_KEY) ? 'set' : 'invalid'), '32-byte key (base64 or hex) that encrypts integration credentials');
    // Layer 9: key ring (current id + old keys used during rotation).
    if (has('INTEGRATION_ENCRYPTION_KEY')) {
      const ring = require('../integrations/credentialService').loadKeyRing(env);
      if (ring.error && /KEY_ID|OLD_KEYS/.test(ring.error)) add(/OLD_KEYS/.test(ring.error) ? 'INTEGRATION_ENCRYPTION_OLD_KEYS' : 'INTEGRATION_ENCRYPTION_KEY_ID', 'conditional', 'integrations', 'invalid', ring.error.replace(/^\S+ /, ''));
      else if (has('INTEGRATION_ENCRYPTION_OLD_KEYS')) {
        const id = env.INTEGRATION_ENCRYPTION_KEY_ID || 'k1';
        const ids = String(env.INTEGRATION_ENCRYPTION_OLD_KEYS).split(',').map((p) => p.trim().split(':')[0]).filter(Boolean);
        if (ids.includes(id)) add('INTEGRATION_ENCRYPTION_OLD_KEYS', 'conditional', 'integrations', 'invalid', 'an old key uses the CURRENT key id; give the new key a new INTEGRATION_ENCRYPTION_KEY_ID');
        else warn('INTEGRATION_ENCRYPTION_OLD_KEYS', 'conditional', 'integrations', 'old keys are loaded (rotation in progress): run scripts/rotate-integration-keys.js, then remove them');
      }
    }
    if (env.GOOGLE_DRIVE_ENABLED === 'true') {
      const all = has('GOOGLE_OAUTH_CLIENT_ID') && has('GOOGLE_OAUTH_CLIENT_SECRET') && (production ? isHttpsUrl(env.GOOGLE_OAUTH_REDIRECT_URI) : isUrl(env.GOOGLE_OAUTH_REDIRECT_URI));
      add('GOOGLE_OAUTH_CLIENT_ID + GOOGLE_OAUTH_CLIENT_SECRET + GOOGLE_OAUTH_REDIRECT_URI', 'conditional', 'integrations', all ? 'set' : 'missing',
        'Google Drive needs an OAuth client (connect + token refresh; access tokens expire after about an hour)');
    }
    if (has('GITHUB_CLIENT_ID') || has('GITHUB_CLIENT_SECRET') || has('GITHUB_REDIRECT_URI')) {
      const all = has('GITHUB_CLIENT_ID') && has('GITHUB_CLIENT_SECRET') && isUrl(env.GITHUB_REDIRECT_URI);
      add('GITHUB_CLIENT_ID + GITHUB_CLIENT_SECRET + GITHUB_REDIRECT_URI', 'conditional', 'integrations', all ? 'set' : 'invalid', 'GitHub OAuth needs all three');
    }
  } else {
    add('INTEGRATIONS_ENABLED', 'optional', 'integrations', 'set', 'integrations are off');
    if (env.GOOGLE_DRIVE_ENABLED === 'true') warn('GOOGLE_DRIVE_ENABLED', 'optional', 'integrations', 'has no effect while INTEGRATIONS_ENABLED is not "true"');
  }

  // ---------------- conditional: billing ----------------
  add('BILLING_ENABLED', 'optional', 'billing', 'set', env.BILLING_ENABLED === 'true' ? 'plan limits ENFORCED' : 'metering only (limits not enforced)');
  const stripeOn = env.STRIPE_ENABLED === 'true';
  if (!stripeOn && (env.BILLING_PROVIDER || '').toLowerCase() === 'generic') {
    add('BILLING_WEBHOOK_SECRET', 'conditional', 'billing', !has('BILLING_WEBHOOK_SECRET') ? 'missing' : (env.BILLING_WEBHOOK_SECRET.length >= 32 ? 'set' : 'invalid'), 'at least 32 characters, shared with the billing system');
  }
  if (stripeOn) {
    const key = String(env.STRIPE_SECRET_KEY || '');
    add('STRIPE_SECRET_KEY', 'conditional', 'stripe', !key ? 'missing' : (/^(sk|rk)_(test|live)_[A-Za-z0-9]{10,}$/.test(key) ? 'set' : 'invalid'), 'Stripe secret or restricted key (server only)');
    if (!production && /^(sk|rk)_live_/.test(key)) warn('STRIPE_SECRET_KEY', 'conditional', 'stripe', 'is a LIVE key on a non-production server; real payments would be taken'); // Layer 9
    if (production && /^(sk|rk)_test_/.test(key)) warn('STRIPE_SECRET_KEY', 'conditional', 'stripe', 'is a TEST-mode key on a production server; no real payment will be taken');
    add('STRIPE_WEBHOOK_SECRET', 'conditional', 'stripe', !has('STRIPE_WEBHOOK_SECRET') ? 'missing' : (/^whsec_[A-Za-z0-9+/=]{16,}$/.test(env.STRIPE_WEBHOOK_SECRET) ? 'set' : 'invalid'), 'signing secret of the /api/billing/webhooks/stripe endpoint');
    const prices = Object.keys(env).filter((k) => /^STRIPE_PRICE_[A-Z][A-Z0-9_]{1,31}$/.test(k));
    const badPrices = prices.filter((k) => !/^price_[A-Za-z0-9]{6,}$/.test(String(env[k]).trim()));
    add('STRIPE_PRICE_<PLAN>', 'conditional', 'stripe', !prices.length ? 'missing' : (badPrices.length ? 'invalid' : 'set'),
      prices.length ? `configured for: ${prices.map((k) => k.slice(13).toLowerCase()).join(', ')}${badPrices.length ? ` (invalid: ${badPrices.join(', ')})` : ''}` : 'e.g. STRIPE_PRICE_PRO, STRIPE_PRICE_BUSINESS (Stripe price ids)');
    if (prices.some((k) => k === 'STRIPE_PRICE_ENTERPRISE')) warn('STRIPE_PRICE_ENTERPRISE', 'conditional', 'stripe', 'Enterprise is normally activated manually; online checkout will be offered for it');
    const app = env.APP_BASE_URL || env.FRONTEND_URL;
    add('APP_BASE_URL', 'conditional', 'stripe', !app ? 'missing' : ((production ? isHttpsUrl(app) : isUrl(app)) ? 'set' : 'invalid'), 'web app URL for checkout / portal return links');
  } else add('STRIPE_ENABLED', 'optional', 'stripe', 'set', 'Stripe off — payment actions are shown as unavailable');

  // ---------------- optional ----------------
  add('PUBLIC_API_URL', 'optional', 'api', has('PUBLIC_API_URL') ? (isHttpsUrl(env.PUBLIC_API_URL) ? 'set' : 'invalid') : 'missing', 'public base URL shown in the API documentation');
  add('ONBOARDING_ENABLED', 'optional', 'product', 'set', env.ONBOARDING_ENABLED === 'false' ? 'off' : 'on (default)');
  add('TEMPLATES_ENABLED', 'optional', 'product', 'set', env.TEMPLATES_ENABLED === 'false' ? 'off' : 'on (default)');
  add('WORKFLOWS_ENABLED', 'optional', 'product', 'set', env.WORKFLOWS_ENABLED === 'false' ? 'off' : 'on (default)');
  // Layer 10: invitation emails (optional)
  {
    const { mailerConfig } = require('../invitationMailer');
    const mc = mailerConfig(env);
    if (!has('INVITE_EMAIL_PROVIDER')) add('INVITE_EMAIL_PROVIDER', 'optional', 'email', 'missing', 'invitations are shared as one-time codes (no email)');
    else add('INVITE_EMAIL_PROVIDER + INVITE_EMAIL_API_KEY + INVITE_EMAIL_FROM + APP_BASE_URL', 'conditional', 'email', mc.configured ? 'set' : 'invalid', mc.configured ? `invitation emails via ${mc.provider}` : mc.error);
  }
  // Layer 10 revenue suite
  add('REVENUE_SUITE_ENABLED', 'optional', 'product', 'set', env.REVENUE_SUITE_ENABLED === 'false' ? 'off' : 'on (default): competitor intelligence, monitoring, alerts, agent QA, AI workforce, webhooks');
  add('REVENUE_WORKER_ENABLED', 'optional', 'product', 'set', env.REVENUE_WORKER_ENABLED === 'false' ? 'off (no scheduled checks, QA runs or webhook deliveries on this instance)' : 'on (default; safe on several instances)');
  if (env.REVENUE_SUITE_ENABLED !== 'false' && env.INTEGRATIONS_ENABLED !== 'true') {
    add('INTEGRATIONS_ENABLED (for monitoring)', 'optional', 'product', 'missing', 'without integrations, monitors accept API-submitted values only and alerts go in-app only (no web pages, Slack or email)');
  }
  if (env.REVENUE_SUITE_ENABLED !== 'false' && !has('INTEGRATION_ENCRYPTION_KEY')) {
    add('INTEGRATION_ENCRYPTION_KEY (for webhooks)', 'conditional', 'product', 'missing', 'webhook signing secrets are stored encrypted with this key; webhooks cannot be created without it');
  }
  // Layer 9: a bridge URL without its token means every desktop call is unauthenticated or fails.
  if (has('NEXUS_URL') && !has('NEXUS_DEVICE_TOKEN')) add('NEXUS_DEVICE_TOKEN', 'conditional', 'agent', 'missing', 'NEXUS_URL is set but the bridge token is not; the token must match nexus/.env');
  else if (has('NEXUS_URL') && production && !isHttpsUrl(env.NEXUS_URL) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/.test(env.NEXUS_URL)) {
    add('NEXUS_URL', 'conditional', 'agent', 'invalid', 'must be https (or a loopback address) in production: the device token would travel in clear text');
  } else add('NEXUS_URL + NEXUS_DEVICE_TOKEN', 'optional', 'agent', has('NEXUS_URL') && has('NEXUS_DEVICE_TOKEN') ? 'set' : 'missing', 'desktop execution bridge (browser/desktop actions); the token must match nexus/.env');

  // ---------------- Layer 9: operations ----------------
  if (has('METRICS_TOKEN')) add('METRICS_TOKEN', 'conditional', 'ops', env.METRICS_TOKEN.length >= 32 ? 'set' : 'invalid', 'bearer token for GET /metrics (at least 32 characters)');
  else add('METRICS_TOKEN', 'optional', 'ops', 'missing', 'GET /metrics is disabled until set');
  if (has('USAGE_RETENTION_DAYS')) {
    const n = Number(env.USAGE_RETENTION_DAYS);
    add('USAGE_RETENTION_DAYS', 'conditional', 'ops', Number.isInteger(n) && n >= 35 && n <= 3650 ? 'set' : 'invalid', 'days of usage ledger to keep (35-3650); invalid values purge nothing');
  }
  if (has('RETENTION_SWEEP_MINUTES')) {
    const n = Number(env.RETENTION_SWEEP_MINUTES);
    add('RETENTION_SWEEP_MINUTES', 'conditional', 'ops', Number.isFinite(n) && n >= 0 ? 'set' : 'invalid', 'minutes between retention sweeps (0 = off, minimum 5)');
  }
  if (env.MULTI_INSTANCE_EXECUTION === 'false') warn('MULTI_INSTANCE_EXECUTION', 'optional', 'ops', 'execution ownership leases are OFF: run exactly ONE backend instance');
  if (production && /^(debug|silly|verbose)$/i.test(env.LOG_LEVEL || '')) warn('LOG_LEVEL', 'optional', 'ops', 'verbose logging in production; use "info"');

  return { ok: errors.length === 0, production, errors, warnings, items };
}

module.exports = { checkConfig };
