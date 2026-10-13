/**
 * Layer 8 — API documentation (served at /developers).
 *
 * Rendered from the server's own description (GET /api/automation/v1/openapi.json),
 * so the page always matches what the API actually does. Examples use
 * placeholders only; keys are created in Security → API keys and shown once.
 */
import React, { useEffect, useState } from "react";
import { getApiSpec, BASE_URL } from "../customer/customerApi";
import { styles as S } from "../customer/useWorkspace";
import WebhooksPanel from "../revenue/WebhooksPanel";
import { auth } from "../firebase";

const code = { background: "var(--mcis-input, #f5f5f7)", border: "1px solid var(--mcis-border, #e5e5e5)", borderRadius: 8, padding: 10, fontSize: 12, overflowX: "auto", whiteSpace: "pre" };

function CopyBlock({ label, text }) {
  const [copied, setCopied] = useState(false);
  return (
    <div style={{ display: "grid", gap: 4 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={S.muted}>{label}</span>
        <button type="button" style={S.btn} onClick={() => { try { navigator.clipboard.writeText(text); setCopied(true); } catch { setCopied(false); } }}>{copied ? "Copied" : "Copy"}</button>
      </div>
      <pre style={code} data-testid={`example-${label}`}>{text}</pre>
    </div>
  );
}

export function examples(base) {
  const b = `${base.replace(/\/+$/, "")}/api/automation/v1`;
  return {
    "Start a workflow run": `curl -X POST "${b}/workflows/<workflow-id>/runs" \\\n  -H "Authorization: Bearer $NEXUS_API_KEY" \\\n  -H "Idempotency-Key: order-2026-0001" \\\n  -H "Content-Type: application/json" \\\n  -d '{"inputs": {"company": "Example Ltd"}}'`,
    "Submit an execution": `curl -X POST "${b}/executions" \\\n  -H "Authorization: Bearer $NEXUS_API_KEY" \\\n  -H "Idempotency-Key: research-2026-0001" \\\n  -H "Content-Type: application/json" \\\n  -d '{"goal": "Summarise the pricing page of example.com"}'`,
    "Check status": `curl "${b}/executions/<execution-id>" \\\n  -H "Authorization: Bearer $NEXUS_API_KEY"`,
  };
}

export default function DevelopersPage() {
  const [spec, setSpec] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => { getApiSpec().then(setSpec).catch((e) => setError(e.message)); }, []);
  const x = spec && spec["x-nexus"];
  const base = (spec && spec.servers && spec.servers[0] && spec.servers[0].url.replace(/\/api\/automation\/v1$/, "")) || BASE_URL;

  return (
    <div style={{ ...S.page, maxWidth: 900 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <h2 style={{ margin: 0 }}>Nexus Automation API</h2>
        <span style={{ flex: 1 }} />
        <a href="/workspace" style={S.muted}>Workspace</a>
      </div>
      {error && <div role="alert" style={S.danger}>{error}</div>}
      {!spec && !error && <div>Loading…</div>}
      {spec && (
        <>
          <section style={S.card} aria-label="Overview">
            <p style={{ margin: 0 }}>{spec.info.description}</p>
          </section>

          <section style={S.card} aria-label="Authentication">
            <strong>Authentication</strong>
            <pre style={code}>{x.authentication.header}</pre>
            <ul style={{ margin: 0, paddingLeft: 18 }}>{x.authentication.notes.map((n) => <li key={n}>{n}</li>)}</ul>
            <a href="/security">Create an API key (workspace owners) →</a>
            <strong>Scopes</strong>
            <ul style={{ margin: 0, paddingLeft: 18 }}>{Object.entries(x.scopes).map(([k, v]) => <li key={k}><code>{k}</code> — {v}</li>)}</ul>
          </section>

          <section style={S.card} aria-label="Endpoints">
            <strong>Endpoints</strong>
            {Object.entries(spec.paths).flatMap(([p, ops]) => Object.entries(ops).map(([m, op]) => (
              <div key={`${m} ${p}`} data-testid={`endpoint-${m.toUpperCase()} ${p}`} style={{ borderTop: "1px solid var(--mcis-border, #eee)", paddingTop: 8, display: "grid", gap: 4 }}>
                <div><code style={{ fontWeight: 600 }}>{m.toUpperCase()} /api/automation/v1{p}</code> <span style={S.muted}>scope {op["x-scope"]}</span></div>
                <span>{op.summary}</span>
                {op.requestBody && (
                  <span style={S.muted}>Request body: {Object.entries((spec.components.schemas[op.requestBody.content["application/json"].schema.$ref.split("/").pop()] || {}).properties || {}).map(([k, v]) => `${k} (${v.type})`).join(", ")}</span>
                )}
                <span style={S.muted}>Responses: {Object.keys(op.responses).join(", ")}</span>
              </div>
            )))}
          </section>

          <section style={S.card} aria-label="Idempotency">
            <strong>Idempotency</strong>
            <ul style={{ margin: 0, paddingLeft: 18 }}>{x.idempotency.map((n) => <li key={n}>{n}</li>)}</ul>
          </section>

          <section style={S.card} aria-label="Quotas and rate limits">
            <strong>Quotas and rate limits</strong>
            <ul style={{ margin: 0, paddingLeft: 18 }}>{[...x.quotas, ...x.rateLimits].map((n) => <li key={n}>{n}</li>)}</ul>
            <span style={S.muted}>{x.approvals}</span>
          </section>

          <section style={S.card} aria-label="Errors">
            <strong>Error codes</strong>
            <table style={{ width: "100%", fontSize: 13, borderCollapse: "collapse" }}>
              <thead><tr><th align="left">HTTP</th><th align="left">code</th><th align="left">Meaning</th></tr></thead>
              <tbody>{x.errors.map((e) => <tr key={e.code}><td>{e.status}</td><td><code>{e.code}</code></td><td>{e.meaning}</td></tr>)}</tbody>
            </table>
            <span style={S.muted}>Every error body is {"{ success: false, error, code }"}.</span>
          </section>

          <section style={S.card} aria-label="Examples">
            <strong>Examples</strong>
            <span style={S.muted}>Keep your key in an environment variable (<code>NEXUS_API_KEY</code>); never put it in a URL or in client-side code.</span>
            {Object.entries(examples(base)).map(([label, text]) => <CopyBlock key={label} label={label} text={text} />)}
            <a href={`${BASE_URL}/api/automation/v1/openapi.json`} style={S.muted}>OpenAPI description (JSON)</a>
          </section>
          {x.webhooks && (
            <section style={S.card} aria-label="Webhook signatures">
              <strong>Webhooks</strong>
              <ul style={{ margin: 0, paddingLeft: 18 }}>{x.webhooks.map((n) => <li key={n}>{n}</li>)}</ul>
            </section>
          )}
          {auth && auth.currentUser ? <WebhooksPanel /> : <span style={S.muted}>Sign in as a workspace admin to manage webhooks.</span>}
        </>
      )}
    </div>
  );
}
