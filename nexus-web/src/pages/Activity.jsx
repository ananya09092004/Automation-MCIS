import { useState } from 'react';
import { Badge, Button, Card, EmptyState, Notice, PageHeader, Resource } from '../components/ui.jsx';
import { useApi } from '../lib/apiContext.jsx';
import { useWorkspace } from '../lib/workspace.jsx';
import { useResource } from '../lib/useResource.js';
import { endpoints } from '../lib/endpoints.js';
import { fmtDate, humanize } from '../lib/format.js';

export default function Activity() {
  const { isAdmin } = useWorkspace();
  const [tab, setTab] = useState('audit');
  return (
    <>
      <PageHeader eyebrow="Govern" title="Activity" description="The workspace audit trail and security events. Payloads are redacted; secrets are never recorded." />
      {!isAdmin ? (
        <Card><Notice tone="info" title="Admins only">The audit log and security events are visible to workspace owners and admins. Your own tasks and their evidence are under Tasks.</Notice></Card>
      ) : (
        <>
          <div className="tabs" role="tablist" aria-label="Activity type">
            <button type="button" role="tab" aria-selected={tab === 'audit'} className={`tab ${tab === 'audit' ? 'active' : ''}`} onClick={() => setTab('audit')}>Audit log</button>
            <button type="button" role="tab" aria-selected={tab === 'security'} className={`tab ${tab === 'security' ? 'active' : ''}`} onClick={() => setTab('security')}>Security events</button>
          </div>
          {tab === 'audit' ? <AuditLog /> : <SecurityEvents />}
        </>
      )}
    </>
  );
}

function AuditLog() {
  const api = useApi();
  const { workspaceId } = useWorkspace();
  const res = useResource(() => endpoints.listAudit(api, workspaceId, 100), [api, workspaceId]);
  return (
    <Card actions={<Button size="sm" onClick={res.refresh}>Refresh</Button>} title="Audit log">
      <Resource res={res} loadingLabel="Loading audit log…" errorTitle="Could not load the audit log">
        {(rows) => (rows.length ? (
          <div className="table-wrap" tabIndex={0} role="region" aria-label="Scrollable table">
            <table className="table">
              <thead><tr><th>When</th><th>Action</th><th>Actor</th><th>Result</th></tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td className="muted">{fmtDate(r.createdAt)}</td>
                    <td>{humanize(r.action)}</td>
                    <td className="mono small">{r.userId || 'system'}</td>
                    <td>{r.success === false ? <><Badge status="failed">Failed</Badge>{r.error ? <div className="small text-danger">{r.error}</div> : null}</> : <Badge status="completed">OK</Badge>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <EmptyState title="No audit entries yet" />)}
      </Resource>
    </Card>
  );
}

function SecurityEvents() {
  const api = useApi();
  const { workspaceId } = useWorkspace();
  const res = useResource(() => endpoints.listSecurityEvents(api, workspaceId, 100), [api, workspaceId]);
  return (
    <Card actions={<Button size="sm" onClick={res.refresh}>Refresh</Button>} title="Security events">
      <Resource res={res} loadingLabel="Loading security events…" errorTitle="Could not load security events">
        {(rows) => (rows.length ? (
          <div className="table-wrap" tabIndex={0} role="region" aria-label="Scrollable table">
            <table className="table">
              <thead><tr><th>When</th><th>Event</th><th>Actor</th><th>Result</th></tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td className="muted">{fmtDate(r.at)}</td>
                    <td>{humanize(r.type)}</td>
                    <td className="mono small">{r.actorId || 'system'}</td>
                    <td>{r.success === false ? <Badge status="failed">Blocked / failed</Badge> : <Badge status="completed">OK</Badge>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <EmptyState title="No security events" />)}
      </Resource>
    </Card>
  );
}
