/**
 * Layer 6 — workspace Security page (served at /security). Admin / owner only.
 *
 *   firewall + policy status · approval policy · integrations & connector
 *   permissions · OAuth connections · API keys · recent security events ·
 *   blocked actions · policy editor (owner)
 *
 * Secrets: nothing secret is ever fetched. A new API key's plaintext is
 * shown ONCE from the create/rotate response, kept only in component state
 * until dismissed, and never written to storage or logs. Authorization is
 * enforced by the backend; members see an explanation, not the data.
 */
import React, { useCallback, useEffect, useState } from "react";
import { onAuthStateChanged } from "firebase/auth";
import { auth } from "../firebase";
import * as wfApi from "../workflows/workflowsApi";
import * as secApi from "./securityApi";

const card = { background: "var(--mcis-surface, #fff)", border: "1px solid var(--mcis-border, #ddd)", borderRadius: 12, padding: 16, display: "grid", gap: 8 };
const btn = { padding: "6px 12px", borderRadius: 8, border: "1px solid var(--mcis-border, #ccc)", background: "var(--mcis-input, #f7f7f7)", color: "inherit", cursor: "pointer", fontSize: 13 };
const input = { padding: "7px 9px", borderRadius: 8, border: "1px solid var(--mcis-border, #ccc)", background: "var(--mcis-input, #fff)", color: "inherit", fontSize: 13 };
const muted = { color: "var(--mcis-muted, #777)", fontSize: 12 };
const table = { fontSize: 12, borderCollapse: "collapse", width: "100%" };
const TIER_COLORS = { green: "#1a9b5c", yellow: "#c98a00", red: "#c43d3d" };
const OAUTH_WS_KEY = "nexus.oauth.workspace"; // workspace id only (not secret)

function Pill({ text, color }) {
  return <span style={{ fontSize: 11, padding: "2px 8px", borderRadius: 999, color: "#fff", background: color || "#666" }}>{text}</span>;
}

