/**
 * Layer 4 — minimal workflow UI (served at /workflows).
 *
 *   current workspace + switcher · workflow list · create · details ·
 *   publish/archive · run (inputs) · run history · run detail with step
 *   status, approval state (approve/reject), review actions and an
 *   evidence summary.
 *
 * Authorization is enforced by the backend on every call; this page only
 * reflects what the server returns (a 404 on a remembered workspace means
 * the user is no longer a member → fall back to the personal workspace).
 */
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { onAuthStateChanged } from "firebase/auth";
import { auth } from "../firebase";
import * as wfApi from "./workflowsApi";
import * as intApi from "../integrations/integrationsApi";

const ACTIVE_RUN = new Set(["queued", "running", "waiting_approval"]);
const card = { background: "var(--mcis-surface, #fff)", border: "1px solid var(--mcis-border, #ddd)", borderRadius: 12, padding: 16 };
const btn = { padding: "6px 12px", borderRadius: 8, border: "1px solid var(--mcis-border, #ccc)", background: "var(--mcis-input, #f7f7f7)", color: "inherit", cursor: "pointer", fontSize: 13 };
const primaryBtn = { ...btn, background: "var(--mcis-primary-solid, #5b4bff)", color: "#fff", border: "none" };
const input = { width: "100%", padding: "7px 9px", borderRadius: 8, border: "1px solid var(--mcis-border, #ccc)", background: "var(--mcis-input, #fff)", color: "inherit", boxSizing: "border-box", fontSize: 13 };
const muted = { color: "var(--mcis-muted, #777)", fontSize: 12 };

function Badge({ value }) {
  const colors = { active: "#1a9b5c", completed: "#1a9b5c", draft: "#8a8a8a", archived: "#8a8a8a", failed: "#c43d3d", cancelled: "#8a8a8a", needs_review: "#c98a00", waiting_approval: "#c98a00", running: "#3a6fd8", queued: "#3a6fd8" };
  return <span data-testid="badge" style={{ fontSize: 11, padding: "2px 8px", borderRadius: 999, color: "#fff", background: colors[value] || "#666" }}>{String(value).replace("_", " ")}</span>;
}

function emptyStep(i) {
  return { key: `step_${i + 1}`, name: "", instruction: "", approval: "auto", integrationId: "", action: "", input: {} };
}

// Layer 5: a step may run one integration action. Only the integration id,
// action name and plain inputs are sent — never credentials.
function useIntegrations(workspaceId) {
  const [state, setState] = useState({ integrations: [], providers: [] });
  useEffect(() => {
    let alive = true;
    Promise.all([intApi.listIntegrations(workspaceId), intApi.listProviders(workspaceId)])
      .then(([integrations, providers]) => { if (alive) setState({ integrations, providers }); })
      .catch(() => { if (alive) setState({ integrations: [], providers: [] }); }); // integrations disabled / no access
    return () => { alive = false; };
  }, [workspaceId]);
  return state;
}

function toDefinitionStep(s) {
  const { integrationId, action, input, ...rest } = s;
  if (!integrationId) return rest;
  const cleanInput = Object.fromEntries(Object.entries(input || {}).filter(([, v]) => v !== ""));
  return { ...rest, ...(rest.instruction ? {} : { instruction: undefined }), connector: { integrationId, action, input: cleanInput } };
}

