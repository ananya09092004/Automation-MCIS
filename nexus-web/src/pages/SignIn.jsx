import { useState } from 'react';
import { useAuth, authErrorMessage } from '../lib/auth.jsx';
import { Button, Notice, RiskTag } from '../components/ui.jsx';
import Icon, { Brand } from '../components/icons.jsx';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD = 8;

const CAPS = [
  { icon: 'firewall', text: 'Every agent action is policy-checked' },
  { icon: 'approvals', text: 'Risky steps wait for a human' },
  { icon: 'lock', text: 'Workspaces are isolated' },
  { icon: 'activity', text: 'Full audit trail and evidence' },
];

/** Illustration of how the firewall routes actions — clearly labelled as examples. */
function ExecutionLane() {
  return (
    <figure className="lane" aria-label="Illustration: how Nexus routes an agent's actions">
      <div className="lane-head">
        <span className="eyebrow">How Nexus decides</span>
        <span className="small" style={{ color: '#7f8aa8' }}>Example</span>
      </div>
      <div className="lane-nodes" aria-hidden="true">
        <div className="lane-node"><span className="tile"><Icon name="user" /></span>You</div>
        <div className="lane-wire" />
        <div className="lane-node"><span className="tile"><Icon name="agents" /></span>Agent</div>
        <div className="lane-wire w2" />
        <div className="lane-node fw"><span className="tile"><Icon name="firewall" /></span>Nexus</div>
        <div className="lane-wire w3" />
        <div className="lane-node"><span className="tile"><Icon name="tool" /></span>Tools</div>
      </div>
      <div className="lane-rows">
        <div className="lane-row"><span className="what">Read last month&apos;s report</span><RiskTag risk="green" /><span className="small">Runs</span></div>
        <div className="lane-row"><span className="what">Email 14 customers</span><RiskTag risk="yellow" /><span className="small">Needs approval</span></div>
        <div className="lane-row"><span className="what">Delete files</span><RiskTag risk="blocked" /><span className="small">Blocked by policy</span></div>
      </div>
    </figure>
  );
}

function PasswordInput({ value, onChange, autoComplete, invalid }) {
  const [show, setShow] = useState(false);
  return (
    <div className="input-wrap">
      <input id="pw" type={show ? 'text' : 'password'} autoComplete={autoComplete} value={value} onChange={onChange} aria-invalid={invalid ? 'true' : undefined} />
      <button type="button" className="icon-btn" aria-label={show ? 'Hide password' : 'Show password'} aria-controls="pw" onClick={() => setShow((v) => !v)}>
        <Icon name={show ? 'eyeOff' : 'eye'} size={17} />
      </button>
    </div>
  );
}

export default function SignIn() {
  const { signInWithEmail, signInWithGoogle, signUpWithEmail, sendPasswordReset } = useAuth();
  const [mode, setMode] = useState('signin'); // signin | signup | reset
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [info, setInfo] = useState(null);
  const [busy, setBusy] = useState(null);

  function switchTo(m) { setMode(m); setError(null); setInfo(null); setPassword(''); }

  async function submit(e) {
    e.preventDefault();
    setError(null);
    setInfo(null);
    const em = email.trim();
    if (mode === 'reset') {
      if (!EMAIL_RE.test(em)) { setError('Enter a valid email address.'); return; }
      setBusy('email');
      try { await sendPasswordReset(em); } catch { /* same message either way: no account enumeration */ }
      setBusy(null);
      setInfo(`If an account exists for ${em}, a password reset link is on its way.`);
      return;
    }
    if (!em || !password) { setError('Enter your email and password.'); return; }
    if (mode === 'signup') {
      if (!EMAIL_RE.test(em)) { setError('Enter a valid email address.'); return; }
      if (password.length < MIN_PASSWORD) { setError(`Use at least ${MIN_PASSWORD} characters for your password.`); return; }
    }
    setBusy('email');
    try {
      if (mode === 'signup') await signUpWithEmail(em, password);
      else await signInWithEmail(em, password);
    } catch (err) { setError(authErrorMessage(err)); setBusy(null); }
  }

  async function google() {
    setBusy('google');
    setError(null);
    setInfo(null);
    try { await signInWithGoogle(); } catch (err) { setError(authErrorMessage(err)); setBusy(null); }
  }

  const titles = {
    signin: ['Sign in', 'Welcome back. Pick up where your agents left off.'],
    signup: ['Create your account', 'Start with a personal workspace. Invite your team when you are ready.'],
    reset: ['Reset your password', 'We will email you a link to choose a new password.'],
  };
  const [title, sub] = titles[mode];

  return (
    <div className="auth-page">
      <section className="auth-hero" aria-label="About Nexus">
        <Brand />
        <div className="auth-hero-body">
          <div>
            <span className="eyebrow">AI agent execution platform</span>
            <p className="hero-title" style={{ marginTop: 12 }}>Your AI workforce, <span className="grad">under control.</span></p>
            <p className="lede">Nexus runs your agents&apos; work through a policy firewall. Routine steps run on their own, risky ones wait for a person, and every action is recorded.</p>
          </div>
          <ExecutionLane />
          <ul className="caps">
            {CAPS.map((c) => <li key={c.text}><span className="cap-icon" aria-hidden="true"><Icon name={c.icon} size={15} /></span>{c.text}</li>)}
          </ul>
        </div>
        <div className="auth-foot">Nexus · secure execution for AI agents</div>
      </section>

      <main className="auth-side">
        <div className="auth-card">
          <div className="mobile-brand"><Brand /><span className="small muted">Your AI workforce, under control.</span></div>
          <h1>{title}</h1>
          <p className="sub">{sub}</p>
          <div className="auth-panel">
            <form onSubmit={submit} noValidate>
              <label className="field"><span>Email</span>
                <input type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} aria-invalid={error && /email/i.test(error) ? 'true' : undefined} />
              </label>
              {mode !== 'reset' ? (
                <div className="field">
                  <div className="field-row">
                    <label htmlFor="pw">Password</label>
                    {mode === 'signin' ? <button type="button" className="link small" onClick={() => switchTo('reset')}>Forgot password?</button> : <span className="hint">At least {MIN_PASSWORD} characters</span>}
                  </div>
                  <PasswordInput value={password} onChange={(e) => setPassword(e.target.value)} autoComplete={mode === 'signup' ? 'new-password' : 'current-password'} invalid={error && /password/i.test(error)} />
                </div>
              ) : null}
              {error ? <Notice tone="danger">{error}</Notice> : null}
              {info ? <Notice tone="success">{info}</Notice> : null}
              <Button variant="primary" type="submit" busy={busy === 'email'} disabled={!!busy} className="full">
                {mode === 'signin' ? 'Sign in' : mode === 'signup' ? 'Create account' : 'Send reset link'}
              </Button>
            </form>
            {mode !== 'reset' ? (
              <>
                <div className="divider"><span>or</span></div>
                <Button onClick={google} busy={busy === 'google'} disabled={!!busy} className="full">Continue with Google</Button>
              </>
            ) : null}
          </div>
          <p className="auth-switch">
            {mode === 'signin' ? <>New to Nexus? <button type="button" className="link" onClick={() => switchTo('signup')}>Create an account</button></> : null}
            {mode === 'signup' ? <>Already have an account? <button type="button" className="link" onClick={() => switchTo('signin')}>Sign in</button></> : null}
            {mode === 'reset' ? <button type="button" className="link" onClick={() => switchTo('signin')}>Back to sign in</button> : null}
          </p>
        </div>
      </main>
    </div>
  );
}
