import { useEffect, useMemo, useState } from 'react';
import { Badge, Button, Card, Dot, EmptyState, Modal, Notice, PageHeader, Resource } from '../components/ui.jsx';
import Icon from '../components/icons.jsx';
import { useApi } from '../lib/apiContext.jsx';
import { useWorkspace } from '../lib/workspace.jsx';
import { useToast } from '../lib/toast.jsx';
import { useResource } from '../lib/useResource.js';
import { endpoints } from '../lib/endpoints.js';
import { Link } from '../lib/router.jsx';
import { fmtDate, fmtNumber, humanize, timeAgo } from '../lib/format.js';
import { CRITERIA, hostAllowed, isComparable, safeHref, score, sourceHost, toCsv } from '../lib/compare.js';

const MAX_SELECTED = 4;
const HEALTH_TONE = { VERIFIED: 'success', UNVERIFIED: 'warning', PENDING: 'info', STALE: 'neutral', UNAVAILABLE: 'danger' };
const AVAIL_LABEL = { IN_STOCK: 'In stock', LIMITED: 'Limited stock', OUT_OF_STOCK: 'Out of stock', UNKNOWN: 'Not published' };
const METHOD_LABEL = { json_ld: 'JSON-LD', microdata: 'Microdata', meta_tags: 'Product meta tags', shopify_json: 'Shopify JSON', json_pointer: 'JSON fields', http_status: 'HTTP status' };

function readIds() {
  try { return (new URLSearchParams(window.location.search).get('ids') || '').split(',').filter(Boolean).slice(0, MAX_SELECTED); } catch { return []; }
}
function writeIds(ids) {
  try {
    const q = ids.length ? `?ids=${ids.map(encodeURIComponent).join(',')}` : '';
    window.history.replaceState(window.history.state, '', window.location.pathname + q);
  } catch { /* non-browser */ }
}

/** Monitoring is an optional module (REVENUE_SUITE_ENABLED); 404 → not enabled. Integrations may be off. */
async function loadCompare(api, ws, isAdmin) {
  const monitors = await endpoints.listProductMonitors(api, ws).catch((err) => (err.status === 404 ? null : Promise.reject(err)));
  let integrations = null;
  if (isAdmin) integrations = await endpoints.listIntegrations(api, ws).catch((err) => (err.status === 404 ? 'disabled' : []));
  return { monitors, integrations };
}

function Missing({ children = 'Not published' }) {
  return <span className="cmp-missing">{children}</span>;
}

function money(v, currency) {
  if (typeof v !== 'number') return null;
  try { return new Intl.NumberFormat(undefined, { style: 'currency', currency: currency || 'XXX', maximumFractionDigits: 2 }).format(v); } catch { return `${fmtNumber(v)}${currency ? ` ${currency}` : ''}`; }
}

export default function Compare() {
  const api = useApi();
  const { workspaceId, isAdmin } = useWorkspace();
  const res = useResource(() => loadCompare(api, workspaceId, isAdmin), [api, workspaceId, isAdmin]);
  const [adding, setAdding] = useState(false);

  return (
    <>
      <PageHeader
        eyebrow="Intelligence"
        title="Compare"
        description="Put products side by side using the structured data each product page publishes. Every value shows where and when Nexus read it — nothing is estimated or invented."
        actions={<>
          <Button size="sm" onClick={res.refresh}>Refresh</Button>
          {isAdmin ? <Button variant="primary" onClick={() => setAdding(true)}><Icon name="plus" size={16} />Add product</Button> : null}
        </>}
      />
      <Resource res={res} loadingLabel="Loading products…" errorTitle="Could not load products">
        {(d) => (d.monitors === null
          ? <Card><EmptyState icon="compare" title="Product intelligence is not enabled on this server">An administrator can enable it with REVENUE_SUITE_ENABLED on the Nexus API.</EmptyState></Card>
          : <Workspace data={d} onAdd={() => setAdding(true)} reload={res.refresh} />)}
      </Resource>
      {adding && res.data && res.data.monitors !== null
        ? <AddProduct integrations={res.data.integrations} onClose={() => setAdding(false)} onAdded={res.refresh} />
        : null}
    </>
  );
}

