/**
 * Layer 5 — Supabase persistence for integrations, encrypted credentials
 * and per-action permissions. Tables: migrations/20260927_layer5_integrations.up.sql
 *
 * Every query is filtered by workspace_id. Credential rows are only read
 * by the credential service; listing/metadata reads never select the
 * ciphertext columns.
 */
'use strict';

const { createClient } = require('@supabase/supabase-js');

let client = null;
function db() {
  if (!client) client = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
  return client;
}

function unwrap({ data, error }) {
  if (error) {
    const err = new Error(error.message || 'Database error');
    err.code = error.code;
    err.dbError = true;
    throw err;
  }
  return data;
}
const first = (rows) => (Array.isArray(rows) ? rows[0] || null : rows || null);
const nowIso = () => new Date().toISOString();

function createSupabaseIntegrationStore() {
  return {
    async insertIntegration(row) {
      return unwrap(await db().from('integrations').insert(row).select('*').single());
    },
    // Layer 10: count limit (RPC re-counts under the workspace row lock and removes an over-limit insert).
    async enforceIntegrationLimit(workspaceId, integrationId, limit) {
      return unwrap(await db().rpc('enforce_integration_limit', { p_workspace: workspaceId, p_integration: integrationId, p_limit: limit })) === true;
    },
    async deleteIntegration(workspaceId, id) {
      unwrap(await db().from('integrations').delete().eq('workspace_id', workspaceId).eq('id', id));
    },
    async getIntegration(workspaceId, id) {
      return first(unwrap(await db().from('integrations').select('*').eq('workspace_id', workspaceId).eq('id', id).limit(1)));
    },
    async listIntegrations(workspaceId) {
      return unwrap(await db().from('integrations').select('*').eq('workspace_id', workspaceId).order('created_at', { ascending: true }));
    },
    async updateIntegration(workspaceId, id, expectedVersion, patch) {
      return first(unwrap(await db().from('integrations')
        .update({ ...patch, version: expectedVersion + 1, updated_at: nowIso() })
        .eq('workspace_id', workspaceId).eq('id', id).eq('version', expectedVersion).select('*')));
    },
    // Runtime bookkeeping (last_used_at / status after a provider auth
    // failure). Not versioned on purpose: it must never block an admin edit.
    async touchIntegration(workspaceId, id, patch) {
      unwrap(await db().from('integrations').update({ ...patch, updated_at: nowIso() }).eq('workspace_id', workspaceId).eq('id', id));
    },

    async listPermissions(workspaceId, integrationId) {
      return unwrap(await db().from('integration_permissions').select('*').eq('workspace_id', workspaceId).eq('integration_id', integrationId));
    },
    async upsertPermissions(rows) {
      return unwrap(await db().from('integration_permissions').upsert(rows, { onConflict: 'integration_id,action' }).select('*'));
    },

    async upsertCredential(row) {
      unwrap(await db().from('integration_credentials').upsert(row, { onConflict: 'integration_id' }));
    },
    async getCredential(workspaceId, integrationId) {
      return first(unwrap(await db().from('integration_credentials')
        .select('integration_id, workspace_id, key_id, algorithm, iv, auth_tag, ciphertext')
        .eq('workspace_id', workspaceId).eq('integration_id', integrationId).limit(1)));
    },
    async getCredentialMeta(workspaceId, integrationId) {
      return first(unwrap(await db().from('integration_credentials')
        .select('integration_id, key_id, created_at')
        .eq('workspace_id', workspaceId).eq('integration_id', integrationId).limit(1)));
    },
    async deleteCredential(workspaceId, integrationId) {
      unwrap(await db().from('integration_credentials').delete().eq('workspace_id', workspaceId).eq('integration_id', integrationId));
    },
    /** Layer 9 (key rotation): credentials NOT under the current key, oldest first. */
    async listCredentialsNotUnderKey(currentKeyId, limit = 200) {
      return unwrap(await db().from('integration_credentials')
        .select('integration_id, workspace_id, key_id, algorithm, iv, auth_tag, ciphertext')
        .neq('key_id', currentKeyId).order('created_at', { ascending: true }).limit(limit));
    },
    /** Layer 9: replace a credential only if it is still under the key we read (CAS). */
    async replaceCredentialIfKey(workspaceId, integrationId, expectedKeyId, patch) {
      const rows = unwrap(await db().from('integration_credentials').update(patch)
        .eq('workspace_id', workspaceId).eq('integration_id', integrationId).eq('key_id', expectedKeyId)
        .select('integration_id'));
      return (rows || []).length === 1;
    },
  };
}

module.exports = { createSupabaseIntegrationStore };
