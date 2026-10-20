// Firebase-backed auth client. Only imported by main.jsx, never by the UI.
import { initializeApp } from 'firebase/app';
import {
  getAuth, onAuthStateChanged, signInWithEmailAndPassword, signInWithPopup, GoogleAuthProvider, signOut,
  createUserWithEmailAndPassword, sendEmailVerification, sendPasswordResetEmail,
} from 'firebase/auth';

export function createFirebaseAuthClient(config) {
  const app = initializeApp(config, 'nexus-web');
  const auth = getAuth(app);
  return {
    onChange: (cb) => onAuthStateChanged(auth, (u) => cb(u ? { uid: u.uid, email: u.email, displayName: u.displayName, emailVerified: u.emailVerified } : null)),
    signInWithEmail: (email, pw) => signInWithEmailAndPassword(auth, email, pw),
    signInWithGoogle: () => signInWithPopup(auth, new GoogleAuthProvider()),
    // New account → Firebase signs the user in; the verification email is best-effort
    // (workspace invitations require a verified address, enforced by the backend).
    signUpWithEmail: async (email, pw) => {
      const cred = await createUserWithEmailAndPassword(auth, email, pw);
      try { await sendEmailVerification(cred.user); } catch { /* user can resend from the banner */ }
      return cred;
    },
    sendPasswordReset: (email) => sendPasswordResetEmail(auth, email),
    sendVerification: () => (auth.currentUser ? sendEmailVerification(auth.currentUser) : Promise.resolve()),
    signOut: () => signOut(auth),
    getToken: async () => (auth.currentUser ? auth.currentUser.getIdToken() : null),
  };
}
