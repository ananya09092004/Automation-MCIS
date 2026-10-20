import { useState } from 'react';
import { Badge, Button, Card, EmptyState, Notice, PageHeader, Resource } from '../components/ui.jsx';
import { useApi } from '../lib/apiContext.jsx';
import { useWorkspace } from '../lib/workspace.jsx';
import { useAuth } from '../lib/auth.jsx';
import { useResource } from '../lib/useResource.js';
import { useToast } from '../lib/toast.jsx';
import { endpoints } from '../lib/endpoints.js';
import { fmtDate, ROLE_LABEL } from '../lib/format.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default function Team() {
  const api = useApi();
  const { workspaceId, current, isAdmin } = useWorkspace();
  const { user } = useAuth();
  const members = useResource(() => endpoints.listMembers(api, workspaceId), [api, workspaceId]);
  const invites = useResource(() => endpoints.listInvitations(api, workspaceId), [api, workspaceId], { enabled: isAdmin });

  if (current && current.is_personal) {
    return (
      <>
        <PageHeader eyebrow="Workspace" title="Team" />
        <Card><Notice tone="info" title="Personal workspace">Personal workspaces have a single member. Create or switch to a team workspace to invite colleagues.</Notice></Card>
      </>
    );
  }

  return (
    <>
      <PageHeader eyebrow="Workspace" title="Team" description="Members of this workspace and their roles. Roles are enforced by the server on every request." />
      <div className="stack">
        <Card title="Members">
          <Resource res={members} loadingLabel="Loading members…" errorTitle="Could not load members">
            {(rows) => (rows.length ? (
              <div className="table-wrap" tabIndex={0} role="region" aria-label="Scrollable table">
                <table className="table">
                  <thead><tr><th>User</th><th>Role</th><th>Joined</th></tr></thead>
                  <tbody>
                    {rows.map((m) => (
                      <tr key={m.user_id}>
                        <td className="mono small">{m.user_id}{user && m.user_id === user.uid ? <span className="you">you</span> : null}</td>
                        <td>{ROLE_LABEL[m.role] || m.role}</td>
                        <td className="muted">{fmtDate(m.created_at)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : <EmptyState title="No members" />)}
          </Resource>
        </Card>
        {isAdmin ? <Invitations invites={invites} /> : null}
      </div>
    </>
  );
}

function Invitations({ invites }) {
  const api = useApi();
  const { workspaceId } = useWorkspace();
  const toast = useToast();
  const [email, setEmail] = useState('');
  const [role, setRole] = useState('member');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [created, setCreated] = useState(null);

  async function invite(e) {
    e.preventDefault();
    const clean = email.trim().toLowerCase();
    if (!EMAIL_RE.test(clean)) { setError('Enter a valid email address.'); return; }
    setBusy(true);
    setError(null);
    setCreated(null);
    try {
      const out = await endpoints.createInvitation(api, workspaceId, clean, role);
      setCreated({ email: clean, token: out.token, emailStatus: out.email && out.email.status });
      setEmail('');
      toast.success('Invitation created');
      invites.refresh();
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  }

  async function revoke(id) {
    try { await endpoints.revokeInvitation(api, workspaceId, id); toast.success('Invitation revoked'); invites.refresh(); } catch (err) { setError(err.message); }
  }

  return (
    <Card title="Invitations">
      <form className="row wrap" onSubmit={invite} noValidate>
        <label className="field grow"><span>Email</span><input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="colleague@company.com" /></label>
        <label className="field"><span>Role</span>
          <select value={role} onChange={(e) => setRole(e.target.value)}><option value="member">Member</option><option value="admin">Admin</option></select>
        </label>
        <Button variant="primary" type="submit" busy={busy} className="align-end">Invite</Button>
      </form>
      {error ? <Notice tone="danger">{error}</Notice> : null}
      {created ? (
        <Notice tone="success" title={`Invitation for ${created.email}`}>
          {created.emailStatus === 'sent' ? 'An invitation email was sent.' : 'Email delivery is not configured — share this one-time code with them. It is shown only once:'}
          {created.emailStatus !== 'sent' && created.token ? <code className="token">{created.token}</code> : null}
        </Notice>
      ) : null}
      <Resource res={invites} loadingLabel="Loading invitations…" errorTitle="Could not load invitations">
        {(rows) => {
          const pending = (rows || []).filter((i) => i.status === 'pending');
          return pending.length ? (
            <div className="table-wrap" tabIndex={0} role="region" aria-label="Scrollable table">
              <table className="table">
                <thead><tr><th>Email</th><th>Role</th><th>Status</th><th>Expires</th><th><span className="sr-only">Actions</span></th></tr></thead>
                <tbody>
                  {pending.map((i) => (
                    <tr key={i.id}>
                      <td>{i.email}</td><td>{ROLE_LABEL[i.role] || i.role}</td><td><Badge status={i.status} /></td>
                      <td className="muted">{fmtDate(i.expires_at)}</td>
                      <td className="right"><Button size="sm" variant="ghost" onClick={() => revoke(i.id)}>Revoke</Button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : <p className="muted small">No pending invitations.</p>;
        }}
      </Resource>
    </Card>
  );
}
