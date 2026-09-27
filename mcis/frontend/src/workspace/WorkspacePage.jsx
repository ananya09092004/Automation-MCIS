/**
 * Layer 8 — customer workspace home (served at /workspace).
 *
 * Tabs: Overview · Team · Tasks · Activity & approvals · Templates, plus links
 * to the existing Workflows, Integrations, Billing and Security pages (they
 * are reused, not rewritten). The workspace switcher only selects among the
 * user's own memberships; the server enforces membership and roles on every
 * call. Controls the server would refuse are hidden or disabled, never trusted.
 */
import React, { useCallback, useEffect, useState } from "react";
import { sendEmailVerification } from "firebase/auth";
import { auth } from "../firebase";
import * as api from "../customer/customerApi";
import useWorkspace, { styles as S } from "../customer/useWorkspace";
import { ApiError } from "../workflows/workflowsApi";

const TABS = [["overview", "Overview"], ["team", "Team"], ["tasks", "Tasks"], ["activity", "Activity & approvals"], ["templates", "Templates"], ["data", "Data retention"]];
const LINKS = [["/workflows", "Workflows"], ["/integrations", "Integrations"], ["/billing", "Usage & billing"], ["/security", "Security"], ["/developers", "API"]];
const fmt = (n) => (n === null || n === undefined ? "—" : Number(n).toLocaleString());
const ms = (v) => (v === null || v === undefined ? "—" : v < 1000 ? `${v} ms` : v < 60000 ? `${(v / 1000).toFixed(1)} s` : `${Math.round(v / 60000)} min`);

function Stat({ label, value, hint }) {
  return (
    <div data-testid={`stat-${label}`} style={{ border: "1px solid var(--mcis-border, #eee)", borderRadius: 8, padding: 10 }}>
      <div style={S.muted}>{label}</div>
      <div style={{ fontSize: 20 }}>{value}</div>
      {hint && <div style={S.muted}>{hint}</div>}
    </div>
  );
}

function Overview({ data }) {
  if (!data) return <div>Loading…</div>;
  const u = data.usage || {};
  return (
    <div style={{ display: "grid", gap: 12 }}>
      <section style={S.card} aria-label="Last 30 days">
        <strong>Last 30 days</strong>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 8 }}>
          <Stat label="Executions" value={fmt(u.executions)} />
          <Stat label="Workflow runs" value={fmt(u.workflowRuns)} />
          <Stat label="Success rate" value={u.successRate === null || u.successRate === undefined ? "—" : `${u.successRate}%`} />
          <Stat label="Steps" value={fmt(u.steps)} />
          <Stat label="Connector calls" value={fmt(u.connectorCalls)} />
          <Stat label="API calls" value={fmt(u.apiCalls)} />
        </div>
      </section>
      <section style={S.card} aria-label="Right now">
        <strong>Right now</strong>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 8 }}>
          <Stat label="Waiting for approval" value={fmt(data.approvals.waiting)} hint={data.approvals.oldestWaitMinutes !== null ? `oldest ${data.approvals.oldestWaitMinutes} min` : null} />
          <Stat label="Typical run time" value={ms(data.executions.latencyMs.p50)} hint={`p95 ${ms(data.executions.latencyMs.p95)}`} />
          <Stat label="Recent workflow success" value={data.workflowRuns.successRate === null ? "—" : `${data.workflowRuns.successRate}%`} hint={`last ${data.workflowRuns.sample} runs`} />
          <Stat label="Open tasks" value={fmt(data.tasks.open)} hint={`${data.tasks.assignedToMe} mine · ${data.tasks.assignedToAgent} for the AI agent`} />
          <Stat label="Connectors needing attention" value={`${data.connectors.needsAttention} / ${data.connectors.total}`} />
        </div>
      </section>
      {data.failures && (
        <section style={S.card} aria-label="Operational health" data-testid="admin-health">
          <strong>Operational health <span style={S.muted}>(owners and admins)</span></strong>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 8 }}>
            <Stat label="Quota denials" value={fmt(data.failures.quotaDenials)} hint="last 30 days" />
            <Stat label="Billing failures" value={fmt(data.failures.billingFailures)} hint="last 30 days" />
            <Stat label="Security denials" value={fmt(data.failures.securityDenials)} hint="last 30 days" />
          </div>
          {data.connectors.failing && data.connectors.failing.length > 0 && (
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              {data.connectors.failing.map((c) => <li key={c.id}>{c.name} ({c.provider}): {c.status}{c.lastError ? ` — ${c.lastError}` : ""}</li>)}
            </ul>
          )}
        </section>
      )}
    </div>
  );
}

