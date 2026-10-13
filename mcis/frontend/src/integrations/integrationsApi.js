/**
 * Layer 5 — client for workspace integrations. Reuses the authenticated
 * `api()` helper from the workflows client. The backend is the only
 * authority on roles/permissions; responses never contain credentials.
 * Credentials are sent once (connect / rotate) and never stored here.
 */
import { api } from "../workflows/workflowsApi";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const base = (wsId) => {
  if (!UUID_RE.test(String(wsId))) throw new Error("Invalid workspace");
  return `/api/workspaces/${wsId}/integrations`;
};
const one = (wsId, id) => `${base(wsId)}/${encodeURIComponent(id)}`;

export const listProviders = (wsId) => api(`${base(wsId)}/providers`);
export const listIntegrations = (wsId) => api(base(wsId));
export const getIntegration = (wsId, id) => api(one(wsId, id));
export const connectIntegration = (wsId, { provider, name, config, credentials }) =>
  api(base(wsId), { method: "POST", body: { provider, name, config, ...(credentials ? { credentials } : {}) } });
export const rotateCredential = (wsId, id, credentials) => api(`${one(wsId, id)}/credentials`, { method: "POST", body: { credentials } });
export const disconnectIntegration = (wsId, id) => api(`${one(wsId, id)}/disconnect`, { method: "POST", body: {} });
export const reconnectIntegration = (wsId, id) => api(`${one(wsId, id)}/reconnect`, { method: "POST", body: {} });
export const checkHealth = (wsId, id) => api(`${one(wsId, id)}/health`, { method: "POST", body: {} });
export const updatePermissions = (wsId, id, actions) => api(`${one(wsId, id)}/permissions`, { method: "PUT", body: { actions } });

/** "GitHub — Read repository" style label; never includes secrets. */
export function actionLabel(integration, action) {
  return `${integration.providerName} — ${action.label}`;
}
