import { useState, useEffect } from "react";
import { auth } from "./firebase";
import { createUserWithEmailAndPassword, signInWithEmailAndPassword } from "firebase/auth";
import { ArrowRight, Brain, BriefcaseBusiness, CheckCircle2, LockKeyhole, Sparkles } from "lucide-react";
import AmbientBackground from "./components/AmbientBackground";

function Auth({ onLogin }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [isSignup, setIsSignup] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  // ✅ ADDED: allow scrolling on the login page (mobile) — chat/dashboard pages
  // set body/html/#root overflow to 'hidden', which otherwise leaks into this page.
  useEffect(() => {
    const root = document.getElementById('root');
    document.body.style.overflow = 'auto';
    document.documentElement.style.overflow = 'auto';
    if (root) {
      root.style.overflow = 'auto';
      root.style.height = 'auto';
    }
    return () => {
      document.body.style.overflow = 'hidden';
      document.documentElement.style.overflow = 'hidden';
      if (root) {
        root.style.overflow = 'hidden';
        root.style.height = '100%';
      }
    };
  }, []);

  const handleSubmit = async (event) => {
    event?.preventDefault();
    if (!email || !password || loading) return;
    setLoading(true);
    setError("");
    try {
      const userCred = isSignup
        ? await createUserWithEmailAndPassword(auth, email, password)
        : await signInWithEmailAndPassword(auth, email, password);
      onLogin(userCred.user);
    } catch (err) {
      setError(err.message.replace("Firebase: ", ""));
    }
    setLoading(false);
  };

  return (
    <main className="mcis-auth-page" style={styles.page}>
      <section className="mcis-auth-brand" style={styles.brandPanel}>
        <AmbientBackground />
        <div className="mcis-auth-brand-content" style={styles.brandContent}>
          <div style={styles.brandTop}>
            <div style={styles.logo}>M</div>
            <div>
              <div style={styles.brandName}>MCIS</div>
              <div style={styles.brandLine}>AI workspace with persistent memory</div>
            </div>
          </div>

          <div style={styles.heroCopy}>
            <div style={styles.kicker}>
              <Sparkles size={15} />
              Memory-first AI
            </div>
            <h1 style={styles.title}>Remember everything. Continue anything.</h1>
            <p style={styles.subtitle}>
              MCIS remembers your projects, goals, decisions, files, and preferences so your work never starts from zero.
            </p>
          </div>

          <div className="mcis-auth-features" style={styles.featureGrid}>
            <Feature icon={Brain} title="Context memory" text="Searchable memory across conversations and files." />
            <Feature icon={BriefcaseBusiness} title="Workspaces" text="Separate context for projects, clients, research, and life." />
            <Feature icon={CheckCircle2} title="Daily brief" text="Next actions based on what you were already doing." />
          </div>
        </div>
      </section>

      <section className="mcis-auth-panel" style={styles.authPanel}>
        <form style={styles.card} onSubmit={handleSubmit}>
          <div style={styles.cardHeader}>
            <div style={styles.lockIcon}><LockKeyhole size={18} /></div>
            <div>
              <h2>{isSignup ? "Create your workspace" : "Welcome back"}</h2>
              <p>{isSignup ? "Start building your personal work memory." : "Continue with your remembered context."}</p>
            </div>
          </div>

          <label style={styles.label} htmlFor="mcis-email">Email</label>
          <input
            id="mcis-email"
            style={styles.input}
            placeholder="you@company.com"
            value={email}
            onChange={e => setEmail(e.target.value)}
            type="email"
            autoComplete="email"
          />

          <label style={styles.label} htmlFor="mcis-password">Password</label>
          <input
            id="mcis-password"
            style={styles.input}
            placeholder="Minimum 6 characters"
            value={password}
            onChange={e => setPassword(e.target.value)}
            type="password"
            autoComplete={isSignup ? "new-password" : "current-password"}
          />

          {error && <div style={styles.error} role="alert" aria-live="polite">{error}</div>}

          <button style={styles.button} type="submit" disabled={loading || !email || !password}>
            {loading ? "Please wait..." : isSignup ? "Create account" : "Login"}
            {!loading && <ArrowRight size={17} />}
          </button>

          <button style={styles.toggle} type="button" onClick={() => setIsSignup(!isSignup)}>
            {isSignup ? "Already have an account? Login" : "New here? Create account"}
          </button>
        </form>
      </section>
    </main>
  );
}

