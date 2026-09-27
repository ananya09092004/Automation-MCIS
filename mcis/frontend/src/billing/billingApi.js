/**
 * Layer 7 — client for the workspace billing / usage API. Every number
 * shown comes from the server; nothing here computes or sends usage.
 */
import { api } from "../workflows/workflowsApi";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const base = (wsId) => {
  if (!UUID_RE.test(String(wsId))) throw new Error("Invalid workspace");
  return `/api/workspaces/${wsId}/billing`;
};

export const getSummary = (wsId) => api(base(wsId));
export const getPlans = (wsId) => api(`${base(wsId)}/plans`);
export const getDashboard = (wsId, days = 30) => api(`${base(wsId)}/dashboard?days=${encodeURIComponent(days)}`);
export const requestCheckout = (wsId, planId) => api(`${base(wsId)}/subscription/checkout`, { method: "POST", body: { planId } });
// Layer 8: provider-hosted management + cancel at period end (confirmed by the provider's webhook).
export const requestPortal = (wsId) => api(`${base(wsId)}/subscription/portal`, { method: "POST", body: {} });
export const requestCancel = (wsId) => api(`${base(wsId)}/subscription/cancel`, { method: "POST", body: {} });

/** Display price from the plan catalogue (null = not configured → "price on request"). */
export function formatPrice(price) {
  if (!price || typeof price !== "object") return null;
  if (typeof price.display === "string" && price.display.trim()) return price.display.trim();
  if (typeof price.amount === "number" && typeof price.currency === "string") {
    try {
      const money = new Intl.NumberFormat(undefined, { style: "currency", currency: price.currency.toUpperCase(), maximumFractionDigits: 2 }).format(price.amount);
      return `${money} / ${price.interval || "month"}`;
    } catch { return null; }
  }
  return null;
}

export const CAPABILITY_LABELS = {
  executions: "Agent executions / month",
  workflow_runs: "Workflow runs / month",
  api_calls: "API calls / month",
  connector_calls: "Connector calls / month",
  members: "Members",
  active_workflows: "Active workflows",
  concurrent_executions: "Concurrent executions",
  // Layer 10
  monitoring_checks: "Monitoring checks / month",
  agent_test_scenarios: "Agent test scenarios / month",
  monitored_products: "Monitored products",
  integrations: "Integrations",
};

export const STATUS_LABELS = {
  none: "Free (no subscription)",
  trialing: "Trial",
  active: "Active",
  past_due: "Payment overdue",
  cancelled: "Cancelled",
  expired: "Expired",
};
