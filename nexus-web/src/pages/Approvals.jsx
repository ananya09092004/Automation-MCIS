import { useState } from 'react';
import { Badge, Button, Card, EmptyState, Notice, PageHeader, Resource } from '../components/ui.jsx';
import { useApi } from '../lib/apiContext.jsx';
import { useWorkspace } from '../lib/workspace.jsx';
import { useResource } from '../lib/useResource.js';
import { useToast } from '../lib/toast.jsx';
import { endpoints } from '../lib/endpoints.js';
import { Link } from '../lib/router.jsx';
import { fmtDate, humanize } from '../lib/format.js';

const MAX_DETAIL = 25; // bounded detail lookups per refresh

/**
 * Pending approvals from both sources: direct agent executions and steps of
 * workflow runs. Who may decide (role, separation of duties, expiry) is
 * enforced by the server; a refused decision shows the server's reason.
 */
export async function loadApprovals(api, ws) {
  const [execs, runs] = await Promise.all([endpoints.listExecutions(api, ws, 100), endpoints.listRecentRuns(api, ws, 50)]);
  const waitingExecs = execs.filter((e) => e.status === 'waiting_approval').slice(0, MAX_DETAIL);
  const waitingRuns = runs.filter((r) => r.status === 'waiting_approval').slice(0, MAX_DETAIL);
  const [execDetails, runDetails] = await Promise.all([
    Promise.all(waitingExecs.map((e) => endpoints.getExecution(api, ws, e.id).catch(() => null))),
    Promise.all(waitingRuns.map((r) => endpoints.getRun(api, ws, r.id).catch(() => null))),
  ]);
  const items = [];
  for (const e of execDetails) {
    const a = e && e.waitingForApproval;
    if (a && a.status === 'pending') items.push({ key: `e:${a.id}`, source: 'task', title: e.goal, href: `/tasks/${e.id}`, approval: a, execId: e.id });
  }
  for (const r of runDetails) {
    if (!r) continue;
    for (const s of r.steps || []) {
      const a = s.execution && s.execution.waitingForApproval;
      if (a && a.status === 'pending') items.push({ key: `r:${a.id}`, source: 'workflow', title: `Workflow run step "${s.name || s.key}"`, approval: a, runId: r.id, position: s.position });
    }
  }
  items.sort((x, y) => String(x.approval.expiresAt).localeCompare(String(y.approval.expiresAt)));
  return items;
}

export default function Approvals() {
  const api = useApi();
  const { workspaceId } = useWorkspace();
  const res = useResource(() => loadApprovals(api, workspaceId), [api, workspaceId]);
  return (
    <>
      <PageHeader title="Approvals" description="Risky agent actions wait here for a human decision." actions={<Button size="sm" onClick={res.refresh}>Refresh</Button>} />
      <Resource res={res} loadingLabel="Loading approvals…" errorTitle="Could not load approvals">
        {(items) => (items.length ? (
          <div className="stack">{items.map((it) => <ApprovalCard key={it.key} item={it} onDone={res.refresh} />)}</div>
        ) : (
          <Card><EmptyState title="Nothing waiting for approval">When an agent reaches a step your policy marks as risky, it pauses here until someone with the required role decides.</EmptyState></Card>
        ))}
      </Resource>
    </>
  );
}

function ApprovalCard({ item, onDone }) {
  const api = useApi();
  const { workspaceId } = useWorkspace();
  const toast = useToast();
  const [busy, setBusy] = useState(null);
  const [note, setNote] = useState('');
  const [error, setError] = useState(null);
  const a = item.approval;

  async function decide(decision) {
    setBusy(decision);
    setError(null);
    try {
      if (item.source === 'task') await endpoints.decideExecutionApproval(api, workspaceId, item.execId, a.id, decision, note.trim() || undefined);
      else await endpoints.decideRunApproval(api, workspaceId, item.runId, item.position, a.id, decision, note.trim() || undefined);
      toast.success(decision === 'approve' ? 'Approved' : 'Rejected');
      onDone();
    } catch (err) {
      setError(err.message);
      setBusy(null);
    }
  }

  return (
    <Card className="approval" data-testid="approval">
      <div className="approval-head">
        <div>
          <div className="small muted">{item.source === 'task' ? 'Task' : 'Workflow run'}</div>
          <h3>{item.href ? <Link to={item.href} className="link">{item.title}</Link> : item.title}</h3>
        </div>
        <Badge status={a.riskTier}>{`${humanize(a.riskTier)} risk`}</Badge>
      </div>
      <p><strong>{humanize(a.action)}</strong>{a.reason ? ` — ${a.reason}` : ''}</p>
      <p className="small muted">Requires {humanize(a.requiredRole)} or higher · expires {fmtDate(a.expiresAt)}</p>
      <label className="field compact">
        <span className="sr-only">Note</span>
        <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Optional note for the audit trail" maxLength={500} />
      </label>
      {error ? <Notice tone="danger">{error}</Notice> : null}
      <div className="row">
        <Button variant="primary" busy={busy === 'approve'} disabled={!!busy} onClick={() => decide('approve')}>Approve</Button>
        <Button variant="danger" busy={busy === 'reject'} disabled={!!busy} onClick={() => decide('reject')}>Reject</Button>
      </div>
    </Card>
  );
}
