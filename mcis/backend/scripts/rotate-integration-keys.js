#!/usr/bin/env node
/**
 * Layer 9 — re-encrypt integration credentials under the CURRENT key.
 *
 * Key rotation procedure (see docs/PRODUCTION_RUNBOOK.md):
 *   1. INTEGRATION_ENCRYPTION_OLD_KEYS="k1:<old key>" ; INTEGRATION_ENCRYPTION_KEY=<new key> ; INTEGRATION_ENCRYPTION_KEY_ID=k2
 *   2. deploy (reads work with either key, new writes use k2)
 *   3. node scripts/rotate-integration-keys.js --dry-run   → counts
 *   4. node scripts/rotate-integration-keys.js             → re-encrypts
 *   5. when "remaining under old keys" is 0, remove the old key from INTEGRATION_ENCRYPTION_OLD_KEYS
 *
 * Prints counts only — never ids, plaintext or ciphertext. Needs the
 * service-role key (server side only).
 */
'use strict';

const path = require('path');

async function main() {
  require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });
  const dryRun = process.argv.includes('--dry-run');
  const { createCredentialService, loadKeyRing } = require('../services/integrations/credentialService');
  const { createSupabaseIntegrationStore } = require('../services/integrations/integrationStore');
  const keyRing = loadKeyRing(process.env);
  if (keyRing.error) throw new Error(keyRing.error);
  const store = createSupabaseIntegrationStore();
  const svc = createCredentialService({ store, keyRing });
  const out = await svc.rotateCredentials({ dryRun });
  const remaining = (await store.listCredentialsNotUnderKey(keyRing.current.id, 1000)).length;
  console.log(JSON.stringify({ ...out, currentKeyId: keyRing.current.id, remainingUnderOldKeys: remaining }));
  if (out.missingKey || out.unreadable) process.exit(2);
}

main().catch((err) => { console.error(`[rotate-integration-keys] ${err.message}`); process.exit(1); });