function Workspace({ data, onAdd, reload }) {
  const { isAdmin } = useWorkspace();
  const all = data.monitors;
  const [ids, setIds] = useState(() => {
    const fromUrl = readIds().filter((id) => all.some((m) => m.id === id));
    return fromUrl.length ? fromUrl : all.slice(0, Math.min(2, all.length)).map((m) => m.id);
  });
  const [weights, setWeights] = useState({ price: 3, availability: 2, discount: 1 });
  useEffect(() => { writeIds(ids); }, [ids]);

  if (!all.length) {
    return (
      <Card>
        <EmptyState icon="compare" title="No products to compare yet"
          action={isAdmin ? <Button variant="primary" onClick={onAdd}>Add your first product</Button> : null}>
          Add the public page of each product or vendor offer you want to compare. Nexus reads the structured product data the page publishes
          (price, availability, seller, identifiers) — {isAdmin ? 'start with two.' : 'ask a workspace admin to add products.'}
        </EmptyState>
      </Card>
    );
  }

  const selected = ids.map((id) => all.find((m) => m.id === id)).filter(Boolean);
  const toggle = (id) => setIds((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : cur.length >= MAX_SELECTED ? cur : [...cur, id]));

  return (
    <div className="stack">
      <Card title="Products" actions={<span className="small muted">{selected.length} of {MAX_SELECTED} selected</span>}>
        <div className="cmp-picker" role="group" aria-label="Products to compare">
          {all.map((m) => {
            const on = ids.includes(m.id);
            return (
              <button type="button" key={m.id} className={`cmp-pick ${on ? 'on' : ''}`} aria-pressed={on} onClick={() => toggle(m.id)} disabled={!on && ids.length >= MAX_SELECTED}>
                <Dot tone={HEALTH_TONE[m.health] || 'neutral'} />
                <span className="cmp-pick-name">{m.name}</span>
                <span className="small muted">{sourceHost(m) || humanize(m.sourceType)}</span>
              </button>
            );
          })}
        </div>
      </Card>
      {selected.length < 2
        ? <Notice tone="info" title="Select at least two products">Choose the products above to see them side by side.</Notice>
        : <Comparison monitors={selected} weights={weights} setWeights={setWeights} reload={reload} />}
    </div>
  );
}

function Criteria({ weights, setWeights }) {
  return (
    <div className="cmp-criteria" role="group" aria-label="Scoring criteria">
      {CRITERIA.map((c) => (
        <label key={c.key} className="cmp-criterion" title={c.hint}>
          <span className="strong small">{c.label}</span>
          <input type="range" min="0" max="5" step="1" value={weights[c.key]} aria-label={`${c.label} weight`}
            onChange={(e) => setWeights((w) => ({ ...w, [c.key]: Number(e.target.value) }))} />
          <span className="mono small">{weights[c.key] ? `×${weights[c.key]}` : 'off'}</span>
        </label>
      ))}
    </div>
  );
}

