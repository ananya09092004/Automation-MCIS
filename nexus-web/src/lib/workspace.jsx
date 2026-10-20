import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { useApi } from './apiContext.jsx';
import { useAuth } from './auth.jsx';
import { endpoints } from './endpoints.js';

const WorkspaceContext = createContext(null);
const KEY = (uid) => `nexus.workspace.${uid}`;

function readStored(uid) {
  try { return window.localStorage.getItem(KEY(uid)); } catch { return null; }
}
function writeStored(uid, id) {
  try { if (id) window.localStorage.setItem(KEY(uid), id); else window.localStorage.removeItem(KEY(uid)); } catch { /* private mode */ }
}

/** Prefer the stored workspace, then the first team workspace, then personal. */
export function pickWorkspace(list, storedId) {
  if (!list || !list.length) return null;
  return list.find((w) => w.id === storedId) || list.find((w) => !w.is_personal) || list[0];
}

export function WorkspaceProvider({ children }) {
  const api = useApi();
  const { user } = useAuth();
  const uid = user && user.uid;
  const [state, setState] = useState({ list: null, currentId: null, loading: true, error: null });

  const load = useCallback(async () => {
    if (!uid) return;
    setState((s) => ({ ...s, loading: true, error: null }));
    try {
      const list = await endpoints.listWorkspaces(api);
      const picked = pickWorkspace(list, readStored(uid));
      setState({ list, currentId: picked ? picked.id : null, loading: false, error: null });
    } catch (error) {
      setState({ list: null, currentId: null, loading: false, error });
    }
  }, [api, uid]);

  useEffect(() => { load(); }, [load]);

  const select = useCallback((id) => {
    writeStored(uid, id);
    setState((s) => ({ ...s, currentId: id }));
  }, [uid]);

  /** After creating / joining a workspace: remember it, then reload the list (pickWorkspace prefers the stored id). */
  const adopt = useCallback(async (id) => {
    writeStored(uid, id);
    await load();
  }, [uid, load]);

  const value = useMemo(() => {
    const current = state.list ? state.list.find((w) => w.id === state.currentId) || null : null;
    const role = current ? current.role : null;
    return {
      workspaces: state.list || [],
      current,
      workspaceId: current ? current.id : null,
      role,
      isAdmin: role === 'owner' || role === 'admin',
      loading: state.loading,
      error: state.error,
      select,
      adopt,
      reload: load,
    };
  }, [state, select, adopt, load]);

  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}

export function useWorkspace() {
  const ctx = useContext(WorkspaceContext);
  if (!ctx) throw new Error('useWorkspace must be used inside <WorkspaceProvider>');
  return ctx;
}
