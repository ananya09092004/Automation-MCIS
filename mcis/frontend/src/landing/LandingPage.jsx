/**
 * Layer 8 — product landing page (served at /welcome).
 *
 * Copy describes only capabilities that exist in this codebase. No
 * guarantees, no compliance certifications, no "fully autonomous" claims.
 */
import React from "react";

const C = {
  page: { maxWidth: 1080, margin: "0 auto", padding: "32px 20px 64px", display: "grid", gap: 40, lineHeight: 1.5 },
  hero: { display: "grid", gap: 14, paddingTop: 24 },
  h1: { fontSize: 44, margin: 0, letterSpacing: -0.5 },
  tagline: { fontSize: 22, margin: 0, color: "var(--mcis-text, #222)" },
  lead: { fontSize: 16, margin: 0, color: "var(--mcis-muted, #555)", maxWidth: 720 },
  cta: { display: "flex", gap: 10, flexWrap: "wrap" },
  primary: { padding: "10px 18px", borderRadius: 10, background: "var(--mcis-primary-solid, #5b4bff)", color: "#fff", textDecoration: "none", fontWeight: 600 },
  secondary: { padding: "10px 18px", borderRadius: 10, border: "1px solid var(--mcis-border, #ccc)", color: "inherit", textDecoration: "none" },
  grid: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 14 },
  card: { border: "1px solid var(--mcis-border, #e5e5e5)", borderRadius: 12, padding: 16, display: "grid", gap: 6, background: "var(--mcis-surface, #fff)" },
  h2: { fontSize: 24, margin: "0 0 12px" },
  muted: { color: "var(--mcis-muted, #666)", fontSize: 14, margin: 0 },
};

export const FEATURES = [
  ["Connect tools", "Add approved REST APIs and GitHub repositories to a workspace. Credentials are encrypted, and each action can be switched on or off and limited by role."],
  ["Create workflows", "Start from a template or build your own: typed inputs, versioned steps, and runs you can start by hand, on a schedule or through the API."],
  ["Assign AI work", "Create tasks and assign them to a teammate or to the AI agent. The agent works through the same workflows and rules as everyone else."],
  ["Approve sensitive actions", "A workspace security policy decides what the agent may do. Actions that change things can wait for approval from the right person before they run."],
  ["Verify results", "Every step records what was done and whether it could be verified. Failures and unverified results are reported, not hidden."],
  ["Track usage", "See executions, workflow runs, connector and API calls per workspace, with your plan's limits and what remains this month."],
  ["Collaborate with your team", "Company workspaces with owner, admin and member roles, invitations, shared tasks and an audit log of important changes."],
];

const STEPS = [
  ["Set up a workspace", "Create a company workspace and invite your team."],
  ["Connect and choose", "Connect the tools you use and pick a workflow template."],
  ["Run with guardrails", "The agent carries out each step within your policy; sensitive actions wait for approval."],
  ["Review and repeat", "Check the evidence and result, then schedule it or call it from your own systems."],
];

export default function LandingPage() {
  return (
    <main style={C.page}>
      <header style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <strong style={{ fontSize: 20 }}>Nexus</strong>
        <span style={{ flex: 1 }} />
        <a href="/developers" style={{ color: "inherit" }}>API</a>
        <a href="/" style={C.secondary}>Sign in</a>
      </header>

      <section style={C.hero} aria-label="Introduction">
        <h1 style={C.h1}>Nexus</h1>
        <p style={C.tagline}>The secure execution and collaboration layer for business AI agents.</p>
        <p style={C.lead}>
          Connect your tools, turn repeatable work into workflows and let an AI agent carry them out — inside
          permissions you control, with approvals for sensitive actions, evidence for every step and usage you can see.
        </p>
        <div style={C.cta}>
          <a href="/onboarding" style={C.primary}>Get started free</a>
          <a href="/developers" style={C.secondary}>Read the API docs</a>
        </div>
      </section>

      <section aria-label="What you can do">
        <h2 style={C.h2}>What you can do with Nexus</h2>
        <div style={C.grid}>
          {FEATURES.map(([title, text]) => (
            <div key={title} style={C.card} data-testid="feature">
              <strong>{title}</strong>
              <p style={C.muted}>{text}</p>
            </div>
          ))}
        </div>
      </section>

      <section aria-label="How it works">
        <h2 style={C.h2}>How it works</h2>
        <ol style={{ ...C.grid, listStyle: "none", padding: 0, margin: 0 }}>
          {STEPS.map(([title, text], i) => (
            <li key={title} style={C.card}>
              <span style={C.muted}>Step {i + 1}</span>
              <strong>{title}</strong>
              <p style={C.muted}>{text}</p>
            </li>
          ))}
        </ol>
      </section>

      <section aria-label="Good to know" style={{ ...C.card, gap: 8 }}>
        <strong>Good to know</strong>
        <p style={C.muted}>
          AI agents can make mistakes. Nexus limits what they can do, asks before sensitive actions and shows its work so
          your team can check the result — you stay responsible for reviewing important outcomes.
        </p>
        <p style={C.muted}>A free plan is available. Paid plans and limits are shown in the app under Usage &amp; billing.</p>
      </section>

      <footer style={{ ...C.muted, display: "flex", gap: 16, flexWrap: "wrap" }}>
        <span>© Nexus</span>
        <a href="/onboarding" style={{ color: "inherit" }}>Get started</a>
        <a href="/developers" style={{ color: "inherit" }}>API</a>
        <a href="/" style={{ color: "inherit" }}>Sign in</a>
      </footer>
    </main>
  );
}
