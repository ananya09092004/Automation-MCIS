/**
 * Layer 8 — first-time onboarding (served at /onboarding).
 *
 *   workspace → team → use case → first workflow (template) → first safe run → done
 *
 * Resumable: every step is saved on the server, so reloading continues
 * where the user left off. Every action is authorized by the server
 * (workspace membership, invitation rules, plan limits, Agent Firewall,
 * approvals) — this page never decides permissions.
 */
import React, { useCallback, useEffect, useState } from "react";
import { onAuthStateChanged } from "firebase/auth";
import { auth } from "../firebase";
import * as api from "../customer/customerApi";
import { listWorkspaces } from "../workflows/workflowsApi";
import { styles as S } from "../customer/useWorkspace";

const STEP_LABELS = { workspace: "Workspace", team: "Team", use_case: "Use case", template: "First workflow", first_run: "First run", done: "Done" };
const ORDER = ["workspace", "team", "use_case", "template", "first_run", "done"];

function Stepper({ step }) {
  const at = ORDER.indexOf(step);
  return (
    <ol aria-label="Onboarding progress" style={{ display: "flex", gap: 8, listStyle: "none", padding: 0, margin: 0, flexWrap: "wrap" }}>
      {ORDER.map((s, i) => (
        <li key={s} aria-current={s === step ? "step" : undefined}
          style={{ padding: "4px 10px", borderRadius: 999, fontSize: 12, border: "1px solid var(--mcis-border, #ddd)", background: i < at ? "var(--mcis-primary-soft, #ecebff)" : s === step ? "var(--mcis-primary-solid, #5b4bff)" : "transparent", color: s === step ? "#fff" : "inherit" }}>
          {i + 1}. {STEP_LABELS[s]}
        </li>
      ))}
    </ol>
  );
}

