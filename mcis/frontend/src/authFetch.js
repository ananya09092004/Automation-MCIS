import { auth } from "./firebase";

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

function shouldAttachToken(input) {
  try {
    const url = new URL(typeof input === "string" ? input : input.url, window.location.origin);
    return url.pathname.startsWith("/api/") || API_ORIGINS.includes(url.origin);
  } catch {
    return false;
  }
}

export function setupAuthenticatedFetch() {
  if (window.__mcisAuthenticatedFetchInstalled) return;
  window.__mcisAuthenticatedFetchInstalled = true;

  const originalFetch = window.fetch.bind(window);

  window.fetch = async (input, init = {}) => {
    const headers = new Headers(init.headers || {});

    if (!shouldAttachToken(input) || headers.has("Authorization")) {
      return originalFetch(input, init);
    }

    if (!auth.currentUser && typeof auth.authStateReady === "function") {
      await auth.authStateReady();
    }

    const currentUser = auth.currentUser;
    if (!currentUser) return originalFetch(input, init);

    const token = await currentUser.getIdToken();
    headers.set("Authorization", `Bearer ${token}`);

    return originalFetch(input, {
      ...init,
      headers,
    });
  };
}
