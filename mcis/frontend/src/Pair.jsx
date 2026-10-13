import React, { useState, useEffect } from "react";
import { auth } from "./firebase";
import { onAuthStateChanged } from "firebase/auth";

const BASE_URL = process.env.REACT_APP_API_URL || "https://mcis-backend.onrender.com";

function getSessionIdFromUrl() {
  const params = new URLSearchParams(window.location.search);
  return params.get("session");
}

function Pair() {
  const [user, setUser] = useState(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [status, setStatus] = useState("idle"); // idle | loading | success | error
  const [errorMsg, setErrorMsg] = useState("");

  const sessionId = getSessionIdFromUrl();

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (u) => {
      setUser(u);
      setAuthLoading(false);
    });
    return () => unsub();
  }, []);

  async function handleApprove() {
    setStatus("loading");
    setErrorMsg("");

    try {
      const res = await fetch(`${BASE_URL}/api/device/pair/approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId }),
      });
      const data = await res.json();

      if (data.success) {
        setStatus("success");
      } else {
        setStatus("error");
        setErrorMsg(data.error || "Could not approve this device.");
      }
    } catch (err) {
      setStatus("error");
      setErrorMsg("Something went wrong. Please try again.");
    }
  }

  if (authLoading) {
    return (
      <div className="mcis-loading-screen">
        <div className="mcis-loading-logo">M</div>
        <span className="mcis-loading-text">Loading...</span>
      </div>
    );
  }

  if (!sessionId) {
    return (
      <div style={styles.container}>
        <div style={styles.card}>
          <h2 style={styles.title}>Invalid link</h2>
          <p style={styles.text}>No pairing session was found in this link.</p>
        </div>
      </div>
    );
  }

  if (!user) {
    return (
      <div style={styles.container}>
        <div style={styles.card}>
          <h2 style={styles.title}>Please log in first</h2>
          <p style={styles.text}>
            Log in to MCIS in this browser, then reopen the link from your MCIS Agent.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div style={styles.container}>
      <div style={styles.card}>
        {status === "success" ? (
          <>
            <h2 style={styles.title}>✅ Device connected</h2>
            <p style={styles.text}>You can close this tab and go back to your laptop.</p>
          </>
        ) : (
          <>
            <h2 style={styles.title}>Connect this device to MCIS?</h2>
            <p style={styles.text}>
              A laptop is requesting access to run MCIS automation commands on your behalf.
              Only approve this if you just started MCIS Agent on your own device.
            </p>
            {errorMsg && <p style={styles.error}>{errorMsg}</p>}
            <button
              style={styles.button}
              onClick={handleApprove}
              disabled={status === "loading"}
            >
              {status === "loading" ? "Approving..." : "Approve"}
            </button>
          </>
        )}
      </div>
    </div>
  );
}

const styles = {
  container: {
    minHeight: "100vh",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: "20px",
    background: "var(--mcis-bg)",
    color: "var(--mcis-text)",
  },
  card: {
    maxWidth: "420px",
    width: "100%",
    padding: "32px",
    borderRadius: "12px",
    border: "1px solid var(--mcis-border)",
    background: "var(--mcis-surface)",
    textAlign: "center",
  },
  title: { marginBottom: "12px" },
  text: { marginBottom: "20px", color: "var(--mcis-muted)" },
  error: { color: "#ff6b6b", marginBottom: "16px" },
  button: {
    padding: "12px 28px",
    borderRadius: "20px",
    border: "none",
    background: "var(--mcis-primary)",
    color: "#fff",
    fontSize: "15px",
    fontWeight: "bold",
    cursor: "pointer",
  },
};

export default Pair;
