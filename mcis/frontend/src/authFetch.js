import { auth } from "./firebase";
import { getStoredWorkspaceId, storeWorkspaceId } from "./workflows/workflowsApi";

const API_ORIGINS = [
  process.env.REACT_APP_API_URL,
  process.env.REACT_APP_BACKEND_URL,
  "https://mcis-backend.onrender.com",
]
  .filter(Boolean)
  .map((url) => {
    try {
      return new URL(url, window.location.origin).origin;
    } catch {
      return null;
    }
  })
  .filter(Boolean);

function parseUrl(input) {
  try {
    return new URL(typeof input === "string" ? input : input.url, window.location.origin);
  } catch {
    return null;
  }
}

/**
 * Layer 9: the Firebase ID token is attached ONLY to our own API — a
 * same-origin /api/ path or one of the configured backend origins. (Before,
 * any origin with an /api/ path received the token.)
 */
export function shouldAttachToken(input) {
  const url = parseUrl(input);
  if (!url) return false;
  if (url.origin === window.location.origin) return url.pathname.startsWith("/api/");
  return API_ORIGINS.includes(url.origin);
}

// Layer 2 routes that run in the selected workspace (X-Workspace-Id).
const WORKSPACE_SCOPED = /^\/api\/(chat|memory|goals)(\/|$)/;

export function isWorkspaceScoped(input) {
  const url = parseUrl(input);
  return !!url && shouldAttachToken(input) && WORKSPACE_SCOPED.test(url.pathname);
}

export function setupAuthenticatedFetch() {
  if (window.__mcisAuthenticatedFetchInstalled) return;
  window.__mcisAuthenticatedFetchInstalled = true;

  const originalFetch = window.fetch.bind(window);

  window.fetch = async (input, init = {}) => {
    const headers = new Headers(init.headers || {});
    if (!shouldAttachToken(input)) return originalFetch(input, init);

    if (!headers.has("Authorization")) {
      if (!auth.currentUser && typeof auth.authStateReady === "function") {
        await auth.authStateReady();
      }
      if (!auth.currentUser) return originalFetch(input, init);
      headers.set("Authorization", `Bearer ${await auth.currentUser.getIdToken()}`);
    }
    const currentUser = auth.currentUser;

    // Layer 9 (L2-8): chat / memory / goals follow the workspace selected in
    // the app (also for callers that set Authorization themselves). The
    // server re-checks membership; a workspace the user has left (404) is
    // forgotten and the request is retried in the personal workspace — the
    // server default.
    const scoped = !!currentUser && isWorkspaceScoped(input) && !headers.has("X-Workspace-Id");
    const wsId = scoped ? getStoredWorkspaceId(currentUser.uid) : null;
    if (wsId) headers.set("X-Workspace-Id", wsId);

    const res = await originalFetch(input, { ...init, headers });
    const replayable = typeof input === "string" && (init.body === undefined || init.body === null || typeof init.body === "string" || init.body instanceof FormData);
    if (wsId && res.status === 404 && replayable) {
      let code = null;
      try { code = (await res.clone().json()).code; } catch { code = null; }
      if (code === "WORKSPACE_NOT_FOUND") {
        storeWorkspaceId(currentUser.uid, null);
        headers.delete("X-Workspace-Id");
        return originalFetch(input, { ...init, headers });
      }
    }
    return res;
  };
}