function ApiKeys({ workspaceId, keys, isOwner, onChanged }) {
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState({ "workflows:run": true, "runs:read": false, "executions:run": false });
  const [days, setDays] = useState("");
  const [shown, setShown] = useState(null); // plaintext key, once
  const [error, setError] = useState(null);

  async function act(fn) {
    setError(null);
    try { const out = await fn(); onChanged(); return out; } catch (err) { setError(err.message); return null; }
  }
  async function create(e) {
    e.preventDefault();
    const body = { name, scopes: Object.keys(scopes).filter((s) => scopes[s]), ...(days ? { expiresInDays: parseInt(days, 10) } : {}) };
    const out = await act(() => secApi.createApiKey(workspaceId, body));
    if (out) { setShown(out.key); setName(""); setDays(""); }
  }
  return (
    <section style={card} aria-label="API keys">
      <strong>API keys</strong>
      {shown && (
        <div role="status" style={{ ...card, borderColor: "#c98a00" }} data-testid="new-key">
          <div>Copy this key now — it will not be shown again.</div>
          <code style={{ wordBreak: "break-all" }}>{shown}</code>
          <button style={btn} onClick={() => setShown(null)}>I have stored it</button>
        </div>
      )}
      <table style={table}>
        <thead><tr style={{ textAlign: "left" }}><th>Name</th><th>Prefix</th><th>Scopes</th><th>Status</th><th>Last used</th><th>Expires</th><th /></tr></thead>
        <tbody>
          {keys.map((k) => (
            <tr key={k.id} data-testid="api-key-row">
              <td>{k.name}</td><td><code>{k.prefix}</code></td><td>{k.scopes.join(", ")}</td><td>{k.status}</td>
              <td>{k.lastUsedAt ? new Date(k.lastUsedAt).toLocaleString() : "never"}</td>
              <td>{k.expiresAt ? new Date(k.expiresAt).toLocaleDateString() : "never"}</td>
              <td>
                {isOwner && k.status === "active" && (
                  <>
                    <button style={btn} onClick={async () => { const out = await act(() => secApi.rotateApiKey(workspaceId, k.id)); if (out) setShown(out.key); }}>Rotate</button>{" "}
                    <button style={btn} onClick={() => act(() => secApi.revokeApiKey(workspaceId, k.id))}>Revoke</button>
                  </>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {keys.length === 0 && <div style={muted}>No API keys.</div>}
      {isOwner ? (
        <form onSubmit={create} style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }} autoComplete="off">
          <input style={input} aria-label="Key name" placeholder="Key name" value={name} onChange={(e) => setName(e.target.value)} />
          {Object.keys(scopes).map((s) => (
            <label key={s} style={muted}><input type="checkbox" checked={scopes[s]} onChange={(e) => setScopes({ ...scopes, [s]: e.target.checked })} /> {s}</label>
          ))}
          <input style={{ ...input, width: 110 }} aria-label="Expires in days" placeholder="Expiry (days)" value={days} onChange={(e) => setDays(e.target.value.replace(/[^0-9]/g, ""))} />
          <button type="submit" style={btn}>Create key</button>
        </form>
      ) : <div style={muted}>Only the workspace owner can create, rotate or revoke API keys.</div>}
      {error && <div role="alert" style={{ color: "var(--mcis-danger, #c43d3d)" }}>{error}</div>}
    </section>
  );
}

function PolicyEditor({ workspaceId, onSaved }) {
  const [text, setText] = useState("");
  const [version, setVersion] = useState(null);
  const [error, setError] = useState(null);
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    secApi.getPolicy(workspaceId).then((p) => { setVersion(p.version); setText(JSON.stringify(p.policy, null, 2)); }).catch((e) => setError(e.message));
  }, [workspaceId]);
  async function save(e) {
    e.preventDefault();
    setError(null); setSaved(false);
    let policy;
    try { policy = JSON.parse(text); } catch { setError("Policy must be valid JSON."); return; }
    try {
      const p = await secApi.savePolicy(workspaceId, version, policy);
      setVersion(p.version); setText(JSON.stringify(p.policy, null, 2)); setSaved(true); onSaved();
    } catch (err) { setError(err.message); }
  }
  return (
    <form onSubmit={save} style={card} aria-label="Policy editor">
      <strong>Workspace security policy (owner)</strong>
      <div style={muted}>Most restrictive rule wins; built-in protections (credential files, other workspaces, metadata endpoints, tainted runs) cannot be turned off.</div>
      <textarea aria-label="Policy JSON" style={{ ...input, minHeight: 220, fontFamily: "monospace" }} value={text} onChange={(e) => setText(e.target.value)} />
      <div><button type="submit" style={btn}>Save policy (version {version === null ? "…" : version})</button></div>
      {saved && <div role="status" style={muted}>Saved.</div>}
      {error && <div role="alert" style={{ color: "var(--mcis-danger, #c43d3d)" }}>{error}</div>}
    </form>
  );
}

export default function SecurityPage() {
  const [user, setUser] = useState(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [workspaces, setWorkspaces] = useState([]);
  const [workspaceId, setWorkspaceId] = useState(null);
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
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
    }).catch((e) => setError(e.message));
    return () => { alive = false; };
  }, [user]);

  // Completing a workspace GitHub connection: code/state arrive in the URL
  // FRAGMENT (never sent to any server by the browser) and are posted once.
  useEffect(() => {
    if (!user) return;
    const frag = secApi.takeOAuthFragment();
    if (!frag) return;
    let ws = null;
    try { ws = window.sessionStorage.getItem(OAUTH_WS_KEY); window.sessionStorage.removeItem(OAUTH_WS_KEY); } catch { ws = null; }
    const label = frag.provider === "google_drive" ? "Google Drive" : "GitHub";
    if (!ws || frag.error) { setError(`Could not complete the ${label} connection: start it again from this page.`); return; }
    const complete = frag.provider === "google_drive" ? secApi.completeDriveOAuth : secApi.completeGithubOAuth;
    complete(ws, frag.code, frag.state)
      .then((r) => setNotice(`${label} account ${r.account} connected.`))
      .catch((e) => setError(e.message));
  }, [user]);

  const current = workspaces.find((w) => w.id === workspaceId);
  const role = current ? current.role : null;
  const isAdmin = role === "admin" || role === "owner";
  const isOwner = role === "owner";

  const load = useCallback(async () => {
    if (!workspaceId || !isAdmin) { setData(null); return; }
    setError(null);
    try { setData(await secApi.getDashboard(workspaceId)); } catch (e) { setData(null); setError(e.status === 403 ? "Only workspace admins and owners can view security settings." : e.message); }
  }, [workspaceId, isAdmin]);
  useEffect(() => { load(); }, [load]);

  const [providers, setProviders] = useState({ github: true, google_drive: false });
  useEffect(() => {
    if (!workspaceId || !isOwner) return;
    secApi.getOAuthProviders(workspaceId).then(setProviders).catch(() => setProviders({ github: true, google_drive: false }));
  }, [workspaceId, isOwner]);

  // Layer 9: workspace emergency stop (owner/admin) — denies every agent and
  // connector action in this workspace until it is turned off.
  const [stopBusy, setStopBusy] = useState(false);
  async function toggleEmergencyStop(active) {
    setError(null); setNotice(null); setStopBusy(true);
    try {
      await secApi.setEmergencyStop(workspaceId, active);
      setNotice(active ? "Emergency stop is ON: all agent and connector actions in this workspace are blocked." : "Emergency stop is off.");
      await load();
    } catch (e) { setError(e.message); }
    setStopBusy(false);
  }

  async function connectDrive() {
    setError(null);
    try {
      const { url } = await secApi.startDriveOAuth(workspaceId);
      try { window.sessionStorage.setItem(OAUTH_WS_KEY, workspaceId); } catch { /* ignore */ }
      window.location.assign(url);
    } catch (e) { setError(e.message); }
  }

  async function connectGithub() {
    setError(null);
    try {
      const { url } = await secApi.startGithubOAuth(workspaceId);
      try { window.sessionStorage.setItem(OAUTH_WS_KEY, workspaceId); } catch { /* ignore */ }
      window.location.assign(url);
    } catch (e) { setError(e.message); }
  }

  if (authLoading) return <div style={{ padding: 24 }}>Loading…</div>;
  if (!user) return <div style={{ padding: 24 }}>Please sign in.</div>;

  return (
    <div style={{ padding: 24, display: "grid", gap: 16, maxWidth: 1100, margin: "0 auto" }}>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <h2 style={{ margin: 0 }}>Security</h2>
        <select aria-label="Workspace" style={input} value={workspaceId || ""} onChange={(e) => { setWorkspaceId(e.target.value); wfApi.storeWorkspaceId(user.uid, e.target.value); }}>
          {workspaces.map((w) => <option key={w.id} value={w.id}>{w.is_personal ? "Personal" : w.name} ({w.role})</option>)}
        </select>
        <span style={{ flex: 1 }} />
        <a href="/" style={muted}>Back to app</a>
      </div>
      {notice && <div role="status">{notice}</div>}
      {error && <div role="alert" style={{ color: "var(--mcis-danger, #c43d3d)" }}>{error}</div>}
      {current && !isAdmin && <div style={card} data-testid="members-notice">Security settings are visible to workspace admins and owners only. You can use the tools this workspace permits.</div>}
      {data && (
        <>
          <section style={card} aria-label="Emergency stop">
            <strong>Emergency stop</strong>
            {data.policy && data.policy.emergencyStop ? (
              <div data-testid="emergency-stop-on">
                <Pill text="ACTIVE" color="#c43d3d" /> All agent and connector actions in this workspace are blocked.{" "}
                <button style={btn} disabled={stopBusy} onClick={() => toggleEmergencyStop(false)}>Turn off</button>
              </div>
            ) : (
              <div>
                <span style={muted}>Immediately blocks every agent and connector action in this workspace (runs waiting for approval cannot continue).</span>{" "}
                <button style={{ ...btn, borderColor: "#c43d3d", color: "#c43d3d" }} disabled={stopBusy} onClick={() => toggleEmergencyStop(true)}>Stop all actions</button>
              </div>
            )}
          </section>

          <section style={card} aria-label="Firewall status">
            <strong>Agent Firewall</strong>
            <div>
              <Pill text={data.firewall.enabled ? "enabled" : "disabled"} color={data.firewall.enabled ? "#1a9b5c" : "#c43d3d"} />{" "}
              policy {data.firewall.isDefault ? "built-in default" : `version ${data.firewall.policyVersion}`}
              {data.firewall.corrupt && <strong style={{ color: "#c43d3d" }}> — stored policy is invalid: all agent actions are denied</strong>}
            </div>
            {data.approvalPolicy && (
              <div style={muted} data-testid="approval-policy">
                max risk: {data.approvalPolicy.maxRisk} · approvals expire after {data.approvalPolicy.ttlMinutes} min · tainted runs need approval · minimum role to run: {data.approvalPolicy.minRole.execute}, to change state: {data.approvalPolicy.minRole.stateChanging}
              </div>
            )}
            <div style={muted}>Denied by default: {data.builtIn.dangerousActionsDeniedByDefault.join(", ")}</div>
          </section>

          <section style={card} aria-label="Integrations">
            <strong>Integrations & connector permissions</strong>
            {data.integrations.length === 0 && <div style={muted}>No integrations.</div>}
            {data.integrations.map((i) => (
              <div key={i.id}>
                <div>{i.name} <span style={muted}>({i.provider}, {i.status})</span></div>
                <table style={table}>
                  <tbody>
                    {i.connectorPermissions.map((a) => (
                      <tr key={a.action}><td>{a.action}</td><td>{a.enabled ? "enabled" : "disabled"}</td><td><Pill text={a.effectiveTier} color={TIER_COLORS[a.effectiveTier]} /></td><td style={muted}>min role {a.minRole}</td></tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ))}
          </section>

          <section style={card} aria-label="OAuth connections">
            <strong>OAuth connections</strong>
            {data.oauthConnections.length === 0 && <div style={muted}>None.</div>}
            {data.oauthConnections.map((o) => <div key={o.integrationId}>{o.provider}: {o.account} <span style={muted}>({o.status})</span></div>)}
            {isOwner && (
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                {providers.github && <button style={btn} onClick={connectGithub}>Connect GitHub (OAuth)</button>}
                {providers.google_drive && <button style={btn} onClick={connectDrive}>Connect Google Drive (read-only)</button>}
              </div>
            )}
          </section>

          <ApiKeys workspaceId={workspaceId} keys={data.apiKeys} isOwner={isOwner} onChanged={load} />

          <section style={card} aria-label="Blocked actions">
            <strong>Blocked actions</strong>
            {data.blockedActions.length === 0 && <div style={muted}>Nothing blocked recently.</div>}
            {data.blockedActions.map((e) => (
              <div key={e.id} data-testid="blocked-row" style={muted}>{new Date(e.at).toLocaleString()} · {e.type} · {(e.detail && (e.detail.action || e.detail.reason)) || ""} {e.detail && Array.isArray(e.detail.reasons) ? `(${e.detail.reasons.join(", ")})` : ""}</div>
            ))}
          </section>

          <section style={card} aria-label="Security events">
            <strong>Recent security events</strong>
            {data.recentEvents.length === 0 && <div style={muted}>No events yet.</div>}
            {data.recentEvents.map((e) => <div key={e.id} style={muted}>{new Date(e.at).toLocaleString()} · {e.type}{e.success === false ? " (blocked/failed)" : ""}</div>)}
          </section>

          {isOwner && <PolicyEditor workspaceId={workspaceId} onSaved={load} />}
        </>
      )}
    </div>
  );
}
