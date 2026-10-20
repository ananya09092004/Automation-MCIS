import { Badge, Card, EmptyState, Notice, PageHeader, Resource } from '../components/ui.jsx';
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
    const [summary, overview] = await Promise.all([
      endpoints.billingSummary(api, workspaceId),
      endpoints.overview(api, workspaceId).catch(() => null),
    ]);
    return { summary, usage: overview ? overview.usage : null };
  }, [api, workspaceId]);

  return (
    <>
      <PageHeader eyebrow="Workspace" title="Usage & Billing" description="Plan, limits and metered usage for this workspace, as recorded by the server." />
      <Resource res={res} loadingLabel="Loading billing…" errorTitle="Could not load billing">
        {({ summary: s, usage }) => (
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
