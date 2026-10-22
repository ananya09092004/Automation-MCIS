// Every call the console makes, in one place. Workspace id always comes
// from the URL path; the backend re-checks membership and role (non-members
// get 404) — the UI never decides access on its own.
import { newIdempotencyKey } from './api.js';

const enc = encodeURIComponent;
const ws = (id) => `/api/workspaces/${enc(id)}`;
const post = (api, path, body = {}, headers) => api.request(path, { method: 'POST', body, headers });

export const endpoints = {
  // Workspaces & team (Layer 1)
  listWorkspaces: (api) => api.request('/api/workspaces'),
  getWorkspace: (api, w) => api.request(ws(w)),
  createWorkspace: (api, name) => post(api, '/api/workspaces', { name }),
  acceptInvitation: (api, token) => post(api, '/api/workspaces/invitations/accept', { token }),
  listMembers: (api, w) => api.request(`${ws(w)}/members`),
  listInvitations: (api, w) => api.request(`${ws(w)}/invitations`),
  createInvitation: (api, w, email, role) => post(api, `${ws(w)}/invitations`, { email, role }),
  revokeInvitation: (api, w, id) => api.request(`${ws(w)}/invitations/${enc(id)}`, { method: 'DELETE' }),

  // Onboarding (Layer 8) — account-level, resumable, idempotent on the server
  onboarding: (api) => api.request('/api/onboarding'),
  onboardingStart: (api) => post(api, '/api/onboarding/start'),
  onboardingWorkspace: (api, body) => post(api, '/api/onboarding/workspace', body),
  onboardingTeam: (api, body) => post(api, '/api/onboarding/team', body),
  onboardingUseCase: (api, useCase) => post(api, '/api/onboarding/use-case', { useCase }),
  onboardingTemplate: (api, templateId) => post(api, '/api/onboarding/template', { templateId }),
  onboardingFirstRun: (api, inputs) => post(api, '/api/onboarding/first-run', { inputs }),
  onboardingComplete: (api) => post(api, '/api/onboarding/complete'),
  listTemplates: (api, w, useCase) => api.request(`${ws(w)}/templates${useCase ? `?useCase=${enc(useCase)}` : ''}`),

  // Overview (Layer 8) — the dashboard's single aggregate
  overview: (api, w) => api.request(`${ws(w)}/overview`),

  // Agent executions = tasks the agent runs (Layer 3)
  listExecutions: (api, w, limit = 50) => api.request(`${ws(w)}/executions?limit=${enc(limit)}`),
  getExecution: (api, w, id) => api.request(`${ws(w)}/executions/${enc(id)}`),
  getEvidence: (api, w, id) => api.request(`${ws(w)}/executions/${enc(id)}/evidence`),
  startExecution: (api, w, goal, key = newIdempotencyKey()) => post(api, `${ws(w)}/executions`, { goal }, { 'Idempotency-Key': key }),
  cancelExecution: (api, w, id) => post(api, `${ws(w)}/executions/${enc(id)}/cancel`),
  decideExecutionApproval: (api, w, execId, approvalId, decision, note) =>
    post(api, `${ws(w)}/executions/${enc(execId)}/approvals/${enc(approvalId)}/${decision === 'approve' ? 'approve' : 'reject'}`, note ? { note } : {}),

  // AI workforce agents (Layer 10)
  listAgents: (api, w) => api.request(`${ws(w)}/agents`),
  createAgent: (api, w, body) => post(api, `${ws(w)}/agents`, body),

  // Workflows (Layer 4)
  listWorkflows: (api, w) => api.request(`${ws(w)}/workflows`),
  getWorkflow: (api, w, id) => api.request(`${ws(w)}/workflows/${enc(id)}`),
  getVersion: (api, w, id, version) => api.request(`${ws(w)}/workflows/${enc(id)}/versions/${enc(version)}`),
  startRun: (api, w, id, inputs, key = newIdempotencyKey()) => post(api, `${ws(w)}/workflows/${enc(id)}/runs`, { inputs }, { 'Idempotency-Key': key }),
  listRecentRuns: (api, w, limit = 50) => api.request(`${ws(w)}/workflow-runs?limit=${enc(limit)}`),
  getRun: (api, w, runId) => api.request(`${ws(w)}/workflow-runs/${enc(runId)}`),
  decideRunApproval: (api, w, runId, position, approvalId, decision, note) =>
    post(api, `${ws(w)}/workflow-runs/${enc(runId)}/steps/${enc(position)}/approvals/${enc(approvalId)}/${decision === 'approve' ? 'approve' : 'reject'}`, note ? { note } : {}),

  // Integrations (Layer 5)
  listIntegrations: (api, w) => api.request(`${ws(w)}/integrations`),
  createIntegration: (api, w, body) => post(api, `${ws(w)}/integrations`, body),
  updateIntegration: (api, w, id, body) => api.request(`${ws(w)}/integrations/${enc(id)}`, { method: 'PATCH', body }),

  // Product monitoring (Layer 10) — the data behind Compare
  listProductMonitors: (api, w) => api.request(`${ws(w)}/monitoring/monitors?kind=product&limit=200`),
  getMonitor: (api, w, id) => api.request(`${ws(w)}/monitoring/monitors/${enc(id)}`),
  createMonitor: (api, w, body) => post(api, `${ws(w)}/monitoring/monitors`, body),
  checkMonitor: (api, w, id, key = newIdempotencyKey()) => post(api, `${ws(w)}/monitoring/monitors/${enc(id)}/check`, {}, { 'Idempotency-Key': key }),
  deleteMonitor: (api, w, id) => api.request(`${ws(w)}/monitoring/monitors/${enc(id)}`, { method: 'DELETE' }),
  checkIntegrationHealth: (api, w, id) => post(api, `${ws(w)}/integrations/${enc(id)}/health`),

  // Activity (Layer 2 audit + Layer 6 security events; admin only)
  listAudit: (api, w, limit = 100) => api.request(`${ws(w)}/audit?limit=${enc(limit)}`),
  listSecurityEvents: (api, w, limit = 50) => api.request(`${ws(w)}/security/events?limit=${enc(limit)}`),
  securityDashboard: (api, w) => api.request(`${ws(w)}/security`),
  setEmergencyStop: (api, w, active) => post(api, `${ws(w)}/security/emergency-stop`, { active: !!active }),

  // Paired desktop devices (account-level; the caller's own devices only)
  listDevices: async (api) => {
    const r = await api.request('/api/device/list'); // legacy shape: { success, devices }
    return (r && r.devices) || [];
  },
  revokeDevice: (api, deviceId) => api.request(`/api/device/${enc(deviceId)}`, { method: 'DELETE' }),

  // Usage & billing (Layer 7/8)
  billingSummary: (api, w) => api.request(`${ws(w)}/billing`),
  billingPlans: (api, w) => api.request(`${ws(w)}/billing/plans`),
  billingDashboard: (api, w, days = 30) => api.request(`${ws(w)}/billing/dashboard?days=${enc(days)}`),
  billingCheckout: (api, w, planId) => post(api, `${ws(w)}/billing/subscription/checkout`, { planId }),
  billingPortal: (api, w) => post(api, `${ws(w)}/billing/subscription/portal`),
  billingCancel: (api, w) => post(api, `${ws(w)}/billing/subscription/cancel`),
};
