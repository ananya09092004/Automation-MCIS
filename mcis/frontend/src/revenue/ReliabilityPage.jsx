/**
 * Layer 10 — AI agent reliability testing (served at /reliability).
 * Projects → suites → scenarios; runs execute real agent executions /
 * workflow runs (or wait for an external agent's report) and are scored
 * from stored evidence. Metrics are computed by the server from results.
 */
import React, { useState } from "react";
import useWorkspace, { styles as S } from "../customer/useWorkspace";
import * as R from "./revenueApi";
import { Shell, Empty, useLoad } from "./common";

const STATUS_COLOR = { passed: "#1a9b5c", failed: "#c43d3d", error: "#c43d3d", cancelled: "#777" };

function Report({ rep }) {
  if (!rep) return null;
  return (
    <div data-testid="qa-report" style={{ display: "flex", gap: 16, flexWrap: "wrap", fontSize: 13 }}>
      <span>Pass rate <strong>{rep.passRate === null ? "—" : `${rep.passRate}%`}</strong></span>
      <span>{rep.passed} passed · {rep.failed} failed · {rep.errored} errors · {rep.pending} pending</span>
      <span>Verified {rep.verifiedRate === null ? "—" : `${rep.verifiedRate}%`}</span>
      <span>Evidence complete {rep.evidenceCompleteRate === null ? "—" : `${rep.evidenceCompleteRate}%`}</span>
      <span>Policy denials {rep.policyDenials}</span>
      <span>Injection detections {rep.injectionDetections}</span>
      {Object.keys(rep.failureCategories || {}).length > 0 && <span>Failures: {Object.entries(rep.failureCategories).map(([k, v]) => `${k} ${v}`).join(", ")}</span>}
    </div>
  );
}

