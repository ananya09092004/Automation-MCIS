import { useState } from 'react';
import { useAuth, authErrorMessage } from '../lib/auth.jsx';
import { Button, Notice } from '../components/ui.jsx';

export default function SignIn() {
  const { signInWithEmail, signInWithGoogle } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(null);

  async function submit(e) {
    e.preventDefault();
    if (!email.trim() || !password) { setError('Enter your email and password.'); return; }
    setBusy('email');
    setError(null);
    try { await signInWithEmail(email.trim(), password); } catch (err) { setError(authErrorMessage(err)); setBusy(null); }
  }
  async function google() {
    setBusy('google');
    setError(null);
    try { await signInWithGoogle(); } catch (err) { setError(authErrorMessage(err)); setBusy(null); }
  }

  return (
    <div className="auth-page">
      <div className="auth-card">
        <div className="brand center"><span className="brand-mark" aria-hidden="true">N</span><span className="brand-name">Nexus</span></div>
        <h1>Sign in</h1>
        <p className="muted">Operations console for your AI agents, tasks and approvals.</p>
        <form onSubmit={submit} noValidate>
          <label className="field"><span>Email</span><input type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} /></label>
          <label className="field"><span>Password</span><input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} /></label>
          {error ? <Notice tone="danger">{error}</Notice> : null}
          <Button variant="primary" type="submit" busy={busy === 'email'} disabled={!!busy} className="full">Sign in</Button>
        </form>
        <div className="divider"><span>or</span></div>
        <Button onClick={google} busy={busy === 'google'} disabled={!!busy} className="full">Continue with Google</Button>
        <p className="small muted center">Use the same account as the MCIS app. New accounts are created in the MCIS app.</p>
      </div>
    </div>
  );
}
