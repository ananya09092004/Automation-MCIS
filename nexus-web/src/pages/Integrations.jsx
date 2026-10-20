import { useState } from 'react';
import { Badge, Button, Card, EmptyState, Notice, PageHeader, Resource } from '../components/ui.jsx';
import { useApi } from '../lib/apiContext.jsx';
import { useWorkspace } from '../lib/workspace.jsx';
import { useResource } from '../lib/useResource.js';
import { useToast } from '../lib/toast.jsx';
import { endpoints } from '../lib/endpoints.js';
import { timeAgo } from '../lib/format.js';

/** Integrations are optional (INTEGRATIONS_ENABLED). A 404 here means "not enabled on this server". */
async function load(api, ws) {
  try { return { enabled: true, items: await endpoints.listIntegrations(api, ws) }; } catch (err) {
    if (err.status === 404 && err.code !== 'WORKSPACE_NOT_FOUND') return { enabled: false, items: [] };
    throw err;
  }
}

export default function Integrations() {
  const api = useApi();
  const { workspaceId, isAdmin } = useWorkspace();
  const toast = useToast();
  const res = useResource(() => load(api, workspaceId), [api, workspaceId]);
  const [checking, setChecking] = useState(null);
  const [error, setError] = useState(null);

  async function check(id) {
    setChecking(id);
    setError(null);
    try {
      await endpoints.checkIntegrationHealth(api, workspaceId, id);
      toast.success('Health check finished — status updated');
      await res.refresh();
    } catch (err) { setError(err.message); } finally { setChecking(null); }
  }

  return (
    <>
      <PageHeader eyebrow="Govern" title="Integrations" description="Connected systems agents may use. Credentials are encrypted server-side and never shown again." actions={<Button size="sm" onClick={res.refresh}>Refresh</Button>} />
      {error ? <Notice tone="danger">{error}</Notice> : null}
      <Resource res={res} loadingLabel="Loading integrations…" errorTitle="Could not load integrations">
        {({ enabled, items }) => (!enabled ? (
          <Card><Notice tone="warning" title="Integrations are not enabled on this server">An administrator must set INTEGRATIONS_ENABLED=true and INTEGRATION_ENCRYPTION_KEY on the backend.</Notice></Card>
        ) : items.length ? (
          <Card>
            <div className="table-wrap" tabIndex={0} role="region" aria-label="Scrollable table">
              <table className="table">
                <thead><tr><th>Name</th><th>Provider</th><th>Status</th><th>Credential</th><th>Last used</th><th>Last check</th><th><span className="sr-only">Actions</span></th></tr></thead>
                <tbody>
                  {items.map((i) => (
                    <tr key={i.id}>
                      <td className="strong">{i.name}{i.lastError ? <div className="small text-danger">{i.lastError}</div> : null}</td>
                      <td>{i.providerName}</td>
                      <td><Badge status={i.status} /></td>
                      <td>{i.hasCredential ? 'Stored (encrypted)' : 'None'}</td>
                      <td className="muted">{timeAgo(i.lastUsedAt)}</td>
                      <td className="muted">{timeAgo(i.lastCheckedAt)}</td>
                      <td className="right">{isAdmin ? <Button size="sm" busy={checking === i.id} onClick={() => check(i.id)}>Check health</Button> : null}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        ) : (
          <Card><EmptyState title="No integrations connected">Connect systems (HTTP APIs, GitHub, Slack, email, web pages) from the MCIS console's Integrations page. Credentials are entered there once and stored encrypted.</EmptyState></Card>
        ))}
      </Resource>
    </>
  );
}