function CreateWorkflow({ workspaceId, onCreated, onCancel }) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [variables, setVariables] = useState("");
  const [steps, setSteps] = useState([emptyStep(0)]);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const setStep = (i, patch) => setSteps((s) => s.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  const { integrations, providers } = useIntegrations(workspaceId);
  const integrationById = (id) => integrations.find((x) => x.id === id);
  const fieldsFor = (integrationId, action) => {
    const i = integrationById(integrationId);
    const p = i && providers.find((x) => x.provider === i.provider);
    const a = p && p.actions.find((x) => x.name === action);
    return a ? a.input : {};
  };

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const vars = variables.split(",").map((v) => v.trim()).filter(Boolean).map((n) => ({ name: n, type: "string" }));
      const created = await wfApi.createWorkflow(workspaceId, { name, description, definition: { variables: vars, steps: steps.map(toDefinitionStep) } });
      onCreated(created);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} style={{ ...card, display: "grid", gap: 10 }} aria-label="Create workflow">
      <strong>New workflow</strong>
      <input style={input} placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} aria-label="Workflow name" />
      <textarea style={input} placeholder="Description (optional)" value={description} onChange={(e) => setDescription(e.target.value)} />
      <input style={input} placeholder="Variables, comma separated (e.g. customer_name, date_range)" value={variables} onChange={(e) => setVariables(e.target.value)} aria-label="Variables" />
      <span style={muted}>Use {"{{input.customer_name}}"} or {"{{steps.<key>.output}}"} of an earlier step inside instructions.</span>
      {steps.map((s, i) => (
        <div key={i} style={{ display: "grid", gap: 6, borderTop: "1px dashed var(--mcis-border, #ddd)", paddingTop: 8 }}>
          <div style={{ display: "flex", gap: 6 }}>
            <input style={{ ...input, flex: 1 }} placeholder="Step key" value={s.key} onChange={(e) => setStep(i, { key: e.target.value })} />
            <input style={{ ...input, flex: 2 }} placeholder="Step name" value={s.name} onChange={(e) => setStep(i, { name: e.target.value })} aria-label={`Step ${i + 1} name`} />
            <select style={{ ...input, flex: 1 }} value={s.approval} onChange={(e) => setStep(i, { approval: e.target.value })} aria-label={`Step ${i + 1} approval`}>
              <option value="auto">Auto (risk-based)</option>
              <option value="required">Approval required</option>
              <option value="admin">Admin approval</option>
            </select>
          </div>
          {integrations.length > 0 && (
            <div style={{ display: "flex", gap: 6 }}>
              <select style={{ ...input, flex: 1 }} value={s.integrationId} aria-label={`Step ${i + 1} integration`}
                onChange={(e) => setStep(i, { integrationId: e.target.value, action: "", input: {} })}>
                <option value="">Agent step (no integration)</option>
                {integrations.map((x) => <option key={x.id} value={x.id}>{x.name} ({x.providerName}{x.status !== "connected" ? `, ${x.status}` : ""})</option>)}
              </select>
              {s.integrationId && (
                <select style={{ ...input, flex: 1 }} value={s.action} aria-label={`Step ${i + 1} action`} onChange={(e) => setStep(i, { action: e.target.value, input: {} })}>
                  <option value="">Choose an action…</option>
                  {(integrationById(s.integrationId) || { actions: [] }).actions.filter((a) => a.available).map((a) => (
                    <option key={a.name} value={a.name} disabled={!a.enabled}>{intApi.actionLabel(integrationById(s.integrationId), a)}{a.enabled ? "" : " (disabled)"}{a.requiresApproval ? " · needs approval" : ""}</option>
                  ))}
                </select>
              )}
            </div>
          )}
          {s.integrationId && s.action && Object.entries(fieldsFor(s.integrationId, s.action)).map(([field, f]) => (
            <input key={field} style={input} placeholder={`${field}${f.required ? " (required)" : ""}${f.type === "object" ? " — JSON" : ""}`} aria-label={`Step ${i + 1} input ${field}`}
              value={s.input[field] || ""} onChange={(e) => setStep(i, { input: { ...s.input, [field]: e.target.value } })} />
          ))}
          {!s.integrationId && (
            <textarea style={input} placeholder="Instruction for the agent" value={s.instruction} onChange={(e) => setStep(i, { instruction: e.target.value })} aria-label={`Step ${i + 1} instruction`} />
          )}
        </div>
      ))}
      <div style={{ display: "flex", gap: 8 }}>
        <button type="button" style={btn} onClick={() => setSteps((s) => [...s, emptyStep(s.length)])}>Add step</button>
        <span style={{ flex: 1 }} />
        <button type="button" style={btn} onClick={onCancel}>Cancel</button>
        <button type="submit" style={primaryBtn} disabled={busy}>Save draft</button>
      </div>
      {error && <div role="alert" style={{ color: "var(--mcis-danger, #c43d3d)" }}>{error}</div>}
    </form>
  );
}

