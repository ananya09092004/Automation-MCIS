// Firebase-backed auth client. Only imported by main.jsx, never by the UI.
import { initializeApp } from 'firebase/app';
import {
  getAuth, onAuthStateChanged, signInWithEmailAndPassword, signInWithPopup, GoogleAuthProvider, signOut,
} from 'firebase/auth';

export function createFirebaseAuthClient(config) {
  const app = initializeApp(config, 'nexus-web');
  const auth = getAuth(app);
  return {
    onChange: (cb) => onAuthStateChanged(auth, (u) => cb(u ? { uid: u.uid, email: u.email, displayName: u.displayName, emailVerified: u.emailVerified } : null)),
    signInWithEmail: (email, pw) => signInWithEmailAndPassword(auth, email, pw),
    signInWithGoogle: () => signInWithPopup(auth, new GoogleAuthProvider()),
    signOut: () => signOut(auth),
    getToken: async () => (auth.currentUser ? auth.currentUser.getIdToken() : null),
  };
}
