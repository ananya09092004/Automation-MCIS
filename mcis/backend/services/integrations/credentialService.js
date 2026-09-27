/**
 * Layer 5 — credential service (the ONLY code that sees plaintext secrets).
 *
 *   encrypt(secretObject, aad)          → { key_id, algorithm, iv, auth_tag, ciphertext }
 *   decrypt(record, aad)                → secretObject
 *   storeCredential({...})              → encrypts and persists (returns no secret)
 *   getCredentialForExecution({...})    → plaintext, ONLY for a connector's execute boundary
 *   deleteCredential / hasCredential
 *
 * Crypto: AES-256-GCM, random 96-bit IV per write, 128-bit tag. The AAD
 * binds each ciphertext to "<workspace>:<integration>", so a ciphertext
 * copied onto another integration or workspace fails to decrypt.
 *
 * Key: INTEGRATION_ENCRYPTION_KEY — 32 bytes, base64 (44 chars) or hex (64
 * chars). INTEGRATION_ENCRYPTION_KEY_ID names it (default "k1") and is
 * stored with each record. INTEGRATION_ENCRYPTION_OLD_KEYS="id:key,..."
 * keeps retired keys readable during rotation (new writes always use the
 * current key). There is NO fallback: without a valid key every
 * credential operation fails closed with CREDENTIALS_UNAVAILABLE.
 *
 * Isolated behind a small store interface so it can later be backed by an
 * external secret manager without touching connectors or services.
 */
'use strict';

const crypto = require('crypto');

const ALGORITHM = 'aes-256-gcm';
const KEY_ID_RE = /^[A-Za-z0-9_.-]{1,64}$/;
const MAX_PLAINTEXT_BYTES = 8192;

class CredentialError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'CredentialError';
    this.status = status;
    this.code = code;
  }
}

