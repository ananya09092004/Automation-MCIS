/**
 * TEST-ONLY in-memory implementation of services/integrations/integrationStore.js.
 * Mirrors migrations/20260927_layer5_integrations.up.sql:
 *   - unique (workspace_id, lower(name))                          → 23505
 *   - credentials / permissions must match the integration's workspace → 23503
 *   - one credential per integration (upsert), permissions keyed by (integration, action)
 *   - optimistic version check on update
 * Every method yields to the event loop so concurrent callers interleave.
 */
'use strict';

const tick = () => new Promise((r) => setImmediate(r));
const clone = (o) => (o == null ? null : JSON.parse(JSON.stringify(o)));
const err = (code, message) => Object.assign(new Error(message), { code });

function createMemoryIntegrationStore() {
  const integrations = new Map();
  const credentials = new Map();
  const permissions = new Map();
  const iso = () => new Date().toISOString();
  const parentOk = (ws, id) => { const i = integrations.get(id); return !!i && i.workspace_id === ws; };

  return {
    _dump: () => ({ integrations: [...integrations.values()], credentials: [...credentials.values()], permissions: [...permissions.values()] }),

    async insertIntegration(row) {
      await tick();
      if ([...integrations.values()].some((i) => i.workspace_id === row.workspace_id && i.name.toLowerCase() === row.name.toLowerCase())) {
        throw err('23505', 'duplicate key value violates unique constraint "integrations_ws_name_uq"');
      }
      const full = { status: 'disconnected', config: {}, last_used_at: null, last_checked_at: null, last_error: null, version: 0, created_at: iso(), updated_at: iso(), ...clone(row) };
      integrations.set(full.id, full);
      return clone(full);
    },
    async enforceIntegrationLimit(workspaceId, integrationId, limit) {
      await tick();
      const n = [...integrations.values()].filter((i) => i.workspace_id === workspaceId).length;
      if (n <= limit) return true;
      integrations.delete(integrationId);
      return false;
    },
    async deleteIntegration(workspaceId, id) {
      await tick();
      const i = integrations.get(id);
      if (i && i.workspace_id === workspaceId) integrations.delete(id);
    },
    async getIntegration(workspaceId, id) {
      await tick();
      const i = integrations.get(id);
      return i && i.workspace_id === workspaceId ? clone(i) : null;
    },
    async listIntegrations(workspaceId) {
      await tick();
      return [...integrations.values()].filter((i) => i.workspace_id === workspaceId).map(clone);
    },
    async updateIntegration(workspaceId, id, expectedVersion, patch) {
      await tick();
      const i = integrations.get(id);
      if (!i || i.workspace_id !== workspaceId || i.version !== expectedVersion) return null;
      if (patch.name && [...integrations.values()].some((o) => o.id !== id && o.workspace_id === workspaceId && o.name.toLowerCase() === patch.name.toLowerCase())) {
        throw err('23505', 'duplicate key value violates unique constraint "integrations_ws_name_uq"');
      }
      Object.assign(i, clone(patch), { version: expectedVersion + 1, updated_at: iso() });
      return clone(i);
    },
    async touchIntegration(workspaceId, id, patch) {
      await tick();
      const i = integrations.get(id);
      if (i && i.workspace_id === workspaceId) Object.assign(i, clone(patch), { updated_at: iso() });
    },
    async listPermissions(workspaceId, integrationId) {
      await tick();
      return [...permissions.values()].filter((p) => p.workspace_id === workspaceId && p.integration_id === integrationId).map(clone);
    },
    async upsertPermissions(rows) {
      await tick();
      for (const r of rows) if (!parentOk(r.workspace_id, r.integration_id)) throw err('23503', 'violates foreign key constraint (integration_id, workspace_id)');
      for (const r of rows) permissions.set(`${r.integration_id}:${r.action}`, clone(r));
      return rows.map(clone);
    },
    async upsertCredential(row) {
      await tick();
      if (!parentOk(row.workspace_id, row.integration_id)) throw err('23503', 'violates foreign key constraint (integration_id, workspace_id)');
      credentials.set(row.integration_id, clone(row));
    },
    async getCredential(workspaceId, integrationId) {
      await tick();
      const c = credentials.get(integrationId);
      return c && c.workspace_id === workspaceId ? clone(c) : null;
    },
    async getCredentialMeta(workspaceId, integrationId) {
      await tick();
      const c = credentials.get(integrationId);
      return c && c.workspace_id === workspaceId ? { integration_id: c.integration_id, key_id: c.key_id, created_at: c.created_at } : null;
    },
    async deleteCredential(workspaceId, integrationId) {
      await tick();
      const c = credentials.get(integrationId);
      if (c && c.workspace_id === workspaceId) credentials.delete(integrationId);
    },
    async listCredentialsNotUnderKey(currentKeyId, limit = 200) {
      await tick();
      return [...credentials.values()].filter((c) => c.key_id !== currentKeyId).slice(0, limit).map(clone);
    },
    async replaceCredentialIfKey(workspaceId, integrationId, expectedKeyId, patch) {
      await tick();
      const c = credentials.get(integrationId);
      if (!c || c.workspace_id !== workspaceId || c.key_id !== expectedKeyId) return false;
      Object.assign(c, clone(patch));
      return true;
    },
    _credentials: credentials,
  };
}

module.exports = { createMemoryIntegrationStore };
