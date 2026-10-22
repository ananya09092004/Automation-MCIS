import { useEffect, useState } from 'react';
import { Badge, Button, Card, Notice, PageHeader, Resource, RiskTag } from '../components/ui.jsx';
import Icon from '../components/icons.jsx';
import VariableInputs, { collectInputs } from '../components/VariableInputs.jsx';
import { useApi } from '../lib/apiContext.jsx';
import { useWorkspace } from '../lib/workspace.jsx';
import { useRouter, Link } from '../lib/router.jsx';
import { useResource } from '../lib/useResource.js';
import { useToast } from '../lib/toast.jsx';
import { endpoints } from '../lib/endpoints.js';
import { humanize } from '../lib/format.js';

// Server steps: workspace → team → use_case → template → first_run → done.
const STEPS = [
  { key: 'workspace', label: 'Workspace' },
  { key: 'team', label: 'Team' },
  { key: 'use_case', label: 'Use case' },
  { key: 'template', label: 'First workflow' },
  { key: 'first_run', label: 'First run' },
];
const PILLARS = [
  { icon: 'agents', title: 'Execute', text: 'Give work to AI agents and workflows — in the browser, on the desktop and through your tools.' },
  { icon: 'compare', title: 'Compare', text: 'Put products and vendors side by side using facts their pages publish, with sources.' },
  { icon: 'firewall', title: 'Control', text: 'Every action passes the Agent Firewall; risky steps wait for a person; everything is audited.' },
];

/** First-run setup on the real onboarding API (resumable: the server keeps the step). */
export default function Welcome() {
  const api = useApi();
  const res = useResource(() => endpoints.onboarding(api), [api]);
  return (
    <>
      <PageHeader eyebrow="Get started" title="Welcome to Nexus" description="Set up your workspace and run your first workflow. You can stop at any point and come back — progress is saved." />
      <Resource res={res} loadingLabel="Loading setup…" errorTitle="Could not load setup">
        {(s) => (s.enabled === false
          ? <Card><Notice tone="info" title="Guided setup is not enabled on this server">Create a task from the dashboard to get started.</Notice></Card>
          : <Wizard initial={s} />)}
      </Resource>
    </>
  );
}

function Wizard({ initial }) {
  const api = useApi();
  const { adopt } = useWorkspace();
  const { navigate } = useRouter();
  const toast = useToast();
  const [s, setS] = useState(initial);
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const [templates, setTemplates] = useState(initial.recommendedTemplates || null);
  const [invites, setInvites] = useState(null);

  // Resuming at a later step (e.g. after a reload): reload the templates from the server.
  useEffect(() => {
    if (templates !== null || !s.workspaceId || !['template', 'first_run'].includes(s.step)) return;
    endpoints.listTemplates(api, s.workspaceId, s.step === 'template' ? s.useCase : null)
      .then((list) => setTemplates(s.step === 'template' ? list.filter((t) => t.onboarding && t.available) : list))
      .catch(() => setTemplates([]));
  }, [api, s.step, s.workspaceId, s.useCase, templates]);

  async function run(kind, fn, after) {
    setBusy(kind); setError(null);
    try { const next = await fn(); setS(next); if (after) await after(next); } catch (err) { setError(err.message); }
    setBusy(null);
  }

  if (!s.started) {
    return (
      <div className="stack">
        <div className="pillars">
          {PILLARS.map((p) => (
            <div key={p.title} className="pillar"><span className="state-icon" aria-hidden="true"><Icon name={p.icon} size={20} /></span><h2>{p.title}</h2><p className="small muted">{p.text}</p></div>
          ))}
        </div>
        <Card>
          <div className="callout">
            <div className="grow"><div className="strong">Five short steps</div><div className="small muted">Workspace → team → use case → first workflow → first run. About three minutes.</div></div>
            <Button variant="ghost" onClick={() => run('skip', () => endpoints.onboardingComplete(api).catch(() => s), () => navigate('/'))}>Skip for now</Button>
            <Button variant="primary" busy={busy === 'start'} onClick={() => run('start', () => endpoints.onboardingStart(api))}>Start setup</Button>
          </div>
          {error ? <Notice tone="danger">{error}</Notice> : null}
        </Card>
      </div>
    );
  }

  const done = s.completed || s.step === 'done';
  const idx = done ? STEPS.length : Math.max(0, STEPS.findIndex((x) => x.key === s.step));

  return (
    <div className="stack">
      <ol className="lifecycle onboarding-steps" aria-label="Setup progress">
        {STEPS.map((st, i) => (
          <li key={st.key} className={`lc-step ${i < idx ? 'lc-done' : i === idx ? 'lc-current' : 'lc-todo'}`} aria-current={i === idx ? 'step' : undefined}>
            <span className="lc-dot" aria-hidden="true" /><span className="lc-label">{st.label}</span>
          </li>
        ))}
      </ol>
      {error ? <Notice tone="danger">{error}</Notice> : null}
      {done ? <Done s={s} /> : null}
      {!done && s.step === 'workspace' ? <StepWorkspace busy={busy} onCreate={(name) => run('ws', () => endpoints.onboardingWorkspace(api, { mode: 'create', name }), async (n) => { if (n.companyWorkspaceId) await adopt(n.companyWorkspaceId); })} onPersonal={() => run('ws', () => endpoints.onboardingWorkspace(api, { mode: 'personal' }))} /> : null}
      {!done && s.step === 'team' ? <StepTeam busy={busy} personal={!s.companyWorkspaceId} invites={invites}
        onInvite={(list) => run('team', async () => { const r = await endpoints.onboardingTeam(api, { invites: list }); setInvites(r.invitations || []); return r; })}
        onSkip={() => run('team', () => endpoints.onboardingTeam(api, { skip: true }))} /> : null}
      {!done && s.step === 'use_case' ? <StepUseCase busy={busy} useCases={s.useCases || []} onPick={(id) => run('uc', async () => { const r = await endpoints.onboardingUseCase(api, id); setTemplates(r.recommendedTemplates || []); return r; })} /> : null}
      {!done && s.step === 'template' ? <StepTemplate busy={busy} templates={templates} onBack={() => setS({ ...s, step: 'use_case' })} onPick={(t) => run(`t:${t.id}`, () => endpoints.onboardingTemplate(api, t.id), () => toast.success(`"${t.name}" created and published`))} /> : null}
      {!done && s.step === 'first_run' ? <StepFirstRun busy={busy} template={(templates || []).find((t) => t.id === s.templateId)} onRun={(inputs) => run('run', () => endpoints.onboardingFirstRun(api, inputs), () => toast.success('First run started'))} onFinish={() => run('finish', () => endpoints.onboardingComplete(api))} /> : null}
    </div>
  );
}

