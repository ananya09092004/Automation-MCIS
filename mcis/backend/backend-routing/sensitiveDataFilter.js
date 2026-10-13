/**
 * Sensitive-data redaction for anything the backend PERSISTS or RETURNS
 * about agent executions, commands, or audit/error logs.
 *
 * This file combines two independently-written redaction APIs that both
 * target the same problem from different call sites -- rather than
 * picking one and dropping the other, both are kept side by side since
 * real production code already depends on each set of exports:
 *
 *   - redact() / redactString() / redactActionPayload() / isSensitiveKey()
 *     -- the general-purpose, depth/key/length-bounded deep redactor used
 *     by the integration connectors (http/email/slack/github/
 *     googleDrive/webPage), services/agentExecution/executionService.js,
 *     and services/security/sensitiveClassifier.js.
 *   - redactSensitive() -- the structured-payload redactor (keyed on the
 *     {platform, action, parameters, target, value} shape used throughout
 *     backend-routing/) used by commandRoute.js, taskPlanner.js, and
 *     config/sentry.js (Sentry event scrubbing) before persisting/
 *     echoing a command payload.
 *
 * Both are pure (no I/O, no network) and safe to call on arbitrary tool
 * output. Their internal string-matching helpers are named distinctly
 * (redactString vs redactStringValue) so neither shadows the other --
 * redactString(value, maxString) remains the module's public, exported
 * API (depth-walking entry point used by isSensitiveKey-based callers);
 * redactStringValue(text) is redactSensitive()'s own private helper.
 *
 * What is NOT done here
 *   - Neither function decides what may be executed (that's riskModel /
 *     permissions / approvals).
 *   - Neither is applied to data sent to the planner LLM (unchanged
 *     existing behaviour of taskPlanner.decideNextStep).
 */
'use strict';

const REDACTED = '[REDACTED]';

// ---------------------------------------------------------------------
// Part 1: general-purpose deep redactor (redact / redactString /
// redactActionPayload / isSensitiveKey).
// ---------------------------------------------------------------------

const MAX_DEPTH = 6;
const MAX_KEYS = 50;
const MAX_ARRAY = 50;
const DEFAULT_MAX_STRING = 2000;

const SENSITIVE_KEY_RE = /(pass(word|wd|phrase)?|pwd|secret|token|api[_-]?key|apikey|access[_-]?key|private[_-]?key|authori[sz]ation|auth[_-]?header|cookie|session[_-]?id|otp|cvv|cvc|card[_-]?(number|no)|cc[_-]?num|\bpin\b|^pin$|aadhaa?r|^pan$|pan[_-]?(number|no)|ssn|credential|signature)/i;

function luhnValid(digits) {
  let sum = 0;
  let dbl = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (dbl) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
    dbl = !dbl;
  }
  return sum % 10 === 0;
}

const STRING_RULES = [
  // PEM private keys
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, () => REDACTED],
  // Authorization: Bearer xxx / Basic xxx
  [/\b(bearer|basic)\s+[A-Za-z0-9\-._~+/]{8,}=*/gi, (m, scheme) => `${scheme} ${REDACTED}`],
  // JWTs
  [/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/g, () => REDACTED],
  // Common API key shapes (AWS, Google, GitHub, Slack, Stripe, OpenAI/Anthropic-style, Groq)
  [/\b(AKIA|ASIA)[0-9A-Z]{16}\b/g, () => REDACTED],
  [/\bAIza[0-9A-Za-z_-]{30,}\b/g, () => REDACTED],
  [/\b(gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b/g, () => REDACTED],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g, () => REDACTED],
  [/\b(sk|pk|rk)_(live|test)_[A-Za-z0-9]{16,}\b/g, () => REDACTED],
  [/\b(sk|gsk)-[A-Za-z0-9_-]{20,}\b/g, () => REDACTED],
  // key=value / key: value pairs with a sensitive key name
  [/\b(password|passwd|pwd|passcode|secret|api[_-]?key|token|otp|pin|cvv)\b(\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;&]+)/gi,
    (m, key, sep) => `${key}${sep}${REDACTED}`],
  // Payment card numbers (13–19 digits, optional spaces/dashes), Luhn-checked
  // (not inside a larger token such as a UUID or a hex id: `-` / word chars around it)
  [/(?<![-\w])(?:\d[ -]?){12,18}\d(?![-\w])/g, (m) => {
    const digits = m.replace(/[ -]/g, '');
    return digits.length >= 13 && digits.length <= 19 && luhnValid(digits) ? REDACTED : m;
  }],
  // Aadhaar (12 digits, first digit 2-9, optional spaces) — not the last group of a UUID
  [/(?<![-\w])[2-9]\d{3}\s?\d{4}\s?\d{4}(?![-\w])/g, () => REDACTED],
  // PAN (ABCDE1234F)
  [/\b[A-Z]{5}[0-9]{4}[A-Z]\b/g, () => REDACTED],
];

