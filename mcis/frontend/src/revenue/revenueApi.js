/**
 * Layer 10 — client for the revenue suite APIs (competitor intelligence,
 * monitoring + alerts, agent reliability, AI workforce, webhooks). Every
 * value shown comes from the server; the workspace id only selects among
 * the caller's own memberships and the backend re-checks it every time.
 */
import { api } from "../workflows/workflowsApi";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ws = (id) => {
  if (!UUID_RE.test(String(id))) throw new Error("Invalid workspace");
  return `/api/workspaces/${id}`;
};
const id = (x) => { if (!UUID_RE.test(String(x))) throw new Error("Invalid id"); return x; };
const post = (path, body = {}, headers) => api(path, { method: "POST", body, ...(headers ? { headers } : {}) });
const patch = (path, body) => api(path, { method: "PATCH", body });
const del = (path) => api(path, { method: "DELETE" });
const newKey = () => `ui-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

// Competitor intelligence
export const ciDashboard = (w) => api(`${ws(w)}/competitors/dashboard`);
export const createProduct = (w, body) => post(`${ws(w)}/competitors/products`, body);
export const addCompetitor = (w, productId, body) => post(`${ws(w)}/competitors/products/${id(productId)}/competitors`, body);
export const decideMatch = (w, productId, competitorId, decision, version) => post(`${ws(w)}/competitors/products/${id(productId)}/competitors/${id(competitorId)}/match`, { decision, version });
export const listRecommendations = (w, status = "open") => api(`${ws(w)}/competitors/recommendations?status=${encodeURIComponent(status)}`);
export const setRecommendationStatus = (w, recId, status) => post(`${ws(w)}/competitors/recommendations/${id(recId)}/status`, { status });
export const recommendationToTask = (w, recId) => post(`${ws(w)}/competitors/recommendations/${id(recId)}/act`, { action: "task" });

// Monitoring + alerts
export const listMonitors = (w) => api(`${ws(w)}/monitoring/monitors`);
export const createMonitor = (w, body) => post(`${ws(w)}/monitoring/monitors`, body);
export const checkMonitor = (w, monitorId) => post(`${ws(w)}/monitoring/monitors/${id(monitorId)}/check`, {}, { "Idempotency-Key": newKey() });
export const listChanges = (w) => api(`${ws(w)}/monitoring/changes?limit=50`);
export const listAlerts = (w) => api(`${ws(w)}/monitoring/alerts?limit=50`);
export const acknowledgeAlert = (w, alertId) => post(`${ws(w)}/monitoring/alerts/${id(alertId)}/acknowledge`);
export const retryDelivery = (w, alertId, deliveryId) => post(`${ws(w)}/monitoring/alerts/${id(alertId)}/deliveries/${id(deliveryId)}/retry`);
export const listRules = (w) => api(`${ws(w)}/monitoring/rules`);
export const createRule = (w, body) => post(`${ws(w)}/monitoring/rules`, body);
export const deleteRule = (w, ruleId) => del(`${ws(w)}/monitoring/rules/${id(ruleId)}`);
export const listIntegrations = (w) => api(`${ws(w)}/integrations`);

// Agent reliability (QA)
export const listProjects = (w) => api(`${ws(w)}/reliability/projects`);
export const getProject = (w, projectId) => api(`${ws(w)}/reliability/projects/${id(projectId)}`);
export const createProject = (w, body) => post(`${ws(w)}/reliability/projects`, body);
export const createSuite = (w, projectId, body) => post(`${ws(w)}/reliability/projects/${id(projectId)}/suites`, body);
export const createScenario = (w, suiteId, body) => post(`${ws(w)}/reliability/suites/${id(suiteId)}/scenarios`, body);
export const startQaRun = (w, projectId) => post(`${ws(w)}/reliability/projects/${id(projectId)}/runs`, {}, { "Idempotency-Key": newKey() });
export const getQaRun = (w, runId) => api(`${ws(w)}/reliability/runs/${id(runId)}`);
export const cancelQaRun = (w, runId) => post(`${ws(w)}/reliability/runs/${id(runId)}/cancel`);
export const projectMetrics = (w, projectId) => api(`${ws(w)}/reliability/projects/${id(projectId)}/metrics`);

// AI workforce
export const listAgents = (w) => api(`${ws(w)}/agents`);
export const createAgent = (w, body) => post(`${ws(w)}/agents`, body);
export const provisionAgents = (w) => post(`${ws(w)}/agents/defaults`);
export const updateAgent = (w, agentId, body) => patch(`${ws(w)}/agents/${id(agentId)}`, body);
export const agentTasks = (w, agentId) => api(`${ws(w)}/tasks?agentId=${encodeURIComponent(id(agentId))}&limit=50`);

// Webhooks
export const listWebhooks = (w) => api(`${ws(w)}/webhooks`);
export const createWebhook = (w, body) => post(`${ws(w)}/webhooks`, body);
export const rotateWebhook = (w, hookId) => post(`${ws(w)}/webhooks/${id(hookId)}/rotate-secret`);
export const testWebhook = (w, hookId) => post(`${ws(w)}/webhooks/${id(hookId)}/test`);
export const webhookDeliveries = (w, hookId) => api(`${ws(w)}/webhooks/${id(hookId)}/deliveries?limit=20`);
export const deleteWebhook = (w, hookId) => del(`${ws(w)}/webhooks/${id(hookId)}`);
export const WEBHOOK_EVENTS = ["execution.completed", "execution.failed", "workflow_run.completed", "workflow_run.failed", "alert.created", "monitor.changed", "recommendation.created", "qa_run.completed"];

/** Source health → label + colour. STALE / UNAVAILABLE are never shown as current. */
export const HEALTH = {
  PENDING: { label: "Not checked yet", color: "#777" },
  VERIFIED: { label: "Verified", color: "#1a9b5c" },
  UNVERIFIED: { label: "Unverified", color: "#c98a00" },
  STALE: { label: "Stale", color: "#c98a00" },
  UNAVAILABLE: { label: "Unavailable", color: "#c43d3d" },
};
export const fmtMoney = (v, currency) => {
  if (v === null || v === undefined) return "—";
  try { return new Intl.NumberFormat(undefined, { style: "currency", currency: currency || "INR", maximumFractionDigits: 2 }).format(v); } catch { return String(v); }
};
export const fmtTime = (t) => (t ? new Date(t).toLocaleString() : "—");
