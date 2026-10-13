/**
 * Layer 10 — outbound webhooks (part of /developers; workspace admins).
 * The signing secret is shown ONCE after create / rotate; Nexus stores it
 * encrypted and never shows it again. Delivery attempts are listed with
 * their real status (delivered / failed / dead).
 */
import React, { useState } from "react";
import useWorkspace, { styles as S } from "../customer/useWorkspace";
import * as R from "./revenueApi";
import { Empty, useLoad } from "./common";

export default function WebhooksPanel() {
  const ws = useWorkspace();
  const w = ws.workspaceId;
  const hooks = useLoad(() => (w && ws.isAdmin ? R.listWebhooks(w) : Promise.resolve([])), [w, ws.isAdmin]);
  const [url, setUrl] = useState("");
  const [events, setEvents] = useState(["execution.completed", "execution.failed"]);
  const [secret, setSecret] = useState(null);
  const [deliveries, setDeliveries] = useState({});
  const [msg, setMsg] = useState(null);
  if (!ws.user || !w) return null;
  if (!ws.isAdmin) return <section style={S.card} aria-label="Webhooks"><strong>Webhooks</strong><span style={S.muted}>Workspace admins manage webhooks.</span></section>;
  const act = (fn) => async (e) => { if (e && e.preventDefault) e.preventDefault(); setMsg(null); try { await fn(); hooks.reload(); } catch (x) { setMsg(x.message); } };
  const create = act(async () => { const h = await R.createWebhook(w, { url, events }); setSecret(h.secret); setUrl(""); });
  return (
    <section style={S.card} aria-label="Webhooks">
      <strong>Webhooks</strong>
      <span style={S.muted}>Every delivery carries a Nexus-Signature header (t=…,v1=HMAC-SHA256 of "t.body"). Verify it and reject timestamps older than 5 minutes.</span>
      {msg && <div role="alert" style={S.danger}>{msg}</div>}
      {secret && <div role="status" data-testid="webhook-secret" style={{ border: "1px solid #c98a00", borderRadius: 8, padding: 8 }}>Signing secret (shown once — store it now): <code>{secret}</code> <button type="button" style={S.btn} onClick={() => setSecret(null)}>I stored it</button></div>}
      {hooks.data && hooks.data.length === 0 && <Empty>No webhooks.</Empty>}
      {(hooks.data || []).map((h) => (
        <div key={h.id} data-testid={`webhook-${h.id}`} style={{ borderTop: "1px solid var(--mcis-border, #eee)", paddingTop: 6, display: "grid", gap: 4 }}>
          <div><code>{h.url}</code> <span style={S.muted}>{h.status} · {h.events.join(", ")}{h.failureCount ? ` · ${h.failureCount} recent failures` : ""}</span></div>
          <div style={{ display: "flex", gap: 6 }}>
            <button type="button" style={S.btn} onClick={act(() => R.testWebhook(w, h.id))}>Send test</button>
            <button type="button" style={S.btn} onClick={act(async () => { const r = await R.rotateWebhook(w, h.id); setSecret(r.secret); })}>Rotate secret</button>
            <button type="button" style={S.btn} onClick={act(async () => setDeliveries({ ...deliveries, [h.id]: await R.webhookDeliveries(w, h.id) }))}>Deliveries</button>
            <button type="button" style={S.btn} onClick={act(() => R.deleteWebhook(w, h.id))}>Delete</button>
          </div>
          {(deliveries[h.id] || []).map((d) => <div key={d.id} style={{ fontSize: 12 }}>{d.eventType}: <strong>{d.status}</strong> · {d.attempts} attempt(s){d.lastError ? ` · ${d.lastError}` : ""}</div>)}
        </div>
      ))}
      <form onSubmit={create} style={{ display: "grid", gap: 6 }} aria-label="New webhook">
        <input style={S.input} aria-label="Endpoint URL" placeholder="https://your-app.example.com/nexus-webhook" value={url} onChange={(e) => setUrl(e.target.value)} required />
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", fontSize: 12 }}>
          {R.WEBHOOK_EVENTS.map((ev) => (
            <label key={ev}><input type="checkbox" checked={events.includes(ev)} onChange={(e) => setEvents(e.target.checked ? [...events, ev] : events.filter((x) => x !== ev))} /> {ev}</label>
          ))}
        </div>
        <button type="submit" style={{ ...S.primary, justifySelf: "start" }} disabled={!events.length}>Add webhook</button>
      </form>
    </section>
  );
}