function redactString(value, maxString = DEFAULT_MAX_STRING) {
  let out = String(value);
  for (const [re, fn] of STRING_RULES) out = out.replace(re, fn);
  if (out.length > maxString) out = `${out.slice(0, maxString)}…[truncated ${out.length - maxString} chars]`;
  return out;
}

function isSensitiveKey(key) {
  return SENSITIVE_KEY_RE.test(String(key));
}

/**
 * Deep-redact any JSON-like value. Returns a NEW value; never mutates.
 * @param {*} value
 * @param {{maxString?: number}} [opts]
 */
function redact(value, opts = {}, depth = 0) {
  const maxString = opts.maxString || DEFAULT_MAX_STRING;
  if (value === null || value === undefined) return value ?? null;
  if (typeof value === 'string') return redactString(value, maxString);
  if (typeof value === 'number' || typeof value === 'boolean') {
    return typeof value === 'number' && Number.isInteger(value) && String(value).length >= 12
      ? redactString(String(value), maxString)
      : value;
  }
  if (depth >= MAX_DEPTH) return '[TRUNCATED: max depth]';
  if (Array.isArray(value)) {
    const arr = value.slice(0, MAX_ARRAY).map((v) => redact(v, opts, depth + 1));
    if (value.length > MAX_ARRAY) arr.push(`[TRUNCATED: ${value.length - MAX_ARRAY} more items]`);
    return arr;
  }
  if (typeof value === 'object') {
    const out = {};
    const keys = Object.keys(value);
    for (const key of keys.slice(0, MAX_KEYS)) {
      out[key] = isSensitiveKey(key) ? REDACTED : redact(value[key], opts, depth + 1);
    }
    if (keys.length > MAX_KEYS) out['[truncated]'] = `${keys.length - MAX_KEYS} more keys`;
    return out;
  }
  return String(value);
}

// Field/target words that mean the TYPED VALUE of an action is a secret
// (e.g. fill { target: { name: 'Password' }, value: 'hunter2' }).
const SENSITIVE_FIELD_RE = /pass(word|code|phrase)?|pwd|otp|one[\s_-]?time|\bpin\b|cvv|cvc|card|secret|token|api[\s_-]?key|aadhaa?r|\bpan\b|ssn|security[\s_-]?(code|answer)/i;

/**
 * Redact an executor action payload ({ platform, parameters, target, value }).
 * Beyond redact(): the free-text `value` is fully hidden when the target or
 * parameters indicate a secret field, because the value itself carries no
 * recognisable secret pattern ("hunter2").
 */
function redactActionPayload(payload) {
  if (!payload || typeof payload !== 'object') return redact(payload);
  const out = redact(payload);
  const context = JSON.stringify({ target: payload.target || null, parameters: payload.parameters || null });
  if (out && out.value !== undefined && out.value !== null && SENSITIVE_FIELD_RE.test(context)) {
    out.value = REDACTED;
  }
  return out;
}

// ---------------------------------------------------------------------
// Part 2: structured command-payload redactor (redactSensitive).
//
// Deliberately scoped to STRUCTURED payloads -- the same
// {platform, action, parameters, target, value, ...} shape used
// throughout backend-routing/ -- rather than scrubbing arbitrary
// natural-language text. That keeps it from mangling an ordinary
// instruction that merely mentions a sensitive-sounding word (e.g.
// "open the password manager app" must survive untouched); it redacts
// a VALUE only when the key name identifies it as a secret, or when
// the value itself matches a known credential/token/card shape.
//
// This does NOT claim to catch every secret a user could type into
// free text with no structural signal (e.g. "my password is Sw0rd!"
// typed as a bare sentence with no labeled field) -- that is a much
// harder, inherently lossy problem (indistinguishable from ordinary
// prose without a much more aggressive filter that would also eat
// legitimate commands). What this module guarantees is: any secret
// that arrives in a recognizable field (password/token/otp/card/cvv/
// cookie/... by name) or a recognizable shape (bearer token, common
// API-key prefixes, OTP/CVV phrasing, card-number-shaped digit runs)
// is redacted before it reaches storage.
// ---------------------------------------------------------------------