function Comparison({ monitors, weights, setWeights, reload }) {
  const api = useApi();
  const { workspaceId, isAdmin } = useWorkspace();
  const toast = useToast();
  const details = useResource(() => Promise.all(monitors.map((m) => endpoints.getMonitor(api, workspaceId, m.id).catch(() => null))), [api, workspaceId, monitors.map((m) => m.id).join(',')]);
  const scored = useMemo(() => score(monitors, weights), [monitors, weights]);
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const best = (key, id) => (scored.best[key] || []).includes(id);
  const detailOf = (id) => (details.data || []).find((x) => x && x.id === id) || null;

  async function check(m) {
    setBusy(`check:${m.id}`); setError(null);
    try {
      const r = await endpoints.checkMonitor(api, workspaceId, m.id);
      const st = r && r.monitor ? r.monitor.health : null;
      if (st === 'VERIFIED') toast.success(`${m.name}: read and verified`);
      else toast.error(`${m.name}: ${humanize(st || 'checked')}${r && r.monitor && r.monitor.healthReason ? ` — ${r.monitor.healthReason}` : ''}`);
      await reload(); await details.refresh();
    } catch (err) { setError(err.message); } finally { setBusy(null); }
  }
  async function remove(m) {
    if (typeof window !== 'undefined' && window.confirm && !window.confirm(`Remove "${m.name}"? Its observations and change history are deleted.`)) return;
    setBusy(`remove:${m.id}`); setError(null);
    try { await endpoints.deleteMonitor(api, workspaceId, m.id); toast.success(`Removed ${m.name}`); await reload(); } catch (err) { setError(err.message); setBusy(null); }
  }
  function exportCsv() {
    const csv = toCsv(monitors, scored);
    const blob = new Blob([`﻿${csv}`], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `nexus-comparison-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  const v = (m, f) => (m.current ? f(m.current) : null);
  const row = (label, render, key) => (
    <tr>
      <th scope="row">{label}</th>
      {monitors.map((m) => {
        const content = render(m);
        const isBest = key && best(key, m.id);
        return <td key={m.id} className={`${isBest ? 'cmp-best' : ''} ${!m.currentIsFresh ? 'cmp-stale' : ''}`}>{content === null || content === undefined || content === '' ? <Missing /> : content}{isBest ? <span className="cmp-best-tag">Best</span> : null}</td>;
      })}
    </tr>
  );

  return (
    <div className="stack">
      {scored.mixedCurrency ? <Notice tone="warning" title="Different currencies">These products are priced in {scored.currencies.join(', ')}. Nexus does not convert currencies, so price is shown but not compared or scored.</Notice> : null}
      {monitors.some((m) => !isComparable(m)) ? <Notice tone="info" title="Some values are not comparable yet">Only fresh, verified values receive “Best” marks and scores. Greyed values are stale or unverified — use “Read now” to refresh them.</Notice> : null}
      {error ? <Notice tone="danger">{error}</Notice> : null}

      <Card title="Side by side" actions={<Button size="sm" onClick={exportCsv}><Icon name="arrow" size={14} />Export CSV</Button>}>
        <div className="table-wrap" tabIndex={0} role="region" aria-label="Comparison table">
          <table className="table cmp-table">
            <thead>
              <tr>
                <th scope="col"><span className="sr-only">Field</span></th>
                {monitors.map((m) => (
                  <th scope="col" key={m.id}>
                    <div className="cmp-col-head">
                      <span className="cmp-col-name">{m.name}</span>
                      <Badge status={m.health === 'VERIFIED' ? 'verified' : m.health === 'UNVERIFIED' ? 'unverified' : m.health === 'UNAVAILABLE' ? 'failed' : 'none'}>{humanize(m.health)}</Badge>
                    </div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              <tr className="cmp-section"><th colSpan={monitors.length + 1}>Offer</th></tr>
              {row('Product', (m) => v(m, (c) => c.title))}
              {row('Price', (m) => v(m, (c) => money(c.price, c.currency)), 'price')}
              {row('List price', (m) => v(m, (c) => money(c.listPrice, c.currency)))}
              {row('Discount', (m) => v(m, (c) => (typeof c.discountPct === 'number' ? `${c.discountPct}%` : null)), 'discount')}
              {row('Availability', (m) => v(m, (c) => (c.availability && c.availability !== 'UNKNOWN' ? AVAIL_LABEL[c.availability] || humanize(c.availability) : null)), 'availability')}
              {row('Seller', (m) => v(m, (c) => c.seller))}
              <tr className="cmp-section"><th colSpan={monitors.length + 1}>Identity</th></tr>
              {row('Brand', (m) => v(m, (c) => c.identifiers && c.identifiers.brand))}
              {row('Model', (m) => v(m, (c) => c.identifiers && c.identifiers.model))}
              {row('MPN', (m) => v(m, (c) => c.identifiers && c.identifiers.mpn && <span className="mono">{c.identifiers.mpn}</span>))}
              {row('GTIN', (m) => v(m, (c) => c.identifiers && c.identifiers.gtin && <span className="mono">{c.identifiers.gtin}</span>))}
              <tr className="cmp-section"><th colSpan={monitors.length + 1}>Evidence</th></tr>
              {row('Source', (m) => { const href = safeHref(m.source && m.source.url); return href ? <a className="link" href={href} target="_blank" rel="noopener noreferrer nofollow">{sourceHost(m)}</a> : null; })}
              {row('Last read', (m) => (m.lastSuccessAt ? <span title={fmtDate(m.lastSuccessAt)}>{timeAgo(m.lastSuccessAt)}{m.currentIsFresh ? '' : ' · stale'}</span> : null))}
              {row('Read from', (m) => { if (!m.current) return null; const d = detailOf(m.id); const o = d && d.observations && d.observations.find((x) => x.method); return o ? METHOD_LABEL[o.method] || humanize(o.method) : (details.loading ? '…' : null); })}
              {row('Status detail', (m) => m.healthReason || (m.health === 'VERIFIED' ? 'Read successfully' : null))}
              {scored.criteria.length ? (
                <>
                  <tr className="cmp-section"><th colSpan={monitors.length + 1}>Score</th></tr>
                  <tr className="cmp-score-row">
                    <th scope="row">Weighted score</th>
                    {monitors.map((m) => {
                      const s = scored.scores[m.id];
                      return (
                        <td key={m.id}>
                          {s.unverified ? <Missing>Not scored — data not verified</Missing> : s.score === null ? <Missing>Not scored</Missing> : <><span className="cmp-score">{s.score}</span><span className="small muted"> / 100</span></>}
                          {s.missing.length ? <div className="small muted">Not scored on: {s.missing.map((k) => CRITERIA.find((c) => c.key === k).label.toLowerCase()).join(', ')}</div> : null}
                        </td>
                      );
                    })}
                  </tr>
                </>
              ) : null}
            </tbody>
          </table>
        </div>
        {isAdmin ? (
          <div className="cmp-actions">
            {monitors.map((m) => (
              <div key={m.id} className="row">
                <span className="small strong">{m.name}</span>
                <Button size="sm" busy={busy === `check:${m.id}`} disabled={!!busy} onClick={() => check(m)}>Read now</Button>
                <Button size="sm" variant="ghost" busy={busy === `remove:${m.id}`} disabled={!!busy} onClick={() => remove(m)}>Remove</Button>
              </div>
            ))}
          </div>
        ) : null}
      </Card>

      <div className="grid-2">
        <Card title="Scoring criteria">
          <p className="small muted">The score is a weighted average of the criteria you choose, scaled across the products shown. Only products with fresh, verified data are scored. It is arithmetic, not an AI judgement.</p>
          <Criteria weights={weights} setWeights={setWeights} />
        </Card>
        <Card title="Recent changes">
          {details.data ? <Changes monitors={monitors} details={details.data} /> : <p className="muted small">Loading change history…</p>}
        </Card>
      </div>
      <p className="small muted">Nexus compares only facts the product pages publish as structured data (schema.org, Shopify product JSON). Features, plans and certifications are not extracted. Pages are read through your workspace's Agent Firewall as read-only actions.</p>
    </div>
  );
}

const scalar = (x) => (x === null || x === undefined || typeof x === 'object' ? null : (AVAIL_LABEL[x] || String(x)));

function Changes({ monitors, details }) {
  const items = details.filter(Boolean).flatMap((d) => (d.changes || []).map((c) => ({ ...c, name: (monitors.find((m) => m.id === d.id) || {}).name })))
    .sort((a, b) => String(b.detectedAt || '').localeCompare(String(a.detectedAt || ''))).slice(0, 8);
  if (!items.length) return <p className="muted small">No changes detected yet. Price, stock and discount changes appear here after repeated reads.</p>;
  return (
    <ul className="list">
      {items.map((c, i) => (
        <li key={`${c.id}-${i}`} className="list-row">
          <span className="list-main">{c.name}: {humanize(c.changeType)}</span>
          <span className="small muted">{scalar(c.oldValue) !== null && scalar(c.newValue) !== null ? `${scalar(c.oldValue)} → ${scalar(c.newValue)}` : ''}</span>
          <span className="small muted">{timeAgo(c.detectedAt)}</span>
        </li>
      ))}
    </ul>
  );
}

function AddProduct({ integrations, onClose, onAdded }) {
  const api = useApi();
  const { workspaceId } = useWorkspace();
  const toast = useToast();
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const disabled = integrations === 'disabled';
  const webPages = Array.isArray(integrations) ? integrations.filter((i) => i.provider === 'web_page' && i.status === 'connected') : [];
  let host = null;
  try { const u = new URL(url.trim()); if (u.protocol === 'https:' || u.protocol === 'http:') host = u.hostname.toLowerCase(); } catch { /* not yet a URL */ }
  const covering = host ? webPages.find((i) => hostAllowed(i, host)) : null;
  const needsGrant = !!host && !covering;

  async function submit(e) {
    e.preventDefault();
    setError(null);
    if (!name.trim()) { setError('Give the product a name.'); return; }
    if (!host) { setError('Enter the full address of the product page (https://…).'); return; }
    if (needsGrant && !consent) { setError(`Confirm that Nexus may read public pages on ${host}.`); return; }
    setBusy(true);
    try {
      let integration = covering;
      if (!integration) {
        const existing = webPages[0];
        integration = existing
          ? await endpoints.updateIntegration(api, workspaceId, existing.id, { version: existing.version, config: { ...existing.config, allowedHosts: [...(existing.config.allowedHosts || []), host] } })
          : await endpoints.createIntegration(api, workspaceId, { provider: 'web_page', name: 'Web pages', config: { allowedHosts: [host] } });
      }
      const monitor = await endpoints.createMonitor(api, workspaceId, { name: name.trim(), kind: 'product', sourceType: 'web_page', integrationId: integration.id, source: { url: url.trim() } });
      let note = 'added';
      try {
        const r = await endpoints.checkMonitor(api, workspaceId, monitor.id);
        note = r && r.monitor ? humanize(r.monitor.health).toLowerCase() : 'added';
      } catch { note = 'added — first read failed, try “Read now”'; }
      toast.success(`${name.trim()}: ${note}`);
      await onAdded();
      onClose();
    } catch (err) { setError(err.message); setBusy(false); }
  }

  return (
    <Modal title="Add a product" onClose={onClose}>
      {disabled ? (
        <Notice tone="warning" title="Integrations are not enabled on this server">Reading product pages uses the “Web pages” integration. An administrator must set INTEGRATIONS_ENABLED=true on the Nexus API.</Notice>
      ) : (
        <form onSubmit={submit} noValidate>
          <label className="field"><span>Name</span><input value={name} maxLength={200} onChange={(e) => setName(e.target.value)} placeholder="e.g. Vendor A — Pro plan" /></label>
          <label className="field"><span>Product page address</span><input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://shop.example.com/products/…" inputMode="url" autoComplete="off" spellCheck="false" /></label>
          <p className="small muted">Nexus reads the structured product data the page publishes (price, availability, seller, identifiers). Pages without structured data are reported as unavailable — nothing is guessed.</p>
          {needsGrant ? (
            <label className="cmp-consent">
              <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
              <span>Allow Nexus to read public pages on <strong>{host}</strong> (read-only, checked by the Agent Firewall, recorded in the audit log).</span>
            </label>
          ) : null}
          {covering ? <p className="small"><Dot tone="success" /> {host} is already allowed by “{covering.name}”.</p> : null}
          {error ? <Notice tone="danger">{error}</Notice> : null}
          <div className="modal-foot inline">
            <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
            <Button variant="primary" type="submit" busy={busy}>Add and read</Button>
          </div>
        </form>
      )}
      <p className="small muted" style={{ marginTop: 12 }}>Manage allowed hosts under <Link to="/integrations" className="link">Integrations</Link>.</p>
    </Modal>
  );
}