export default function OnboardingPage() {
  const [user, setUser] = useState(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [state, setState] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [workspaces, setWorkspaces] = useState([]);
  const [templates, setTemplates] = useState([]);
  const [invitations, setInvitations] = useState([]);
  const [run, setRun] = useState(null);
  // form state
  const [companyName, setCompanyName] = useState("");
  const [invites, setInvites] = useState([{ email: "", role: "member" }]);
  const [chosenTemplate, setChosenTemplate] = useState(null);
  const [inputs, setInputs] = useState({});

  useEffect(() => onAuthStateChanged(auth, (u) => { setUser(u); setAuthLoading(false); }), []);

  const act = useCallback(async (fn) => {
    setBusy(true); setError(null);
    try { const out = await fn(); if (out && out.step !== undefined) setState(out); return out; } catch (e) { setError(e.message); return null; } finally { setBusy(false); }
  }, []);

  useEffect(() => {
    if (!user) return;
    act(() => api.getOnboarding());
    listWorkspaces().then(setWorkspaces).catch(() => {});
  }, [user, act]);

  // Templates for the template step (current onboarding workspace).
  useEffect(() => {
    if (!state || state.step !== "template" || !state.workspaceId || templates.length) return;
    api.listTemplates(state.workspaceId, { useCase: state.useCase || undefined })
      .then((list) => setTemplates(list.filter((t) => t.onboarding && t.available)))
      .catch((e) => setError(e.message));
  }, [state, templates.length]);

  // First-run form needs the chosen template's inputs.
  useEffect(() => {
    if (!state || state.step !== "first_run" || !state.workspaceId || chosenTemplate) return;
    api.listTemplates(state.workspaceId).then((list) => {
      const t = list.find((x) => x.id === state.templateId);
      if (t) { setChosenTemplate(t); setInputs(Object.fromEntries(t.inputs.map((i) => [i.name, i.default !== undefined ? String(i.default) : ""]))); }
    }).catch(() => {});
  }, [state, chosenTemplate]);

  if (authLoading) return <div style={{ padding: 24 }}>Loading…</div>;
  if (!user) return <div style={{ padding: 24 }}>Please <a href="/">sign in</a> to set up Nexus.</div>;
  if (!state) return <div style={S.page}>{error ? <div role="alert" style={S.danger}>{error}</div> : "Loading…"}</div>;
  if (!state.enabled) return <div style={S.page}><p>Guided setup is not enabled on this server.</p><a href="/workspace">Go to your workspace</a></div>;

  const teamWorkspaces = workspaces.filter((w) => !w.is_personal);
  const skip = () => act(() => api.completeOnboarding()).then((s) => { if (s) window.location.assign("/workspace"); });

  return (
    <div style={{ ...S.page, maxWidth: 760 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <h2 style={{ margin: 0 }}>Set up Nexus</h2>
        <span style={{ flex: 1 }} />
        {!state.completed && state.started && <button type="button" style={S.btn} onClick={skip} disabled={busy}>Skip for now</button>}
      </div>
      {state.started && <Stepper step={state.step} />}
      {error && <div role="alert" style={S.danger}>{error}</div>}

      {!state.started && (
        <section style={S.card} aria-label="Welcome">
          <strong style={{ fontSize: 18 }}>Welcome to Nexus</strong>
          <p style={{ margin: 0 }}>In a few steps you will create a workspace, invite your team, and run a first safe workflow. Every AI action goes through your workspace's security rules and approvals.</p>
          <div style={{ display: "flex", gap: 8 }}>
            <button type="button" style={S.primary} disabled={busy} onClick={() => act(() => api.startOnboarding())}>Get started</button>
            <button type="button" style={S.btn} disabled={busy} onClick={skip}>Skip — I'll explore myself</button>
          </div>
        </section>
      )}

      {state.started && state.step === "workspace" && (
        <section style={S.card} aria-label="Choose a workspace">
          <strong>Where will your team work?</strong>
          <label style={{ display: "grid", gap: 4 }}>Company workspace name
            <input style={S.input} value={companyName} maxLength={100} onChange={(e) => setCompanyName(e.target.value)} placeholder="e.g. Sharma & Co Accountants" />
          </label>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button type="button" style={S.primary} disabled={busy || !companyName.trim()} onClick={() => act(() => api.chooseWorkspace({ mode: "create", name: companyName.trim() }))}>Create company workspace</button>
            <button type="button" style={S.btn} disabled={busy} onClick={() => act(() => api.chooseWorkspace({ mode: "personal" }))}>Just me for now (personal workspace)</button>
          </div>
          {teamWorkspaces.length > 0 && (
            <div style={{ display: "grid", gap: 6 }}>
              <span style={S.muted}>Or continue in a workspace you already belong to:</span>
              {teamWorkspaces.map((w) => (
                <button key={w.id} type="button" style={{ ...S.btn, textAlign: "left" }} disabled={busy} onClick={() => act(() => api.chooseWorkspace({ mode: "existing", workspaceId: w.id }))}>
                  {w.name} ({w.role})
                </button>
              ))}
            </div>
          )}
        </section>
      )}

      {state.started && state.step === "team" && (
        <section style={S.card} aria-label="Invite your team">
          <strong>Invite teammates</strong>
          {!state.companyWorkspaceId ? (
            <p style={S.muted}>You are using your personal workspace, which is just for you. You can create a company workspace later.</p>
          ) : (
            <>
              {invites.map((inv, i) => (
                <div key={i} style={{ display: "flex", gap: 6 }}>
                  <input aria-label={`Teammate ${i + 1} email`} style={{ ...S.input, flex: 1 }} type="email" value={inv.email} onChange={(e) => setInvites(invites.map((x, j) => (j === i ? { ...x, email: e.target.value } : x)))} placeholder="name@company.com" />
                  <select aria-label={`Teammate ${i + 1} role`} style={S.input} value={inv.role} onChange={(e) => setInvites(invites.map((x, j) => (j === i ? { ...x, role: e.target.value } : x)))}>
                    <option value="member">Member</option>
                    <option value="admin">Admin</option>
                  </select>
                </div>
              ))}
              <div style={{ display: "flex", gap: 8 }}>
                {invites.length < 10 && <button type="button" style={S.btn} onClick={() => setInvites([...invites, { email: "", role: "member" }])}>Add another</button>}
                <button type="button" style={S.primary} disabled={busy || !invites.some((i) => i.email.trim())}
                  onClick={async () => { const out = await act(() => api.inviteTeam({ invites: invites.filter((i) => i.email.trim()) })); if (out) setInvitations(out.invitations || []); }}>Send invitations</button>
              </div>
            </>
          )}
          {invitations.length > 0 && (
            <ul aria-label="Invitation results" style={{ margin: 0, paddingLeft: 18 }}>
              {invitations.map((i) => (
                <li key={`${i.email}-${i.status}`}>
                  {i.email}: {i.status === "invited" ? <>invited as {i.role}. Share this one-time invite code with them: <code>{i.token}</code></> : <span style={S.danger}>{i.error}</span>}
                </li>
              ))}
            </ul>
          )}
          <button type="button" style={S.btn} disabled={busy} onClick={() => act(() => api.inviteTeam({ skip: true }))}>{invitations.some((i) => i.status === "invited") ? "Continue" : "Skip — invite later"}</button>
        </section>
      )}

      {state.started && state.step === "use_case" && (
        <section style={S.card} aria-label="Choose a use case">
          <strong>What will you use Nexus for first?</strong>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {state.useCases.map((u) => (
              <button key={u.id} type="button" style={S.btn} disabled={busy} onClick={() => act(() => api.chooseUseCase(u.id)).then((out) => out && setTemplates(out.recommendedTemplates || []))}>{u.label}</button>
            ))}
          </div>
        </section>
      )}

      {state.started && state.step === "template" && (
        <section style={S.card} aria-label="Choose a template">
          <strong>Pick a first workflow</strong>
          <span style={S.muted}>Templates only use tools that are available in your workspace. You can edit the workflow afterwards.</span>
          {templates.length === 0 && <span style={S.muted}>Loading templates…</span>}
          {templates.map((t) => (
            <div key={t.id} data-testid={`tpl-${t.id}`} style={{ border: "1px solid var(--mcis-border, #eee)", borderRadius: 8, padding: 10, display: "grid", gap: 4 }}>
              <strong>{t.name}</strong>
              <span>{t.description}</span>
              <span style={S.muted}>{api.RISK_LABELS[t.riskLevel]} · {t.steps.length} step{t.steps.length === 1 ? "" : "s"}{t.requiresApproval ? " · asks for approval before sensitive actions" : ""} · Output: {t.expectedOutput}</span>
              <button type="button" style={{ ...S.primary, justifySelf: "start" }} disabled={busy} onClick={() => act(() => api.createFirstWorkflow(t.id))}>Use this template</button>
            </div>
          ))}
        </section>
      )}

      {state.started && state.step === "first_run" && (
        <section style={S.card} aria-label="Run your first task">
          <strong>Run your first task{chosenTemplate ? `: ${chosenTemplate.name}` : ""}</strong>
          {chosenTemplate && chosenTemplate.inputs.map((i) => (
            <label key={i.name} style={{ display: "grid", gap: 4 }}>{i.label}{i.required ? " *" : ""}
              {i.type === "enum"
                ? <select style={S.input} value={inputs[i.name] || ""} onChange={(e) => setInputs({ ...inputs, [i.name]: e.target.value })}>{i.options.map((o) => <option key={o} value={o}>{o}</option>)}</select>
                : <input style={S.input} value={inputs[i.name] || ""} onChange={(e) => setInputs({ ...inputs, [i.name]: e.target.value })} />}
            </label>
          ))}
          <span style={S.muted}>Do not type passwords or keys here — anything that looks like a secret is removed before it is stored.</span>
          <button type="button" style={{ ...S.primary, justifySelf: "start" }} disabled={busy || !chosenTemplate}
            onClick={async () => { const out = await act(() => api.runFirstTask(Object.fromEntries(Object.entries(inputs).filter(([, v]) => v !== "")))); if (out) setRun(out.run); }}>Run it</button>
        </section>
      )}

      {state.started && state.step === "done" && (
        <section style={S.card} aria-label="All set">
          <strong style={{ fontSize: 18 }}>You're all set</strong>
          {(run || state.firstRunId) && <p style={{ margin: 0 }}>Your first run {run ? `is ${run.status}` : "was started"}. Follow it, approve any steps that need you and see the evidence under Workflows.</p>}
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <a href="/workspace" style={S.primary}>Open your workspace</a>
            <a href="/workflows" style={S.btn}>Workflows</a>
            <a href="/developers" style={S.btn}>API &amp; developers</a>
          </div>
        </section>
      )}
    </div>
  );
}
