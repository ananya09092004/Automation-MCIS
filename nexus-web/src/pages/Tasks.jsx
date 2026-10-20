import { useMemo, useState } from 'react';
import { Badge, Button, Card, EmptyState, ErrorState, Loading, Notice, PageHeader, Resource } from '../components/ui.jsx';
import AskNexusDialog from '../components/AskNexusDialog.jsx';
import { useApi } from '../lib/apiContext.jsx';
import { useWorkspace } from '../lib/workspace.jsx';
import { useResource } from '../lib/useResource.js';
import { useToast } from '../lib/toast.jsx';
import { endpoints } from '../lib/endpoints.js';
import { Link } from '../lib/router.jsx';
import { ACTIVE_EXECUTION, fmtDate, humanize, timeAgo } from '../lib/format.js';

const FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'active', label: 'Running', match: (s) => ACTIVE_EXECUTION.includes(s) && s !== 'waiting_approval' },
  { id: 'waiting_approval', label: 'Needs approval', match: (s) => s === 'waiting_approval' },
  { id: 'completed', label: 'Completed', match: (s) => s === 'completed' },
  { id: 'failed', label: 'Failed', match: (s) => s === 'failed' || s === 'cancelled' },
];

export default function Tasks() {
  const api = useApi();
  const { workspaceId } = useWorkspace();
  const res = useResource(() => endpoints.listExecutions(api, workspaceId, 100), [api, workspaceId]);
  const [filter, setFilter] = useState('all');
  const [asking, setAsking] = useState(false);

  return (
    <>
      <PageHeader
        eyebrow="Operate"
        title="Tasks"
        description="Every task an agent runs, with its status, approvals and evidence."
        actions={<><Button size="sm" onClick={res.refresh}>Refresh</Button><Button variant="primary" onClick={() => setAsking(true)}>Create task</Button></>}
      />
      <div className="tabs" role="tablist" aria-label="Filter tasks">
        {FILTERS.map((f) => (
          <button key={f.id} type="button" role="tab" aria-selected={filter === f.id} className={`tab ${filter === f.id ? 'active' : ''}`} onClick={() => setFilter(f.id)}>{f.label}</button>
        ))}
      </div>
      <Card>
        <Resource res={res} loadingLabel="Loading tasks…" errorTitle="Could not load tasks">
          {(rows) => <TaskTable rows={rows} filter={FILTERS.find((f) => f.id === filter)} onAsk={() => setAsking(true)} />}
        </Resource>
      </Card>
      {asking ? <AskNexusDialog onClose={() => setAsking(false)} /> : null}
    </>
  );
}

