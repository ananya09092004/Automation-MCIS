import { Badge, Button, Card, EmptyState, Notice, PageHeader, Resource, RiskTag } from '../components/ui.jsx';
import Icon from '../components/icons.jsx';
import { EmergencyStop } from '../components/SafetyControls.jsx';
import { useApi } from '../lib/apiContext.jsx';
import { useWorkspace } from '../lib/workspace.jsx';
import { useResource } from '../lib/useResource.js';
import { endpoints } from '../lib/endpoints.js';
import { Link } from '../lib/router.jsx';
import { fmtDate, fmtNumber, humanize, timeAgo } from '../lib/format.js';

// Mirrors the backend decision rules (services/security/policyEngine.js):
// green → allowed; yellow → approval by a member; red → approval by an admin;
// any deny rule, or a risk above the workspace maximum → blocked.
const RISK_RANK = { green: 0, yellow: 1, red: 2 };

function Flow({ state }) {
  const halted = state !== 'enforcing';
  const label = { enforcing: 'Enforcing policy', disabled: 'Disabled on this server', stopped: 'Emergency stop — all actions denied', unknown: 'Policy-checked' }[state];
  return (
    <div className="flow" role="img" aria-label={`You, then AI agent, then Nexus Agent Firewall (${label}), then tools and systems`}>
      <div className="flow-node"><span className="icon-tile"><Icon name="user" /></span><div><strong>You &amp; your team</strong><span className="small muted">Ask, approve, review</span></div></div>
      <div className={`flow-link ${halted && state !== 'unknown' ? 'halt' : ''}`} aria-hidden="true" />
      <div className="flow-node"><span className="icon-tile"><Icon name="agents" /></span><div><strong>AI agent</strong><span className="small muted">Plans each step</span></div></div>
      <div className={`flow-link ${halted && state !== 'unknown' ? 'halt' : ''}`} aria-hidden="true" />
      <div className={`flow-node firewall ${state === 'disabled' ? 'off' : ''} ${state === 'stopped' ? 'stopped' : ''}`}>
        <span className="icon-tile"><Icon name="firewall" /></span>
        <div><strong>Nexus Agent Firewall</strong><span className="small">{label}</span></div>
      </div>
      <div className={`flow-link ${halted && state !== 'unknown' ? 'halt' : ''}`} aria-hidden="true" />
      <div className="flow-node"><span className="icon-tile"><Icon name="tool" /></span><div><strong>Tools &amp; systems</strong><span className="small muted">Browser, desktop, connectors</span></div></div>
    </div>
  );
}

function Decisions({ maxRisk, ttl }) {
  const max = RISK_RANK[maxRisk] ?? 2;
  const capped = (r) => RISK_RANK[r] > max;
  const cards = [
    { risk: 'green', title: 'Allowed', text: 'Low-risk steps run automatically. Each one is recorded with its evidence.' },
    { risk: 'yellow', title: 'Requires approval', text: `Pauses until a workspace member approves.${ttl ? ` Requests expire after ${ttl} min.` : ''}` },
    { risk: 'red', title: 'Requires admin approval', text: 'Pauses until an owner or admin approves. You can never approve your own request.' },
    { risk: 'blocked', title: 'Blocked', text: 'Matches a deny rule or exceeds the workspace maximum risk. Nothing runs.' },
  ];
  return (
    <div className="decision-grid">
      {cards.map((c) => (
        <div className="decision" key={c.risk}>
          <div className="decision-head"><RiskTag risk={c.risk} /><strong>{c.title}</strong></div>
          <p>{c.text}</p>
          {c.risk !== 'blocked' && capped(c.risk) ? <Badge status="failed">Blocked in this workspace</Badge> : null}
        </div>
      ))}
    </div>
  );
}

function Yes({ on, yes = 'On', no = 'Off' }) {
  return on ? <Badge status="active">{yes}</Badge> : <Badge status="cancelled">{no}</Badge>;
}

function PolicyCard({ d }) {
  const p = d.policy || {};
  const types = p.executionTypes || {};
  const files = p.files || {};
  const domains = p.domains || { allow: [], deny: [] };
  const repos = p.repositories || { allow: [], deny: [] };
  const sched = p.schedule;
  return (
    <Card title="Active policy" actions={<span className="small muted">Version {d.firewall.policyVersion}{d.firewall.isDefault ? ' · built-in default' : ''}</span>}>
      {d.firewall.corrupt ? <Notice tone="danger" title="Stored policy is unreadable">The firewall fails closed and denies every action until an owner saves a valid policy.</Notice> : null}
      <ul className="policy-list">
        <li><span>Highest risk allowed</span>{p.maxRisk ? <RiskTag risk={p.maxRisk} /> : '—'}</li>
        <li><span>Execution types</span><span className="chips" style={{ margin: 0 }}>
          {['connector', 'browser', 'desktop'].map((t) => <Badge key={t} status={types[t] === false ? 'cancelled' : 'active'}>{humanize(t)}</Badge>)}
        </span></li>
        <li><span>Secrets in agent input</span><Yes on={!p.sensitiveData || p.sensitiveData.blockSecretsInInput !== false} yes="Blocked" no="Allowed" /></li>
        <li><span>Steps that read untrusted content</span><Yes on={!p.approval || p.approval.taintedRequiresApproval !== false} yes="Need approval" no="No extra approval" /></li>
        <li><span>Deleting files</span><Yes on={files.delete === 'deny'} yes="Denied" no={humanize(files.delete || 'allow')} /></li>
        <li><span>Protected paths</span><span className="strong">{fmtNumber((files.protectedPaths || []).length)}</span></li>
        <li><span>Domain rules</span><span className="small">{fmtNumber(domains.allow.length)} allowed · {fmtNumber(domains.deny.length)} denied{domains.allow.length ? ' · allow-list on' : ''}</span></li>
        <li><span>Repository rules</span><span className="small">{fmtNumber(repos.allow.length)} allowed · {fmtNumber(repos.deny.length)} denied</span></li>
        <li><span>Allowed hours</span><span className="small">{sched ? `${sched.startHourUtc}:00–${sched.endHourUtc}:00 ${sched.timeZone || 'UTC'}` : 'Any time'}</span></li>
        <li><span>Approval expiry</span><span className="small">{p.approval && p.approval.ttlMinutes ? `${p.approval.ttlMinutes} min` : '—'}</span></li>
      </ul>
      <p className="small muted" style={{ marginTop: 12 }}>Owners change the policy through the API (<span className="mono">PUT /api/workspaces/:id/security/policy</span>). Every change is versioned and recorded as a security event.</p>
    </Card>
  );
}

