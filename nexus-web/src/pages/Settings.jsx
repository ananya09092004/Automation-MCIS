import { useState } from 'react';
import { Button, Card, Notice, PageHeader, Resource } from '../components/ui.jsx';
import { useApi } from '../lib/apiContext.jsx';
import { useWorkspace } from '../lib/workspace.jsx';
import { useAuth } from '../lib/auth.jsx';
import { useResource } from '../lib/useResource.js';
import { useToast } from '../lib/toast.jsx';
import { endpoints } from '../lib/endpoints.js';
import { fmtDate, ROLE_LABEL } from '../lib/format.js';
import SafetyControls from '../components/SafetyControls.jsx';
import { Link } from '../lib/router.jsx';
import { API_URL } from '../config.js';

export default function Settings() {
  const { user, signOut } = useAuth();
  const { current, isAdmin, role } = useWorkspace();
  return (
    <>
      <PageHeader eyebrow="Workspace" title="Settings" description="Your account, this workspace, paired devices and safety controls." />
      <div className="stack">
        <div className="grid-2">
          <Card title="Account">
            <dl className="kv">
              <dt>Email</dt><dd>{user && user.email}</dd>
              <dt>Email verified</dt><dd>{user && user.emailVerified ? 'Yes' : 'No'}</dd>
              <dt>User id</dt><dd className="mono small">{user && user.uid}</dd>
            </dl>
            <Button onClick={() => signOut()}>Sign out</Button>
          </Card>
          <Card title="Workspace">
            <dl className="kv">
              <dt>Name</dt><dd>{current && current.name}</dd>
              <dt>Type</dt><dd>{current && current.is_personal ? 'Personal' : 'Team'}</dd>
              <dt>Your role</dt><dd>{ROLE_LABEL[role] || role}</dd>
              <dt>API</dt><dd className="mono small">{API_URL || 'same origin (/api)'}</dd>
            </dl>
          </Card>
        </div>
        <Devices />
        {isAdmin ? <SafetyControls /> : <Card title="Safety controls"><p className="muted">Owners and admins manage the agent firewall and the emergency stop. See how actions are decided on the <Link to="/security" className="link">Agent Firewall</Link> page.</p></Card>}
      </div>
    </>
  );
}

function Devices() {
  const api = useApi();
  const toast = useToast();
  const res = useResource(() => endpoints.listDevices(api), [api]);
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);

  async function revoke(id) {
    if (typeof window !== 'undefined' && window.confirm && !window.confirm(`Revoke "${id}"? The desktop agent on it is disconnected and must be paired again.`)) return;
    setBusy(id);
    setError(null);
    try {
      await endpoints.revokeDevice(api, id);
      toast.success(`Device "${id}" revoked`);
      await res.refresh();
    } catch (err) { setError(err.message); } finally { setBusy(null); }
  }

  return (
    <Card title="Paired desktop devices">
      <p className="small muted">Computers running the Nexus desktop agent under your account. Revoking one invalidates its token immediately and closes its live connection.</p>
      {error ? <Notice tone="danger">{error}</Notice> : null}
      <Resource res={res} loadingLabel="Loading devices…" errorTitle="Could not load devices">
        {(devices) => (devices.length ? (
          <div className="table-wrap" tabIndex={0} role="region" aria-label="Scrollable table">
            <table className="table">
              <thead><tr><th>Device</th><th>Paired</th><th><span className="sr-only">Actions</span></th></tr></thead>
              <tbody>
                {devices.map((d) => (
                  <tr key={d.device_id}>
                    <td className="mono small">{d.device_id}</td>
                    <td className="muted">{fmtDate(d.created_at)}</td>
                    <td className="right"><Button size="sm" variant="danger" busy={busy === d.device_id} onClick={() => revoke(d.device_id)}>Revoke</Button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <p className="muted">No paired devices.</p>)}
      </Resource>
    </Card>
  );
}
