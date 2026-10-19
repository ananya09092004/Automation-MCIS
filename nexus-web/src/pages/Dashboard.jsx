import { useState } from 'react';
import { Badge, Button, Card, EmptyState, Notice, PageHeader, Resource, Stat } from '../components/ui.jsx';
import AskNexusDialog from '../components/AskNexusDialog.jsx';
import { useApi } from '../lib/apiContext.jsx';
import { useWorkspace } from '../lib/workspace.jsx';
import { useResource } from '../lib/useResource.js';
import { endpoints } from '../lib/endpoints.js';
import { Link } from '../lib/router.jsx';
import { fmtDuration, fmtNumber, fmtPercent, humanize, timeAgo, ROLE_LABEL } from '../lib/format.js';

const RUNNING = ['created', 'planning', 'executing', 'verifying'];

/** Agents are an optional module (REVENUE_SUITE_ENABLED); absent → null, not an error. */
async function loadDashboard(api, ws) {
  const [overview, agents] = await Promise.all([
    endpoints.overview(api, ws),
    endpoints.listAgents(api, ws).catch((err) => (err.status === 404 || err.status === 503 ? null : Promise.reject(err))),
  ]);
  return { overview, agents };
}

export default function Dashboard() {
  const api = useApi();
  const { workspaceId } = useWorkspace();
  const res = useResource(() => loadDashboard(api, workspaceId), [api, workspaceId]);
  const [asking, setAsking] = useState(false);

  return (
    <>
      <PageHeader
        title="Dashboard"
        description="Live status of your agents, tasks, workflows and approvals."
        actions={<><Button size="sm" onClick={res.refresh}>Refresh</Button><Button variant="primary" onClick={() => setAsking(true)}>Create task</Button></>}
      />
      <Resource res={res} loadingLabel="Loading workspace overview…" errorTitle="Could not load the dashboard">
        {(d) => <DashboardBody data={d} onAsk={() => setAsking(true)} />}
      </Resource>
      {asking ? <AskNexusDialog onClose={() => setAsking(false)} /> : null}
    </>
  );
}

