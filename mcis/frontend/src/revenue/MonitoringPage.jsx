/**
 * Layer 10 — Monitoring & alerts (served at /monitoring).
 * Monitors with honest health (Verified / Unverified / Stale / Unavailable),
 * detected changes, alerts with per-channel delivery state (a failed or
 * blocked Slack / email delivery is shown as such), and alert rules.
 */
import React, { useState } from "react";
import useWorkspace, { styles as S } from "../customer/useWorkspace";
import * as R from "./revenueApi";
import { HealthBadge, Shell, Empty, useLoad } from "./common";

const RULE_TYPES = ["price_below", "price_drop_pct", "out_of_stock", "back_in_stock", "product_disappeared", "source_stale", "source_unavailable", "any_change"];

function valueText(m) {
  const v = m.current;
  if (!v) return "—";
  if (m.kind === "product") return v.present === false ? "Removed at source" : `${R.fmtMoney(v.price, v.currency)} · ${(v.availability || "UNKNOWN").replace("_", " ").toLowerCase()}`;
  return Object.entries(v).map(([k, x]) => `${k}: ${x}`).join(", ");
}

export default function MonitoringPage() {
  const ws = useWorkspace();
  const w = ws.workspaceId;
  const mons = useLoad(() => (w ? R.listMonitors(w) : Promise.resolve([])), [w]);
  const changes = useLoad(() => (w ? R.listChanges(w) : Promise.resolve([])), [w]);
  const alerts = useLoad(() => (w ? R.listAlerts(w) : Promise.resolve([])), [w]);
  const rules = useLoad(() => (w ? R.listRules(w) : Promise.resolve([])), [w]);
  const ints = useLoad(() => (w && ws.isAdmin ? R.listIntegrations(w).catch(() => []) : Promise.resolve([])), [w, ws.isAdmin]);
  const [msg, setMsg] = useState(null);
  const [mf, setMf] = useState({ name: "", url: "", integrationId: "", checkIntervalMinutes: 360 });
  const [rf, setRf] = useState({ name: "", ruleType: "out_of_stock", threshold: "", monitorId: "", channel: "in_app" });
  const reloadAll = () => { mons.reload(); changes.reload(); alerts.reload(); };
  const run = (fn) => async (...a) => { setMsg(null); try { await fn(...a); reloadAll(); rules.reload(); } catch (x) { setMsg(x.message); } };
  const checkNow = run(async (m) => { await R.checkMonitor(w, m.id); });
  const ack = run(async (a) => { await R.acknowledgeAlert(w, a.id); });
  const retry = run(async (a, d) => { await R.retryDelivery(w, a.id, d.id); });
  const addMonitor = run(async (e) => {
    e.preventDefault();
    await R.createMonitor(w, { name: mf.name, kind: "product", sourceType: mf.integrationId ? "web_page" : "api_submission", ...(mf.integrationId ? { integrationId: mf.integrationId, source: { url: mf.url } } : {}), checkIntervalMinutes: Number(mf.checkIntervalMinutes) });
    setMf({ name: "", url: "", integrationId: "", checkIntervalMinutes: 360 });
  });
  const addRule = run(async (e) => {
    e.preventDefault();
    const [type, integrationId] = rf.channel.split(":");
    await R.createRule(w, { name: rf.name, ruleType: rf.ruleType, ...(rf.threshold !== "" ? { threshold: Number(rf.threshold) } : {}), ...(rf.monitorId ? { monitorId: rf.monitorId } : {}),
      channels: type === "in_app" ? [{ type: "in_app" }] : [{ type: "in_app" }, { type, integrationId }] });
    setRf({ ...rf, name: "", threshold: "" });
  });
  const notifyInts = (ints.data || []).filter((i) => i.provider === "slack" || i.provider === "email");
  return (
    <Shell title="Monitoring & alerts" ws={ws}>
      {msg && <div role="alert" style={S.danger}>{msg}</div>}
      <section style={S.card} aria-label="Monitors">
        <strong>Monitors</strong>
        {mons.loading && !mons.data && <div>Loading…</div>}
        {mons.error && <div role="alert" style={S.danger}>{mons.error}</div>}
        {mons.data && mons.data.length === 0 && <Empty>No monitors yet.</Empty>}
        {(mons.data || []).map((m) => (
          <div key={m.id} data-testid={`monitor-${m.id}`} style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", borderTop: "1px solid var(--mcis-border, #eee)", paddingTop: 6 }}>
            <strong>{m.name}</strong><HealthBadge health={m.health} fresh={m.currentIsFresh} />
            <span style={m.currentIsFresh ? {} : { opacity: 0.6 }}>{valueText(m)}</span>
            <span style={S.muted}>last success {R.fmtTime(m.lastSuccessAt)}{m.healthReason ? ` · ${m.healthReason}` : ""}</span>
            <span style={{ flex: 1 }} />
            {ws.isAdmin && m.sourceType !== "api_submission" && <button type="button" style={S.btn} onClick={() => checkNow(m)}>Check now</button>}
          </div>
        ))}
        {ws.isAdmin && (
          <form onSubmit={addMonitor} style={{ display: "flex", gap: 6, flexWrap: "wrap" }} aria-label="Add monitor">
            <input style={S.input} aria-label="Monitor name" placeholder="Name" value={mf.name} onChange={(e) => setMf({ ...mf, name: e.target.value })} required />
            <select style={S.input} aria-label="Source" value={mf.integrationId} onChange={(e) => setMf({ ...mf, integrationId: e.target.value })}>
              <option value="">Values sent by API</option>
              {(ints.data || []).filter((i) => i.provider === "web_page").map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
            </select>
            {mf.integrationId && <input style={S.input} aria-label="Page URL" placeholder="https://…" value={mf.url} onChange={(e) => setMf({ ...mf, url: e.target.value })} required />}
            <input style={{ ...S.input, width: 90 }} type="number" min={15} aria-label="Check every (minutes)" value={mf.checkIntervalMinutes} onChange={(e) => setMf({ ...mf, checkIntervalMinutes: e.target.value })} />
            <button type="submit" style={S.primary}>Add monitor</button>
          </form>
        )}
      </section>

      <section style={S.card} aria-label="Alerts">
        <strong>Alerts</strong>
        {alerts.data && alerts.data.length === 0 && <Empty>No alerts.</Empty>}
        {(alerts.data || []).map((a) => (
          <div key={a.id} data-testid={`alert-${a.id}`} style={{ borderTop: "1px solid var(--mcis-border, #eee)", paddingTop: 6, display: "grid", gap: 4 }}>
            <div><strong>{a.title}</strong> <span style={S.muted}>{a.severity} · {R.fmtTime(a.createdAt)}{a.details && a.details.change && a.details.change.verification === "UNVERIFIED" ? " · unverified data" : ""}</span></div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", fontSize: 12 }}>
              {(a.deliveries || []).map((d) => (
                <span key={d.id} data-testid={`delivery-${d.channel}`} style={{ color: d.status === "delivered" ? "#1a9b5c" : d.status === "pending" ? "#777" : "#c43d3d" }}>
                  {d.channel}: {d.status}{d.errorCode ? ` (${d.errorCode})` : ""}
                  {ws.isAdmin && (d.status === "failed" || d.status === "blocked") && <button type="button" style={{ ...S.btn, marginLeft: 4, padding: "1px 6px" }} onClick={() => retry(a, d)}>Retry</button>}
                </span>
              ))}
            </div>
            {!a.acknowledged ? <button type="button" style={{ ...S.btn, justifySelf: "start" }} onClick={() => ack(a)}>Acknowledge</button> : <span style={S.muted}>Acknowledged</span>}
          </div>
        ))}
      </section>

      <section style={S.card} aria-label="Changes">
        <strong>Recent changes</strong>
        {changes.data && changes.data.length === 0 && <Empty>No changes detected yet.</Empty>}
        {(changes.data || []).slice(0, 30).map((c) => (
          <div key={c.id} style={{ fontSize: 13 }} data-testid="change">
            {c.changeType.replace(/_/g, " ")} — {c.field}: {String(c.oldValue ?? "—")} → {String(c.newValue ?? "—")} <span style={S.muted}>{c.verification} · {R.fmtTime(c.detectedAt)}</span>
          </div>
        ))}
      </section>

      <section style={S.card} aria-label="Alert rules">
        <strong>Alert rules</strong>
        {rules.data && rules.data.length === 0 && <Empty>No rules.</Empty>}
        {(rules.data || []).map((r) => <div key={r.id} style={{ fontSize: 13 }}>{r.name} — {r.ruleType}{r.threshold !== null ? ` (${r.threshold})` : ""} · {r.channels.map((c) => c.type).join(", ")}</div>)}
        {ws.isAdmin && (
          <form onSubmit={addRule} style={{ display: "flex", gap: 6, flexWrap: "wrap" }} aria-label="Add rule">
            <input style={S.input} aria-label="Rule name" placeholder="Name" value={rf.name} onChange={(e) => setRf({ ...rf, name: e.target.value })} required />
            <select style={S.input} aria-label="Rule type" value={rf.ruleType} onChange={(e) => setRf({ ...rf, ruleType: e.target.value })}>{RULE_TYPES.map((t) => <option key={t}>{t}</option>)}</select>
            {["price_below", "price_drop_pct"].includes(rf.ruleType) && <input style={{ ...S.input, width: 100 }} type="number" aria-label="Threshold" value={rf.threshold} onChange={(e) => setRf({ ...rf, threshold: e.target.value })} required />}
            <select style={S.input} aria-label="Monitor" value={rf.monitorId} onChange={(e) => setRf({ ...rf, monitorId: e.target.value })}>
              <option value="">All monitors</option>{(mons.data || []).map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
            </select>
            <select style={S.input} aria-label="Notify" value={rf.channel} onChange={(e) => setRf({ ...rf, channel: e.target.value })}>
              <option value="in_app">In app only</option>{notifyInts.map((i) => <option key={i.id} value={`${i.provider}:${i.id}`}>{i.provider}: {i.name}</option>)}
            </select>
            <button type="submit" style={S.primary}>Add rule</button>
          </form>
        )}
      </section>
    </Shell>
  );
}