function RunDetail({ workspaceId, runId, uid, onChanged }) {
  const [run, setRun] = useState(null);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    try {
      setRun(await wfApi.getRun(workspaceId, runId));
      setError(null);
    } catch (err) {
      setError(err.message);
    }
  }, [workspaceId, runId]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (!run || !ACTIVE_RUN.has(run.status)) return undefined;
    const t = setInterval(load, 2000);
    return () => clearInterval(t);
  }, [run, load]);

  async function act(fn) {
    try {
      await fn();
      await load();
      onChanged && onChanged();
    } catch (err) {
      setError(err.message);
    }
  }

  if (!run) return <div style={muted}>{error || "Loading run…"}</div>;
  return (
    <div style={{ ...card, display: "grid", gap: 8 }} data-testid="run-detail">
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <strong>Run</strong> <Badge value={run.status} /> <span style={muted}>version {run.version} · {run.trigger}</span>
        <span style={{ flex: 1 }} />
        {ACTIVE_RUN.has(run.status) && <button style={btn} onClick={() => act(() => wfApi.cancelRun(workspaceId, run.id))}>Cancel run</button>}
      </div>
      {run.failure && <div style={{ color: "var(--mcis-danger, #c43d3d)" }}>{run.failure.code}: {run.failure.message}</div>}
      {run.status === "needs_review" && (
        <div style={{ ...card, background: "var(--mcis-accent-soft, #fff7e0)" }}>
          <div style={{ marginBottom: 6 }}>Needs review: {run.reviewReason}</div>
          <button style={btn} onClick={() => act(() => wfApi.resolveRun(workspaceId, run.id, "retry_step"))}>Retry step</button>{" "}
          <button style={btn} onClick={() => act(() => wfApi.resolveRun(workspaceId, run.id, "skip_step"))}>Skip step</button>{" "}
          <button style={btn} onClick={() => act(() => wfApi.resolveRun(workspaceId, run.id, "fail"))}>Fail run</button>
        </div>
      )}
      <ol style={{ margin: 0, paddingLeft: 18, display: "grid", gap: 6 }}>
        {run.steps.map((s) => {
          const appr = s.execution && s.execution.waitingForApproval;
          const ev = s.execution && s.execution.evidenceSummary;
          return (
            <li key={s.position}>
              <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                <span>{s.name}</span> <Badge value={s.status} />
                {s.attempt > 1 && <span style={muted}>attempt {s.attempt}</span>}
              </div>
              {ev && <div style={muted}>evidence: {ev.steps} action(s), {ev.succeeded} ok, {ev.failed} failed, {ev.verified} verified</div>}
              {s.output && s.output.message && <div style={muted}>output: {s.output.message}</div>}
              {s.error && <div style={{ ...muted, color: "var(--mcis-danger, #c43d3d)" }}>{s.error.code}: {s.error.message}</div>}
              {appr && appr.status === "pending" && (
                <div style={{ ...card, padding: 8, marginTop: 4 }} data-testid="approval">
                  <div>Approval needed: <strong>{appr.action}</strong> ({appr.riskTier}, {appr.requiredRole === "admin" ? "admin only" : "initiator or admin"})</div>
                  <button style={primaryBtn} onClick={() => act(() => wfApi.decideApproval(workspaceId, run.id, s.position, appr.id, "approve"))}>Approve</button>{" "}
                  <button style={btn} onClick={() => act(() => wfApi.decideApproval(workspaceId, run.id, s.position, appr.id, "reject"))}>Reject</button>
                </div>
              )}
            </li>
          );
        })}
      </ol>
      {run.verification && <div style={muted}>verification: {run.verification.status}</div>}
      {run.initiatedBy === uid && <div style={muted}>You started this run.</div>}
      {error && <div role="alert" style={{ color: "var(--mcis-danger, #c43d3d)" }}>{error}</div>}
    </div>
  );
}