export default function ReliabilityPage() {
  const ws = useWorkspace();
  const w = ws.workspaceId;
  const projects = useLoad(() => (w ? R.listProjects(w) : Promise.resolve([])), [w]);
  const [pid, setPid] = useState(null);
  const project = useLoad(() => (w && pid ? R.getProject(w, pid) : Promise.resolve(null)), [w, pid]);
  const metrics = useLoad(() => (w && pid ? R.projectMetrics(w, pid) : Promise.resolve(null)), [w, pid]);
  const [run, setRun] = useState(null);
  const [msg, setMsg] = useState(null);
  const [pf, setPf] = useState({ name: "", agentLabel: "" });
  const [sf, setSf] = useState({ name: "", goal: "", executor: "nexus_agent", mustContain: "" });
  const act = (fn) => async (...a) => { setMsg(null); try { await fn(...a); } catch (x) { setMsg(x.code === "QUOTA_EXCEEDED" ? "Your plan's limit for agent test scenarios has been reached." : x.message); } };
  const addProject = act(async (e) => { e.preventDefault(); const p = await R.createProject(w, { name: pf.name, ...(pf.agentLabel ? { agentLabel: pf.agentLabel } : {}) }); setPf({ name: "", agentLabel: "" }); await projects.reload(); setPid(p.id); });
  const addScenario = act(async (e) => {
    e.preventDefault();
    let suite = project.data.suites[0];
    if (!suite) suite = await R.createSuite(w, pid, { name: "Default suite" });
    await R.createScenario(w, suite.id, { name: sf.name, executor: sf.executor, ...(sf.goal ? { goal: sf.goal } : {}), expected: sf.mustContain ? { mustContain: sf.mustContain.split(",").map((x) => x.trim()).filter(Boolean) } : {} });
    setSf({ ...sf, name: "", goal: "", mustContain: "" });
    project.reload();
  });
  const start = act(async () => { const r = await R.startQaRun(w, pid); setRun(await R.getQaRun(w, r.id)); });
  const refresh = act(async () => { if (run) setRun(await R.getQaRun(w, run.id)); metrics.reload(); });
  const cancel = act(async () => { await R.cancelQaRun(w, run.id); setRun(await R.getQaRun(w, run.id)); });
  const scen = new Map(((project.data && project.data.scenarios) || []).map((s) => [s.id, s]));
  return (
    <Shell title="Agent reliability" ws={ws}>
      {msg && <div role="alert" style={S.danger}>{msg}</div>}
      <section style={S.card} aria-label="Projects">
        <strong>Test projects</strong>
        {projects.error && <div role="alert" style={S.danger}>{projects.error}</div>}
        {projects.data && projects.data.length === 0 && <Empty>No test projects yet.</Empty>}
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {(projects.data || []).map((p) => <button key={p.id} type="button" style={p.id === pid ? S.primary : S.btn} onClick={() => { setPid(p.id); setRun(null); }}>{p.name}</button>)}
        </div>
        {ws.isAdmin && (
          <form onSubmit={addProject} style={{ display: "flex", gap: 6 }} aria-label="New project">
            <input style={S.input} aria-label="Project name" placeholder="Project name" value={pf.name} onChange={(e) => setPf({ ...pf, name: e.target.value })} required />
            <input style={S.input} aria-label="Agent under test" placeholder="Agent under test" value={pf.agentLabel} onChange={(e) => setPf({ ...pf, agentLabel: e.target.value })} />
            <button type="submit" style={S.primary}>Create</button>
          </form>
        )}
      </section>
      {project.data && (
        <section style={S.card} aria-label="Scenarios">
          <strong>{project.data.name} — scenarios</strong>
          {project.data.scenarios.length === 0 && <Empty>No scenarios yet.</Empty>}
          {project.data.scenarios.map((s) => <div key={s.id} style={{ fontSize: 13 }}>{s.name} <span style={S.muted}>{s.executor}{s.goal ? ` · ${s.goal}` : ""}</span></div>)}
          {ws.isAdmin && (
            <form onSubmit={addScenario} style={{ display: "flex", gap: 6, flexWrap: "wrap" }} aria-label="New scenario">
              <input style={S.input} aria-label="Scenario name" placeholder="Scenario name" value={sf.name} onChange={(e) => setSf({ ...sf, name: e.target.value })} required />
              <select style={S.input} aria-label="Executor" value={sf.executor} onChange={(e) => setSf({ ...sf, executor: e.target.value })}>
                <option value="nexus_agent">Nexus agent</option><option value="external_agent">External agent (reports via API)</option>
              </select>
              <input style={{ ...S.input, minWidth: 260 }} aria-label="Goal" placeholder="Goal for the agent" value={sf.goal} onChange={(e) => setSf({ ...sf, goal: e.target.value })} required={sf.executor === "nexus_agent"} />
              <input style={S.input} aria-label="Result must contain" placeholder="Result must contain (comma separated)" value={sf.mustContain} onChange={(e) => setSf({ ...sf, mustContain: e.target.value })} />
              <button type="submit" style={S.primary}>Add scenario</button>
            </form>
          )}
          <div style={{ display: "flex", gap: 6 }}>
            <button type="button" style={S.primary} onClick={start} disabled={!project.data.scenarios.length}>Run all scenarios</button>
            {run && <button type="button" style={S.btn} onClick={refresh}>Refresh</button>}
            {run && run.status === "running" && <button type="button" style={S.btn} onClick={cancel}>Cancel run</button>}
          </div>
        </section>
      )}
      {run && (
        <section style={S.card} aria-label="Run results">
          <strong>Run {run.status}</strong>
          <Report rep={run.report} />
          {run.results.map((r) => (
            <div key={r.id} data-testid={`result-${r.id}`} style={{ fontSize: 13, borderTop: "1px solid var(--mcis-border, #eee)", paddingTop: 4 }}>
              <span style={{ color: STATUS_COLOR[r.status] || "inherit", fontWeight: 600 }}>{r.status.replace("_", " ")}</span> {scen.get(r.scenarioId) ? scen.get(r.scenarioId).name : r.scenarioId}
              {r.failureCategory && <span> · {r.failureCategory}</span>}
              {r.verdict && r.verdict.checks && <span style={S.muted}> · {r.verdict.checks.filter((c) => !c.passed).map((c) => c.name).join(", ") || "all checks passed"}</span>}
            </div>
          ))}
        </section>
      )}
      {metrics.data && metrics.data.runs > 0 && (
        <section style={S.card} aria-label="Reliability metrics">
          <strong>Last {metrics.data.runs} completed run(s)</strong>
          <Report rep={metrics.data.overall} />
          {metrics.data.flakyScenarios.length > 0 && <div role="alert">Flaky scenarios: {metrics.data.flakyScenarios.map((f) => (scen.get(f.scenarioId) || {}).name || f.scenarioId).join(", ")}</div>}
        </section>
      )}
    </Shell>
  );
}
