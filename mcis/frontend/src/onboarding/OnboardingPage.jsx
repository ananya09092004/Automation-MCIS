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
import * as R from "../revenue/revenueApi";
import * as IG from "../integrations/integrationsApi";

/**
 * Commercial pass: for the "Monitoring & alerts" use case, a short,
 * genuinely competitor-intelligence-specific first-value flow — add a
 * product, add a competitor (which creates its monitor), check it once,
 * see the real VERIFIED/UNVERIFIED/STALE/UNAVAILABLE result, and enable a
 * free in-app alert. Every call hits the SAME already-tested, tenant-
 * isolated revenue endpoints the Competitor intelligence page uses — no
 * new backend state machine, no fake success.
 *
 * Launch-readiness fix: a `web_page` monitor REQUIRES an already-connected
 * "Web pages" integration (`services/revenue/monitoringService.js`'s
 * `validateSource` rejects it otherwise with INTEGRATIONS_DISABLED or
 * "integrationId is required"). The form only ever asked for a URL, never
 * for an integration, so typing a URL here used to fail outright the
 * moment a pilot customer tried the one path this quick-start exists to
 * showcase. `ensureWebPageIntegration` finds or creates that integration
 * (no credential needed for this read-only, host-allowlisted connector —
 * see `connectors/webPageConnector.js`) before creating the competitor. If
 * the server has integrations turned off entirely (`INTEGRATIONS_ENABLED`
 * is not `"true"`, so `/integrations` isn't even mounted — a 404, not a
 * validation error), this falls back to the manual `api_submission`
 * monitor honestly instead of showing the customer a raw backend error.
 */
function hostnameOf(url) {
  try { return new URL(url).hostname.toLowerCase(); } catch { return null; }
}

async function ensureWebPageIntegration(wsId, hostname) {
  let list;
  try { list = await IG.listIntegrations(wsId); } catch (e) {
    if (e.status === 404) return { unavailable: true };
    throw e;
  }
  const existing = list.find((i) => i.provider === "web_page" && i.status === "connected"
    && (i.config.allowedHosts || []).some((h) => h === hostname || (h.startsWith("*.") && hostname.endsWith(h.slice(1)))));
  if (existing) return { integrationId: existing.id };
  const created = await IG.connectIntegration(wsId, {
    provider: "web_page", name: `Web pages — ${hostname}`, config: { allowedHosts: [hostname] },
  });
  return { integrationId: created.id };
}
function CompetitorQuickStart({ wsId }) {
  const [step, setStep] = useState("product"); // product -> competitor -> check -> alert -> done
  const [product, setProduct] = useState(null);
  const [competitor, setCompetitor] = useState(null);
  const [checkResult, setCheckResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [note, setNote] = useState(null);
  const [name, setName] = useState("");
  const [compName, setCompName] = useState("");
  const [url, setUrl] = useState("");

  async function addProduct(e) {
    e.preventDefault(); setBusy(true); setErr(null);
    try { const p = await R.createProduct(wsId, { name: name.trim() }); setProduct(p); setStep("competitor"); } catch (x) { setErr(x.message); } finally { setBusy(false); }
  }
  async function addCompetitor(e) {
    e.preventDefault(); setBusy(true); setErr(null);
    try {
      const trimmedUrl = url.trim();
      let monitor = { sourceType: "api_submission" };
      let fellBack = false;
      if (trimmedUrl) {
        const hostname = hostnameOf(trimmedUrl);
        if (!hostname) throw new Error("That doesn't look like a valid URL.");
        const r = await ensureWebPageIntegration(wsId, hostname);
        if (r.unavailable) {
          fellBack = true;
        } else {
          monitor = { sourceType: "web_page", integrationId: r.integrationId, source: { url: trimmedUrl } };
        }
      }
      const c = await R.addCompetitor(wsId, product.id, {
        competitorName: compName.trim(), marketplace: "website",
        ...(trimmedUrl ? { sourceUrl: trimmedUrl } : {}),
        monitor,
      });
      setCompetitor(c); setStep("check");
      if (fellBack) setNote("Automated page checks aren't enabled on this server yet, so this competitor was set up for manual/API price submissions instead — see the automation API docs.");
    } catch (x) { setErr(x.message); } finally { setBusy(false); }
  }
  async function checkNow() {
    setBusy(true); setErr(null);
    try { const out = await R.checkMonitor(wsId, competitor.monitorId); setCheckResult(out.monitor || out); setStep("alert"); } catch (x) { setErr(x.message); } finally { setBusy(false); }
  }
  async function enableAlert() {
    setBusy(true); setErr(null);
    try { await R.createRule(wsId, { name: `${compName.trim()} price drop`, ruleType: "price_drop_pct", threshold: 1, monitorId: competitor.monitorId, channels: [{ type: "in_app" }] }); setStep("done"); } catch (x) { setErr(x.message); } finally { setBusy(false); }
  }

  return (
    <div style={{ ...S.card, border: "1px dashed var(--mcis-border, #ccc)" }} data-testid="ci-quickstart" aria-label="Competitor intelligence quick start">
      <strong>Monitor your first competitor</strong>
      {err && <div role="alert" style={S.danger}>{err}</div>}
      {note && <div style={S.muted}>{note}</div>}
      {step === "product" && (
        <form onSubmit={addProduct} style={{ display: "flex", gap: 6 }}>
          <input style={S.input} aria-label="Your product name" placeholder="Your product name" value={name} onChange={(e) => setName(e.target.value)} required />
          <button type="submit" style={S.primary} disabled={busy || !name.trim()}>Add product</button>
        </form>
      )}
      {step === "competitor" && (
        <form onSubmit={addCompetitor} style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          <input style={S.input} aria-label="Competitor name" placeholder="Competitor name" value={compName} onChange={(e) => setCompName(e.target.value)} required />
          <input style={S.input} aria-label="Competitor product page URL (optional)" placeholder="Product page URL (optional)" value={url} onChange={(e) => setUrl(e.target.value)} />
          <button type="submit" style={S.primary} disabled={busy || !compName.trim()}>Add competitor</button>
        </form>
      )}
      {step === "check" && (
        <div style={{ display: "grid", gap: 6 }}>
          <span style={S.muted}>Run your first check — you'll see the real, honest result (VERIFIED, UNVERIFIED, STALE or UNAVAILABLE), never a guess.</span>
          <button type="button" style={S.primary} disabled={busy} onClick={checkNow}>Check now</button>
        </div>
      )}
      {step === "alert" && (
        <div style={{ display: "grid", gap: 6 }}>
          <span data-testid="ci-check-result">Source state: <strong>{checkResult ? checkResult.health : "—"}</strong></span>
          <button type="button" style={S.primary} disabled={busy} onClick={enableAlert}>Enable a free in-app price-drop alert</button>
        </div>
      )}
      {step === "done" && (
        <div style={{ display: "grid", gap: 6 }}>
          <span>You're set up — see insights, value and more competitors at <a href="/competitors">Competitor intelligence</a>.</span>
          <span style={S.muted}>Want to explore without real data first? Competitor intelligence has clearly-marked sample data you can load instead.</span>
        </div>
      )}
    </div>
  );
}

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
            <a href="/billing" style={S.btn}>Billing &amp; packaging</a>
            <a href="/developers" style={S.btn}>API &amp; developers</a>
          </div>
          {state.useCase === "monitoring" && state.workspaceId && <CompetitorQuickStart wsId={state.workspaceId} />}
        </section>
      )}
    </div>
  );
}
