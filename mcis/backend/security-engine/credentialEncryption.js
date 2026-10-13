'use strict';

/**
 * Encrypts/decrypts credentials (currently: stored GitHub OAuth tokens)
 * at rest, using the AES-256-GCM helper already in encryption.js --
 * that helper existed in this codebase but a repo-wide search found it
 * was never actually called anywhere, so credentials were stored in
 * plaintext despite real encryption code already being present. This
 * module is the wiring that makes it real.
 *
 * Key management: a single 32-byte key, read from
 * GITHUB_TOKEN_ENCRYPTION_KEY (base64-encoded). Generate one with:
 *   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
 * and keep it stable across restarts/deployments -- losing it makes
 * every previously-encrypted token permanently undecryptable, so it
 * must be configured once, not derived fresh per process.
 *
 * There is deliberately NO silent fallback to plaintext when the key
 * is missing: that would let this module claim "encrypted" while doing
 * nothing. encryptCredential()/decryptCredential() throw a clear
 * configuration error instead, so a misconfigured deployment fails
 * loudly at the point of use rather than quietly storing secrets
 * unprotected.
 *
 * Key ROTATION (P2.15): rotating GITHUB_TOKEN_ENCRYPTION_KEY outright
 * would make every already-stored token permanently undecryptable --
 * there's no key id embedded in the ciphertext, so an old token
 * encrypted under the old key simply can't be read with a new one.
 * To rotate safely without a flag day that breaks every connected
 * GitHub account at once:
 *
 *   1. Generate a new key, but don't replace the old env var yet --
 *      set it as GITHUB_TOKEN_ENCRYPTION_KEY_PREVIOUS (comma-separated
 *      if there's ever more than one retired key to still support).
 *   2. Set GITHUB_TOKEN_ENCRYPTION_KEY to the NEW key and restart.
 *   3. From this point on: every encryptCredential() call uses the new
 *      key; every decryptCredential() call tries the new (current)
 *      key FIRST, then falls back to each key in
 *      GITHUB_TOKEN_ENCRYPTION_KEY_PREVIOUS in order -- so tokens
 *      encrypted under the old key still decrypt transparently.
 *      Tokens get migrated to the new key lazily, the same way legacy
 *      plaintext tokens already migrate: the next time a user
 *      reconnects GitHub (exchangeCodeForToken), the token is
 *      re-encrypted under the current key.
 *   4. Once nothing still needs the old key (every token has been
 *      re-encrypted, or enough time/re-connections have passed),
 *      GITHUB_TOKEN_ENCRYPTION_KEY_PREVIOUS can be cleared.
 *
 * With GITHUB_TOKEN_ENCRYPTION_KEY_PREVIOUS unset (the default), this
 * behaves exactly as before: a single key, no fallback.
 */

const { encrypt, decrypt } = require('./encryption');

function _parseKey(raw, varName) {
  const buf = Buffer.from(raw, 'base64');
  if (buf.length !== 32) {
    throw new Error(`${varName} must decode to exactly 32 bytes (base64-encoded).`);
  }
  return buf;
}

function _currentKey() {
  const raw = process.env.GITHUB_TOKEN_ENCRYPTION_KEY;
  if (!raw) {
    throw new Error(
      "GITHUB_TOKEN_ENCRYPTION_KEY is not set -- cannot encrypt/decrypt stored GitHub tokens. " +
      "Generate one with: node -e \"console.log(require('crypto').randomBytes(32).toString('base64'))\" " +
      "and set it in the environment before connecting GitHub."
    );
  }
  return _parseKey(raw, 'GITHUB_TOKEN_ENCRYPTION_KEY');
}

/** Retired keys still accepted for DECRYPTION only, oldest-rotation-safety-net. */
function _previousKeys() {
  const raw = process.env.GITHUB_TOKEN_ENCRYPTION_KEY_PREVIOUS;
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => _parseKey(s, 'GITHUB_TOKEN_ENCRYPTION_KEY_PREVIOUS'));
}

/** Returns a JSON string -- store this verbatim in place of the plaintext token. Always uses the CURRENT key. */
function encryptCredential(plainText) {
  return JSON.stringify(encrypt(plainText, _currentKey()));
}

/**
 * Reverses encryptCredential(). Tries the current key first, then each
 * retired key in GITHUB_TOKEN_ENCRYPTION_KEY_PREVIOUS in order, so a
 * token encrypted before a key rotation still decrypts. Throws only if
 * none of them work.
 */
function decryptCredential(stored) {
  const payload = typeof stored === 'string' ? JSON.parse(stored) : stored;
  const keys = [_currentKey(), ..._previousKeys()];
  let lastError = null;
  for (const key of keys) {
    try {
      return decrypt(payload, key);
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError || new Error('Unable to decrypt credential with any configured key.');
}

/** True if `stored` looks like our ciphertext envelope rather than a legacy plaintext token. */
function isEncryptedCredential(stored) {
  if (typeof stored !== 'string') return false;
  try {
    const parsed = JSON.parse(stored);
    return !!(parsed && parsed.ciphertext && parsed.iv && parsed.authTag);
  } catch {
    return false;
  }
}

module.exports = { encryptCredential, decryptCredential, isEncryptedCredential };