function Team({ wsId, current, onError }) {
  const [members, setMembers] = useState([]);
  const [invites, setInvites] = useState([]);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("member");
  const [lastToken, setLastToken] = useState(null);
  // Layer 10: an emailed invitation link carries the one-time code in the URL fragment (#invite=…), which is never sent to a server.
  const [joinCode, setJoinCode] = useState(() => { try { const m = /(?:^#|&)invite=([A-Za-z0-9_-]{20,100})/.exec(window.location.hash || ""); return m ? m[1] : ""; } catch { return ""; } });
  const [lastEmail, setLastEmail] = useState(null);
  const [transferTo, setTransferTo] = useState("");
  const [transferConfirm, setTransferConfirm] = useState(false);
  const [verifyNote, setVerifyNote] = useState(null);
  const isAdmin = current.role === "owner" || current.role === "admin";
  const isOwner = current.role === "owner";
  const load = useCallback(async () => {
    try {
      setMembers(await api.listMembers(wsId));
      setInvites(isAdmin ? await api.listInvitations(wsId) : []);
    } catch (e) { onError(e.message); }
  }, [wsId, isAdmin, onError]);
  useEffect(() => { load(); }, [load]);
  const run = (fn) => async () => { try { await fn(); await load(); } catch (e) { onError(e.message); } };
  return (
    <div style={{ display: "grid", gap: 12 }}>
      <section style={S.card} aria-label="Members">
        <strong>Members ({members.length})</strong>
        <table style={{ width: "100%", fontSize: 13, borderCollapse: "collapse" }}>
          <thead><tr><th align="left">User</th><th align="left">Role</th><th /></tr></thead>
          <tbody>
            {members.map((m) => (
              <tr key={m.user_id} data-testid={`member-${m.user_id}`}>
                <td>{m.user_id}</td>
                <td>{isOwner && m.role !== "owner" ? (
                  <select aria-label={`Role of ${m.user_id}`} style={S.input} value={m.role} onChange={(e) => run(() => api.changeRole(wsId, m.user_id, e.target.value))()}>
                    <option value="member">Member</option><option value="admin">Admin</option>
                  </select>
                ) : api.ROLE_LABELS[m.role]}</td>
                <td align="right">{isAdmin && m.role !== "owner" && (isOwner || m.role === "member") && (
                  <button type="button" style={S.btn} onClick={run(() => api.removeMember(wsId, m.user_id))}>Remove</button>
                )}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!isAdmin && <span style={S.muted}>Only owners and admins can change the team.</span>}
      </section>
      {isOwner && !current.is_personal && members.some((m) => m.role !== "owner") && (
        <section style={S.card} aria-label="Transfer ownership">
          <strong>Transfer ownership</strong>
          <span style={S.muted}>The new owner gets full control of this workspace, its billing and its security settings. You stay on the team as an admin.</span>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
            <select aria-label="New owner" style={S.input} value={transferTo} onChange={(e) => { setTransferTo(e.target.value); setTransferConfirm(false); }}>
              <option value="">Choose a member…</option>
              {members.filter((m) => m.role !== "owner").map((m) => <option key={m.user_id} value={m.user_id}>{m.user_id} ({api.ROLE_LABELS[m.role]})</option>)}
            </select>
            <label style={S.muted}><input type="checkbox" aria-label="Confirm transfer" checked={transferConfirm} onChange={(e) => setTransferConfirm(e.target.checked)} disabled={!transferTo} /> I understand I will no longer be the owner</label>
            <button type="button" style={S.primary} disabled={!transferTo || !transferConfirm} onClick={run(async () => {
              await api.transferOwnership(wsId, transferTo);
              window.location.reload();
            })}>Transfer</button>
          </div>
        </section>
      )}
      {isAdmin && (
        <section style={S.card} aria-label="Invite">
          <strong>Invite a teammate</strong>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            <input aria-label="Invite email" type="email" style={{ ...S.input, flex: 1 }} value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@company.com" />
            <select aria-label="Invite role" style={S.input} value={role} onChange={(e) => setRole(e.target.value)}>
              <option value="member">Member</option>{isOwner && <option value="admin">Admin</option>}
            </select>
            <button type="button" style={S.primary} disabled={!email.trim()} onClick={run(async () => { const r = await api.createInvitation(wsId, email.trim(), role); setLastToken(r.token); setLastEmail(r.email || null); setEmail(""); })}>Invite</button>
          </div>
          {lastToken && <div role="status">Invitation created.{lastEmail && lastEmail.status === "sent" ? " An email with the link was accepted by the email provider." : ""} {lastEmail && lastEmail.status === "failed" ? "The invitation email could not be sent. " : ""}Share this one-time code with your teammate: <code>{lastToken}</code></div>}
          {invites.filter((i) => i.status === "pending").map((i) => (
            <div key={i.id} style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <span>{i.email} · {i.role} · pending</span>
              <button type="button" style={S.btn} onClick={run(() => api.revokeInvitation(wsId, i.id))}>Revoke</button>
            </div>
          ))}
        </section>
      )}
      <section style={S.card} aria-label="Join a workspace">
        <strong>Join another workspace</strong>
        {auth.currentUser && auth.currentUser.emailVerified === false && (
          <div data-testid="verify-email" style={S.muted}>
            Invitations can be accepted only with a verified email address.{" "}
            <button type="button" style={S.btn} onClick={async () => {
              try { await sendEmailVerification(auth.currentUser); setVerifyNote("Verification email sent. Open the link, then sign in again."); } catch (e) { setVerifyNote("Could not send the email right now; try again later."); }
            }}>Send verification email</button>
            {verifyNote && <span role="status"> {verifyNote}</span>}
          </div>
        )}
        <div style={{ display: "flex", gap: 6 }}>
          <input aria-label="Invite code" style={{ ...S.input, flex: 1 }} value={joinCode} onChange={(e) => setJoinCode(e.target.value)} placeholder="Paste an invite code" />
          <button type="button" style={S.btn} disabled={!joinCode.trim()} onClick={run(async () => {
            await api.acceptInvitation(joinCode.trim());
            window.location.reload();
          })}>Join</button>
        </div>
      </section>
    </div>
  );
}

function Tasks({ wsId, current, members, onError }) {
  const [tasks, setTasks] = useState([]);
  const [title, setTitle] = useState("");
  const [assignee, setAssignee] = useState("me");
  const load = useCallback(async () => { try { setTasks(await api.listTasks(wsId)); } catch (e) { onError(e.message); } }, [wsId, onError]);
  useEffect(() => { load(); }, [load]);
  const toAssignee = (v) => (v === "agent" ? { type: "agent" } : v === "none" ? null : { type: "human", userId: v === "me" ? current.userId : v });
  const run = (fn) => async () => { try { await fn(); await load(); } catch (e) { onError(e.message); } };
  return (
    <section style={S.card} aria-label="Tasks">
      <strong>Tasks</strong>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        <input aria-label="Task title" style={{ ...S.input, flex: 1 }} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="What needs doing?" />
        <select aria-label="Assign to" style={S.input} value={assignee} onChange={(e) => setAssignee(e.target.value)}>
          <option value="me">Me</option>
          <option value="agent">AI agent</option>
          <option value="none">Unassigned</option>
          {members.filter((m) => m.user_id !== current.userId).map((m) => <option key={m.user_id} value={m.user_id}>{m.user_id}</option>)}
        </select>
        <button type="button" style={S.primary} disabled={!title.trim()} onClick={run(async () => { await api.createTask(wsId, { title: title.trim(), assignee: toAssignee(assignee) }); setTitle(""); })}>Add task</button>
      </div>
      {tasks.length === 0 && <span style={S.muted}>No tasks yet.</span>}
      {tasks.map((t) => (
        <div key={t.id} data-testid={`task-${t.id}`} style={{ display: "flex", gap: 8, alignItems: "center", borderTop: "1px solid var(--mcis-border, #eee)", paddingTop: 6 }}>
          <span style={{ flex: 1 }}>{t.title}</span>
          <span style={S.muted}>{t.assignee ? (t.assignee.type === "agent" ? "AI agent" : t.assignee.userId === current.userId ? "me" : t.assignee.userId) : "unassigned"}</span>
          <select aria-label={`Status of ${t.title}`} style={S.input} value={t.status} onChange={(e) => run(() => api.setTaskStatus(wsId, t.id, e.target.value))()}>
            {["todo", "in_progress", "blocked", "done", "cancelled"].map((s) => <option key={s} value={s}>{s.replace("_", " ")}</option>)}
          </select>
        </div>
      ))}
    </section>
  );
}

function Activity({ wsId, onError }) {
  const [execs, setExecs] = useState([]);
  const [runs, setRuns] = useState([]);
  const [note, setNote] = useState(null);
  const load = useCallback(async () => {
    try {
      const list = await api.listExecutions(wsId);
      const waiting = await Promise.all(list.filter((e) => e.status === "waiting_approval").slice(0, 5).map((e) => api.getExecution(wsId, e.id)));
      setExecs(list.map((e) => waiting.find((w) => w.id === e.id) || e));
      setRuns(await api.listRecentRuns(wsId).catch(() => []));
    } catch (e) { onError(e.message); }
  }, [wsId, onError]);
  useEffect(() => { load(); }, [load]);
  const decide = (e, d) => async () => {
    try { await api.decideExecutionApproval(wsId, e.id, e.waitingForApproval.id, d); setNote(`${d === "approve" ? "Approved" : "Rejected"}.`); await load(); } catch (err) {
      onError(err instanceof ApiError && err.status === 403 ? "You are not allowed to decide this approval." : err.message);
    }
  };
  return (
    <div style={{ display: "grid", gap: 12 }}>
      {note && <div role="status">{note}</div>}
      <section style={S.card} aria-label="Recent executions">
        <strong>Recent AI executions</strong>
        {execs.length === 0 && <span style={S.muted}>Nothing has run yet.</span>}
        {execs.map((e) => (
          <div key={e.id} data-testid={`exec-${e.id}`} style={{ display: "grid", gap: 4, borderTop: "1px solid var(--mcis-border, #eee)", paddingTop: 6 }}>
            <div style={{ display: "flex", gap: 8 }}><span style={{ flex: 1 }}>{e.goal}</span><strong>{e.status.replace(/_/g, " ")}</strong></div>
            {e.waitingForApproval && (
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <span>Needs approval: {e.waitingForApproval.action} ({e.waitingForApproval.riskTier})</span>
                <button type="button" style={S.primary} onClick={decide(e, "approve")}>Approve</button>
                <button type="button" style={S.btn} onClick={decide(e, "reject")}>Reject</button>
              </div>
            )}
            {e.verification && <span style={S.muted}>Verification: {e.verification.status}</span>}
          </div>
        ))}
      </section>
      <section style={S.card} aria-label="Recent workflow runs">
        <strong>Recent workflow runs</strong>
        {runs.length === 0 && <span style={S.muted}>No workflow runs yet.</span>}
        {runs.map((r) => (
          <div key={r.id} style={{ display: "flex", gap: 8 }}>
            <span style={{ flex: 1 }}>{r.trigger} run · {new Date(r.createdAt).toLocaleString()}</span>
            <strong>{r.status.replace(/_/g, " ")}</strong>
          </div>
        ))}
        <a href="/workflows" style={S.muted}>Open Workflows for step-by-step evidence and workflow approvals →</a>
      </section>
    </div>
  );
}

function Templates({ wsId, onError }) {
  const [list, setList] = useState([]);
  const [msg, setMsg] = useState(null);
  useEffect(() => { api.listTemplates(wsId).then(setList).catch((e) => onError(e.message)); }, [wsId, onError]);
  return (
    <section style={S.card} aria-label="Workflow templates">
      <strong>Workflow templates</strong>
      {msg && <div role="status">{msg}</div>}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 8 }}>
        {list.map((t) => (
          <div key={t.id} data-testid={`template-${t.id}`} style={{ border: "1px solid var(--mcis-border, #eee)", borderRadius: 8, padding: 10, display: "grid", gap: 4 }}>
            <strong>{t.name}</strong>
            <span style={{ fontSize: 13 }}>{t.description}</span>
            <span style={S.muted}>{api.RISK_LABELS[t.riskLevel]} · {t.category}{t.requiresApproval ? " · includes an approval step" : ""}</span>
            {t.requiredIntegrations.map((r) => (
              <span key={r.provider} style={{ ...S.muted, color: r.available ? undefined : "#c98a00" }}>
                Needs: {r.label} — {r.available ? "connected" : "not connected"}
              </span>
            ))}
            <button type="button" style={{ ...S.btn, justifySelf: "start" }} disabled={!t.available}
              title={t.available ? "" : "Connect the required integration first"}
              onClick={async () => {
                try {
                  const body = {};
                  if (t.requiredIntegrations.length) body.integrations = Object.fromEntries(t.requiredIntegrations.map((r) => [r.provider, r.candidates[0].id]));
                  const out = await api.instantiateTemplate(wsId, t.id, body);
                  setMsg(`"${out.workflow.name}" was created as a draft. Review and publish it in Workflows.`);
                } catch (e) { onError(e.message); }
              }}>{t.available ? "Create workflow" : "Integration required"}</button>
          </div>
        ))}
      </div>
    </section>
  );
}

// Layer 9: data retention (owner edits, admins view). The server enforces the
// minimums and runs the purge; this form only collects the numbers.
function Retention({ wsId, current, onError }) {
  const [r, setR] = useState(null);
  const [execDays, setExecDays] = useState("");
  const [auditDays, setAuditDays] = useState("");
  const [msg, setMsg] = useState(null);
  const isAdmin = current.role === "owner" || current.role === "admin";
  const isOwner = current.role === "owner";
  const show = (v) => { setR(v); setExecDays(v.executionsDays ?? ""); setAuditDays(v.auditDays ?? ""); };
  useEffect(() => { if (isAdmin) api.getRetention(wsId).then(show).catch((e) => onError(e.message)); }, [wsId, isAdmin, onError]);
  if (!isAdmin) return <section style={S.card} aria-label="Data retention"><span style={S.muted}>Data retention is managed by workspace owners and admins.</span></section>;
  if (!r) return <section style={S.card} aria-label="Data retention">Loading…</section>;
  const toBody = () => ({ executionsDays: execDays === "" ? null : Number(execDays), auditDays: auditDays === "" ? null : Number(auditDays) });
  return (
    <section style={S.card} aria-label="Data retention">
      <strong>Data retention</strong>
      <span style={S.muted}>Finished runs and executions (with their evidence) and audit records older than these limits are deleted permanently. Leave empty to keep them. Minimums: {r.floors.executionsDays} days for executions, {r.floors.auditDays} days for audit records. Running or waiting work is never deleted.</span>
      <label>Executions & runs (days) <input aria-label="Execution retention days" style={S.input} inputMode="numeric" value={execDays} disabled={!isOwner} onChange={(e) => setExecDays(e.target.value.replace(/[^0-9]/g, ""))} /></label>
      <label>Audit records (days) <input aria-label="Audit retention days" style={S.input} inputMode="numeric" value={auditDays} disabled={!isOwner} onChange={(e) => setAuditDays(e.target.value.replace(/[^0-9]/g, ""))} /></label>
      <span style={S.muted}>Usage records: {r.usageDays ? `${r.usageDays} days (server setting)` : "kept (server setting)"}.</span>
      {isOwner ? (
        <div style={{ display: "flex", gap: 6 }}>
          <button type="button" style={S.primary} onClick={async () => { setMsg(null); try { show(await api.saveRetention(wsId, toBody())); setMsg("Saved."); } catch (e) { onError(e.message); } }}>Save</button>
          <button type="button" style={S.btn} onClick={async () => {
            setMsg(null);
            try { const out = await api.purgeRetentionNow(wsId); setMsg(out.skipped ? "Nothing to delete with the current settings." : `Deleted ${out.counts.workflowRuns} run(s), ${out.counts.executions} execution(s), ${out.counts.auditRows} audit record(s).`); } catch (e) { onError(e.message); }
          }}>Apply now</button>
        </div>
      ) : <span style={S.muted}>Only the owner can change retention.</span>}
      {msg && <div role="status">{msg}</div>}
    </section>
  );
}

export default function WorkspacePage() {
  const w = useWorkspace();
  const [tab, setTab] = useState(() => { try { if (/(?:^#|&)invite=/.test(window.location.hash || "")) return "team"; return new URLSearchParams(window.location.search).get("tab") || "overview"; } catch { return "overview"; } });
  const [overview, setOverview] = useState(null);
  const [members, setMembers] = useState([]);
  const [error, setError] = useState(null);
  const onError = useCallback((m) => setError(m), []);

  useEffect(() => {
    if (!w.workspaceId) return;
    setOverview(null); setError(null);
    api.getOverview(w.workspaceId).then(setOverview).catch((e) => setError(e.status === 404 ? "You no longer have access to that workspace." : e.message));
    api.listMembers(w.workspaceId).then(setMembers).catch(() => setMembers([]));
  }, [w.workspaceId]);

  if (w.authLoading) return <div style={{ padding: 24 }}>Loading…</div>;
  if (!w.user) return <div style={{ padding: 24 }}>Please <a href="/">sign in</a>.</div>;
  const current = w.current ? { ...w.current, userId: w.user.uid } : null;

  return (
    <div style={S.page}>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <h2 style={{ margin: 0 }}>{current ? (current.is_personal ? "Personal workspace" : current.name) : "Workspace"}</h2>
        <select aria-label="Workspace" style={S.input} value={w.workspaceId || ""} onChange={(e) => w.setWorkspaceId(e.target.value)}>
          {w.workspaces.map((x) => <option key={x.id} value={x.id}>{x.is_personal ? "Personal" : x.name} ({x.role})</option>)}
        </select>
        {current && <span style={S.muted}>You are {api.ROLE_LABELS[current.role]?.toLowerCase()}</span>}
        <span style={{ flex: 1 }} />
        <a href="/" style={S.muted}>Back to app</a>
      </div>
      <nav aria-label="Workspace sections" style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        {TABS.map(([id, label]) => (
          <button key={id} type="button" role="tab" aria-selected={tab === id} style={tab === id ? S.primary : S.btn} onClick={() => setTab(id)}>{label}</button>
        ))}
        <span style={{ width: 12 }} />
        {LINKS.map(([href, label]) => <a key={href} href={href} style={{ ...S.btn, textDecoration: "none" }}>{label}</a>)}
      </nav>
      {error && <div role="alert" style={S.danger}>{error}</div>}
      {current && !error && tab === "overview" && <Overview data={overview} />}
      {current && tab === "team" && <Team wsId={current.id} current={current} onError={onError} />}
      {current && tab === "tasks" && <Tasks wsId={current.id} current={current} members={members} onError={onError} />}
      {current && tab === "activity" && <Activity wsId={current.id} onError={onError} />}
      {current && tab === "templates" && <Templates wsId={current.id} onError={onError} />}
      {current && tab === "data" && <Retention wsId={current.id} current={current} onError={onError} />}
    </div>
  );
}
