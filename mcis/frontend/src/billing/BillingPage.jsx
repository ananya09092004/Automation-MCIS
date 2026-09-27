/**
 * Layer 7 — Billing & usage page (served at /billing).
 *
 *   current plan · subscription status · billing period · usage meters
 *   (used / limit / remaining) · usage dashboard (executions, runs,
 *   success rate, steps, connector + API calls, 30-day trend) · plans
 *
 * Honest by design: when no payment provider is configured the page says
 * so and upgrade/manage actions are shown as unavailable — nothing pretends
 * a payment happened. When BILLING_ENABLED is off it says limits are not
 * enforced. All data comes from the server; authorization is enforced there.
 *
 * Layer 8: Upgrade (provider checkout), Manage subscription (provider
 * portal) and Cancel (at period end) are enabled only when the server says
 * the provider can do it for this caller (summary.paymentStatus). A return
 * from checkout never claims success: the plan changes when the provider
 * confirms it by webhook.
 */
import React, { useCallback, useEffect, useState } from "react";
import { onAuthStateChanged } from "firebase/auth";
import { auth } from "../firebase";
import * as wfApi from "../workflows/workflowsApi";
import * as billApi from "./billingApi";

const card = { background: "var(--mcis-surface, #fff)", border: "1px solid var(--mcis-border, #ddd)", borderRadius: 12, padding: 16, display: "grid", gap: 10 };
const btn = { padding: "6px 12px", borderRadius: 8, border: "1px solid var(--mcis-border, #ccc)", background: "var(--mcis-input, #f7f7f7)", color: "inherit", cursor: "pointer", fontSize: 13 };
const input = { padding: "7px 9px", borderRadius: 8, border: "1px solid var(--mcis-border, #ccc)", background: "var(--mcis-input, #fff)", color: "inherit", fontSize: 13 };
const muted = { color: "var(--mcis-muted, #777)", fontSize: 12 };
const fmtDate = (d) => (d ? new Date(d).toLocaleDateString() : "—");
const fmtNum = (n) => (n === null || n === undefined ? "—" : Number(n).toLocaleString());

function Meter({ m }) {
  const pct = m.unlimited || !m.limit ? 0 : Math.min(100, Math.round(((m.used || 0) / m.limit) * 100));
  const color = pct >= 100 ? "#c43d3d" : pct >= 80 ? "#c98a00" : "#1a9b5c";
  return (
    <div data-testid={`meter-${m.capability}`} style={{ display: "grid", gap: 4 }}>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13 }}>
        <span>{billApi.CAPABILITY_LABELS[m.capability] || m.capability}</span>
        <span>{m.unlimited ? `${fmtNum(m.used)} used · Unlimited` : `${fmtNum(m.used)} / ${fmtNum(m.limit)} · ${fmtNum(m.remaining)} left`}</span>
      </div>
      {!m.unlimited && (
        <div role="progressbar" aria-label={billApi.CAPABILITY_LABELS[m.capability] || m.capability} aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}
          style={{ height: 8, borderRadius: 4, background: "var(--mcis-border, #eee)", overflow: "hidden" }}>
          <div style={{ width: `${pct}%`, height: "100%", background: color }} />
        </div>
      )}
    </div>
  );
}

function Trend({ trend }) {
  const max = Math.max(1, ...trend.map((d) => d.executions + d.workflowRuns));
  return (
    <div aria-label="Usage trend (last 30 days)" style={{ display: "flex", alignItems: "flex-end", gap: 2, height: 60 }}>
      {trend.map((d) => (
        <div key={d.day} data-testid="trend-bar" title={`${d.day}: ${d.executions} executions, ${d.workflowRuns} runs`}
          style={{ flex: 1, minWidth: 2, height: `${Math.max(2, Math.round(((d.executions + d.workflowRuns) / max) * 60))}px`, background: "var(--mcis-primary-solid, #5b4bff)", opacity: d.executions + d.workflowRuns ? 1 : 0.2, borderRadius: 2 }} />
      ))}
    </div>
  );
}

