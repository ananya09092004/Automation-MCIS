/**
 * Sensitive-data redaction for anything the backend PERSISTS or RETURNS
 * about agent executions (evidence, step summaries, errors, goals).
 *
 * This file existed in the repo as an empty placeholder; it is now the
 * single redaction module. It is pure (no I/O, no network) and bounded
 * (depth / key-count / string-length caps), so it is safe to call on
 * arbitrary tool output.
 *
 * What is redacted
 *   - values under sensitive KEYS (password, token, secret, api key,
 *     authorization, cookie, otp, cvv, card number, pin, aadhaar, pan, ...)
 *   - sensitive PATTERNS inside any string: bearer/JWT tokens, private
 *     keys, common cloud/API key shapes, payment card numbers (Luhn),
 *     Aadhaar numbers, PAN numbers, "password: xyz"-style pairs
 *
 * What is NOT done here
 *   - It does not decide what may be executed (that's riskModel /
 *     permissions / approvals).
 *   - It is not applied to data sent to the planner LLM (unchanged
 *     existing behaviour of taskPlanner.decideNextStep).
 */
'use strict';

const REDACTED = '[REDACTED]';
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

module.exports = { redact, redactString, redactActionPayload, isSensitiveKey, REDACTED };
