import { useState } from 'react';
import { Badge, Button, Card, EmptyState, Loading, Modal, Notice, PageHeader, Resource } from '../components/ui.jsx';
import { useApi } from '../lib/apiContext.jsx';
import { useWorkspace } from '../lib/workspace.jsx';
import { useResource } from '../lib/useResource.js';
import { useToast } from '../lib/toast.jsx';
import { endpoints } from '../lib/endpoints.js';
import { newIdempotencyKey } from '../lib/api.js';
import { fmtDate, humanize, timeAgo } from '../lib/format.js';

export default function Workflows() {
  const api = useApi();
  const { workspaceId } = useWorkspace();
  const res = useResource(async () => {
    const [workflows, runs] = await Promise.all([endpoints.listWorkflows(api, workspaceId), endpoints.listRecentRuns(api, workspaceId, 25)]);
    return { workflows, runs };
  }, [api, workspaceId]);
  const [running, setRunning] = useState(null);

  return (
    <>
      <PageHeader eyebrow="Operate" title="Workflows" description="Repeatable multi-step processes. Each step runs as a governed agent task with retries, approvals and evidence." actions={<Button size="sm" onClick={res.refresh}>Refresh</Button>} />
      <Resource res={res} loadingLabel="Loading workflows…" errorTitle="Could not load workflows">
        {({ workflows, runs }) => (
          <div className="stack">
            <Card title="Workflows">
              {workflows.length ? (
                <div className="table-wrap" tabIndex={0} role="region" aria-label="Scrollable table">
                  <table className="table">
                    <thead><tr><th>Name</th><th>Status</th><th>Trigger</th><th>Version</th><th><span className="sr-only">Actions</span></th></tr></thead>
                    <tbody>
                      {workflows.map((w) => (
                        <tr key={w.id}>
                          <td><span className="strong">{w.name}</span>{w.description ? <div className="small muted">{w.description}</div> : null}</td>
                          <td><Badge status={w.status} /></td>
                          <td className="muted">{w.trigger && w.trigger.type === 'scheduled' ? `Every ${w.trigger.intervalMinutes} min` : w.trigger && w.trigger.type === 'api' ? 'API' : 'Manual'}</td>
                          <td className="muted">{w.latestVersion ? `v${w.latestVersion}` : 'Draft'}</td>
                          <td className="right">
                            {w.status === 'active' && w.activeVersionId
                              ? <Button size="sm" variant="primary" onClick={() => setRunning(w)}>Run</Button>
                              : <span className="small muted">{w.status === 'archived' ? 'Archived' : 'Publish to run'}</span>}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : <EmptyState title="No workflows yet">Workflows are created and published in the workflow builder. Published workflows can be run from here.</EmptyState>}
            </Card>
            <Card title="Recent runs">
              {runs.length ? (
                <div className="table-wrap" tabIndex={0} role="region" aria-label="Scrollable table">
                  <table className="table">
                    <thead><tr><th>Workflow</th><th>Status</th><th>Trigger</th><th>Started</th><th>Outcome</th></tr></thead>
                    <tbody>
                      {runs.map((r) => {
                        const wf = workflows.find((w) => w.id === r.workflowId);
                        return (
                          <tr key={r.id}>
                            <td>{wf ? wf.name : 'Workflow'} <span className="small muted">v{r.version}</span></td>
                            <td><Badge status={r.status} /></td>
                            <td className="muted">{humanize(r.trigger)}</td>
                            <td className="muted" title={fmtDate(r.createdAt)}>{timeAgo(r.createdAt)}</td>
                            <td className="small">{r.failure ? <span className="text-danger">{r.failure.message || r.failure.code}</span> : r.reviewReason ? r.reviewReason : ''}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              ) : <EmptyState title="No runs yet" />}
            </Card>
          </div>
        )}
      </Resource>
      {running ? <RunWorkflow workflow={running} onClose={() => setRunning(null)} onStarted={() => { setRunning(null); res.refresh(); }} /> : null}
    </>
  );
}

/** Loads the ACTIVE version's variables and starts a run with typed inputs. */
function RunWorkflow({ workflow, onClose, onStarted }) {
  const api = useApi();
  const { workspaceId } = useWorkspace();
  const toast = useToast();
  const def = useResource(async () => {
    const wf = await endpoints.getWorkflow(api, workspaceId, workflow.id);
    const active = (wf.versions || []).find((v) => v.id === wf.activeVersionId);
    if (!active) throw Object.assign(new Error('This workflow has no active version.'), { status: 409 });
    return (await endpoints.getVersion(api, workspaceId, workflow.id, active.version)).definition;
  }, [api, workspaceId, workflow.id]);
  const [values, setValues] = useState({});
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [key] = useState(newIdempotencyKey);

  function coerce(v, raw) {
    if (raw === undefined || raw === '') return undefined;
    if (v.type === 'number') return Number(raw);
    if (v.type === 'boolean') return raw === true || raw === 'true';
    return raw;
  }

  async function submit(e) {
    e.preventDefault();
    const vars = (def.data && def.data.variables) || [];
    const inputs = {};
    for (const v of vars) {
      const val = coerce(v, values[v.name] !== undefined ? values[v.name] : v.default);
      if (val === undefined) { if (v.required) { setError(`${v.label || v.name} is required.`); return; } continue; }
      if (v.type === 'number' && !Number.isFinite(val)) { setError(`${v.label || v.name} must be a number.`); return; }
      inputs[v.name] = val;
    }
    setBusy(true);
    setError(null);
    try {
      await endpoints.startRun(api, workspaceId, workflow.id, inputs, key);
      toast.success(`Run of "${workflow.name}" started`);
      onStarted();
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  return (
    <Modal title={`Run "${workflow.name}"`} onClose={onClose}>
      {def.loading ? <Loading label="Loading inputs…" /> : def.error ? <Notice tone="danger">{def.error.message}</Notice> : (
        <form onSubmit={submit} noValidate>
          {(def.data.variables || []).length === 0 ? <p className="muted">This workflow takes no inputs.</p> : null}
          {(def.data.variables || []).map((v) => (
            <label key={v.name} className="field">
              <span>{v.label || humanize(v.name)}{v.required ? ' *' : ''}</span>
              {v.type === 'enum' ? (
                <select value={values[v.name] ?? v.default ?? ''} onChange={(e) => setValues((x) => ({ ...x, [v.name]: e.target.value }))}>
                  <option value="">Select…</option>
                  {(v.options || []).map((o) => <option key={o} value={o}>{o}</option>)}
                </select>
              ) : v.type === 'boolean' ? (
                <select value={String(values[v.name] ?? v.default ?? '')} onChange={(e) => setValues((x) => ({ ...x, [v.name]: e.target.value }))}>
                  <option value="">Select…</option><option value="true">Yes</option><option value="false">No</option>
                </select>
              ) : (
                <input
                  type={v.type === 'number' ? 'number' : v.type === 'date' ? 'date' : 'text'}
                  value={values[v.name] ?? v.default ?? ''}
                  maxLength={v.maxLength || 500}
                  onChange={(e) => setValues((x) => ({ ...x, [v.name]: e.target.value }))}
                />
              )}
            </label>
          ))}
          {error ? <Notice tone="danger">{error}</Notice> : null}
          <div className="modal-foot inline">
            <Button onClick={onClose}>Cancel</Button>
            <Button variant="primary" type="submit" busy={busy}>Start run</Button>
          </div>
        </form>
      )}
    </Modal>
  );
}