function WorkflowDetail({ workspaceId, workflowId, uid, onChanged }) {
  const [wf, setWf] = useState(null);
  const [version, setVersion] = useState(null);
  const [runs, setRuns] = useState([]);
  const [inputs, setInputs] = useState({});
  const [selectedRun, setSelectedRun] = useState(null);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    try {
      const w = await wfApi.getWorkflow(workspaceId, workflowId);
      setWf(w);
      const active = w.activeVersionId && w.versions.find((v) => v.id === w.activeVersionId);
      setVersion(active ? await wfApi.getVersion(workspaceId, w.id, active.version) : null);
      setRuns(await wfApi.listRuns(workspaceId, w.id));
      setError(null);
    } catch (err) {
      setError(err.message);
    }
  }, [workspaceId, workflowId]);

  useEffect(() => { setSelectedRun(null); load(); }, [load]);

  async function act(fn) {
    try {
      const out = await fn();
      await load();
      onChanged && onChanged();
      return out;
    } catch (err) {
      setError(err.message);
      return null;
    }
  }

  if (!wf) return <div style={muted}>{error || "Loading…"}</div>;
  const vars = version ? version.definition.variables : [];
  return (
    <div style={{ display: "grid", gap: 12 }}>
      <div style={{ ...card, display: "grid", gap: 8 }} data-testid="workflow-detail">
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <strong style={{ fontSize: 16 }}>{wf.name}</strong> <Badge value={wf.status} />
          <span style={muted}>{wf.latestVersion ? `latest v${wf.latestVersion}` : "not published"} · trigger: {wf.trigger.type}</span>
          <span style={{ flex: 1 }} />
          {wf.status !== "archived" && <button style={btn} onClick={() => act(() => wfApi.publishWorkflow(workspaceId, wf.id))}>Publish draft</button>}
          {wf.status !== "archived"
            ? <button style={btn} onClick={() => act(() => wfApi.archiveWorkflow(workspaceId, wf.id))}>Archive</button>
            : <button style={btn} onClick={() => act(() => wfApi.activateWorkflow(workspaceId, wf.id))}>Re-activate</button>}
        </div>
        {wf.description && <div style={muted}>{wf.description}</div>}
        <ol style={{ margin: 0, paddingLeft: 18 }}>
          {(version ? version.definition.steps : wf.draft.steps).map((s) => (
            <li key={s.key}>{s.name} {s.connector && <span style={muted}>[integration: {s.connector.action}]</span>} {s.approval && s.approval !== "auto" && <span style={muted}>({s.approval === "admin" ? "admin approval" : "approval required"})</span>}</li>
          ))}
        </ol>
        {wf.status === "active" && version && (
          <form
            aria-label="Run workflow"
            style={{ display: "grid", gap: 6 }}
            onSubmit={async (e) => {
              e.preventDefault();
              const out = await act(() => wfApi.startRun(workspaceId, wf.id, inputs));
              if (out) setSelectedRun(out.id);
            }}
          >
            {vars.map((v) => (
              <input key={v.name} style={input} placeholder={v.label || v.name} aria-label={`input ${v.name}`}
                value={inputs[v.name] || ""} onChange={(e) => setInputs((x) => ({ ...x, [v.name]: e.target.value }))} />
            ))}
            <button type="submit" style={primaryBtn}>Run v{version.version}</button>
          </form>
        )}
        {error && <div role="alert" style={{ color: "var(--mcis-danger, #c43d3d)" }}>{error}</div>}
      </div>
      <div style={{ ...card }}>
        <strong>Run history</strong>
        {runs.length === 0 && <div style={muted}>No runs yet.</div>}
        <ul style={{ listStyle: "none", padding: 0, margin: "8px 0 0", display: "grid", gap: 4 }}>
          {runs.map((r) => (
            <li key={r.id}>
              <button style={{ ...btn, width: "100%", textAlign: "left", display: "flex", gap: 8 }} onClick={() => setSelectedRun(r.id)}>
                <Badge value={r.status} /> <span>v{r.version}</span> <span style={muted}>{new Date(r.createdAt).toLocaleString()}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
      {selectedRun && <RunDetail workspaceId={workspaceId} runId={selectedRun} uid={uid} onChanged={load} />}
    </div>
  );
}

export default function WorkflowsPage() {
  const [user, setUser] = useState(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [workspaces, setWorkspaces] = useState([]);
  const [workspaceId, setWorkspaceId] = useState(null);
  const [workflows, setWorkflows] = useState([]);
  const [selected, setSelected] = useState(null);
  const [creating, setCreating] = useState(false);
  const [notice, setNotice] = useState(null);

  useEffect(() => onAuthStateChanged(auth, (u) => { setUser(u); setAuthLoading(false); }), []);

  // Load memberships from the SERVER and re-validate the remembered choice.
  useEffect(() => {
    if (!user) return;
    let alive = true;
    wfApi.listWorkspaces().then((list) => {
      if (!alive) return;
      setWorkspaces(list);
      const chosen = wfApi.pickWorkspace(list, wfApi.getStoredWorkspaceId(user.uid));
      setWorkspaceId(chosen ? chosen.id : null);
    }).catch((err) => setNotice(err.message));
    return () => { alive = false; };
  }, [user]);

  const personal = useMemo(() => workspaces.find((w) => w.is_personal) || workspaces[0], [workspaces]);

  const loadWorkflows = useCallback(async () => {
    if (!workspaceId) return;
    try {
      setWorkflows(await wfApi.listWorkflows(workspaceId));
    } catch (err) {
      if (err.status === 404 && personal && workspaceId !== personal.id) {
        // No longer a member (or never was): the server refused — go back to personal.
        setNotice("You no longer have access to that workspace.");
        wfApi.storeWorkspaceId(user.uid, null);
        setWorkspaceId(personal.id);
      } else {
        setNotice(err.message);
      }
    }
  }, [workspaceId, personal, user]);

  useEffect(() => { setSelected(null); setCreating(false); loadWorkflows(); }, [loadWorkflows]);

  function switchWorkspace(id) {
    setNotice(null);
    wfApi.storeWorkspaceId(user.uid, id);
    setWorkflows([]);
    setWorkspaceId(id);
  }

  if (authLoading) return <div className="mcis-loading-screen"><span className="mcis-loading-text">Loading...</span></div>;
  if (!user) {
    return (
      <div style={{ padding: 32 }}>
        <p>Please <a href="/">sign in</a> to manage workflows.</p>
      </div>
    );
  }

  const current = workspaces.find((w) => w.id === workspaceId);
  return (
    <div style={{ minHeight: "100vh", background: "var(--mcis-bg, #fafafa)", color: "var(--mcis-text, #111)", padding: 16, boxSizing: "border-box" }}>
      <header style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", marginBottom: 16 }}>
        <a href="/" style={{ ...btn, textDecoration: "none" }}>← Back</a>
        <h1 style={{ margin: 0, fontSize: 20 }}>Workflows</h1>
        <span style={{ flex: 1 }} />
        <label style={muted} htmlFor="ws-switcher">Workspace</label>
        <select id="ws-switcher" aria-label="Workspace" style={{ ...input, width: "auto" }} value={workspaceId || ""} onChange={(e) => switchWorkspace(e.target.value)}>
          {workspaces.map((w) => <option key={w.id} value={w.id}>{w.is_personal ? "Personal" : w.name} ({w.role})</option>)}
        </select>
      </header>
      {notice && <div role="status" style={{ ...card, marginBottom: 12 }}>{notice}</div>}
      <div style={{ display: "grid", gridTemplateColumns: "minmax(220px, 300px) 1fr", gap: 16, alignItems: "start" }}>
        <aside style={{ ...card, display: "grid", gap: 6 }}>
          <div style={{ display: "flex", alignItems: "center" }}>
            <strong style={{ flex: 1 }}>{current ? (current.is_personal ? "Personal" : current.name) : ""}</strong>
            <button style={btn} onClick={() => { setCreating(true); setSelected(null); }}>New</button>
          </div>
          {workflows.length === 0 && <div style={muted}>No workflows in this workspace.</div>}
          {workflows.map((w) => (
            <button key={w.id} style={{ ...btn, textAlign: "left", display: "flex", gap: 6, alignItems: "center", background: selected === w.id ? "var(--mcis-active, #eee)" : btn.background }}
              onClick={() => { setSelected(w.id); setCreating(false); }}>
              <span style={{ flex: 1 }}>{w.name}</span> <Badge value={w.status} />
            </button>
          ))}
        </aside>
        <main>
          {creating && workspaceId && (
            <CreateWorkflow workspaceId={workspaceId} onCancel={() => setCreating(false)}
              onCreated={(w) => { setCreating(false); loadWorkflows(); setSelected(w.id); }} />
          )}
          {!creating && selected && workspaceId && <WorkflowDetail key={`${workspaceId}:${selected}`} workspaceId={workspaceId} workflowId={selected} uid={user.uid} onChanged={loadWorkflows} />}
          {!creating && !selected && <div style={muted}>Select a workflow, or create one.</div>}
        </main>
      </div>
    </div>
  );
}
