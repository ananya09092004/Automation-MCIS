import { useState } from "react";
import { auth } from "./firebase";
import { sendPasswordResetEmail, sendEmailVerification } from "firebase/auth";

const BASE_URL = process.env.REACT_APP_API_URL || "https://mcis-backend.onrender.com";

// P2.14 -- a settings/billing page was entirely missing from the frontend;
// this adds exactly two things, both honest about the current state of
// the backend rather than implying capabilities that don't exist:
//
// 1. Account/security: shows the signed-in email + verification status,
//    and reuses the same sendPasswordResetEmail/sendEmailVerification
//    calls added for Auth.js (P2.13) so a signed-in user has the same
//    recovery/verification tools without having to sign out first.
// 2. Billing: states plainly that every account is on the free tier and
//    that paid plans aren't available yet -- see
//    mcis/backend/docs/BILLING.md. This deliberately does NOT render a
//    pricing page, a "Subscribe"/checkout button, or any usage number
//    this frontend can't actually get from the server (there is no
//    GET /usage endpoint, and resolveServerSideTier() is an internal,
//    not an exposed, concept) -- a fake-looking billing UI would be
//    exactly the kind of fake integration this pass is forbidden from
//    creating.
// C3 (security hardening, pre-launch): a Settings/Data Controls UI was
// entirely missing from the frontend -- the backend's export/erase
// endpoints (routes/dataControls.js) existed with no way to reach them
// except a raw API call. This adds that UI as its own tab.
//
// Identity: the uid used in every request below is ALWAYS
// auth.currentUser.uid -- the signed-in Firebase user, never a value
// typed into a form field. There is deliberately no "export/delete
// user ID" input anywhere in this panel: the backend's own
// middleware/auth.js already rejects any request whose URL names a
// different user (403), so even a tampered request from this page
// could never reach another user's data -- but the UI itself should
// never offer that as something to type in the first place.
function DataControlsPanel() {
  const user = auth.currentUser;
  const [phase, setPhase] = useState("idle"); // "idle" | "exporting" | "export-done" | "export-error"
  const [exportError, setExportError] = useState("");
  const [confirmText, setConfirmText] = useState("");
  const [deletePhase, setDeletePhase] = useState("idle"); // "idle" | "confirming" | "deleting" | "done" | "error"
  const [deleteError, setDeleteError] = useState("");

  const handleExport = async () => {
    if (!user || phase === "exporting") return;
    setPhase("exporting");
    setExportError("");
    try {
      const res = await fetch(`${BASE_URL}/api/data-controls/${user.uid}/export`, { method: "GET" });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `Export failed (${res.status}).`);
      }
      const data = await res.json();
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `mcis-data-export-${user.uid}-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      setPhase("export-done");
    } catch (err) {
      setExportError(err.message || "Something went wrong exporting your data.");
      setPhase("export-error");
    }
  };

  const startDelete = () => {
    setDeletePhase("confirming");
    setConfirmText("");
    setDeleteError("");
  };

  const cancelDelete = () => {
    setDeletePhase("idle");
    setConfirmText("");
    setDeleteError("");
  };

  const handleDelete = async () => {
    if (!user || confirmText !== "DELETE" || deletePhase === "deleting") return;
    setDeletePhase("deleting");
    setDeleteError("");
    try {
      const res = await fetch(`${BASE_URL}/api/data-controls/${user.uid}`, {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirm: "DELETE" }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `Deletion failed (${res.status}).`);
      setDeletePhase("done");
    } catch (err) {
      setDeleteError(err.message || "Something went wrong deleting your data.");
      setDeletePhase("error");
    }
  };

  return (
    <>
      <div style={styles.card}>
        <div style={styles.cardLabel}>Export your data</div>
        <p style={styles.cardText}>
          Download a copy of everything stored under your account — chats,
          memories, goals, preferences, and more — as a JSON file. Secret
          values like connected-account tokens are never included.
        </p>
        <button style={styles.actionBtn} onClick={handleExport} disabled={phase === "exporting"}>
          {phase === "exporting" ? "Preparing export..." : "Export my data"}
        </button>
        {phase === "export-done" && (
          <div style={styles.successBox} role="status" aria-live="polite">
            Your data was downloaded to your device.
          </div>
        )}
        {phase === "export-error" && (
          <div style={styles.errorBox} role="alert">{exportError}</div>
        )}
      </div>

      <div style={{ ...styles.card, ...styles.dangerCard }}>
        <div style={styles.cardLabel}>Delete your data</div>
        {deletePhase === "done" ? (
          <div style={styles.successBox} role="status" aria-live="polite">
            Your account data has been deleted. (Deleting the sign-in account
            itself is separate — see below.)
          </div>
        ) : deletePhase === "confirming" || deletePhase === "deleting" || deletePhase === "error" ? (
          <>
            <p style={styles.cardText}>
              <strong>This cannot be undone.</strong> All chats, memories,
              goals, projects, and preferences tied to your account will be
              permanently erased.
            </p>
            <p style={styles.cardText}>
              Type <strong>DELETE</strong> below to confirm.
            </p>
            <input
              style={styles.textInput}
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value)}
              placeholder="Type DELETE to confirm"
              disabled={deletePhase === "deleting"}
              autoFocus
            />
            {deletePhase === "error" && <div style={styles.errorBox} role="alert">{deleteError}</div>}
            <div style={styles.confirmRow}>
              <button
                style={{ ...styles.actionBtn, ...styles.dangerBtn, ...(confirmText !== "DELETE" ? styles.btnDisabled : {}) }}
                onClick={handleDelete}
                disabled={confirmText !== "DELETE" || deletePhase === "deleting"}
              >
                {deletePhase === "deleting" ? "Deleting..." : "Permanently delete my data"}
              </button>
              <button style={styles.secondaryBtn} onClick={cancelDelete} disabled={deletePhase === "deleting"}>
                Cancel
              </button>
            </div>
          </>
        ) : (
          <>
            <p style={styles.cardText}>
              Permanently erase all data stored under your account. This
              cannot be undone.
            </p>
            <button style={{ ...styles.actionBtn, ...styles.dangerBtn }} onClick={startDelete}>
              Delete my data
            </button>
          </>
        )}
      </div>
    </>
  );
}

function SettingsPanel({ userId, onClose }) {
  const [tab, setTab] = useState("account"); // "account" | "billing" | "data"
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);

  const user = auth.currentUser;

  const handleResetPassword = async () => {
    if (!user?.email || busy) return;
    setBusy(true);
    setStatus("");
    try {
      await sendPasswordResetEmail(auth, user.email);
      setStatus("Password reset email sent to " + user.email + ".");
    } catch (err) {
      setStatus(err.message.replace("Firebase: ", ""));
    }
    setBusy(false);
  };

  const handleResendVerification = async () => {
    if (!user || busy) return;
    setBusy(true);
    setStatus("");
    try {
      await sendEmailVerification(user);
      setStatus("Verification email sent to " + user.email + ".");
    } catch (err) {
      setStatus(err.message.replace("Firebase: ", ""));
    }
    setBusy(false);
  };

  return (
    <div style={styles.overlay}>
      <div className="mcis-drawer-panel" style={styles.panel}>
        <div style={styles.header}>
          <div>
            <div style={styles.title}>Settings</div>
            <div style={styles.subtitle}>Account, security, and billing</div>
          </div>
          <button style={styles.closeBtn} onClick={onClose}>✕</button>
        </div>

        <div style={styles.tabRow}>
          <button
            style={{ ...styles.tabBtn, ...(tab === "account" ? styles.tabBtnActive : {}) }}
            onClick={() => { setTab("account"); setStatus(""); }}
          >
            Account & security
          </button>
          <button
            style={{ ...styles.tabBtn, ...(tab === "billing" ? styles.tabBtnActive : {}) }}
            onClick={() => { setTab("billing"); setStatus(""); }}
          >
            Billing
          </button>
          <button
            style={{ ...styles.tabBtn, ...(tab === "data" ? styles.tabBtnActive : {}) }}
            onClick={() => { setTab("data"); setStatus(""); }}
          >
            Data controls
          </button>
        </div>

        <div style={styles.body}>
          {tab === "account" && (
            <>
              <div style={styles.card}>
                <div style={styles.cardLabel}>Signed in as</div>
                <div style={styles.cardValue}>{user?.email || userId}</div>
                <div style={styles.verifyRow}>
                  {user?.emailVerified ? (
                    <span style={styles.verifiedBadge}>Email verified</span>
                  ) : (
                    <>
                      <span style={styles.unverifiedBadge}>Email not verified</span>
                      <button style={styles.linkBtn} onClick={handleResendVerification} disabled={busy}>
                        Resend verification email
                      </button>
                    </>
                  )}
                </div>
              </div>

              <div style={styles.card}>
                <div style={styles.cardLabel}>Password</div>
                <p style={styles.cardText}>
                  Send yourself a password reset link by email. The link lets you
                  set a new password without needing your current one.
                </p>
                <button style={styles.actionBtn} onClick={handleResetPassword} disabled={busy}>
                  {busy ? "Sending..." : "Send password reset email"}
                </button>
              </div>

              {status && <div style={styles.statusBox} role="status" aria-live="polite">{status}</div>}
            </>
          )}

          {tab === "billing" && (
            <div style={styles.card}>
              <div style={styles.planBadge}>Free plan</div>
              <p style={styles.cardText}>
                Your account is on the free plan. There are no paid plans
                available yet — every account today gets the same daily
                usage allowance, and nothing you do here can change that.
              </p>
              <p style={styles.cardText}>
                When paid plans launch, this page is where you'll be able
                to see your plan and manage billing. There's nothing to
                configure or subscribe to right now.
              </p>
            </div>
          )}

          {tab === "data" && <DataControlsPanel />}
        </div>
      </div>
    </div>
  );
}

const styles = {
  overlay: { position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'var(--mcis-overlay)', zIndex: 1000, display: 'flex', justifyContent: 'flex-end', backdropFilter: 'blur(8px)' },
  panel: { width: '100%', maxWidth: 460, height: '100vh', display: 'flex', flexDirection: 'column', overflow: 'hidden', boxShadow: 'var(--mcis-drawer-shadow)', background: 'var(--mcis-sidebar)' },
  header: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '22px 22px 16px', flexShrink: 0, borderBottom: '1px solid var(--mcis-border)' },
  title: { fontSize: 20, fontWeight: '800', color: 'var(--mcis-text)' },
  subtitle: { fontSize: 12, marginTop: 4, color: 'var(--mcis-muted)' },
  closeBtn: { background: 'transparent', border: '1px solid var(--mcis-border)', borderRadius: 8, cursor: 'pointer', padding: '6px 12px', fontSize: 14, color: 'var(--mcis-muted)' },
  tabRow: { display: 'flex', gap: 6, padding: '12px 16px', flexShrink: 0 },
  tabBtn: { flex: 1, borderRadius: 10, padding: '9px 10px', fontSize: 13, fontWeight: 700, cursor: 'pointer', border: '1px solid var(--mcis-border)', background: 'transparent', color: 'var(--mcis-muted)' },
  tabBtnActive: { background: 'var(--mcis-primary)', color: '#ffffff', border: '1px solid var(--mcis-primary)', boxShadow: 'var(--mcis-glow)' },
  body: { flex: 1, overflowY: 'auto', padding: '0 16px 16px', display: 'flex', flexDirection: 'column', gap: 12 },
  card: { background: 'var(--mcis-surface)', border: '1px solid var(--mcis-border)', borderRadius: 12, padding: '14px', boxShadow: 'var(--mcis-card-shadow)' },
  cardLabel: { fontSize: 11, fontWeight: 800, color: 'var(--mcis-muted)', textTransform: 'uppercase', letterSpacing: 0.4 },
  cardValue: { fontSize: 15, fontWeight: 700, color: 'var(--mcis-text)', marginTop: 4 },
  cardText: { fontSize: 13, lineHeight: 1.6, color: 'var(--mcis-muted)', margin: '8px 0 0' },
  verifyRow: { marginTop: 10, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' },
  verifiedBadge: { fontSize: 11, fontWeight: 700, color: '#00c9a7', border: '1px solid #00c9a7', borderRadius: 20, padding: '3px 10px' },
  unverifiedBadge: { fontSize: 11, fontWeight: 700, color: '#f7b731', border: '1px solid #f7b731', borderRadius: 20, padding: '3px 10px' },
  linkBtn: { background: 'transparent', border: 'none', color: 'var(--mcis-accent)', cursor: 'pointer', fontSize: 12, fontWeight: 700, padding: 0 },
  actionBtn: { marginTop: 12, background: 'var(--mcis-primary)', border: 'none', borderRadius: 10, color: '#ffffff', padding: '10px 14px', fontSize: 13, fontWeight: 700, cursor: 'pointer', boxShadow: 'var(--mcis-glow)' },
  statusBox: { fontSize: 13, color: 'var(--mcis-accent)', background: 'var(--mcis-subtle)', border: '1px solid var(--mcis-border)', borderRadius: 10, padding: '10px 12px' },
  planBadge: { display: 'inline-block', fontSize: 12, fontWeight: 800, color: 'var(--mcis-accent)', background: 'var(--mcis-subtle)', borderRadius: 20, padding: '4px 12px' },
  successBox: { marginTop: 12, fontSize: 13, color: '#00c9a7', background: 'var(--mcis-subtle)', border: '1px solid #00c9a7', borderRadius: 10, padding: '10px 12px' },
  errorBox: { marginTop: 12, fontSize: 13, color: '#ff5c5c', background: 'var(--mcis-subtle)', border: '1px solid #ff5c5c', borderRadius: 10, padding: '10px 12px' },
  dangerCard: { borderColor: '#ff5c5c33' },
  dangerBtn: { background: '#e03131', boxShadow: 'none' },
  btnDisabled: { opacity: 0.5, cursor: 'not-allowed' },
  secondaryBtn: { marginTop: 12, marginLeft: 10, background: 'transparent', border: '1px solid var(--mcis-border)', borderRadius: 10, color: 'var(--mcis-muted)', padding: '10px 14px', fontSize: 13, fontWeight: 700, cursor: 'pointer' },
  confirmRow: { display: 'flex', alignItems: 'center' },
  textInput: { marginTop: 10, width: '100%', boxSizing: 'border-box', background: 'var(--mcis-surface)', border: '1px solid var(--mcis-border)', borderRadius: 8, padding: '8px 10px', fontSize: 13, color: 'var(--mcis-text)' },
};

export default SettingsPanel;
