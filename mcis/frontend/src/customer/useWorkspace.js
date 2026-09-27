/**
 * Layer 8 — shared signed-in user + workspace selection for the customer
 * pages. The selection is only a choice among the server's list of the
 * user's own memberships; the backend re-checks it on every request.
 */
import { useEffect, useState } from "react";
import { onAuthStateChanged } from "firebase/auth";
import { auth } from "../firebase";
import * as wfApi from "../workflows/workflowsApi";

export default function useWorkspace() {
  const [user, setUser] = useState(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [workspaces, setWorkspaces] = useState([]);
  const [workspaceId, setWorkspaceIdState] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => onAuthStateChanged(auth, (u) => { setUser(u); setAuthLoading(false); }), []);
  useEffect(() => {
    if (!user) return undefined;
    let alive = true;
    wfApi.listWorkspaces().then((list) => {
      if (!alive) return;
      setWorkspaces(list);
      const chosen = wfApi.pickWorkspace(list, wfApi.getStoredWorkspaceId(user.uid));
      setWorkspaceIdState(chosen ? chosen.id : null);
    }).catch((e) => alive && setError(e.message));
    return () => { alive = false; };
  }, [user]);

  const setWorkspaceId = (id) => {
    setWorkspaceIdState(id);
    if (user) wfApi.storeWorkspaceId(user.uid, id);
  };
  const current = workspaces.find((w) => w.id === workspaceId) || null;
  const isAdmin = !!current && (current.role === "owner" || current.role === "admin");
  return { user, authLoading, workspaces, workspaceId, setWorkspaceId, current, isAdmin, error };
}

export const styles = {
  page: { padding: 24, display: "grid", gap: 16, maxWidth: 1100, margin: "0 auto" },
  card: { background: "var(--mcis-surface, #fff)", border: "1px solid var(--mcis-border, #ddd)", borderRadius: 12, padding: 16, display: "grid", gap: 10 },
  btn: { padding: "6px 12px", borderRadius: 8, border: "1px solid var(--mcis-border, #ccc)", background: "var(--mcis-input, #f7f7f7)", color: "inherit", cursor: "pointer", fontSize: 13 },
  primary: { padding: "8px 14px", borderRadius: 8, border: "1px solid var(--mcis-primary-solid, #5b4bff)", background: "var(--mcis-primary-solid, #5b4bff)", color: "#fff", cursor: "pointer", fontSize: 13 },
  input: { padding: "7px 9px", borderRadius: 8, border: "1px solid var(--mcis-border, #ccc)", background: "var(--mcis-input, #fff)", color: "inherit", fontSize: 13 },
  muted: { color: "var(--mcis-muted, #777)", fontSize: 12 },
  danger: { color: "var(--mcis-danger, #c43d3d)" },
};
