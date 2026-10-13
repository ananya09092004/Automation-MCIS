/**
 * Public-launch hardening pass, item 4 — the `/` vs `/welcome` behavior.
 *
 * `/` used to always render <App/> directly, which meant a logged-out
 * visitor landing on the root URL saw the bare sign-in form (Auth.js)
 * with no marketing/product context at all, instead of the public Nexus
 * landing experience that already exists at /welcome. An authenticated
 * user hitting `/` should still go straight to the app/dashboard, not a
 * marketing page.
 *
 * This component is the one place that decides between the two: once
 * Firebase's first auth-state callback fires, a logged-out visitor sees
 * <LandingPage/>, and anyone signed in sees <App/> (which still owns its
 * own full chat/dashboard experience and its own sign-out — nothing
 * about App.js changes here). Until that first callback fires, it shows
 * the same loading shell App.js already used for its own authLoading
 * state, so there's no guess and no flash of the wrong page.
 *
 * The one thing this intentionally does NOT do is fold the actual
 * sign-in form into this component: LandingPage's "Sign in" links point
 * at /signin (see index.js), a route that renders <App/> directly (which
 * renders the Auth form for a logged-out visitor exactly as before) —
 * so a logged-out visitor can always reach the sign-in form, and
 * clicking "Sign in" from the landing page never just loops back to the
 * landing page itself.
 */
import { useEffect, useState } from 'react';
import { auth } from './firebase';
import { onAuthStateChanged } from 'firebase/auth';
import App from './App';
import LandingPage from './landing/LandingPage';

function RootLoadingShell() {
  return (
    <div className="mcis-loading-screen">
      <div className="mcis-loading-logo">M</div>
      <span className="mcis-loading-text">Preparing your intelligence workspace</span>
      <div className="mcis-loading-bar"><span /></div>
    </div>
  );
}

function RootRoute() {
  const [signedIn, setSignedIn] = useState(null); // null = not resolved yet

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (u) => setSignedIn(!!u));
    return () => unsub();
  }, []);

  if (signedIn === null) return <RootLoadingShell />;
  return signedIn ? <App /> : <LandingPage />;
}

export default RootRoute;