function StepWorkspace({ busy, onCreate, onPersonal }) {
  const [name, setName] = useState('');
  const [err, setErr] = useState(null);
  return (
    <Card title="Where will your team work?">
      <p className="small muted">A company workspace keeps its agents, tasks, approvals, audit trail and usage separate from everything else. You will be its owner.</p>
      <form className="row wrap" onSubmit={(e) => { e.preventDefault(); if (!name.trim()) { setErr('Give the workspace a name.'); return; } setErr(null); onCreate(name.trim()); }} noValidate>
        <label className="field grow"><span>Company workspace name</span><input value={name} maxLength={100} onChange={(e) => setName(e.target.value)} placeholder="e.g. Acme Operations" /></label>
        <Button variant="primary" type="submit" busy={busy === 'ws'} className="align-end">Create workspace</Button>
      </form>
      {err ? <Notice tone="danger">{err}</Notice> : null}
      <p className="small"><button type="button" className="link" onClick={onPersonal}>Just me for now — use my personal workspace</button></p>
    </Card>
  );
}

function StepTeam({ busy, personal, invites, onInvite, onSkip }) {
  const [text, setText] = useState('');
  const [err, setErr] = useState(null);
  if (personal) {
    return <Card title="Invite your team"><p className="muted">Teammates join company workspaces. You can create one later from the workspace menu.</p><Button variant="primary" busy={busy === 'team'} onClick={onSkip}>Continue</Button></Card>;
  }
  function submit(e) {
    e.preventDefault();
    const emails = text.split(/[\s,;]+/).map((x) => x.trim()).filter(Boolean);
    if (!emails.length) { setErr('Enter at least one email address, or skip.'); return; }
    if (emails.some((m) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(m))) { setErr('One of the addresses is not a valid email.'); return; }
    setErr(null);
    onInvite(emails.slice(0, 20).map((email) => ({ email, role: 'member' })));
  }
  return (
    <Card title="Invite your team">
      <p className="small muted">Teammates join as members (they can create tasks and approve YELLOW actions). Invitations require a verified email address.</p>
      {invites ? (
        <ul className="list">
          {invites.map((i) => (
            <li key={i.email} className="list-row">
              <span className="list-main">{i.email}</span>
              {i.status === 'invited' ? <><Badge status="active">Invited</Badge>{i.token ? <code className="small" title="One-time invitation code">{i.token}</code> : null}</> : <Badge status="failed">{i.error || 'Failed'}</Badge>}
            </li>
          ))}
        </ul>
      ) : (
        <form onSubmit={submit} noValidate>
          <label className="field"><span>Email addresses</span><textarea rows={3} value={text} onChange={(e) => setText(e.target.value)} placeholder="priya@acme.com, rahul@acme.com" /></label>
          {err ? <Notice tone="danger">{err}</Notice> : null}
          <div className="row"><Button variant="primary" type="submit" busy={busy === 'team'}>Send invitations</Button><Button variant="ghost" onClick={onSkip}>Skip for now</Button></div>
        </form>
      )}
      {invites ? <p className="small muted">Share each one-time code with its owner if email delivery is not configured. They join from “Join with code”.</p> : null}
    </Card>
  );
}

