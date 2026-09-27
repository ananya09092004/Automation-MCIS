import React from "react";
import { styles as S } from "../customer/useWorkspace";
import { HEALTH } from "./revenueApi";

export function HealthBadge({ health, fresh }) {
  const h = HEALTH[health] || HEALTH.PENDING;
  return (
    <span data-testid="health" title={fresh === false && (health === "VERIFIED" || health === "UNVERIFIED") ? "Last value is not current" : h.label}
      style={{ fontSize: 11, padding: "2px 8px", borderRadius: 10, border: `1px solid ${h.color}`, color: h.color, whiteSpace: "nowrap" }}>
      {h.label}{fresh === false && (health === "VERIFIED" || health === "UNVERIFIED") ? " · not current" : ""}
    </span>
  );
}

export function Shell({ title, ws, children, nav = true }) {
  const { user, authLoading, workspaces, workspaceId, setWorkspaceId, error } = ws;
  if (authLoading) return <div style={{ padding: 24 }}>Loading…</div>;
  if (!user) return <div style={{ padding: 24 }}>Please sign in.</div>;
  return (
    <div style={S.page}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <h2 style={{ margin: 0 }}>{title}</h2>
        <span style={{ flex: 1 }} />
        {workspaces.length > 0 && (
          <select aria-label="Workspace" style={S.input} value={workspaceId || ""} onChange={(e) => setWorkspaceId(e.target.value)}>
            {workspaces.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
          </select>
        )}
        {nav && ["competitors", "monitoring", "reliability", "workforce", "developers"].map((p) => <a key={p} href={`/${p}`} style={S.muted}>{p}</a>)}
      </div>
      {error && <div role="alert" style={S.danger}>{error}</div>}
      {children}
    </div>
  );
}

export function Empty({ children }) {
  return <div data-testid="empty" style={{ ...S.muted, padding: 8 }}>{children}</div>;
}

export function useLoad(fn, deps) {
  const [state, setState] = React.useState({ loading: true, data: null, error: null });
  const reload = React.useCallback(async () => {
    setState((s) => ({ ...s, loading: true, error: null }));
    try { setState({ loading: false, data: await fn(), error: null }); } catch (e) {
      setState({ loading: false, data: null, error: e.status === 404 ? "You no longer have access to that workspace." : (e.message || "Request failed") });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  React.useEffect(() => { reload(); }, [reload]);
  return { ...state, reload };
}