function BuiltIn({ builtIn }) {
  if (!builtIn) return null;
  const dangerous = builtIn.dangerousActionsDeniedByDefault || [];
  return (
    <Card title="Always on">
      <ul className="policy-list">
        {(builtIn.alwaysDenied || []).map((t) => <li key={t}><span>{t.charAt(0).toUpperCase() + t.slice(1)}</span><RiskTag risk="blocked" /></li>)}
        {dangerous.length ? <li><span>Dangerous actions denied by default ({fmtNumber(dangerous.length)})</span><RiskTag risk="blocked" /></li> : null}
      </ul>
      {dangerous.length ? <p className="small muted" style={{ marginTop: 10 }}>{dangerous.map(humanize).join(' · ')}</p> : null}
    </Card>
  );
}

function Blocked({ rows }) {
  return (
    <Card title="Recently blocked" actions={<Link to="/activity" className="link">All security events</Link>}>
      {rows && rows.length ? (
        <ul className="list">
          {rows.slice(0, 8).map((r) => (
            <li key={r.id} className="list-row">
              <RiskTag risk="blocked" />
              <span className="list-main">{humanize(r.type)}</span>
              <span className="muted small" title={fmtDate(r.at)}>{timeAgo(r.at)}</span>
            </li>
          ))}
        </ul>
      ) : <EmptyState icon="firewall" title="Nothing blocked recently">Denied actions, blocked connectors and rejected credentials appear here.</EmptyState>}
    </Card>
  );
}

function Connections({ items }) {
  if (!items || !items.length) return null;
  return (
    <Card title="Connected systems" actions={<Link to="/integrations" className="link">Integrations</Link>}>
      <div className="table-wrap" tabIndex={0} role="region" aria-label="Scrollable table">
        <table className="table">
          <thead><tr><th>Integration</th><th>Status</th><th>Credential</th><th>Actions enabled</th><th>Last used</th></tr></thead>
          <tbody>
            {items.map((i) => (
              <tr key={i.id}>
                <td><strong>{i.name}</strong><div className="small muted">{humanize(i.provider)}</div></td>
                <td><Badge status={i.status} /></td>
                <td>{i.hasCredential ? <Badge status="active">Stored encrypted</Badge> : <Badge status="cancelled">None</Badge>}</td>
                <td>{fmtNumber((i.connectorPermissions || []).filter((a) => a.enabled).length)} of {fmtNumber((i.connectorPermissions || []).length)}</td>
                <td className="muted">{i.lastUsedAt ? timeAgo(i.lastUsedAt) : 'Never'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

export default function Security() {
  const api = useApi();
  const { workspaceId, isAdmin } = useWorkspace();
  const res = useResource(() => endpoints.securityDashboard(api, workspaceId), [api, workspaceId], { enabled: isAdmin });

  return (
    <>
      <PageHeader
        eyebrow="Govern"
        title="Agent Firewall"
        description="Every action an agent takes passes through Nexus first. Policy decides whether it runs, waits for a person, or is blocked."
        actions={isAdmin ? <Button size="sm" onClick={res.refresh}>Refresh</Button> : null}
      />
      {!isAdmin ? (
        <div className="stack">
          <Card><Flow state="unknown" /></Card>
          <Card title="How actions are decided"><Decisions maxRisk="red" /></Card>
          <Notice tone="info" title="Owners and admins manage the firewall">You can see how decisions work. The live policy, blocked actions and the emergency stop are visible to workspace owners and admins.</Notice>
        </div>
      ) : (
        <Resource res={res} loadingLabel="Loading the firewall…" errorTitle="Could not load the Agent Firewall">
          {(d) => {
            const state = d.policy && d.policy.emergencyStop ? 'stopped' : d.firewall.enabled ? 'enforcing' : 'disabled';
            return (
              <div className="stack">
                {!d.firewall.enabled ? <Notice tone="warning" title="The Agent Firewall is disabled on this server">The server is running with SECURITY_FIREWALL_ENABLED=false. Risk approvals still apply, but workspace policy rules are not enforced.</Notice> : null}
                <Card><Flow state={state} /></Card>
                <EmergencyStop dashboard={d} onChanged={res.refresh} />
                <Card title="How actions are decided"><Decisions maxRisk={d.policy && d.policy.maxRisk} ttl={d.policy && d.policy.approval && d.policy.approval.ttlMinutes} /></Card>
                <div className="grid-2">
                  <PolicyCard d={d} />
                  <div className="stack">
                    <Blocked rows={d.blockedActions} />
                    <BuiltIn builtIn={d.builtIn} />
                  </div>
                </div>
                <Connections items={d.integrations} />
              </div>
            );
          }}
        </Resource>
      )}
    </>
  );
}