function StepUseCase({ busy, useCases, onPick }) {
  return (
    <Card title="What should Nexus help with first?">
      <div className="choice-grid">
        {useCases.map((u) => (
          <button key={u.id} type="button" className="choice" disabled={!!busy} onClick={() => onPick(u.id)}>
            <span className="strong">{u.label}</span>
          </button>
        ))}
      </div>
    </Card>
  );
}

function StepTemplate({ busy, templates, onPick, onBack }) {
  if (!templates || !templates.length) {
    return <Card title="Choose a starting workflow"><p className="muted">No ready-made workflow matches this use case on this server.</p><div className="row"><Button onClick={onBack}>Pick another use case</Button><Link to="/" className="btn">Go to dashboard</Link></div></Card>;
  }
  return (
    <Card title="Choose a starting workflow">
      <p className="small muted">Each template becomes a workflow in your workspace. Nothing runs until you start it.</p>
      <div className="cards-grid">
        {templates.map((t) => (
          <section key={t.id} className="plan" aria-label={t.name}>
            <div className="plan-head"><h3>{t.name}</h3>{t.riskLevel ? <RiskTag risk={t.riskLevel} /> : null}</div>
            <p className="small muted">{t.description}</p>
            {t.expectedOutput ? <p className="small"><span className="strong">You get:</span> {t.expectedOutput}</p> : null}
            <ul className="plan-limits">
              {t.requiresApproval ? <li><span>Approval</span><strong>Some steps wait for a person</strong></li> : null}
              {(t.permissions || []).slice(0, 3).map((p) => <li key={p}><span>Uses</span><strong>{humanize(p)}</strong></li>)}
            </ul>
            <div className="plan-cta"><Button variant="primary" className="full" busy={busy === `t:${t.id}`} disabled={!!busy} onClick={() => onPick(t)}>Use this workflow</Button></div>
          </section>
        ))}
      </div>
    </Card>
  );
}

function StepFirstRun({ busy, template, onRun, onFinish }) {
  const [values, setValues] = useState({});
  const [err, setErr] = useState(null);
  const vars = template ? template.inputs || [] : null;
  return (
    <Card title="Run it once">
      <p className="small muted">This starts a real run of your new workflow. Risky steps pause in Approvals; results and evidence appear under Workflows and Tasks.</p>
      {vars === null ? <p className="small muted">Fill in the workflow's inputs on the Workflows page, or run it with defaults here.</p> : null}
      <form onSubmit={(e) => { e.preventDefault(); const { inputs, error } = collectInputs(vars || [], values); if (error) { setErr(error); return; } setErr(null); onRun(inputs); }} noValidate>
        {vars ? <VariableInputs vars={vars} values={values} setValues={setValues} /> : null}
        {err ? <Notice tone="danger">{err}</Notice> : null}
        <div className="row"><Button variant="primary" type="submit" busy={busy === 'run'}>Start first run</Button><Button variant="ghost" busy={busy === 'finish'} onClick={onFinish}>Finish without running</Button></div>
      </form>
    </Card>
  );
}

function Done({ s }) {
  return (
    <Card>
      <div className="callout">
        <span className="state-icon" aria-hidden="true"><Icon name="check" size={20} /></span>
        <div className="grow"><div className="strong">You are set up</div><div className="small muted">{s.firstRunId ? 'Your first run has started — follow it under Workflows.' : 'Create a task or run a workflow whenever you are ready.'}</div></div>
        <Link to="/" className="btn btn-primary">Go to dashboard</Link>
      </div>
    </Card>
  );
}
