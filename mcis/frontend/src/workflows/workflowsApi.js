/**
 * Layer 4 — minimal client for workspaces + workflows.
 *
 * The frontend is NOT an authorization layer: every call carries the
 * Firebase ID token and the workspace id only SELECTS among the caller's
 * own memberships. The backend re-checks membership, role and ownership
 * on every request (non-members get 404). The remembered workspace is a
 * per-browser convenience and is re-validated against the server's list.
 */
import { auth } from "../firebase";

export const BASE_URL = process.env.REACT_APP_API_URL || "https://mcis-backend.onrender.com";
const STORAGE_PREFIX = "mcis.currentWorkspace.";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message || `Request failed (${status})`);
    this.status = status;
    this.code = code || null;
    this.details = details || null;
  }
}

async function authHeaders() {
  const user = auth && auth.currentUser;
  const token = user ? await user.getIdToken() : null;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export async function api(path, { method = "GET", body, headers = {} } = {}) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(await authHeaders()),
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* empty body */ }
  if (!res.ok || !json || json.success === false) {
    throw new ApiError(res.status, json && json.code, json && json.error, json && json.details);
  }
  return json.data;
}

// ---------------------------------------------------------------------
// Current workspace (per signed-in user, per browser)
// ---------------------------------------------------------------------
export function getStoredWorkspaceId(uid) {
  try {
    const v = window.localStorage.getItem(STORAGE_PREFIX + uid);
    return v && UUID_RE.test(v) ? v : null;
  } catch {
    return null;
  }
}

export function storeWorkspaceId(uid, workspaceId) {
  try {
    if (workspaceId) window.localStorage.setItem(STORAGE_PREFIX + uid, workspaceId);
    else window.localStorage.removeItem(STORAGE_PREFIX + uid);
  } catch { /* storage unavailable: selection just isn't remembered */ }
}

/**
 * Picks the workspace to show: the remembered one ONLY if the server
 * still lists it among the user's memberships, else the personal one.
 */
export function pickWorkspace(workspaces, storedId) {
  if (!Array.isArray(workspaces) || !workspaces.length) return null;
  const stored = storedId && workspaces.find((w) => w.id === storedId);
  return stored || workspaces.find((w) => w.is_personal) || workspaces[0];
}

export const listWorkspaces = () => api("/api/workspaces");

const ws = (id) => {
  if (!UUID_RE.test(String(id))) throw new ApiError(404, "WORKSPACE_NOT_FOUND", "Workspace not found");
  return `/api/workspaces/${id}`;
};
const idem = () => (window.crypto && window.crypto.randomUUID ? window.crypto.randomUUID() : `k${Date.now()}${Math.random().toString(36).slice(2)}`);

// ---------------------------------------------------------------------
// Workflows
// ---------------------------------------------------------------------
export const listWorkflows = (wsId) => api(`${ws(wsId)}/workflows`);
export const getWorkflow = (wsId, id) => api(`${ws(wsId)}/workflows/${encodeURIComponent(id)}`);
export const createWorkflow = (wsId, body) => api(`${ws(wsId)}/workflows`, { method: "POST", body });
export const updateWorkflow = (wsId, id, body) => api(`${ws(wsId)}/workflows/${encodeURIComponent(id)}`, { method: "PATCH", body });
export const publishWorkflow = (wsId, id) => api(`${ws(wsId)}/workflows/${encodeURIComponent(id)}/publish`, { method: "POST", body: {} });
export const archiveWorkflow = (wsId, id) => api(`${ws(wsId)}/workflows/${encodeURIComponent(id)}/archive`, { method: "POST", body: {} });
export const activateWorkflow = (wsId, id) => api(`${ws(wsId)}/workflows/${encodeURIComponent(id)}/activate`, { method: "POST", body: {} });
// One idempotency key per click: a double-submit can never start two runs.
export const startRun = (wsId, id, inputs, key = idem()) => api(`${ws(wsId)}/workflows/${encodeURIComponent(id)}/runs`, {
  method: "POST", body: { inputs }, headers: { "Idempotency-Key": `ui-${key}` },
});
export const listRuns = (wsId, workflowId) => api(`${ws(wsId)}/workflows/${encodeURIComponent(workflowId)}/runs`);
export const getRun = (wsId, runId) => api(`${ws(wsId)}/workflow-runs/${encodeURIComponent(runId)}`);
export const cancelRun = (wsId, runId) => api(`${ws(wsId)}/workflow-runs/${encodeURIComponent(runId)}/cancel`, { method: "POST", body: {} });
export const resolveRun = (wsId, runId, action) => api(`${ws(wsId)}/workflow-runs/${encodeURIComponent(runId)}/resolve`, { method: "POST", body: { action } });
export const decideApproval = (wsId, runId, position, approvalId, decision) => api(
  `${ws(wsId)}/workflow-runs/${encodeURIComponent(runId)}/steps/${encodeURIComponent(position)}/approvals/${encodeURIComponent(approvalId)}/${decision === "approve" ? "approve" : "reject"}`,
  { method: "POST", body: {} },
);
export const getVersion = (wsId, id, version) => api(`${ws(wsId)}/workflows/${encodeURIComponent(id)}/versions/${encodeURIComponent(version)}`);
