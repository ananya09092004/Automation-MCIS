import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

/**
 * Auth is provided by an injected `client` so the UI never imports Firebase
 * directly (tests use a fake client; main.jsx passes the Firebase one).
 *
 * client = { onChange(cb) → unsubscribe, signInWithEmail(email, pw),
 *            signInWithGoogle(), signOut(), getToken() → Promise<string|null>,
 *            signUpWithEmail(email, pw), sendPasswordReset(email), sendVerification() }
 */
const AuthContext = createContext(null);

export function AuthProvider({ client, children }) {
  const [state, setState] = useState({ status: 'loading', user: null });

  useEffect(() => {
    if (!client) return undefined;
    return client.onChange((user) => setState({ status: user ? 'signedIn' : 'signedOut', user: user || null }));
  }, [client]);

  const getToken = useCallback(() => (client ? client.getToken() : Promise.resolve(null)), [client]);
  const value = useMemo(() => ({
    ...state,
    getToken,
    signInWithEmail: (email, pw) => client.signInWithEmail(email, pw),
    signInWithGoogle: () => client.signInWithGoogle(),
    signUpWithEmail: (email, pw) => (client.signUpWithEmail ? client.signUpWithEmail(email, pw) : Promise.reject(new Error('Sign-up is not available'))),
    sendPasswordReset: (email) => (client.sendPasswordReset ? client.sendPasswordReset(email) : Promise.resolve()),
    sendVerification: () => (client.sendVerification ? client.sendVerification() : Promise.resolve()),
    signOut: () => client.signOut(),
  }), [state, getToken, client]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}

/** Firebase errors → short, user-facing messages (no internal codes). */
export function authErrorMessage(err) {
  const code = (err && err.code) || '';
  if (/invalid-credential|wrong-password|user-not-found|invalid-email/.test(code)) return 'Email or password is incorrect.';
  if (/too-many-requests/.test(code)) return 'Too many attempts. Wait a moment and try again.';
  if (/popup-closed|cancelled-popup/.test(code)) return 'Sign-in was cancelled.';
  if (/network/.test(code)) return 'Network error. Check your connection.';
  if (/operation-not-allowed/.test(code)) return 'This sign-in method is not enabled for this project.';
  if (/email-already-in-use/.test(code)) return 'An account with this email already exists. Sign in instead.';
  if (/weak-password/.test(code)) return 'Choose a stronger password (at least 8 characters).';
  if (/popup-blocked/.test(code)) return 'Your browser blocked the Google sign-in window. Allow pop-ups for this site and try again.';
  if (/unauthorized-domain/.test(code)) return 'Sign-in is not enabled for this web address yet (Firebase authorized domains).';
  if (/invalid-api-key|api-key-not-valid/.test(code)) return 'Sign-in is not configured correctly for this site (Firebase API key).';
  return 'Sign-in failed. Please try again.';
}