function TaskTable({ rows, filter, onAsk }) {
  const shown = useMemo(() => (filter.match ? rows.filter((r) => filter.match(r.status)) : rows), [rows, filter]);
  if (!rows.length) return <EmptyState title="No tasks yet" action={<Button variant="primary" onClick={onAsk}>Create task</Button>}>Tasks you or your workflows start appear here.</EmptyState>;
  if (!shown.length) return <EmptyState title={`No ${filter.label.toLowerCase()} tasks`} />;
  return (
    <div className="table-wrap" tabIndex={0} role="region" aria-label="Scrollable table">
      <table className="table">
        <thead><tr><th>Task</th><th>Status</th><th>Progress</th><th>Started</th></tr></thead>
        <tbody>
          {shown.map((e) => (
            <tr key={e.id}>
              <td><Link to={`/tasks/${e.id}`} className="link strong">{e.goal || 'Untitled task'}</Link>{e.failure ? <div className="small text-danger">{e.failure.message || e.failure.code}</div> : null}</td>
              <td><Badge status={e.status} /></td>
              <td className="muted">{e.progress ? `${e.progress.stepsExecuted || 0} / ${e.progress.maxSteps} steps` : '—'}</td>
              <td className="muted" title={fmtDate(e.createdAt)}>{timeAgo(e.createdAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function TaskDetail({ id }) {
  const api = useApi();
  const { workspaceId } = useWorkspace();
  const toast = useToast();
  const res = useResource(async () => {
    const [execution, evidence] = await Promise.all([
      endpoints.getExecution(api, workspaceId, id),
      endpoints.getEvidence(api, workspaceId, id).catch(() => null),
    ]);
    return { execution, evidence };
  }, [api, workspaceId, id]);
  const [busy, setBusy] = useState(null);
  const [actionError, setActionError] = useState(null);

  async function act(kind, fn, okText) {
    setBusy(kind);
    setActionError(null);
    try { await fn(); toast.success(okText); await res.refresh(); } catch (err) { setActionError(err.message); } finally { setBusy(null); }
  }

  if (res.loading && !res.data) return <Loading label="Loading task…" />;
  if (res.error && !res.data) return <><BackLink /><ErrorState error={res.error} onRetry={res.reload} title="Could not load this task" /></>;
  const { execution: e, evidence } = res.data;
  const appr = e.waitingForApproval;
  const active = ACTIVE_EXECUTION.includes(e.status);

  return (
    <>
      <BackLink />
      <PageHeader
        eyebrow="Operate"
        title={e.goal || 'Task'}
        description={<>Started {fmtDate(e.createdAt)}{e.finishedAt ? ` · finished ${fmtDate(e.finishedAt)}` : ''}</>}
        actions={<>
          <Badge status={e.status} />
          <Button size="sm" onClick={res.refresh}>Refresh</Button>
          {active ? <Button size="sm" variant="danger" busy={busy === 'cancel'} onClick={() => act('cancel', () => endpoints.cancelExecution(api, workspaceId, e.id), 'Cancellation requested')}>Cancel task</Button> : null}
        </>}
      />
      {actionError ? <Notice tone="danger">{actionError}</Notice> : null}
      {appr && appr.status === 'pending' ? (
        <Card title="Approval required" className="card-warning">
          <p><strong>{humanize(appr.action)}</strong> · risk <Badge status={appr.riskTier}>{humanize(appr.riskTier)}</Badge></p>
          {appr.reason ? <p className="muted">{appr.reason}</p> : null}
          <p className="small muted">Requires {humanize(appr.requiredRole)} or higher · expires {fmtDate(appr.expiresAt)}</p>
          <div className="row">
            <Button variant="primary" busy={busy === 'approve'} onClick={() => act('approve', () => endpoints.decideExecutionApproval(api, workspaceId, e.id, appr.id, 'approve'), 'Step approved')}>Approve step</Button>
            <Button variant="danger" busy={busy === 'reject'} onClick={() => act('reject', () => endpoints.decideExecutionApproval(api, workspaceId, e.id, appr.id, 'reject'), 'Step rejected')}>Reject</Button>
          </div>
        </Card>
      ) : null}
      <div className="grid-2">
        <Card title="Outcome">
          {e.failure ? <Notice tone="danger" title={humanize(e.failure.code)}>{e.failure.message}</Notice> : null}
          {e.result ? <pre className="pre">{typeof e.result === 'string' ? e.result : (e.result.message || JSON.stringify(e.result, null, 2))}</pre> : (!e.failure ? <p className="muted">{active ? 'In progress…' : 'No result recorded.'}</p> : null)}
          <dl className="kv">
            <dt>Verification</dt><dd>{e.verification ? <Badge status={e.verification.status} /> : '—'}</dd>
            <dt>Current action</dt><dd>{e.currentAction ? humanize(e.currentAction) : '—'}</dd>
            <dt>Steps</dt><dd>{e.progress ? `${e.progress.stepsExecuted || 0} of max ${e.progress.maxSteps}` : '—'}</dd>
          </dl>
        </Card>
        <Card title="Evidence summary">
          {e.evidenceSummary ? (
            <dl className="kv">
              <dt>Succeeded</dt><dd>{e.evidenceSummary.succeeded}</dd>
              <dt>Failed</dt><dd>{e.evidenceSummary.failed}</dd>
              <dt>Verified</dt><dd>{e.evidenceSummary.verified}</dd>
              <dt>Unverified</dt><dd>{e.evidenceSummary.unverified}</dd>
              <dt>Recoveries</dt><dd>{e.evidenceSummary.retriesOrRecoveries}</dd>
            </dl>
          ) : <p className="muted">No evidence yet.</p>}
        </Card>
      </div>
      <Card title="Steps">
        {evidence && evidence.steps && evidence.steps.length ? (
          <div className="table-wrap" tabIndex={0} role="region" aria-label="Scrollable table">
            <table className="table">
              <thead><tr><th>#</th><th>Action</th><th>Risk</th><th>Status</th><th>Verification</th><th>Detail</th></tr></thead>
              <tbody>
                {evidence.steps.map((s) => (
                  <tr key={s.index}>
                    <td>{s.index + 1}</td>
                    <td>{humanize(s.action)}{s.tool ? <div className="small muted">{s.tool}</div> : null}</td>
                    <td>{s.riskTier ? <Badge status={s.riskTier} /> : '—'}</td>
                    <td><Badge status={s.status} /></td>
                    <td>{s.verification ? <Badge status={s.verification.status} /> : '—'}</td>
                    <td className="small">{s.error ? <span className="text-danger">{s.error.message || s.error.code}</span> : (s.output && typeof s.output === 'string' ? s.output.slice(0, 160) : '')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <EmptyState title="No steps recorded yet" />}
      </Card>
    </>
  );
}

function BackLink() {
  return <p><Link to="/tasks" className="link">← All tasks</Link></p>;
}
