// Runtime configuration. Everything here comes from VITE_* variables, which
// are compiled into the browser bundle: never put server secrets in them.
const env = (typeof import.meta !== 'undefined' && import.meta.env) || {};

export const API_URL = String(env.VITE_API_URL || '').replace(/\/+$/, '');

export const firebaseConfig = {
  apiKey: env.VITE_FIREBASE_API_KEY,
  authDomain: env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: env.VITE_FIREBASE_PROJECT_ID,
  appId: env.VITE_FIREBASE_APP_ID,
  storageBucket: env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: env.VITE_FIREBASE_MESSAGING_SENDER_ID,
};

const REQUIRED = {
  apiKey: 'VITE_FIREBASE_API_KEY',
  authDomain: 'VITE_FIREBASE_AUTH_DOMAIN',
  projectId: 'VITE_FIREBASE_PROJECT_ID',
  appId: 'VITE_FIREBASE_APP_ID',
};

/** Names (never values) of the Firebase settings that are missing. */
export function missingFirebaseConfig(cfg = firebaseConfig) {
  return Object.entries(REQUIRED).filter(([k]) => !cfg[k]).map(([, name]) => name);
}
