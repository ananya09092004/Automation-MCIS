/**
 * Layer 10 — Competitor intelligence (served at /competitors).
 *
 * Products with own price, verified/unverified competitor listings, their
 * last observed price and stock with source health (a STALE or UNAVAILABLE
 * source is labelled as such and excluded from the margin impact), margin
 * impact, and recommendations. Nothing on this page changes a price:
 * recommendations become tasks or governed workflow runs.
 */
import React, { useState } from "react";
import useWorkspace, { styles as S } from "../customer/useWorkspace";
import * as R from "./revenueApi";
import { HealthBadge, Shell, Empty, useLoad } from "./common";

function Pct({ v }) { return v === null || v === undefined ? "—" : `${v}%`; }

function MarginLine({ label, m, currency }) {
  if (!m) return <div style={S.muted}>{label}: —</div>;
  if (!m.complete) return <div style={S.muted} data-testid="margin-incomplete">{label}: needs {m.missing.join(", ")}</div>;
  return <div>{label}: <strong>{m.marginPct}%</strong> <span style={S.muted}>({R.fmtMoney(m.profit, currency)} profit at {R.fmtMoney(m.price, currency)})</span></div>;
}

function ProductCard({ p, isAdmin, onChanged, wsId, integrations }) {
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ competitorName: "", marketplace: "website", sourceUrl: "", integrationId: "" });
  const [err, setErr] = useState(null);
  const mi = p.marginImpact;
  const cur = p.product.currency;
  async function add(e) {
    e.preventDefault(); setErr(null);
    try {
      await R.addCompetitor(wsId, p.product.id, {
        competitorName: form.competitorName, marketplace: form.marketplace, ...(form.sourceUrl ? { sourceUrl: form.sourceUrl } : {}),
        ...(form.integrationId ? { monitor: { integrationId: form.integrationId, sourceType: "web_page" } } : { monitor: { sourceType: "api_submission" } }),
      });
      setAdding(false); onChanged();
    } catch (x) { setErr(x.message); }
  }
  async function decide(c, decision) {
    try { await R.decideMatch(wsId, p.product.id, c.id, decision, c.version); onChanged(); } catch (x) { setErr(x.message); }
  }
  return (
    <section style={S.card} aria-label={`Product ${p.product.name}`} data-testid={`product-${p.product.id}`}>
      <div style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
        <strong>{p.product.name}</strong>
        {p.product.sku && <span style={S.muted}>SKU {p.product.sku}</span>}
        <span style={{ flex: 1 }} />
        <span>Your price: <strong>{p.ownPrice ? R.fmtMoney(p.ownPrice.value, cur) : "not set"}</strong>{p.ownPrice && <span style={S.muted}> ({p.ownPrice.source})</span>}</span>
      </div>
      <table style={{ width: "100%", fontSize: 13, borderCollapse: "collapse" }}>
        <thead><tr><th align="left">Competitor</th><th align="left">Match</th><th align="left">Price</th><th align="left">Stock</th><th align="left">Source</th><th /></tr></thead>
        <tbody>
          {p.competitors.length === 0 && <tr><td colSpan={6}><Empty>No competitors yet.</Empty></td></tr>}
          {p.competitors.map((c) => {
            const m = c.monitor;
            const v = m && m.current;
            const gone = v && v.present === false;
            return (
              <tr key={c.id} data-testid={`competitor-${c.id}`} style={{ borderTop: "1px solid var(--mcis-border, #eee)" }}>
                <td>{c.competitorName}<div style={S.muted}>{c.marketplace}{c.title ? ` · ${c.title}` : ""}</div></td>
                <td><span title={`method ${c.match.method || "—"}, confidence ${c.match.confidence}`}>{c.match.status}</span></td>
                <td style={m && !m.currentIsFresh ? { opacity: 0.5 } : {}}>{gone ? "Listing removed" : v ? R.fmtMoney(v.price, v.currency || cur) : "—"}{v && v.discountPct ? <span style={S.muted}> (−{v.discountPct}%)</span> : null}</td>
                <td>{gone ? "—" : v ? (v.availability || "UNKNOWN").replace("_", " ").toLowerCase() : "—"}</td>
                <td>{m ? <HealthBadge health={m.health} fresh={m.currentIsFresh} /> : <span style={S.muted}>no monitor</span>}</td>
                <td>{isAdmin && c.match.status !== "VERIFIED" && <button type="button" style={S.btn} onClick={() => decide(c, "confirm")}>Confirm match</button>}
                  {isAdmin && c.match.status !== "REJECTED" && <button type="button" style={S.btn} onClick={() => decide(c, "reject")}>Reject</button>}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div data-testid="margin-impact" style={{ display: "grid", gap: 2, fontSize: 13 }}>
        <div>Lowest current verified competitor: <strong>{mi.lowestCompetitor ? `${mi.lowestCompetitor.name} ${R.fmtMoney(mi.lowestCompetitor.price, cur)}` : "none"}</strong>
          {mi.priceGap !== null && <span> · gap {R.fmtMoney(mi.priceGap, cur)} (<Pct v={mi.priceGapPct} />)</span>}</div>
        <MarginLine label="Margin at your price" m={mi.marginAtOwnPrice} currency={cur} />
        <MarginLine label="Margin if you match" m={mi.marginIfMatchLowest} currency={cur} />
        {mi.matchWouldBreachMinimum && <div role="alert" style={S.danger}>Matching the lowest price would breach your {mi.minMarginPct}% minimum margin (floor price {R.fmtMoney(mi.floorPrice, cur)}).</div>}
        {mi.excludedCompetitors > 0 && <div style={S.muted}>{mi.excludedCompetitors} competitor price(s) excluded: stale, unavailable, unverified or another currency.</div>}
      </div>
      {err && <div role="alert" style={S.danger}>{err}</div>}
      {isAdmin && !adding && <button type="button" style={S.btn} onClick={() => setAdding(true)}>Add competitor</button>}
      {isAdmin && adding && (
        <form onSubmit={add} style={{ display: "flex", gap: 6, flexWrap: "wrap" }} aria-label="Add competitor">
          <input style={S.input} placeholder="Competitor name" aria-label="Competitor name" value={form.competitorName} onChange={(e) => setForm({ ...form, competitorName: e.target.value })} required />
          <select style={S.input} aria-label="Marketplace" value={form.marketplace} onChange={(e) => setForm({ ...form, marketplace: e.target.value })}>
            {["website", "shopify", "amazon", "flipkart", "other"].map((m) => <option key={m}>{m}</option>)}
          </select>
          <input style={S.input} placeholder="Product page URL" aria-label="Product page URL" value={form.sourceUrl} onChange={(e) => setForm({ ...form, sourceUrl: e.target.value })} />
          <select style={S.input} aria-label="Read with integration" value={form.integrationId} onChange={(e) => setForm({ ...form, integrationId: e.target.value })}>
            <option value="">Values sent by API</option>
            {integrations.filter((i) => i.provider === "web_page").map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
          </select>
          <button type="submit" style={S.primary}>Add</button>
        </form>
      )}
    </section>
  );
}

export default function CompetitorPage() {
  const ws = useWorkspace();
  const w = ws.workspaceId;
  const dash = useLoad(() => (w ? R.ciDashboard(w) : Promise.resolve(null)), [w]);
  const recs = useLoad(() => (w ? R.listRecommendations(w) : Promise.resolve([])), [w]);
  const ints = useLoad(() => (w && ws.isAdmin ? R.listIntegrations(w).catch(() => []) : Promise.resolve([])), [w, ws.isAdmin]);
  const [form, setForm] = useState({ name: "", sku: "", gtin: "", cost: "", sellingPrice: "", feesFixed: "", feesPct: "", minMarginPct: "" });
  const [msg, setMsg] = useState(null);
  const reload = () => { dash.reload(); recs.reload(); };
  const num = (v) => (v === "" ? undefined : Number(v));
  async function addProduct(e) {
    e.preventDefault(); setMsg(null);
    try {
      await R.createProduct(w, { name: form.name, ...(form.sku ? { sku: form.sku } : {}), ...(form.gtin ? { gtin: form.gtin } : {}),
        cost: num(form.cost), sellingPrice: num(form.sellingPrice), feesFixed: num(form.feesFixed), feesPct: num(form.feesPct), minMarginPct: num(form.minMarginPct) });
      setForm({ name: "", sku: "", gtin: "", cost: "", sellingPrice: "", feesFixed: "", feesPct: "", minMarginPct: "" });
      reload();
    } catch (x) { setMsg(x.code === "QUOTA_EXCEEDED" ? "Your plan's limit for monitored products has been reached." : x.message); }
  }
  async function recAction(r, kind) {
    try {
      if (kind === "task") await R.recommendationToTask(w, r.id);
      else await R.setRecommendationStatus(w, r.id, kind);
      recs.reload();
    } catch (x) { setMsg(x.message); }
  }
  const d = dash.data;
  return (
    <Shell title="Competitor intelligence" ws={ws}>
      {dash.loading && !d && <div>Loading…</div>}
      {dash.error && <div role="alert" style={S.danger}>{dash.error}</div>}
      {msg && <div role="alert" style={S.danger}>{msg}</div>}
      {d && (
        <>
          <section style={{ ...S.card, gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))" }} aria-label="Summary">
            {[["Products", d.totals.products], ["Competitors", d.totals.competitors], ["Verified matches", d.totals.verifiedMatches], ["Need review", d.totals.unverifiedMatches],
              ["Stale / unavailable sources", d.totals.sources.stale + d.totals.sources.unavailable], ["Undercut products", d.totals.undercutBy], ["Open recommendations", d.totals.openRecommendations]].map(([k, v]) => (
              <div key={k} data-testid={`total-${k}`}><div style={S.muted}>{k}</div><strong style={{ fontSize: 20 }}>{v}</strong></div>
            ))}
          </section>
          {d.products.length === 0 && <Empty>No products yet. {ws.isAdmin ? "Add your first product below." : "Ask a workspace admin to add products."}</Empty>}
          {d.products.map((p) => <ProductCard key={p.product.id} p={p} isAdmin={ws.isAdmin} wsId={w} integrations={ints.data || []} onChanged={reload} />)}
          <section style={S.card} aria-label="Recommendations">
            <strong>Recommendations</strong>
            <span style={S.muted}>Advice only — Nexus never changes a price by itself. Turn one into a task, or run an approved workflow.</span>
            {recs.data && recs.data.length === 0 && <Empty>No open recommendations.</Empty>}
            {(recs.data || []).map((r) => (
              <div key={r.id} data-testid={`rec-${r.id}`} style={{ borderTop: "1px solid var(--mcis-border, #eee)", paddingTop: 6, display: "grid", gap: 4 }}>
                <div><strong>{r.type.replace(/_/g, " ")}</strong> <span style={S.muted}>{r.priority} priority · {R.fmtTime(r.createdAt)}</span></div>
                {r.rationale.note && <div>{r.rationale.note}</div>}
                {r.rationale.change && <div style={S.muted}>{r.rationale.competitor.name}: {r.rationale.change.type.replace(/_/g, " ")} {String(r.rationale.change.oldValue ?? "")} → {String(r.rationale.change.newValue ?? "")}</div>}
                <div style={{ display: "flex", gap: 6 }}>
                  <button type="button" style={S.btn} onClick={() => recAction(r, "task")}>Create task</button>
                  <button type="button" style={S.btn} onClick={() => recAction(r, "acknowledged")}>Acknowledge</button>
                  <button type="button" style={S.btn} onClick={() => recAction(r, "dismissed")}>Dismiss</button>
                </div>
              </div>
            ))}
          </section>
          {ws.isAdmin && (
            <form onSubmit={addProduct} style={S.card} aria-label="Add product">
              <strong>Add product</strong>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {[["name", "Name"], ["sku", "SKU"], ["gtin", "GTIN / EAN / UPC"], ["sellingPrice", "Your price"], ["cost", "Cost"], ["feesFixed", "Fixed fees"], ["feesPct", "Fees %"], ["minMarginPct", "Minimum margin %"]].map(([k, l]) => (
                  <input key={k} style={S.input} aria-label={l} placeholder={l} value={form[k]} onChange={(e) => setForm({ ...form, [k]: e.target.value })} required={k === "name"} />
                ))}
                <button type="submit" style={S.primary}>Add product</button>
              </div>
              <span style={S.muted}>Margins are only calculated when cost and fees are set (enter 0 if you have no fees).</span>
            </form>
          )}
        </>
      )}
    </Shell>
  );
}
