import { useState } from 'react';
import { Badge, Button, Card, Dot, EmptyState, Notice, PageHeader, Resource, RiskTag } from '../components/ui.jsx';
import { useApi } from '../lib/apiContext.jsx';
import { useWorkspace } from '../lib/workspace.jsx';
import { useResource } from '../lib/useResource.js';
import { useToast } from '../lib/toast.jsx';
import { endpoints } from '../lib/endpoints.js';
import { Link } from '../lib/router.jsx';
import { timeAgo } from '../lib/format.js';

/** Integrations are optional (INTEGRATIONS_ENABLED). A 404 here means "not enabled on this server". */
async function load(api, ws) {
  try { return { enabled: true, items: await endpoints.listIntegrations(api, ws) }; } catch (err) {
    if (err.status === 404 && err.code !== 'WORKSPACE_NOT_FOUND') return { enabled: false, items: [] };
    throw err;
  }
}

// Status as the SERVER reports it — never inferred as "connected" by the UI.
const STATE = {
  connected: { label: 'Connected', badge: 'connected', dot: 'success' },
  disconnected: { label: 'Disconnected', badge: 'disconnected', dot: 'neutral' },
  error: { label: 'Needs attention', badge: 'failed', dot: 'danger' },
  revoked: { label: 'Access revoked — reconnect', badge: 'failed', dot: 'danger' },
};

export default function Integrations() {
  const api = useApi();
  const { workspaceId } = useWorkspace();
  const res = useResource(() => load(api, workspaceId), [api, workspaceId]);

  return (
    <>
      <PageHeader eyebrow="Govern" title="Integrations"
        description="Systems your agents may use, and exactly what each one is allowed to do. Credentials are encrypted on the server and never shown again."
        actions={<Button size="sm" onClick={res.refresh}>Refresh</Button>} />
      <Resource res={res} loadingLabel="Loading integrations…" errorTitle="Could not load integrations">
        {({ enabled, items }) => (!enabled ? (
          <Card><Notice tone="warning" title="Integrations are not enabled on this server">An administrator must set INTEGRATIONS_ENABLED=true and INTEGRATION_ENCRYPTION_KEY on the backend.</Notice></Card>
        ) : items.length ? (
          <div className="stack">
            {items.map((i) => <IntegrationCard key={i.id} i={i} onChanged={res.refresh} />)}
          </div>
        ) : (
          <Card><EmptyState icon="integrations" title="No integrations connected"
            action={<Link to="/compare" className="btn">Add a product page in Compare</Link>}>
            Connected systems appear here with their permissions. A “Web pages” integration is created when you add a product in Compare.
          </EmptyState></Card>
        ))}
      </Resource>
    </>
  );
}

function IntegrationCard({ i, onChanged }) {
  const api = useApi();
  const { workspaceId, isAdmin } = useWorkspace();
  const toast = useToast();
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const st = STATE[i.status] || { label: i.status, badge: 'none', dot: 'neutral' };
  const actions = (i.actions || []).filter((a) => a.available !== false);
  const enabledCount = actions.filter((a) => a.enabled).length;

  async function check() {
    setBusy('health'); setError(null);
    try { await endpoints.checkIntegrationHealth(api, workspaceId, i.id); toast.success('Health check finished — status updated'); await onChanged(); } catch (err) { setError(err.message); }
    setBusy(null);
  }
  async function toggle(a) {
    const turnOn = !a.enabled;
    if (turnOn && !a.readOnly && typeof window !== 'undefined' && window.confirm
      && !window.confirm(`Allow agents to use "${a.label}"? It changes data in ${i.providerName}.${a.requiresApproval ? ' Each use still waits for approval.' : ''}`)) return;
    setBusy(a.name); setError(null);
    try {
      await endpoints.updateIntegrationPermissions(api, workspaceId, i.id, { [a.name]: { enabled: turnOn } });
      toast.success(`${a.label}: ${turnOn ? 'allowed' : 'blocked'}`);
      await onChanged();
    } catch (err) { setError(err.message); }
    setBusy(null);
  }

  return (
    <Card>
      <div className="intg-head">
        <div className="grow">
          <div className="intg-title"><Dot tone={st.dot} /><h2>{i.name}</h2><span className="small muted">{i.providerName}</span></div>
          <div className="small muted">
            <Badge status={st.badge}>{st.label}</Badge>
            <span> · credential {i.hasCredential ? 'stored encrypted' : 'none'} · last used {i.lastUsedAt ? timeAgo(i.lastUsedAt) : 'never'} · last check {i.lastCheckedAt ? timeAgo(i.lastCheckedAt) : 'never'}</span>
          </div>
          {i.lastError ? <Notice tone="danger">{i.lastError}</Notice> : null}
        </div>
        {isAdmin ? <Button size="sm" busy={busy === 'health'} onClick={check}>Check health</Button> : null}
      </div>
      {error ? <Notice tone="danger">{error}</Notice> : null}
      {actions.length ? (
        <>
          <p className="small strong" style={{ margin: '14px 0 6px' }}>What agents may do · {enabledCount} of {actions.length} allowed</p>
          <ul className="policy-list">
            {actions.map((a) => (
              <li key={a.name}>
                <span>
                  <span className="strong">{a.label}</span>
                  <span className="small muted"> · {a.readOnly ? 'reads only' : 'changes data'}{a.requiresAdminApproval ? ' · admin approval each time' : a.requiresApproval ? ' · approval each time' : ''}</span>
                </span>
                <span className="row" style={{ margin: 0 }}>
                  <RiskTag risk={a.effectiveTier} />
                  {isAdmin ? (
                    <button type="button" role="switch" aria-checked={a.enabled} aria-label={`${a.label} allowed`} className={`switch ${a.enabled ? 'on' : ''}`} disabled={!!busy} onClick={() => toggle(a)}>
                      <span className="switch-knob" aria-hidden="true" />
                    </button>
                  ) : <Badge status={a.enabled ? 'active' : 'cancelled'}>{a.enabled ? 'Allowed' : 'Blocked'}</Badge>}
                </span>
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </Card>
  );
}