// Key names that mark their VALUE as a secret, wherever they occur in
// a payload object (any nesting depth). Lower-cased comparison.
const SECRET_KEY_NAMES = new Set([
  'password', 'passwd', 'pass', 'otp', 'one_time_password',
  'api_key', 'apikey', 'api_secret', 'client_secret',
  'access_token', 'refresh_token', 'bearer_token', 'auth_token',
  'id_token', 'session_token', 'session_id', 'token', 'secret',
  'cookie', 'cookies', 'authorization', 'auth',
  'cvv', 'cvc', 'card_number', 'card_cvv', 'cardnumber',
  'private_key', 'github_token', 'device_token',
]);

// Value-SHAPE patterns -- catch a secret even under a generic key name
// (e.g. "value": "...") or inside free text that happens to carry a
// recognizably-shaped credential.
const VALUE_PATTERNS = [
  // OTP: "otp"/"one time password" followed by 4-8 digits. Checked
  // before the bare card-number pattern so an OTP's digits aren't
  // double-matched/mangled by the more generic card pattern below.
  { name: 'otp', pattern: /\b(?:otp|one[\s-]?time[\s-]?password)\b[^\d]{0,15}\d{4,8}\b/gi },
  // CVV: the word "cvv"/"cvc" followed by 3-4 digits.
  { name: 'cvv', pattern: /\bcvv?c?\s*[:\-]?\s*\d{3,4}\b/gi },
  // Bearer token in an Authorization-style string.
  { name: 'bearer', pattern: /\bBearer\s+[A-Za-z0-9\-_.]{10,}\b/g },
  // Common API-key-shaped tokens (GitHub/Stripe/Slack/OpenAI-style prefixes).
  { name: 'api_key', pattern: /\b(?:gh[pousr]_|sk-|xox[baprs]-)[A-Za-z0-9]{10,}\b/g },
  // Credit/debit card number: 13-19 digits, optionally grouped with
  // spaces/dashes. Checked last -- narrow enough (13+ consecutive
  // digit groups) that it won't fire on ordinary short numbers.
  { name: 'card_number', pattern: /\b(?:\d[ -]?){13,19}\b/g },
];

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// Private to redactSensitive() -- distinct name from the exported,
// depth-walking redactString() above so neither shadows the other.
function redactStringValue(text) {
  let result = text;
  for (const { pattern } of VALUE_PATTERNS) {
    result = result.replace(pattern, REDACTED);
  }
  return result;
}

/**
 * Deep-clones `value` (never mutates the input), redacting:
 *  - any object value whose KEY matches SECRET_KEY_NAMES (case-insensitive)
 *  - any string, wherever it occurs, that matches one of VALUE_PATTERNS
 * Numbers/booleans/null/undefined pass through unchanged. Arrays are
 * walked element-wise.
 */
function redactSensitive(value) {
  if (typeof value === 'string') {
    return redactStringValue(value);
  }
  if (Array.isArray(value)) {
    return value.map(redactSensitive);
  }
  if (isPlainObject(value)) {
    const out = {};
    for (const [key, val] of Object.entries(value)) {
      if (SECRET_KEY_NAMES.has(key.toLowerCase())) {
        out[key] = val === null || val === undefined ? val : REDACTED;
      } else {
        out[key] = redactSensitive(val);
      }
    }
    return out;
  }
  return value;
}

module.exports = {
  // Part 1 (general-purpose deep redactor)
  redact,
  redactString,
  redactActionPayload,
  isSensitiveKey,
  REDACTED,
  // Part 2 (structured command-payload redactor)
  redactSensitive,
  SECRET_KEY_NAMES,
  VALUE_PATTERNS,
};
