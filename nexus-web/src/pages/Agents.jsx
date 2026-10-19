import { useState } from 'react';
import { Badge, Button, Card, EmptyState, Modal, Notice, PageHeader, Resource } from '../components/ui.jsx';
import { useApi } from '../lib/apiContext.jsx';
import { useWorkspace } from '../lib/workspace.jsx';
import { useResource } from '../lib/useResource.js';
import { useToast } from '../lib/toast.jsx';
import { endpoints } from '../lib/endpoints.js';
import { fmtDate, humanize } from '../lib/format.js';

export const AGENT_ROLES = ['research', 'data', 'spreadsheet', 'reviewer', 'custom']; // server-validated list
const RISK_HELP = {
  green: 'Read-only actions only',
  yellow: 'May take actions that need approval (default)',
  red: 'May request high-risk actions (always approval-gated)',
};

export default function Agents() {
  const api = useApi();
  const { workspaceId, isAdmin } = useWorkspace();
  const res = useResource(() => endpoints.listAgents(api, workspaceId), [api, workspaceId]);
  const [creating, setCreating] = useState(false);

  return (
    <>
      <PageHeader
        title="AI Agents"
        description="Named agents with standing instructions and a maximum risk level. Every action still passes the workspace firewall and approvals."
        actions={isAdmin ? <Button variant="primary" onClick={() => setCreating(true)}>New agent</Button> : null}
      />
      <Resource res={res} loadingLabel="Loading agents…" errorTitle="Could not load agents">
        {(agents) => (agents.length ? (
          <div className="cards-grid">
            {agents.map((a) => (
              <Card key={a.id} className="agent-card">
                <div className="agent-head">
                  <span className="agent-avatar" aria-hidden="true">{a.name.charAt(0).toUpperCase()}</span>
                  <div>
                    <h3>{a.name}</h3>
                    <div className="small muted">{humanize(a.role)} agent</div>
                  </div>
                  <Badge status={a.status} />
                </div>
                {a.description ? <p>{a.description}</p> : null}
                <dl className="kv">
                  <dt>Max risk</dt><dd><Badge status={a.maxRisk} /></dd>
                  <dt>Integrations</dt><dd>{a.allowedIntegrationIds.length ? `${a.allowedIntegrationIds.length} allowed` : 'None'}</dd>
                  <dt>Created</dt><dd>{fmtDate(a.createdAt)}</dd>
                </dl>
              </Card>
            ))}
          </div>
        ) : (
          <Card>
            <EmptyState title="No agents yet" action={isAdmin ? <Button variant="primary" onClick={() => setCreating(true)}>Create an agent</Button> : null}>
              {isAdmin ? 'Create an agent for a recurring job, e.g. a research or data agent.' : 'Ask a workspace admin to create agents.'}
            </EmptyState>
          </Card>
        ))}
      </Resource>
      {creating ? <CreateAgent onClose={() => setCreating(false)} onCreated={() => { setCreating(false); res.refresh(); }} /> : null}
    </>
  );
}

function CreateAgent({ onClose, onCreated }) {
  const api = useApi();
  const { workspaceId } = useWorkspace();
  const toast = useToast();
  const [f, setF] = useState({ name: '', role: 'research', description: '', instructions: '', maxRisk: 'yellow' });
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.value }));

  async function submit(e) {
    e.preventDefault();
    const name = f.name.trim();
    if (!name) { setError('Give the agent a name.'); return; }
    if (name.length > 80) { setError('Name must be at most 80 characters.'); return; }
    setBusy(true);
    setError(null);
    try {
      await endpoints.createAgent(api, workspaceId, {
        name, role: f.role, maxRisk: f.maxRisk,
        ...(f.description.trim() ? { description: f.description.trim() } : {}),
        ...(f.instructions.trim() ? { instructions: f.instructions.trim() } : {}),
      });
      toast.success(`Agent "${name}" created`);
      onCreated();
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  return (
    <Modal title="New agent" onClose={onClose}>
      <form onSubmit={submit} noValidate>
        <label className="field"><span>Name</span><input value={f.name} onChange={set('name')} maxLength={80} /></label>
        <label className="field"><span>Role</span>
          <select value={f.role} onChange={set('role')}>{AGENT_ROLES.map((r) => <option key={r} value={r}>{humanize(r)}</option>)}</select>
        </label>
        <label className="field"><span>Description</span><input value={f.description} onChange={set('description')} maxLength={1000} /></label>
        <label className="field"><span>Standing instructions</span><textarea rows={3} value={f.instructions} onChange={set('instructions')} maxLength={2000} /></label>
        <label className="field"><span>Maximum risk</span>
          <select value={f.maxRisk} onChange={set('maxRisk')}>{Object.keys(RISK_HELP).map((r) => <option key={r} value={r}>{`${humanize(r)} — ${RISK_HELP[r]}`}</option>)}</select>
        </label>
        {error ? <Notice tone="danger">{error}</Notice> : null}
        <div className="modal-foot inline">
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" busy={busy}>Create agent</Button>
        </div>
      </form>
    </Modal>
  );
}
