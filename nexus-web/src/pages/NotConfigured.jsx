export default function NotConfigured({ missing }) {
  return (
    <div className="auth-page">
      <div className="auth-card">
        <div className="brand center"><span className="brand-mark" aria-hidden="true">N</span><span className="brand-name">Nexus</span></div>
        <h1>Configuration required</h1>
        <p className="muted">This deployment is missing its Firebase web configuration, so sign-in is unavailable. Set these build-time variables (names only — values come from your Firebase project settings):</p>
        <ul className="mono small">{missing.map((m) => <li key={m}>{m}</li>)}</ul>
        <p className="small muted">See nexus-web/README.md.</p>
      </div>
    </div>
  );
}
