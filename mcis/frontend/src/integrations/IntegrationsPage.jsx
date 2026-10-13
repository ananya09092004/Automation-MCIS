/**
 * Layer 5 — minimal Integrations page (served at /integrations).
 *
 *   workspace switcher · connected integrations (status, health, last use,
 *   permissions summary) · available providers · connect / rotate /
 *   disconnect / health check · per-action enable + approval (admins).
 *
 * Secrets: the token field is an UNCONTROLLED password input read through
 * a ref only at submit time and cleared immediately after; it is never put
 * into React state, localStorage or logs. The server never returns it.
 * Authorization is enforced by the backend; admin controls are hidden
 * for members only as a convenience.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { onAuthStateChanged } from "firebase/auth";
import { auth } from "../firebase";
import * as wfApi from "../workflows/workflowsApi";
import * as intApi from "./integrationsApi";

const card = { background: "var(--mcis-surface, #fff)", border: "1px solid var(--mcis-border, #ddd)", borderRadius: 12, padding: 16 };
const btn = { padding: "6px 12px", borderRadius: 8, border: "1px solid var(--mcis-border, #ccc)", background: "var(--mcis-input, #f7f7f7)", color: "inherit", cursor: "pointer", fontSize: 13 };
const primaryBtn = { ...btn, background: "var(--mcis-primary-solid, #5b4bff)", color: "#fff", border: "none" };
const input = { width: "100%", padding: "7px 9px", borderRadius: 8, border: "1px solid var(--mcis-border, #ccc)", background: "var(--mcis-input, #fff)", color: "inherit", boxSizing: "border-box", fontSize: 13 };
const muted = { color: "var(--mcis-muted, #777)", fontSize: 12 };
const STATUS_COLORS = { connected: "#1a9b5c", disconnected: "#8a8a8a", revoked: "#c43d3d", error: "#c98a00" };
const TIER_COLORS = { green: "#1a9b5c", yellow: "#c98a00", red: "#c43d3d" };

function Pill({ text, color }) {
  return <span data-testid="pill" style={{ fontSize: 11, padding: "2px 8px", borderRadius: 999, color: "#fff", background: color || "#666" }}>{text}</span>;
}

function ConnectForm({ workspaceId, providers, onDone, onCancel }) {
  const [provider, setProvider] = useState(providers[0] ? providers[0].provider : "");
  const [name, setName] = useState("");
  const [repos, setRepos] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [authType, setAuthType] = useState("bearer");
  const [authHeaderName, setAuthHeaderName] = useState("");
  const [allowPost, setAllowPost] = useState(false);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const tokenRef = useRef(null); // uncontrolled: the secret never enters React state

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const token = tokenRef.current ? tokenRef.current.value : "";
    if (tokenRef.current) tokenRef.current.value = "";
    try {
      let config;
      let credentials = null;
      if (provider === "github") {
        config = { allowedRepos: repos.split(",").map((r) => r.trim()).filter(Boolean) };
        credentials = { token };
      } else {
        config = { baseUrl, authType, ...(authType === "header" ? { authHeaderName } : {}), ...(allowPost ? { allowPost: true } : {}) };
        credentials = authType === "none" ? null : { token };
      }
      await intApi.connectIntegration(workspaceId, { provider, name, config, credentials });
      onDone();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} style={{ ...card, display: "grid", gap: 8 }} aria-label="Connect integration" autoComplete="off">
      <strong>Connect an integration</strong>
      <select style={input} value={provider} onChange={(e) => setProvider(e.target.value)} aria-label="Provider">
        {providers.map((p) => <option key={p.provider} value={p.provider}>{p.displayName}</option>)}
      </select>
      <input style={input} placeholder="Display name, e.g. Finance repo" value={name} onChange={(e) => setName(e.target.value)} aria-label="Integration name" />
      {provider === "github" ? (
        <input style={input} placeholder="Allowed repositories, e.g. acme/books, acme/*" value={repos} onChange={(e) => setRepos(e.target.value)} aria-label="Allowed repositories" />
      ) : (
        <>
          <input style={input} placeholder="https://api.example.com/v1/" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} aria-label="Base URL" />
          <select style={input} value={authType} onChange={(e) => setAuthType(e.target.value)} aria-label="Authentication">
            <option value="bearer">Bearer token</option>
            <option value="header">API key header</option>
            <option value="none">No authentication</option>
          </select>
          {authType === "header" && <input style={input} placeholder="Header name, e.g. X-API-Key" value={authHeaderName} onChange={(e) => setAuthHeaderName(e.target.value)} aria-label="Header name" />}
          <label style={muted}><input type="checkbox" checked={allowPost} onChange={(e) => setAllowPost(e.target.checked)} /> Allow controlled POST (disabled per action until enabled)</label>
        </>
      )}
      {(provider === "github" || authType !== "none") && (
        <input ref={tokenRef} type="password" style={input} placeholder="Token (stored encrypted, never shown again)" aria-label="Token" autoComplete="new-password" />
      )}
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
        <button type="button" style={btn} onClick={onCancel}>Cancel</button>
        <button type="submit" style={primaryBtn} disabled={busy}>Connect</button>
      </div>
      {error && <div role="alert" style={{ color: "var(--mcis-danger, #c43d3d)" }}>{error}</div>}
    </form>
  );
}

function IntegrationCard({ workspaceId, integration: i, isAdmin, onChanged }) {
  const [error, setError] = useState(null);
  const [health, setHealth] = useState(null);
  const rotateRef = useRef(null);

  async function act(fn) {
    setError(null);
    try {
      const out = await fn();
      onChanged();
      return out;
    } catch (err) {
      setError(err.message);
      return null;
    }
  }

  return (
    <div style={{ ...card, display: "grid", gap: 8 }} data-testid="integration-card">
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <strong>{i.name}</strong> <span style={muted}>{i.providerName}</span>
        <Pill text={i.status} color={STATUS_COLORS[i.status]} />
        <span style={{ flex: 1 }} />
        <span style={muted}>{i.hasCredential ? "credential stored (encrypted)" : "no credential"}</span>
      </div>
      <div style={muted}>
        last used: {i.lastUsedAt ? new Date(i.lastUsedAt).toLocaleString() : "never"} · last check: {i.lastCheckedAt ? new Date(i.lastCheckedAt).toLocaleString() : "never"}
        {i.lastError ? ` · ${i.lastError}` : ""}
      </div>
      <table style={{ fontSize: 12, borderCollapse: "collapse", width: "100%" }}>
        <thead><tr style={{ textAlign: "left" }}><th>Action</th><th>Risk</th><th>Enabled</th><th>Approval</th></tr></thead>
        <tbody>
          {i.actions.filter((a) => a.available).map((a) => (
            <tr key={a.name}>
              <td>{intApi.actionLabel(i, a)}</td>
              <td><Pill text={a.effectiveTier} color={TIER_COLORS[a.effectiveTier]} /></td>
              <td>
                {isAdmin
                  ? <input type="checkbox" aria-label={`enable ${a.name}`} checked={a.enabled} onChange={(e) => act(() => intApi.updatePermissions(workspaceId, i.id, { [a.name]: { enabled: e.target.checked } }))} />
                  : (a.enabled ? "yes" : "no")}
              </td>
              <td>
                {isAdmin ? (
                  <select aria-label={`approval ${a.name}`} value={a.approval} onChange={(e) => act(() => intApi.updatePermissions(workspaceId, i.id, { [a.name]: { approval: e.target.value } }))}>
                    <option value="default">By risk</option>
                    <option value="required">Always ask</option>
                    <option value="admin">Admin only</option>
                  </select>
                ) : (a.requiresAdminApproval ? "admin" : a.requiresApproval ? "required" : "none")}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {isAdmin && (
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
          {i.status !== "disconnected" && <button style={btn} onClick={async () => { const h = await act(() => intApi.checkHealth(workspaceId, i.id)); if (h) setHealth(h); }}>Check health</button>}
          {i.status !== "disconnected" && <button style={btn} onClick={() => act(() => intApi.disconnectIntegration(workspaceId, i.id))}>Disconnect</button>}
          {i.status === "disconnected" && !i.hasCredential && i.config && i.config.authType === "none" && (
            <button style={btn} onClick={() => act(() => intApi.reconnectIntegration(workspaceId, i.id))}>Reconnect</button>
          )}
          {!(i.config && i.config.authType === "none") && (
            <form style={{ display: "flex", gap: 6 }} autoComplete="off" onSubmit={(e) => {
              e.preventDefault();
              const token = rotateRef.current ? rotateRef.current.value : "";
              if (rotateRef.current) rotateRef.current.value = "";
              act(() => intApi.rotateCredential(workspaceId, i.id, { token }));
            }}>
              <input ref={rotateRef} type="password" style={{ ...input, width: 220 }} placeholder="New token" aria-label={`new token for ${i.name}`} autoComplete="new-password" />
              <button type="submit" style={btn}>{i.hasCredential ? "Replace token" : "Connect"}</button>
            </form>
          )}
        </div>
      )}
      {health && <div role="status" style={muted}>Health: {health.ok ? "OK" : "failed"} ({health.detail})</div>}
      {error && <div role="alert" style={{ color: "var(--mcis-danger, #c43d3d)" }}>{error}</div>}
    </div>
  );
}

export default function IntegrationsPage() {
  const [user, setUser] = useState(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [workspaces, setWorkspaces] = useState([]);
  const [workspaceId, setWorkspaceId] = useState(null);
  const [providers, setProviders] = useState([]);
  const [integrations, setIntegrations] = useState([]);
  const [connecting, setConnecting] = useState(false);
  const [notice, setNotice] = useState(null);

  useEffect(() => onAuthStateChanged(auth, (u) => { setUser(u); setAuthLoading(false); }), []);
  useEffect(() => {
    if (!user) return;
    let alive = true;
    wfApi.listWorkspaces().then((list) => {
      if (!alive) return;
      setWorkspaces(list);
      const chosen = wfApi.pickWorkspace(list, wfApi.getStoredWorkspaceId(user.uid));
      setWorkspaceId(chosen ? chosen.id : null);
    }).catch((err) => setNotice(err.message));
    return () => { alive = false; };
  }, [user]);

  const personal = useMemo(() => workspaces.find((w) => w.is_personal) || workspaces[0], [workspaces]);
  const current = workspaces.find((w) => w.id === workspaceId);
  const isAdmin = !!current && (current.role === "admin" || current.role === "owner");

  const load = useCallback(async () => {
    if (!workspaceId) return;
    try {
      const [p, list] = await Promise.all([intApi.listProviders(workspaceId), intApi.listIntegrations(workspaceId)]);
      setProviders(p);
      setIntegrations(list);
    } catch (err) {
      if (err.status === 404 && personal && workspaceId !== personal.id) {
        setNotice("You no longer have access to that workspace.");
        wfApi.storeWorkspaceId(user.uid, null);
        setWorkspaceId(personal.id);
      } else if (err.status === 404) {
        setNotice("Integrations are not enabled on this server.");
      } else {
        setNotice(err.message);
      }
    }
  }, [workspaceId, personal, user]);

  useEffect(() => { setConnecting(false); setIntegrations([]); load(); }, [load]);

  if (authLoading) return <div className="mcis-loading-screen"><span className="mcis-loading-text">Loading...</span></div>;
  if (!user) return <div style={{ padding: 32 }}><p>Please <a href="/">sign in</a> to manage integrations.</p></div>;

  return (
    <div style={{ minHeight: "100vh", background: "var(--mcis-bg, #fafafa)", color: "var(--mcis-text, #111)", padding: 16, boxSizing: "border-box" }}>
      <header style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", marginBottom: 16 }}>
        <a href="/" style={{ ...btn, textDecoration: "none" }}>← Back</a>
        <a href="/workflows" style={{ ...btn, textDecoration: "none" }}>Workflows</a>
        <h1 style={{ margin: 0, fontSize: 20 }}>Integrations</h1>
        <span style={{ flex: 1 }} />
        <label style={muted} htmlFor="ws-switcher">Workspace</label>
        <select id="ws-switcher" aria-label="Workspace" style={{ ...input, width: "auto" }} value={workspaceId || ""}
          onChange={(e) => { setNotice(null); wfApi.storeWorkspaceId(user.uid, e.target.value); setWorkspaceId(e.target.value); }}>
          {workspaces.map((w) => <option key={w.id} value={w.id}>{w.is_personal ? "Personal" : w.name} ({w.role})</option>)}
        </select>
      </header>
      {notice && <div role="status" style={{ ...card, marginBottom: 12 }}>{notice}</div>}
      <div style={{ display: "grid", gap: 12, maxWidth: 900 }}>
        <div style={{ display: "flex", alignItems: "center" }}>
          <strong style={{ flex: 1 }}>Connected ({integrations.length})</strong>
          {isAdmin && providers.length > 0 && !connecting && <button style={primaryBtn} onClick={() => setConnecting(true)}>Connect integration</button>}
        </div>
        {connecting && <ConnectForm workspaceId={workspaceId} providers={providers} onCancel={() => setConnecting(false)} onDone={() => { setConnecting(false); load(); }} />}
        {integrations.length === 0 && <div style={muted}>No integrations in this workspace yet.</div>}
        {integrations.map((i) => <IntegrationCard key={i.id} workspaceId={workspaceId} integration={i} isAdmin={isAdmin} onChanged={load} />)}
        <div style={{ ...card }}>
          <strong>Available</strong>
          <ul style={{ margin: "8px 0 0", paddingLeft: 18 }}>
            {providers.map((p) => (
              <li key={p.provider}>
                {p.displayName} — {p.description} <span style={muted}>({p.actions.map((a) => `${a.label} [${a.risk}]`).join(", ")})</span>
              </li>
            ))}
          </ul>
          {!isAdmin && <div style={muted}>Only workspace admins can connect or change integrations.</div>}
        </div>
      </div>
    </div>
  );
}
