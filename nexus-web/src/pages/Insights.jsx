import { useEffect, useState } from 'react';
import { Card, EmptyState, Notice, PageHeader, Resource, Stat } from '../components/ui.jsx';
import BarChart from '../components/BarChart.jsx';
import { useApi } from '../lib/apiContext.jsx';
import { useWorkspace } from '../lib/workspace.jsx';
import { useResource } from '../lib/useResource.js';
import { endpoints } from '../lib/endpoints.js';
import { Link } from '../lib/router.jsx';
import { fmtDuration, fmtNumber, fmtPercent } from '../lib/format.js';

const RANGES = [7, 30, 90];
const KEY = (ws) => `nexus.minutesPerTask.${ws}`;

function readMinutes(ws) { try { const v = Number(window.localStorage.getItem(KEY(ws))); return Number.isFinite(v) && v >= 0 && v <= 600 ? v : 0; } catch { return 0; } }
function writeMinutes(ws, v) { try { window.localStorage.setItem(KEY(ws), String(v)); } catch { /* private mode */ } }

/** Executive view built only from the server's usage ledger and overview. */
export default function Insights() {
  const api = useApi();
  const { workspaceId } = useWorkspace();
  const [days, setDays] = useState(30);
  const res = useResource(async () => {
    const [dash, overview] = await Promise.all([
      endpoints.billingDashboard(api, workspaceId, days),
      endpoints.overview(api, workspaceId).catch(() => null),
    ]);
    return { dash, overview };
  }, [api, workspaceId, days]);

  return (
    <>
      <PageHeader eyebrow="Intelligence" title="Insights" description="What your agents did, how reliably, and what it consumed — computed by the server from the usage ledger."
        actions={<div className="seg seg-inline" role="tablist" aria-label="Time range">
          {RANGES.map((d) => <button key={d} type="button" role="tab" aria-selected={days === d} onClick={() => setDays(d)}>{d} days</button>)}
        </div>} />
      <Resource res={res} loadingLabel="Loading insights…" errorTitle="Could not load insights">
        {(d) => <Body data={d} days={days} workspaceId={workspaceId} />}
      </Resource>
    </>
  );
}

function Body({ data, days, workspaceId }) {
  const { dash: s, overview: o } = data;
  const [minutes, setMinutes] = useState(() => readMinutes(workspaceId));
  useEffect(() => { writeMinutes(workspaceId, minutes); }, [workspaceId, minutes]);
  const completed = s.outcomes.completed;
  const hours = minutes > 0 ? (completed * minutes) / 60 : null;
  const empty = !s.executions && !s.workflowRuns;
  const shorter = s.window && s.window.days < days;

  return (
    <div className="stack">
      {shorter ? <Notice tone="info">Your plan keeps usage history for {s.window.days} days, so this view covers {s.window.days} days.</Notice> : null}
      <div className="stats" aria-label="Key figures">
        <Stat testId="ins-executions" dot="info" label="Agent executions" value={fmtNumber(s.executions)} hint={`Last ${s.window.days} days`} />
        <Stat testId="ins-success" dot={s.successRate === null ? 'neutral' : s.successRate >= 90 ? 'success' : 'warning'} label="Success rate" value={fmtPercent(s.successRate)} hint={`${fmtNumber(completed)} completed · ${fmtNumber(s.outcomes.failed)} failed`} />
        <Stat dot="neutral" label="Workflow runs" value={fmtNumber(s.workflowRuns)} hint={`${fmtNumber(s.steps)} executed steps`} />
        <Stat dot={o && o.approvals && o.approvals.waiting ? 'warning' : 'neutral'} label="Awaiting approval" value={fmtNumber(o && o.approvals ? o.approvals.waiting : 0)} hint={o && o.approvals && o.approvals.oldestWaitMinutes !== null ? `Oldest ${o.approvals.oldestWaitMinutes} min` : 'Nothing waiting'} />
        <Stat dot="neutral" label="Median duration" value={fmtDuration(o && o.executions && o.executions.latencyMs ? o.executions.latencyMs.p50 : null)} hint={`p95 ${fmtDuration(o && o.executions && o.executions.latencyMs ? o.executions.latencyMs.p95 : null)}`} />
      </div>
      {empty ? (
        <Card><EmptyState icon="activity" title="No activity in this period" action={<Link to="/tasks" className="btn btn-primary">Create a task</Link>}>Charts fill in as agents run tasks and workflows. Every figure here comes from the usage ledger — nothing is projected.</EmptyState></Card>
      ) : (
        <div className="grid-2">
          <Card><BarChart title="Agent executions per day" data={s.trend} valueKey="executions" /></Card>
          <Card><BarChart title="Workflow runs per day" data={s.trend} valueKey="workflowRuns" /></Card>
        </div>
      )}
      <div className="grid-2">
        <Card title="Estimated time saved">
          <p className="small muted">An estimate, not a measurement: completed tasks × the minutes you say each one would take a person. Nexus does not measure time saved and does not convert it to money.</p>
          <label className="field compact"><span>Minutes a person would spend per task</span>
            <input type="number" min="0" max="600" step="1" value={minutes} onChange={(e) => setMinutes(Math.max(0, Math.min(600, Number(e.target.value) || 0)))} />
          </label>
          {hours === null ? <p className="muted small">Enter your own assumption to see an estimate.</p> : (
            <p><span className="cmp-score">{fmtNumber(Math.round(hours * 10) / 10)}</span> <span className="muted">hours estimated</span><br />
              <span className="small muted">= {fmtNumber(completed)} completed tasks × {minutes} min ÷ 60 (your assumption, last {s.window.days} days)</span></p>
          )}
        </Card>
        <Card title="Consumption" actions={<Link to="/billing" className="link">Plan & limits</Link>}>
          <dl className="kv">
            <dt>Agent executions</dt><dd>{fmtNumber(s.executions)}</dd>
            <dt>Executed steps</dt><dd>{fmtNumber(s.steps)}</dd>
            <dt>Connector calls</dt><dd>{fmtNumber(s.connectorCalls)}</dd>
            <dt>API calls</dt><dd>{fmtNumber(s.apiCalls)}</dd>
            <dt>Integrations connected</dt><dd>{o && o.connectors ? `${fmtNumber(o.connectors.connected)} of ${fmtNumber(o.connectors.total)}` : '—'}</dd>
          </dl>
        </Card>
      </div>
    </div>
  );
}
