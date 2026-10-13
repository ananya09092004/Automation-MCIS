'use strict';

/**
 * P1.9 -- production error visibility via Sentry.
 *
 * `@sentry/node` has been a dependency in package.json since before
 * this pass, but it was never actually initialized or wired into
 * server.js anywhere (confirmed via repo-wide search) -- errors were
 * only ever logged to stdout/stderr, with nothing surfaced to an
 * operator unless they were tailing logs at the exact moment something
 * broke.
 *
 * This module initializes Sentry ONLY when a real DSN is present in
 * the environment (SENTRY_DSN). No DSN is invented, hardcoded, or
 * assumed here -- in dev/test, where no DSN is configured, this is a
 * complete no-op (initSentry() returns false and nothing Sentry-related
 * ever runs), so local development and CI never need, or attempt to
 * reach, any external monitoring credentials.
 *
 * Secret scrubbing: every event is passed through the same
 * `redactSensitive()` used for audit logging (backend-routing/
 * sensitiveDataFilter.js) before Sentry ever sees it, and request
 * headers/cookies/body are dropped entirely rather than redacted
 * in-place -- an Authorization header or a raw request body is simply
 * not something an error-monitoring dashboard needs to do its job, so
 * the safer default is "never present" rather than "redacted but still
 * structurally there."
 */

const Sentry = require('@sentry/node');
const { redactSensitive } = require('../backend-routing/sensitiveDataFilter');

let initialized = false;

function scrubEvent(event) {
  if (!event) return event;

  // Request headers/cookies/body can carry Authorization tokens,
  // session cookies, or raw user-submitted secrets -- never send these
  // to a third-party monitoring service at all, scrubbed or not.
  if (event.request) {
    delete event.request.headers;
    delete event.request.cookies;
    delete event.request.data;
    // A raw query string can carry a token/secret as a plain
    // `key=value` pair (e.g. "token=abcd1234") that doesn't match any
    // of redactSensitive()'s credential-SHAPE patterns (those look for
    // things like a Bearer-prefixed value or a labeled "otp:"/"cvv:"
    // phrase, not arbitrary querystring key names) -- so this is
    // dropped entirely rather than partially/unreliably text-redacted.
    delete event.request.query_string;
  }

  // User context: keep only a stable id (useful for "how many users
  // hit this"), never email/IP/other PII the SDK might attach.
  if (event.user) {
    event.user = event.user.id ? { id: event.user.id } : undefined;
  }

  // Deep-redact whatever is left (extra context, breadcrumbs, etc.) --
  // belt-and-suspenders on top of the explicit deletions above.
  try {
    return redactSensitive(event);
  } catch (_err) {
    // If redaction itself somehow throws on some exotic event shape,
    // fail closed by dropping the event rather than risking a leak.
    return null;
  }
}

function initSentry() {
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) {
    console.log('[Sentry] SENTRY_DSN not set -- error monitoring stays disabled (expected in dev/test).');
    return false;
  }

  Sentry.init({
    dsn,
    environment: process.env.NODE_ENV || 'development',
    // No performance tracing by default -- tracing payloads can carry
    // request/response data we'd rather not transmit unless an operator
    // deliberately opts into it later.
    tracesSampleRate: 0,
    // Never auto-attach IP addresses, cookies, or other default PII --
    // scrubEvent() above is belt-and-suspenders on top of this.
    sendDefaultPii: false,
    beforeSend: scrubEvent,
    beforeSendTransaction: scrubEvent,
  });

  initialized = true;
  console.log(`[Sentry] Error monitoring initialized for environment "${process.env.NODE_ENV || 'development'}".`);
  return true;
}

function isInitialized() {
  return initialized;
}

function captureException(err) {
  if (!initialized) return;
  try {
    Sentry.captureException(err);
  } catch (_err) {
    // Monitoring must never be able to crash the app it's monitoring.
  }
}

module.exports = { initSentry, isInitialized, captureException, scrubEvent };
