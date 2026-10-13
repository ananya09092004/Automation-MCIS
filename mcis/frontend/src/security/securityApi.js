/**
 * Layer 6 — client for the workspace security API. The backend is the only
 * authority on roles; responses never contain secrets (no credentials, key
 * hashes, OAuth tokens). A newly created / rotated API key is returned ONCE
 * and must never be stored by this app.
 */
import { api } from "../workflows/workflowsApi";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const base = (wsId) => {
  if (!UUID_RE.test(String(wsId))) throw new Error("Invalid workspace");
  return `/api/workspaces/${wsId}/security`;
};

export const getDashboard = (wsId) => api(base(wsId));
export const getPolicy = (wsId) => api(`${base(wsId)}/policy`);
export const savePolicy = (wsId, version, policy) => api(`${base(wsId)}/policy`, { method: "PUT", body: { version, policy } });
export const listEvents = (wsId, limit = 50) => api(`${base(wsId)}/events?limit=${encodeURIComponent(limit)}`);
export const createApiKey = (wsId, body) => api(`${base(wsId)}/api-keys`, { method: "POST", body });
export const revokeApiKey = (wsId, id) => api(`${base(wsId)}/api-keys/${encodeURIComponent(id)}/revoke`, { method: "POST", body: {} });
export const rotateApiKey = (wsId, id) => api(`${base(wsId)}/api-keys/${encodeURIComponent(id)}/rotate`, { method: "POST", body: {} });
export const startGithubOAuth = (wsId) => api(`${base(wsId)}/oauth/github/start`, { method: "POST", body: {} });
export const completeGithubOAuth = (wsId, code, state) => api(`${base(wsId)}/oauth/github/complete`, { method: "POST", body: { code, state } });
// Layer 9
export const getOAuthProviders = (wsId) => api(`${base(wsId)}/oauth/providers`);
export const startDriveOAuth = (wsId) => api(`${base(wsId)}/oauth/google_drive/start`, { method: "POST", body: {} });
export const completeDriveOAuth = (wsId, code, state) => api(`${base(wsId)}/oauth/google_drive/complete`, { method: "POST", body: { code, state } });
export const setEmergencyStop = (wsId, active) => api(`${base(wsId)}/emergency-stop`, { method: "POST", body: { active: !!active } });

/** Reads (and removes) an OAuth result from the URL fragment. */
export function takeOAuthFragment(loc = window.location, hist = window.history) {
  const h = String(loc.hash || "").replace(/^#/, "");
  if (!h) return null;
  const p = new URLSearchParams(h);
  const provider = p.get("oauth");
  if (!["github", "google_drive"].includes(provider)) return null;
  try { hist.replaceState(null, "", loc.pathname + loc.search); } catch { /* ignore */ }
  if (p.get("error") || !p.get("code") || !p.get("state")) return { provider, error: true };
  return { provider, code: p.get("code"), state: p.get("state") };
}
