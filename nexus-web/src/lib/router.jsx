import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

// Minimal History-API router (no dependency). Production hosting must
// rewrite unknown paths to /index.html (see vercel.json).
const RouterContext = createContext(null);

export function RouterProvider({ initialPath, children }) {
  const [path, setPath] = useState(() => initialPath || (typeof window !== 'undefined' ? window.location.pathname : '/'));
  useEffect(() => {
    const onPop = () => setPath(window.location.pathname);
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
  const navigate = useCallback((to) => {
    if (to === path) return;
    try { window.history.pushState({}, '', to); } catch { /* non-browser */ }
    setPath(to);
    if (typeof window !== 'undefined' && window.scrollTo) { try { window.scrollTo(0, 0); } catch { /* jsdom */ } }
  }, [path]);
  const value = useMemo(() => ({ path, navigate }), [path, navigate]);
  return <RouterContext.Provider value={value}>{children}</RouterContext.Provider>;
}

export function useRouter() {
  const ctx = useContext(RouterContext);
  if (!ctx) throw new Error('useRouter must be used inside <RouterProvider>');
  return ctx;
}

export function Link({ to, children, className, onClick, ...rest }) {
  const { navigate } = useRouter();
  return (
    <a
      {...rest}
      href={to}
      className={className}
      onClick={(e) => {
        // A caller's onClick (e.g. closing the mobile menu) runs first and is
        // composed, never allowed to replace the client-side navigation.
        if (onClick) onClick(e);
        if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        e.preventDefault();
        navigate(to);
      }}
    >
      {children}
    </a>
  );
}

/** Matches "/tasks/:id"-style patterns. Returns params or null. */
export function matchPath(pattern, path) {
  const p = pattern.split('/').filter(Boolean);
  const s = path.split('/').filter(Boolean);
  if (p.length !== s.length) return null;
  const params = {};
  for (let i = 0; i < p.length; i++) {
    if (p[i].startsWith(':')) params[p[i].slice(1)] = decodeURIComponent(s[i]);
    else if (p[i] !== s[i]) return null;
  }
  return params;
}
