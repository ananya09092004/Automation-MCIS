import { useState } from 'react';
import { Badge, Button, Card, Notice, Resource, RiskTag } from './ui.jsx';
import Icon from './icons.jsx';
import { useApi } from '../lib/apiContext.jsx';
import { useWorkspace } from '../lib/workspace.jsx';
import { useToast } from '../lib/toast.jsx';
import { useResource } from '../lib/useResource.js';
import { endpoints } from '../lib/endpoints.js';

/** Emergency stop control (owners/admins). Uses the dashboard already loaded by the caller when given. */
export function EmergencyStop({ dashboard, onChanged }) {
  const api = useApi();
  const { workspaceId } = useWorkspace();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const stopped = !!(dashboard.policy && dashboard.policy.emergencyStop);

  async function toggle(active) {
    if (active && typeof window !== 'undefined' && window.confirm
      && !window.confirm('Turn on the emergency stop? Every agent and connector action in this workspace will be denied until you release it.')) return;
    setBusy(true);
    setError(null);
    try {
      await endpoints.setEmergencyStop(api, workspaceId, active);
      toast.success(active ? 'Emergency stop is ON — all agent actions are blocked' : 'Emergency stop released');
      await onChanged();
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  }

  return (
    <div className={`card stop-card ${stopped ? 'on' : ''}`}>
      <div className="callout-icon" style={stopped ? { background: '#fff', color: 'var(--danger)' } : { background: 'var(--danger-soft)', color: 'var(--danger)' }} aria-hidden="true"><Icon name="alert" size={18} /></div>
      <div className="grow">
        <div className="strong">Emergency stop {stopped ? <Badge status="failed">ON — all agent actions blocked</Badge> : <Badge status="completed">Off</Badge>}</div>
        <div className="small muted">Denies every agent and connector action in this workspace until released. Steps already sent to a desktop cannot be recalled.</div>
        {error ? <Notice tone="danger">{error}</Notice> : null}
      </div>
      {stopped
        ? <Button busy={busy} onClick={() => toggle(false)}>Release emergency stop</Button>
        : <Button variant="danger" busy={busy} onClick={() => toggle(true)}>Emergency stop</Button>}
    </div>
  );
}

/** Compact safety summary used on Settings. */
export default function SafetyControls() {
  const api = useApi();
  const { workspaceId } = useWorkspace();
  const res = useResource(() => endpoints.securityDashboard(api, workspaceId), [api, workspaceId]);
  return (
    <Card title="Safety controls">
      <Resource res={res} loadingLabel="Loading safety controls…" errorTitle="Could not load safety controls">
        {(d) => (
          <>
            <dl className="kv">
              <dt>Agent firewall</dt><dd>{d.firewall.enabled ? <Badge status="active">Enforcing</Badge> : <Badge status="paused">Disabled on this server</Badge>}</dd>
              <dt>Policy version</dt><dd>{d.firewall.policyVersion}{d.firewall.isDefault ? ' (default)' : ''}</dd>
              <dt>Highest risk allowed</dt><dd>{d.approvalPolicy && d.approvalPolicy.maxRisk ? <RiskTag risk={d.approvalPolicy.maxRisk} /> : '—'}</dd>
              <dt>Blocked actions (recent)</dt><dd>{d.blockedActions ? d.blockedActions.length : 0}</dd>
            </dl>
            <EmergencyStop dashboard={d} onChanged={res.refresh} />
          </>
        )}
      </Resource>
    </Card>
  );
}