function Feature({ icon: Icon, title, text }) {
  return (
    <div style={styles.feature}>
      <div style={styles.featureIcon}><Icon size={18} /></div>
      <strong style={styles.featureTitle}>{title}</strong>
      <span style={styles.featureText}>{text}</span>
    </div>
  );
}

const styles = {
  page: {
    minHeight: "100vh",
    background: "var(--mcis-bg)",
    color: "var(--mcis-text)",
    display: "grid",
    gridTemplateColumns: "minmax(0, 1.1fr) minmax(360px, 0.7fr)",
    fontFamily: 'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  },
  brandPanel: {
    position: "relative",
    overflow: "hidden",
    background: "var(--mcis-hero)",
    color: "var(--mcis-text)",
  },
  brandContent: {
    position: "relative",
    zIndex: 2,
    height: "100%",
    padding: "clamp(28px, 6vw, 72px)",
    display: "flex",
    flexDirection: "column",
    justifyContent: "space-between",
    gap: 42,
    boxSizing: "border-box",
  },
  brandTop: { display: "flex", alignItems: "center", gap: 14, color: "var(--mcis-text)" },
  logo: {
    width: 46,
    height: 46,
    borderRadius: 14,
    background: "var(--mcis-primary)",
    color: "#ffffff",
    boxShadow: "var(--mcis-glow)",
    display: "grid",
    placeItems: "center",
    fontWeight: 900,
    fontSize: 20,
  },
  brandName: { fontSize: 20, fontWeight: 700, letterSpacing: 0, fontFamily: 'var(--mcis-font-display)', color: "var(--mcis-text)" },
  brandLine: { color: "var(--mcis-muted)", fontSize: 13, marginTop: 3 },
  heroCopy: { maxWidth: 760 },
  kicker: { color: "var(--mcis-accent)", fontSize: 13, fontWeight: 800, display: "flex", alignItems: "center", gap: 8, marginBottom: 18 },
  title: { color: "var(--mcis-text)", fontSize: "clamp(40px, 7vw, 76px)", lineHeight: 1, letterSpacing: "-0.02em", margin: "0 0 20px", fontFamily: 'var(--mcis-font-display)', fontWeight: 700 },
  subtitle: { color: "var(--mcis-muted)", fontSize: 18, lineHeight: 1.7, maxWidth: 660, margin: 0 },
  featureGrid: { display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 14 },
  feature: { background: "var(--mcis-subtle)", border: "1px solid var(--mcis-border)", borderRadius: 16, padding: 16, display: "flex", flexDirection: "column", gap: 8, color: "var(--mcis-text)" },
  featureIcon: { width: 36, height: 36, borderRadius: 11, background: "var(--mcis-active)", color: "var(--mcis-accent)", display: "grid", placeItems: "center" },
  featureTitle: { color: "var(--mcis-text)", fontSize: 14, fontWeight: 700 },
  featureText: { color: "var(--mcis-muted)", fontSize: 13, lineHeight: 1.5 },
  authPanel: { display: "grid", placeItems: "center", padding: 24 },
  card: { width: "100%", maxWidth: 420, background: "var(--mcis-surface)", border: "1px solid var(--mcis-border)", borderRadius: 22, padding: 24, boxShadow: "var(--mcis-card-shadow)" },
  cardHeader: { display: "flex", gap: 12, alignItems: "flex-start", marginBottom: 22 },
  lockIcon: { width: 40, height: 40, borderRadius: 12, background: "var(--mcis-subtle)", color: "var(--mcis-accent)", display: "grid", placeItems: "center", flexShrink: 0 },
  label: { display: "block", fontSize: 12, fontWeight: 800, color: "var(--mcis-muted)", margin: "14px 0 7px" },
  input: { width: "100%", boxSizing: "border-box", background: "var(--mcis-input)", border: "1px solid var(--mcis-border)", borderRadius: 12, padding: "13px 14px", color: "var(--mcis-text)", fontSize: 15, outline: "none" },
  error: { marginTop: 12, color: "var(--mcis-danger)", background: "var(--mcis-danger-soft)", border: "1px solid var(--mcis-danger)", borderRadius: 10, padding: "10px 12px", fontSize: 13 },
  button: { width: "100%", height: 46, marginTop: 18, border: 0, borderRadius: 12, background: "var(--mcis-primary)", color: "#ffffff", fontWeight: 850, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 9, fontSize: 15, boxShadow: "var(--mcis-glow)" },
  toggle: { width: "100%", marginTop: 14, border: 0, background: "transparent", color: "var(--mcis-accent)", cursor: "pointer", fontWeight: 750, fontSize: 13 },
};

export default Auth;
