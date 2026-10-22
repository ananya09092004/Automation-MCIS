import { useState } from 'react';
import { Badge, Button, Card, EmptyState, Notice, PageHeader, Resource } from '../components/ui.jsx';
import { useToast } from '../lib/toast.jsx';
import { safeHref } from '../lib/compare.js';
import { redirectTo } from '../lib/redirect.js';
import { useApi } from '../lib/apiContext.jsx';
import { useWorkspace } from '../lib/workspace.jsx';
import { useResource } from '../lib/useResource.js';
import { endpoints } from '../lib/endpoints.js';
import { fmtDate, fmtNumber, humanize } from '../lib/format.js';

/**
 * Shows the server's own billing state. Nothing here is invented: when no
 * payment provider is configured the page says so — no prices, invoices or
 * card UI are shown.
 */
export default function Billing() {
  const api = useApi();
  const { workspaceId } = useWorkspace();
  const res = useResource(async () => {
    const [summary, overview, plans] = await Promise.all([
      endpoints.billingSummary(api, workspaceId),
      endpoints.overview(api, workspaceId).catch(() => null),
      endpoints.billingPlans(api, workspaceId).catch(() => []),
    ]);
    return { summary, usage: overview ? overview.usage : null, plans };
  }, [api, workspaceId]);

  return (
    <>
      <PageHeader eyebrow="Workspace" title="Usage & Billing" description="Plan, limits and metered usage for this workspace, as recorded by the server." />
      <Resource res={res} loadingLabel="Loading billing…" errorTitle="Could not load billing">
        {({ summary: s, usage, plans }) => (
          <div className="stack">
            <div className="grid-3">
              <Card title="Plan">
                <div className="big">{s.plan ? s.plan.name : 'No plan'}</div>
                <dl className="kv">
                  <dt>Subscription</dt><dd><Badge status={s.subscription.effectiveStatus || s.subscription.status} /></dd>
                  <dt>Period</dt><dd>{fmtDate(s.period && s.period.start)} – {fmtDate(s.period && s.period.end)}</dd>
                  {s.subscription.trialEndsAt ? <><dt>Trial ends</dt><dd>{fmtDate(s.subscription.trialEndsAt)}</dd></> : null}
                  {s.subscription.cancelAtPeriodEnd ? <><dt>Cancels</dt><dd>At period end</dd></> : null}
                </dl>
              </Card>
              <Card title="Limits">
                <dl className="kv">
                  <dt>Enforcement</dt><dd>{s.billingEnabled ? <Badge status="active">Enforced</Badge> : <Badge status="paused">Metering only</Badge>}</dd>
                  <dt>Custom limits</dt><dd>{s.customLimits ? 'Yes' : 'No'}</dd>
                </dl>
                {!s.billingEnabled ? <p className="small muted">Usage is recorded, but plan limits are not enforced on this server (BILLING_ENABLED is off).</p> : null}
              </Card>
              <Card title="Payments">
                {s.payments && s.payments.configured ? (
                  <dl className="kv">
                    <dt>Provider</dt><dd>{humanize(s.payments.provider)}</dd>
                    <dt>Checkout</dt><dd>{s.payments.checkoutAvailable ? 'Available' : 'Not available'}</dd>
                  </dl>
                ) : (
                  <Notice tone="warning" title="Not configured">No payment provider is configured on this server. No payments are taken and no invoices are issued.</Notice>
                )}
              </Card>
            </div>
            <Plans plans={plans} summary={s} onChanged={res.refresh} />
            <Card title="Metered usage this period">
              {s.meters && s.meters.length ? (
                <div className="table-wrap" tabIndex={0} role="region" aria-label="Scrollable table">
                  <table className="table">
                    <thead><tr><th>Capability</th><th>Used</th><th>Limit</th><th>Usage</th></tr></thead>
                    <tbody>
                      {s.meters.map((m) => {
                        const pct = !m.unlimited && m.limit && m.used !== null ? Math.min(100, Math.round((m.used / m.limit) * 100)) : null;
                        return (
                          <tr key={m.capability}>
                            <td>{humanize(m.capability)}</td>
                            <td>{m.used === null ? '—' : fmtNumber(m.used)}</td>
                            <td>{m.unlimited ? 'Unlimited' : fmtNumber(m.limit)}</td>
                            <td className="meter-cell">{pct === null ? <span className="muted small">—</span> : (
                              <div className="meter" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-label={`${humanize(m.capability)} ${pct}%`}>
                                <div className={`meter-fill ${pct >= 90 ? 'danger' : pct >= 75 ? 'warning' : ''}`} style={{ width: `${pct}%` }} />
                              </div>
                            )}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              ) : <EmptyState title="No meters reported" />}
            </Card>
            {usage ? (
              <Card title="Last 30 days">
                <dl className="kv cols">
                  <dt>Agent executions</dt><dd>{fmtNumber(usage.executions)}</dd>
                  <dt>Workflow runs</dt><dd>{fmtNumber(usage.workflowRuns)}</dd>
                  <dt>Executed steps</dt><dd>{fmtNumber(usage.steps)}</dd>
                  <dt>Connector calls</dt><dd>{fmtNumber(usage.connectorCalls)}</dd>
                  <dt>API calls</dt><dd>{fmtNumber(usage.apiCalls)}</dd>
                </dl>
              </Card>
            ) : null}
          </div>
        )}
      </Resource>
    </>
  );
}

const LIMIT_ROWS = [
  ['executions_per_month', 'Agent executions / month'],
  ['workflow_runs_per_month', 'Workflow runs / month'],
  ['max_members', 'Team members'],
  ['max_integrations', 'Integrations'],
  ['max_monitored_products', 'Compared / monitored products'],
  ['usage_retention_days', 'Usage history (days)'],
];
const SUPPORT = { community: 'Community', email: 'Email', priority_email: 'Priority email', dedicated: 'Dedicated' };

/** Plan catalogue from the server. Purchase is offered only when the server says it is possible. */
function Plans({ plans, summary: s, onChanged }) {
  const api = useApi();
  const { workspaceId, isAdmin } = useWorkspace();
  const toast = useToast();
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const ps = s.paymentStatus || {};
  const current = s.plan ? s.plan.id : null;
  if (!plans || !plans.length) return null;

  async function go(kind, fn) {
    setBusy(kind); setError(null);
    try {
      const r = await fn();
      const href = r && safeHref(r.url);
      if (href && href.startsWith('https://')) { redirectTo(href); return; }
      if (r && r.status === 'cancel_requested') { toast.success('Your plan will end at the close of the current period'); await onChanged(); }
    } catch (err) { setError(err.message); }
    setBusy(null);
  }

  return (
    <Card title="Plans" actions={ps.portalAvailable ? <Button size="sm" busy={busy === 'portal'} onClick={() => go('portal', () => endpoints.billingPortal(api, workspaceId))}>Manage subscription</Button> : null}>
      {!ps.configured ? <p className="small muted">Online purchase is not available on this deployment yet. Plans are activated by the Nexus team; limits below are what each plan enforces.</p> : null}
      {error ? <Notice tone="danger">{error}</Notice> : null}
      <div className="plans">
        {plans.map((p) => {
          const isCurrent = p.id === current;
          const f = p.features || {};
          return (
            <section key={p.id} className={`plan ${isCurrent ? 'is-current' : ''}`} aria-label={`${p.name} plan`}>
              <div className="plan-head">
                <h3>{p.name}</h3>
                {isCurrent ? <Badge status="active">Current</Badge> : null}
              </div>
              {p.description ? <p className="small muted">{p.description}</p> : null}
              <ul className="plan-limits">
                {LIMIT_ROWS.filter(([k]) => k in (p.limits || {})).map(([k, label]) => (
                  <li key={k}><span>{label}</span><strong>{p.limits[k] === null ? 'Unlimited' : fmtNumber(p.limits[k])}</strong></li>
                ))}
                {f.support ? <li><span>Support</span><strong>{SUPPORT[f.support] || humanize(f.support)}</strong></li> : null}
              </ul>
              <div className="plan-cta">
                {isCurrent ? <span className="small muted">Your workspace is on this plan.</span>
                  : p.purchasable && ps.checkoutAvailable && isAdmin
                    ? <Button variant="primary" className="full" busy={busy === p.id} disabled={!!busy} onClick={() => go(p.id, () => endpoints.billingCheckout(api, workspaceId, p.id))}>Choose {p.name}</Button>
                    : <span className="small muted">{f.manual_activation ? 'Arranged with the Nexus team.' : !ps.configured ? 'Activated by the Nexus team.' : !isAdmin ? 'Owners and admins change plans.' : 'Not available online.'}</span>}
              </div>
            </section>
          );
        })}
      </div>
      {ps.cancelAvailable ? (
        <div className="row"><Button size="sm" variant="ghost" busy={busy === 'cancel'} onClick={() => {
          if (typeof window !== 'undefined' && window.confirm && !window.confirm('Cancel your subscription at the end of the current period?')) return;
          go('cancel', () => endpoints.billingCancel(api, workspaceId));
        }}>Cancel subscription</Button></div>
      ) : null}
    </Card>
  );
}