function DashboardBody({ data, onAsk }) {
  const { overview: o, agents } = data;
  const ex = o.executions || { byStatus: {}, recent: [] };
  const runs = o.workflowRuns || { byStatus: {} };
  const running = RUNNING.reduce((n, s) => n + (ex.byStatus[s] || 0), 0) + (runs.byStatus.running || 0);
  const activeAgents = agents ? agents.filter((a) => a.status === 'active').length : null;
  const usage = o.usage;
  const empty = !ex.sample && !runs.sample;

  return (
    <div className="stack">
      <div className="stats" aria-label="Key metrics">
        <Stat testId="stat-agents" label="Active agents" value={activeAgents === null ? '—' : fmtNumber(activeAgents)} hint={agents === null ? 'Agents module not enabled' : `${fmtNumber(agents.length)} total`} />
        <Stat testId="stat-running" label="Running tasks" value={fmtNumber(running)} hint="Executions + workflow runs" tone={running ? 'info' : undefined} />
        <Stat testId="stat-approvals" label="Pending approvals" value={fmtNumber(o.approvals ? o.approvals.waiting : 0)} hint={o.approvals && o.approvals.oldestWaitMinutes !== null ? `Oldest waiting ${o.approvals.oldestWaitMinutes} min` : 'Nothing waiting'} tone={o.approvals && o.approvals.waiting ? 'warning' : undefined} />
        <Stat testId="stat-succeeded" label="Successful executions" value={fmtNumber(ex.byStatus.completed || 0)} hint={`Last ${fmtNumber(ex.sample || 0)} executions`} tone="success" />
        <Stat testId="stat-failed" label="Failed executions" value={fmtNumber(ex.byStatus.failed || 0)} hint={`Success rate ${fmtPercent(ex.successRate)}`} tone={ex.byStatus.failed ? 'danger' : undefined} />
      </div>

      {empty ? (
        <Card>
          <EmptyState title="No activity in this workspace yet" action={<Button variant="primary" onClick={onAsk}>Create your first task</Button>}>
            Ask Nexus to do something, or start a workflow. Results, evidence and approvals will appear here.
          </EmptyState>
        </Card>
      ) : null}

      <div className="grid-2">
        <Card title="Recent tasks" actions={<Link to="/tasks" className="link">View all</Link>}>
          {ex.recent && ex.recent.length ? (
            <ul className="list">
              {ex.recent.map((e) => (
                <li key={e.id} className="list-row">
                  <Link to={`/tasks/${e.id}`} className="list-main">{e.goal || 'Untitled task'}</Link>
                  <span className="muted small">{timeAgo(e.createdAt)}</span>
                  <Badge status={e.status} />
                </li>
              ))}
            </ul>
          ) : <EmptyState title="No tasks yet" />}
        </Card>

        <Card title="Workflow runs" actions={<Link to="/workflows" className="link">Workflows</Link>}>
          {runs.sample ? (
            <>
              <div className="chips">
                {Object.entries(runs.byStatus).map(([s, n]) => <span key={s} className="chip"><Badge status={s} /> {fmtNumber(n)}</span>)}
              </div>
              <p className="muted small">Success rate {fmtPercent(runs.successRate)} over the last {fmtNumber(runs.sample)} runs.</p>
            </>
          ) : <EmptyState title="No workflow runs yet" />}
        </Card>
      </div>

      <div className="grid-3">
        <Card title="Usage (30 days)" actions={<Link to="/billing" className="link">Details</Link>}>
          {usage ? (
            <dl className="kv">
              <dt>Agent executions</dt><dd>{fmtNumber(usage.executions)}</dd>
              <dt>Workflow runs</dt><dd>{fmtNumber(usage.workflowRuns)}</dd>
              <dt>Executed steps</dt><dd>{fmtNumber(usage.steps)}</dd>
              <dt>Connector calls</dt><dd>{fmtNumber(usage.connectorCalls)}</dd>
              <dt>Success rate</dt><dd>{fmtPercent(usage.successRate)}</dd>
            </dl>
          ) : <EmptyState title="Usage metering unavailable">The usage ledger could not be read.</EmptyState>}
        </Card>

        <Card title="Performance">
          <dl className="kv">
            <dt>Median duration</dt><dd>{fmtDuration(ex.latencyMs && ex.latencyMs.p50)}</dd>
            <dt>p95 duration</dt><dd>{fmtDuration(ex.latencyMs && ex.latencyMs.p95)}</dd>
            <dt>Open tasks</dt><dd>{fmtNumber(o.tasks ? o.tasks.open : 0)}</dd>
            <dt>Assigned to me</dt><dd>{fmtNumber(o.tasks ? o.tasks.assignedToMe : 0)}</dd>
            <dt>Assigned to agents</dt><dd>{fmtNumber(o.tasks ? o.tasks.assignedToAgent : 0)}</dd>
          </dl>
        </Card>

        <Card title="Workspace">
          <dl className="kv">
            <dt>Name</dt><dd>{o.workspace.name}</dd>
            <dt>Type</dt><dd>{o.workspace.isPersonal ? 'Personal' : 'Team'}</dd>
            <dt>Your role</dt><dd>{ROLE_LABEL[o.workspace.role] || humanize(o.workspace.role)}</dd>
            <dt>Integrations</dt><dd>{fmtNumber(o.connectors.connected)} of {fmtNumber(o.connectors.total)} connected</dd>
          </dl>
          {o.connectors.needsAttention ? <Notice tone="warning">{o.connectors.needsAttention} integration(s) need attention. <Link to="/integrations" className="link">Review</Link></Notice> : null}
        </Card>
      </div>

      {o.failures ? (
        <Card title="Operational issues (30 days, admins only)">
          <div className="stats compact">
            <Stat label="Quota denials" value={fmtNumber(o.failures.quotaDenials)} />
            <Stat label="Billing failures" value={fmtNumber(o.failures.billingFailures)} />
            <Stat label="Connector failures" value={fmtNumber(o.failures.connectorFailures)} />
            <Stat label="Security denials" value={fmtNumber(o.failures.securityDenials)} />
          </div>
        </Card>
      ) : null}
      <p className="muted small">Updated {timeAgo(o.generatedAt)} · figures are computed by the server from recorded executions, runs and the usage ledger.</p>
    </div>
  );
}
