/**
 * Layer 8 — client for onboarding, templates, overview, team, tasks,
 * executions / approvals and the public API description.
 *
 * The frontend is not an authorization layer: every call carries the
 * user's Firebase token and the backend re-checks membership, role and
 * plan on every request. Nothing here decides what a user may do; the UI
 * only hides controls the server would refuse anyway.
 */
import { api, BASE_URL, ApiError } from "../workflows/workflowsApi";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ws = (id) => {
  if (!UUID_RE.test(String(id))) throw new ApiError(404, "WORKSPACE_NOT_FOUND", "Workspace not found");
  return `/api/workspaces/${id}`;
};
const enc = encodeURIComponent;
const idem = () => (window.crypto && window.crypto.randomUUID ? window.crypto.randomUUID() : `k${Date.now()}${Math.random().toString(36).slice(2)}`);

// Onboarding (the caller's own)
export const getOnboarding = () => api("/api/onboarding");
export const startOnboarding = () => api("/api/onboarding/start", { method: "POST", body: {} });
export const chooseWorkspace = (body) => api("/api/onboarding/workspace", { method: "POST", body });
export const inviteTeam = (body) => api("/api/onboarding/team", { method: "POST", body });
export const chooseUseCase = (useCase) => api("/api/onboarding/use-case", { method: "POST", body: { useCase } });
export const createFirstWorkflow = (templateId, name) => api("/api/onboarding/template", { method: "POST", body: { templateId, ...(name ? { name } : {}) } });
export const runFirstTask = (inputs) => api("/api/onboarding/first-run", { method: "POST", body: { inputs } });
export const completeOnboarding = () => api("/api/onboarding/complete", { method: "POST", body: {} });

// Templates
export const listTemplates = (wsId, { useCase } = {}) => api(`${ws(wsId)}/templates${useCase ? `?useCase=${enc(useCase)}` : ""}`);
export const instantiateTemplate = (wsId, id, body = {}) => api(`${ws(wsId)}/templates/${enc(id)}/instantiate`, { method: "POST", body });

// Overview
export const getOverview = (wsId) => api(`${ws(wsId)}/overview`);

// Team (Layer 1)
export const listMembers = (wsId) => api(`${ws(wsId)}/members`);
export const changeRole = (wsId, userId, role) => api(`${ws(wsId)}/members/${enc(userId)}`, { method: "PATCH", body: { role } });
export const removeMember = (wsId, userId) => api(`${ws(wsId)}/members/${enc(userId)}`, { method: "DELETE" });
export const listInvitations = (wsId) => api(`${ws(wsId)}/invitations`);
export const createInvitation = (wsId, email, role) => api(`${ws(wsId)}/invitations`, { method: "POST", body: { email, role } });
export const acceptInvitation = (token) => api("/api/workspaces/invitations/accept", { method: "POST", body: { token } });
export const transferOwnership = (wsId, userId) => api(`${ws(wsId)}/transfer-ownership`, { method: "POST", body: { newOwnerId: userId } }); // Layer 9 (not "userId": the auth layer reserves that field for the caller's own id)
export const revokeInvitation = (wsId, id) => api(`${ws(wsId)}/invitations/${enc(id)}`, { method: "DELETE" });

// Data retention (Layer 9)
export const getRetention = (wsId) => api(`${ws(wsId)}/retention`);
export const saveRetention = (wsId, body) => api(`${ws(wsId)}/retention`, { method: "PUT", body });
export const purgeRetentionNow = (wsId) => api(`${ws(wsId)}/retention/purge`, { method: "POST", body: {} });

// Tasks (Layer 2)
export const listTasks = (wsId) => api(`${ws(wsId)}/tasks?limit=50`);
export const createTask = (wsId, body) => api(`${ws(wsId)}/tasks`, { method: "POST", body });
export const assignTask = (wsId, taskId, assignee) => api(`${ws(wsId)}/tasks/${enc(taskId)}/assign`, { method: "POST", body: { assignee } });
export const setTaskStatus = (wsId, taskId, status) => api(`${ws(wsId)}/tasks/${enc(taskId)}/status`, { method: "POST", body: { status } });
export const listActivity = (wsId, taskId) => api(`${ws(wsId)}/tasks/${enc(taskId)}/activity`);

// Executions + approvals (Layer 3) and workflow runs (Layer 4)
export const listExecutions = (wsId) => api(`${ws(wsId)}/executions?limit=20`);
export const getExecution = (wsId, id) => api(`${ws(wsId)}/executions/${enc(id)}`);
export const decideExecutionApproval = (wsId, execId, approvalId, decision) =>
  api(`${ws(wsId)}/executions/${enc(execId)}/approvals/${enc(approvalId)}/${decision === "approve" ? "approve" : "reject"}`, { method: "POST", body: {} });
export const listRecentRuns = (wsId) => api(`${ws(wsId)}/workflow-runs?limit=20`);
export const startExecution = (wsId, goal) => api(`${ws(wsId)}/executions`, { method: "POST", body: { goal }, headers: { "Idempotency-Key": idem() } });

// Public API description (no auth, no workspace data)
export async function getApiSpec() {
  const res = await fetch(`${BASE_URL}/api/automation/v1/openapi.json`);
  if (!res.ok) throw new ApiError(res.status, "SPEC_UNAVAILABLE", "API documentation is unavailable");
  return res.json();
}
export { BASE_URL };

export const ROLE_LABELS = { owner: "Owner", admin: "Admin", member: "Member" };
export const RISK_LABELS = { low: "Low risk", medium: "Medium risk", high: "High risk" };