export default function BillingPage() {
  const [user, setUser] = useState(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [workspaces, setWorkspaces] = useState([]);
  const [workspaceId, setWorkspaceId] = useState(null);
  const [summary, setSummary] = useState(null);
  const [dashboard, setDashboard] = useState(null);
  const [plans, setPlans] = useState([]);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(() => {
    try {
      const c = new URLSearchParams(window.location.search).get("checkout");
      if (c === "success") return "Thanks — the payment provider is confirming your payment. Your plan changes here as soon as it confirms; this can take a minute.";
      if (c === "cancelled") return "Checkout was cancelled. Nothing was charged and your plan is unchanged.";
    } catch { /* ignore */ }
    return null;
  });
  const [confirmCancel, setConfirmCancel] = useState(false);

  useEffect(() => onAuthStateChanged(auth, (u) => { setUser(u); setAuthLoading(false); }), []);
  useEffect(() => {
    if (!user) return;
    let alive = true;
    wfApi.listWorkspaces().then((list) => {
      if (!alive) return;
      setWorkspaces(list);
      const chosen = wfApi.pickWorkspace(list, wfApi.getStoredWorkspaceId(user.uid));
      setWorkspaceId(chosen ? chosen.id : null);
    }).catch((e) => setError(e.message));
    return () => { alive = false; };
  }, [user]);

  const current = workspaces.find((w) => w.id === workspaceId);
  const canManage = current && (current.role === "owner" || current.role === "admin");

  const load = useCallback(async () => {
    if (!workspaceId) return;
    setError(null);
    try {
      const [s, d, p] = await Promise.all([billApi.getSummary(workspaceId), billApi.getDashboard(workspaceId), billApi.getPlans(workspaceId)]);
      setSummary(s); setDashboard(d); setPlans(p);
    } catch (e) {
      setSummary(null); setDashboard(null);
      setError(e.status === 404 ? "You no longer have access to that workspace." : e.message);
    }
  }, [workspaceId]);
  useEffect(() => { load(); }, [load]);

  async function upgrade(planId) {
    setNotice(null); setError(null);
    try {
      const out = await billApi.requestCheckout(workspaceId, planId);
      if (out && out.url) window.location.assign(out.url);
    } catch (e) { setError(e.message); }
  }

  async function manage() {
    setNotice(null); setError(null);
    try {
      const out = await billApi.requestPortal(workspaceId);
      if (out && out.url) window.location.assign(out.url);
    } catch (e) { setError(e.message); }
  }

  async function cancel() {
    setNotice(null); setError(null); setConfirmCancel(false);
    try {
      await billApi.requestCancel(workspaceId);
      setNotice("Cancellation requested. Your plan stays active until the end of the paid period; this page updates when the payment provider confirms.");
      await load();
    } catch (e) { setError(e.message); }
  }

  if (authLoading) return <div style={{ padding: 24 }}>Loading…</div>;
  if (!user) return <div style={{ padding: 24 }}>Please sign in.</div>;
  const payments = summary ? summary.payments : null;
  const ps = summary ? summary.paymentStatus || null : null; // Layer 8 detail (absent on older servers)
  const sub = summary ? summary.subscription : null;
  const checkoutOk = ps ? ps.checkoutAvailable : !!(payments && payments.checkoutAvailable && canManage);

  return (
    <div style={{ padding: 24, display: "grid", gap: 16, maxWidth: 1000, margin: "0 auto" }}>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <h2 style={{ margin: 0 }}>Billing &amp; usage</h2>
        <select aria-label="Workspace" style={input} value={workspaceId || ""} onChange={(e) => { setWorkspaceId(e.target.value); wfApi.storeWorkspaceId(user.uid, e.target.value); }}>
          {workspaces.map((w) => <option key={w.id} value={w.id}>{w.is_personal ? "Personal" : w.name} ({w.role})</option>)}
        </select>
        <span style={{ flex: 1 }} />
        <a href="/" style={muted}>Back to app</a>
      </div>
      {notice && <div role="status">{notice}</div>}
      {error && <div role="alert" style={{ color: "var(--mcis-danger, #c43d3d)" }}>{error}</div>}

      {summary && (
        <>
          <section style={card} aria-label="Plan">
            <div style={{ display: "flex", gap: 12, alignItems: "baseline", flexWrap: "wrap" }}>
              <strong style={{ fontSize: 18 }} data-testid="plan-name">{summary.plan ? summary.plan.name : "—"}</strong>
              <span data-testid="sub-status">{billApi.STATUS_LABELS[sub.status] || sub.status}</span>
              {sub.cancelAtPeriodEnd && <span style={muted}>cancels at period end</span>}
            </div>
            <div style={muted} data-testid="period">Usage period: {fmtDate(summary.period.start)} – {fmtDate(summary.period.end)}</div>
            {sub.effectivePlanReason && sub.source === "default" && sub.status !== "none" && (
              <div style={muted}>Your subscription is {billApi.STATUS_LABELS[sub.status] || sub.status}; Free plan limits apply.</div>
            )}
            {!summary.billingEnabled && (
              <div data-testid="not-enforced" style={{ ...muted, color: "#c98a00" }}>Plan limits are not enforced on this server yet (usage is still measured).</div>
            )}
            {payments && !payments.checkoutAvailable && (
              <div data-testid="payments-unavailable" style={muted}>Payments are not configured for this deployment. Plan changes are handled by the Nexus team; upgrade and subscription management buttons are unavailable.</div>
            )}
            {ps && (
              <div data-testid="provider-status" style={muted}>
                Payment provider: {ps.configured ? `${ps.provider === "stripe" ? "Stripe" : ps.provider} (configured)` : "not configured"}
                {ps.missingConfiguration && ps.missingConfiguration.length > 0 && <> · missing server settings: {ps.missingConfiguration.join(", ")}</>}
              </div>
            )}
            {summary.customLimits && <div style={muted}>Custom limits agreed with the Nexus team apply to this workspace.</div>}
            {ps && ps.canManage && ps.configured && (
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }} aria-label="Subscription actions">
                <button type="button" style={{ ...btn, opacity: ps.portalAvailable ? 1 : 0.55 }} disabled={!ps.portalAvailable} onClick={manage}
                  title={ps.portalAvailable ? "" : "Available after your first purchase"}>Manage subscription</button>
                {ps.cancelAvailable && !confirmCancel && <button type="button" style={btn} onClick={() => setConfirmCancel(true)}>Cancel subscription</button>}
                {ps.cancelAvailable && confirmCancel && (
                  <>
                    <button type="button" style={{ ...btn, borderColor: "#c43d3d", color: "#c43d3d" }} onClick={cancel}>Confirm: cancel at the end of the period</button>
                    <button type="button" style={btn} onClick={() => setConfirmCancel(false)}>Keep subscription</button>
                  </>
                )}
              </div>
            )}
          </section>

          <section style={card} aria-label="Usage">
            <strong>Usage this period</strong>
            {summary.meters.map((m) => <Meter key={m.capability} m={m} />)}
          </section>
        </>
      )}

      {dashboard && (
        <section style={card} aria-label="Usage dashboard">
          <strong>Last {dashboard.window.days} days</strong>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 8 }}>
            {[
              ["Executions", dashboard.executions], ["Workflow runs", dashboard.workflowRuns],
              ["Success rate", dashboard.successRate === null ? "—" : `${dashboard.successRate}%`],
              ["Failure rate", dashboard.failureRate === null ? "—" : `${dashboard.failureRate}%`],
              ["Steps", dashboard.steps], ["Connector calls", dashboard.connectorCalls], ["API calls", dashboard.apiCalls],
            ].map(([label, v]) => (
              <div key={label} data-testid={`stat-${label}`} style={{ border: "1px solid var(--mcis-border, #eee)", borderRadius: 8, padding: 8 }}>
                <div style={muted}>{label}</div><div style={{ fontSize: 18 }}>{typeof v === "number" ? fmtNum(v) : v}</div>
              </div>
            ))}
          </div>
          <Trend trend={dashboard.trend} />
        </section>
      )}

      {summary && plans.length > 0 && (
        <section style={card} aria-label="Plans">
          <strong>Plans</strong>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 8 }}>
            {plans.map((p) => {
              const isCurrent = summary.plan && p.id === summary.plan.id;
              const available = checkoutOk && canManage && !isCurrent && p.purchasable !== false;
              const priceText = billApi.formatPrice(p.price);
              return (
                <div key={p.id} data-testid={`plan-${p.id}`} style={{ border: `1px solid ${isCurrent ? "var(--mcis-primary-solid, #5b4bff)" : "var(--mcis-border, #eee)"}`, borderRadius: 8, padding: 10, display: "grid", gap: 4 }}>
                  <strong>{p.name}{isCurrent ? " (current)" : ""}</strong>
                  <div style={muted}>{p.description}</div>
                  <div style={muted} data-testid={`price-${p.id}`}>{priceText || (p.id === "free" ? "Free" : "Pricing: contact the Nexus team")}</div>
                  <div style={muted}>Executions: {p.limits.executions_per_month === null ? "Unlimited" : fmtNum(p.limits.executions_per_month)} · Members: {p.limits.max_members === null ? "Unlimited" : fmtNum(p.limits.max_members)}</div>
                  {!isCurrent && p.purchasable === false && checkoutOk && p.id === "enterprise" && (
                    <div style={muted}>Enterprise is arranged with the Nexus team and activated manually.</div>
                  )}
                  {!isCurrent && !(p.purchasable === false && checkoutOk && p.id === "enterprise") && (
                    <button style={{ ...btn, opacity: available ? 1 : 0.55, cursor: available ? "pointer" : "not-allowed" }} disabled={!available}
                      title={!canManage ? "Only workspace owners and admins can change the plan" : (!available ? "Online payments are not available yet" : "")}
                      onClick={() => upgrade(p.id)}>
                      {available ? `Switch to ${p.name}` : `Switch to ${p.name} (unavailable)`}
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </section>
      )}
    </div>
  );
}