function decodeKey(raw) {
  if (typeof raw !== 'string') return null;
  const v = raw.trim();
  let buf = null;
  if (/^[0-9a-fA-F]{64}$/.test(v)) buf = Buffer.from(v, 'hex');
  else if (/^[A-Za-z0-9+/_-]{43}=?$/.test(v)) buf = Buffer.from(v.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  return buf && buf.length === 32 ? buf : null;
}

/**
 * Reads the key ring from the environment. Returns { current: {id, key},
 * all: Map(id → key) } or { error } — never throws and never logs values.
 */
function loadKeyRing(env = process.env) {
  const raw = env.INTEGRATION_ENCRYPTION_KEY;
  if (!raw) return { error: 'INTEGRATION_ENCRYPTION_KEY is not set' };
  const key = decodeKey(raw);
  if (!key) return { error: 'INTEGRATION_ENCRYPTION_KEY must be 32 bytes, base64 or hex encoded' };
  const id = env.INTEGRATION_ENCRYPTION_KEY_ID || 'k1';
  if (!KEY_ID_RE.test(id)) return { error: 'INTEGRATION_ENCRYPTION_KEY_ID is invalid' };
  const all = new Map([[id, key]]);
  for (const part of String(env.INTEGRATION_ENCRYPTION_OLD_KEYS || '').split(',').map((s) => s.trim()).filter(Boolean)) {
    const i = part.indexOf(':');
    const oldId = part.slice(0, i);
    const oldKey = decodeKey(part.slice(i + 1));
    if (i < 1 || !KEY_ID_RE.test(oldId) || !oldKey) return { error: 'INTEGRATION_ENCRYPTION_OLD_KEYS is invalid' };
    if (!all.has(oldId)) all.set(oldId, oldKey);
  }
  return { current: { id, key }, all };
}

const aadFor = (workspaceId, integrationId) => Buffer.from(`nexus-integration:${workspaceId}:${integrationId}`, 'utf8');

function createCredentialService({ store, keyRing = loadKeyRing() } = {}) {
  if (!store) throw new Error('credential store is required');

  function ring() {
    if (!keyRing || keyRing.error || !keyRing.current) {
      throw new CredentialError(503, 'CREDENTIALS_UNAVAILABLE',
        'Credential encryption is not configured on this server (INTEGRATION_ENCRYPTION_KEY).');
    }
    return keyRing;
  }

  function isConfigured() {
    return !!(keyRing && !keyRing.error && keyRing.current);
  }

  function encrypt(secret, aad) {
    const { current } = ring();
    const plaintext = Buffer.from(JSON.stringify(secret), 'utf8');
    if (plaintext.length > MAX_PLAINTEXT_BYTES) throw new CredentialError(400, 'BAD_REQUEST', 'Credential is too large');
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv(ALGORITHM, current.key, iv);
    cipher.setAAD(aad);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return {
      key_id: current.id,
      algorithm: ALGORITHM,
      iv: iv.toString('base64'),
      auth_tag: cipher.getAuthTag().toString('base64'),
      ciphertext: ciphertext.toString('base64'),
    };
  }

  function decrypt(record, aad) {
    const { all } = ring();
    if (!record || record.algorithm !== ALGORITHM) throw new CredentialError(500, 'CREDENTIAL_CORRUPT', 'Stored credential is unreadable');
    const key = all.get(record.key_id);
    if (!key) throw new CredentialError(503, 'CREDENTIALS_UNAVAILABLE', 'The key that encrypted this credential is not configured');
    try {
      const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(record.iv, 'base64'));
      decipher.setAAD(aad);
      decipher.setAuthTag(Buffer.from(record.auth_tag, 'base64'));
      const out = Buffer.concat([decipher.update(Buffer.from(record.ciphertext, 'base64')), decipher.final()]);
      return JSON.parse(out.toString('utf8'));
    } catch {
      // Never echo crypto internals or data.
      throw new CredentialError(500, 'CREDENTIAL_CORRUPT', 'Stored credential is unreadable');
    }
  }

  async function storeCredential({ workspaceId, integrationId, secret, actorId }) {
    const enc = encrypt(secret, aadFor(workspaceId, integrationId));
    await store.upsertCredential({
      integration_id: integrationId,
      workspace_id: workspaceId,
      ...enc,
      created_by: actorId,
      created_at: new Date().toISOString(),
    });
    return { stored: true, keyId: enc.key_id };
  }

  async function getCredentialForExecution({ workspaceId, integrationId }) {
    ring();
    const rec = await store.getCredential(workspaceId, integrationId);
    if (!rec) throw new CredentialError(409, 'CREDENTIAL_MISSING', 'This integration has no stored credential');
    return decrypt(rec, aadFor(workspaceId, integrationId));
  }

  async function hasCredential(workspaceId, integrationId) {
    return !!(await store.getCredentialMeta(workspaceId, integrationId));
  }

  async function credentialMeta(workspaceId, integrationId) {
    const m = await store.getCredentialMeta(workspaceId, integrationId);
    return m ? { keyId: m.key_id, updatedAt: m.created_at } : null;
  }

  async function deleteCredential(workspaceId, integrationId) {
    await store.deleteCredential(workspaceId, integrationId);
  }

  /**
   * Layer 9: re-encrypt every credential that is still under an OLD key with
   * the current key (INTEGRATION_ENCRYPTION_KEY). Old keys must still be in
   * INTEGRATION_ENCRYPTION_OLD_KEYS while this runs; afterwards they can be
   * removed. Each row is replaced only if it was not changed meanwhile (CAS
   * on key_id). Returns counts only — never ids, plaintext or ciphertext.
   */
  async function rotateCredentials({ dryRun = false, batchSize = 200, maxBatches = 1000 } = {}) {
    const { current } = ring();
    if (!store.listCredentialsNotUnderKey || !store.replaceCredentialIfKey) throw new Error('credential store does not support rotation');
    const out = { scanned: 0, rotated: 0, unreadable: 0, missingKey: 0, conflicts: 0, dryRun: !!dryRun };
    const skip = new Set(); // rows that cannot be rotated (so the loop terminates)
    for (let b = 0; b < maxBatches; b++) {
      const rows = (await store.listCredentialsNotUnderKey(current.id, batchSize + skip.size)).filter((r) => !skip.has(r.integration_id));
      if (!rows.length) break;
      for (const r of rows) {
        out.scanned += 1;
        let secret;
        try { secret = decrypt(r, aadFor(r.workspace_id, r.integration_id)); } catch (err) {
          if (err.code === 'CREDENTIALS_UNAVAILABLE') out.missingKey += 1; else out.unreadable += 1;
          skip.add(r.integration_id);
          continue;
        }
        if (dryRun) { out.rotated += 1; skip.add(r.integration_id); continue; }
        const enc = encrypt(secret, aadFor(r.workspace_id, r.integration_id));
        const ok = await store.replaceCredentialIfKey(r.workspace_id, r.integration_id, r.key_id, enc);
        if (ok) out.rotated += 1; else { out.conflicts += 1; skip.add(r.integration_id); }
      }
    }
    return out;
  }

  return { isConfigured, encrypt, decrypt, storeCredential, getCredentialForExecution, hasCredential, credentialMeta, deleteCredential, aadFor, rotateCredentials };
}

module.exports = { createCredentialService, loadKeyRing, CredentialError, aadFor, ALGORITHM };
