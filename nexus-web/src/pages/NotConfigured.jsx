import { Brand } from '../components/icons.jsx';

/**
 * Shown instead of the app when the Firebase web configuration is missing
 * (`missing` = variable NAMES) or Firebase rejected it at start-up (`reason`
 * = a Firebase error code such as auth/invalid-api-key). Never shows values.
 */
export default function NotConfigured({ missing = [], reason }) {
  return (
    <div className="center-screen">
      <div className="auth-panel config-card">
        <div style={{ marginBottom: 16 }}><Brand /></div>
        <h2 style={{ fontSize: 20, marginBottom: 6 }}>Configuration required</h2>
        {missing.length ? (
          <>
            <p className="muted">This deployment is missing its Firebase web configuration, so sign-in is unavailable. Set these build-time variables (names only — values come from your Firebase project settings), then rebuild:</p>
            <ul className="mono small">{missing.map((m) => <li key={m}>{m}</li>)}</ul>
          </>
        ) : (
          <>
            <p className="muted">Firebase rejected this deployment&apos;s web configuration, so sign-in is unavailable.</p>
            {reason ? <p className="mono small">{reason}</p> : null}
            <p className="muted">Check the VITE_FIREBASE_* build variables (for example, that the API key value contains only the key, with no quotes or labels), then rebuild and redeploy.</p>
          </>
        )}
        <p className="small muted">See nexus-web/README.md.</p>
      </div>
    </div>
  );
}
