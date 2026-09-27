#!/usr/bin/env node
/**
 * Layer 6 — one-time migration of legacy plaintext GitHub OAuth tokens.
 *
 *   node scripts/migrate-legacy-github-tokens.js            # migrate
 *   node scripts/migrate-legacy-github-tokens.js --dry-run  # count only
 *
 * Requires SUPABASE_URL, SUPABASE_KEY (service role) and a valid
 * INTEGRATION_ENCRYPTION_KEY. Apply migrations/20260928_layer6_security.up.sql
 * first (it blocks NEW plaintext writes; this script moves the OLD ones).
 *
 * For every user_integrations row with a non-null github_token:
 *   1. store the token ENCRYPTED as the "GitHub account (OAuth)" integration
 *      in that user's personal workspace (same place new connections go);
 *   2. set user_integrations.github_token = NULL.
 * A row that cannot be migrated (e.g. no valid GitHub username recorded)
 * still has its plaintext token CLEARED — it is never kept — and the user
 * simply reconnects. Output is counts only; tokens are never printed.
 * Idempotent: re-running finds no plaintext tokens.
 */
'use strict';

const path = require('path');

const LOGIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

async function migrateLegacyGithubTokens({ legacy, workspaceService, integrationService, integrationStore, credentials, dryRun = false, logger = console }) {
  if (!dryRun && !credentials.isConfigured()) throw new Error('INTEGRATION_ENCRYPTION_KEY is not configured; refusing to migrate (tokens would have nowhere safe to go).');
  const rows = await legacy.listPlaintextRows();
  const out = { found: rows.length, migrated: 0, cleared: 0, clearedWithoutMigration: 0, failed: 0 };
  if (dryRun) return out;
  for (const row of rows) {
    let migrated = false;
    try {
      const login = typeof row.github_username === 'string' && LOGIN_RE.test(row.github_username) ? row.github_username : null;
      const token = typeof row.github_token === 'string' ? row.github_token.trim() : '';
      if (login && /^[A-Za-z0-9_]{20,255}$/.test(token)) {
        const ws = await workspaceService.ensurePersonalWorkspace(row.user_id);
        const ctx = { workspace: { id: ws.id }, role: 'owner', userId: row.user_id };
        const config = { allowedRepos: [`${login}/*`], authMethod: 'oauth', account: login };
        const existing = (await integrationStore.listIntegrations(ws.id))
          .find((i) => i.provider === 'github' && i.name === 'GitHub account (OAuth)' && i.config && i.config.authMethod === 'oauth');
        if (existing) {
          // A connection made through the new flow wins; the old token is only cleared.
          migrated = true;
        } else {
          await integrationService.createIntegration(ctx, { provider: 'github', name: 'GitHub account (OAuth)', config, credentials: { token } });
          migrated = true;
          out.migrated += 1;
        }
      }
    } catch (err) {
      out.failed += 1;
      logger.error(`[migrate-github] row for one user could not be migrated (${err.code || err.name}); its plaintext token will still be cleared`);
    }
    try {
      await legacy.clearToken(row.user_id);
      out.cleared += 1;
      if (!migrated) out.clearedWithoutMigration += 1;
    } catch (err) {
      out.failed += 1;
      logger.error(`[migrate-github] could not clear a plaintext token (${err.code || err.name})`);
    }
  }
  return out;
}

function supabaseLegacyStore() {
  const { createClient } = require('@supabase/supabase-js');
  const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
  const unwrap = ({ data, error }) => { if (error) throw Object.assign(new Error(error.message), { code: error.code }); return data; };
  return {
    async listPlaintextRows() {
      return unwrap(await db.from('user_integrations').select('user_id, github_token, github_username').not('github_token', 'is', null).limit(10000));
    },
    async clearToken(userId) {
      unwrap(await db.from('user_integrations').update({ github_token: null, updated_at: new Date().toISOString() }).eq('user_id', userId));
    },
  };
}

async function main() {
  require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
  const dryRun = process.argv.includes('--dry-run');
  const { createSupabaseWorkspaceStore } = require('../services/workspaceStore');
  const { createWorkspaceService } = require('../services/workspaceService');
  const { createSupabaseIntegrationStore } = require('../services/integrations/integrationStore');
  const { createCredentialService, loadKeyRing } = require('../services/integrations/credentialService');
  const { createSafeHttpClient } = require('../services/integrations/safeHttp');
  const { createDefaultRegistry } = require('../services/integrations/connectorRegistry');
  const { createIntegrationService } = require('../services/integrations/integrationService');
  const { appendAuditLog } = require('../security-engine/auditLog');
  const wsStore = createSupabaseWorkspaceStore();
  const integrationStore = createSupabaseIntegrationStore();
  const credentials = createCredentialService({ store: integrationStore, keyRing: loadKeyRing() });
  const integrationService = createIntegrationService({
    store: integrationStore, registry: createDefaultRegistry(), credentials, http: createSafeHttpClient(), appendAuditLog,
    getMemberRole: async (ws, uid) => { const m = await wsStore.getMember(ws, uid); return m ? m.role : null; },
  });
  const out = await migrateLegacyGithubTokens({
    legacy: supabaseLegacyStore(), workspaceService: createWorkspaceService(wsStore), integrationService, integrationStore, credentials, dryRun,
  });
  console.log(JSON.stringify({ dryRun, ...out }));
  if (out.failed) process.exitCode = 1;
}

if (require.main === module) {
  main().catch((err) => { console.error(`[migrate-github] failed: ${err.message}`); process.exit(1); });
}

module.exports = { migrateLegacyGithubTokens };
