/**
 * Layer 10 — AI workforce (served at /workforce).
 * Named agents with a role, standing instructions and limits (maximum
 * risk, allowed integrations) that apply ON TOP of the workspace Agent
 * Firewall. Agents act as the person who started the work; approvals and
 * reviews are always given by people.
 */
import React, { useState } from "react";
import useWorkspace, { styles as S } from "../customer/useWorkspace";
import * as R from "./revenueApi";
import { Shell, Empty, useLoad } from "./common";

const RISK = { green: "Read-only / low risk only", yellow: "Up to state-changing actions (with approval)", red: "Up to high-risk actions (admin approval)" };

function AgentCard({ a, w, isAdmin, onChanged }) {
  const tasks = useLoad(() => R.agentTasks(w, a.id).catch(() => []), [w, a.id]);
  const [err, setErr] = useState(null);
  const toggle = async () => { setErr(null); try { await R.updateAgent(w, a.id, { version: a.version, status: a.status === "active" ? "archived" : "active" }); onChanged(); } catch (x) { setErr(x.message); } };
  return (
    <div data-testid={`agent-${a.id}`} style={{ borderTop: "1px solid var(--mcis-border, #eee)", paddingTop: 8, display: "grid", gap: 4 }}>
      <div style={{ display: "flex", gap: 8, alignItems: "baseline" }}>
        <strong>{a.name}</strong><span style={S.muted}>{a.role} · {a.status}</span><span style={{ flex: 1 }} />
        {isAdmin && <button type="button" style={S.btn} onClick={toggle}>{a.status === "active" ? "Archive" : "Reactivate"}</button>}
      </div>
      {a.description && <div style={{ fontSize: 13 }}>{a.description}</div>}
      <div style={S.muted}>Limit: {RISK[a.maxRisk]}{a.allowedIntegrationIds.length ? ` · ${a.allowedIntegrationIds.length} allowed integration(s)` : " · any enabled integration"}</div>
      <div style={{ fontSize: 13 }}>Assigned tasks: {tasks.data ? tasks.data.length : "…"}{tasks.data && tasks.data.slice(0, 5).map((t) => <div key={t.id} style={S.muted}>• {t.title} ({t.status})</div>)}</div>
      {err && <div role="alert" style={S.danger}>{err}</div>}
    </div>
  );
}

export default function WorkforcePage() {
  const ws = useWorkspace();
  const w = ws.workspaceId;
  const agents = useLoad(() => (w ? R.listAgents(w) : Promise.resolve([])), [w]);
  const [f, setF] = useState({ name: "", role: "custom", maxRisk: "green", instructions: "" });
  const [msg, setMsg] = useState(null);
  const act = (fn) => async (e) => { if (e && e.preventDefault) e.preventDefault(); setMsg(null); try { await fn(); agents.reload(); } catch (x) { setMsg(x.message); } };
  const defaults = act(() => R.provisionAgents(w));
  const add = act(async () => { await R.createAgent(w, f); setF({ name: "", role: "custom", maxRisk: "green", instructions: "" }); });
  return (
    <Shell title="AI workforce" ws={ws}>
      {msg && <div role="alert" style={S.danger}>{msg}</div>}
      <section style={S.card} aria-label="Agents">
        <strong>Agents</strong>
        <span style={S.muted}>Assign tasks to an agent from Tasks, or use agents in workflow steps (e.g. Research → Data → Spreadsheet → human review).</span>
        {agents.loading && !agents.data && <div>Loading…</div>}
        {agents.error && <div role="alert" style={S.danger}>{agents.error}</div>}
        {agents.data && agents.data.length === 0 && <Empty>No agents yet.{ws.isAdmin ? " Add the standard team to get started." : ""}</Empty>}
        {(agents.data || []).map((a) => <AgentCard key={a.id} a={a} w={w} isAdmin={ws.isAdmin} onChanged={agents.reload} />)}
        {ws.isAdmin && <button type="button" style={{ ...S.btn, justifySelf: "start" }} onClick={defaults}>Add standard agents (Research, Data, Spreadsheet, Reviewer)</button>}
      </section>
      {ws.isAdmin && (
        <form onSubmit={add} style={S.card} aria-label="New agent">
          <strong>New agent</strong>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            <input style={S.input} aria-label="Agent name" placeholder="Name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required />
            <select style={S.input} aria-label="Role" value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })}>{["research", "data", "spreadsheet", "reviewer", "custom"].map((r) => <option key={r}>{r}</option>)}</select>
            <select style={S.input} aria-label="Maximum risk" value={f.maxRisk} onChange={(e) => setF({ ...f, maxRisk: e.target.value })}>{Object.entries(RISK).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
          </div>
          <textarea style={{ ...S.input, minHeight: 60 }} aria-label="Standing instructions" placeholder="Standing instructions" value={f.instructions} onChange={(e) => setF({ ...f, instructions: e.target.value })} />
          <button type="submit" style={{ ...S.primary, justifySelf: "start" }}>Create agent</button>
        </form>
      )}
    </Shell>
  );
}
