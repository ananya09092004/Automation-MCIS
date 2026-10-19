import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import NotConfigured from './pages/NotConfigured.jsx';
import { firebaseConfig, missingFirebaseConfig } from './config.js';
import './styles.css';

const root = createRoot(document.getElementById('root'));
const missing = missingFirebaseConfig();

if (missing.length) {
  root.render(<StrictMode><NotConfigured missing={missing} /></StrictMode>);
} else {
  // Firebase is loaded only when configured (keeps the not-configured screen dependency-free).
  import('./lib/firebaseClient.js').then(({ createFirebaseAuthClient }) => {
    const authClient = createFirebaseAuthClient(firebaseConfig);
    root.render(<StrictMode><App authClient={authClient} /></StrictMode>);
  });
}
