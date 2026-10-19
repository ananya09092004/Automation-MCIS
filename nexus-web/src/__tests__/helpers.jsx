import { render } from '@testing-library/react';
import App from '../App.jsx';
import { ApiError } from '../lib/api.js';

export const WS_TEAM = { id: '11111111-1111-4111-8111-111111111111', name: 'Acme Ops', is_personal: false, role: 'owner' };
export const WS_PERSONAL = { id: '22222222-2222-4222-8222-222222222222', name: 'Personal', is_personal: true, role: 'owner' };
export const USER = { uid: 'uid_alice', email: 'alice@acme.test', displayName: 'Alice', emailVerified: true };

/** Fake auth client: starts signed in (or out) synchronously. */
export function fakeAuth({ user = USER, signInError } = {}) {
  let cb = null;
  const client = {
    onChange: (fn) => { cb = fn; fn(user); return () => { cb = null; }; },
    signInWithEmail: async () => { if (signInError) throw signInError; cb && cb(USER); },
    signInWithGoogle: async () => { cb && cb(USER); },
    signOut: async () => { cb && cb(null); },
    getToken: async () => 'test-token',
  };
  return client;
}

/**
 * Fake API: routes = [[method, pathRegex, handler(match, opts, path)]].
 * Every call is recorded in api.calls; unknown routes → 404.
 */
export function fakeApi(routes) {
  const calls = [];
  const api = {
    calls,
    async request(path, opts = {}) {
      const method = opts.method || 'GET';
      calls.push({ method, path, body: opts.body, headers: opts.headers || {} });
      for (const [m, re, handler] of routes) {
        const match = method === m && path.match(re);
        if (match) return typeof handler === 'function' ? handler(match, opts, path) : handler;
      }
      throw new ApiError(404, 'NOT_FOUND', `No fake route for ${method} ${path}`);
    },
  };
  return api;
}

export const wsPath = (ws = WS_TEAM) => `/api/workspaces/${ws.id}`;

export function overviewFixture(over = {}) {
  return {
    workspace: { id: WS_TEAM.id, name: WS_TEAM.name, isPersonal: false, role: 'owner' },
    generatedAt: new Date().toISOString(),
    usage: { window: { days: 30 }, executions: 42, workflowRuns: 7, steps: 210, connectorCalls: 15, apiCalls: 3, outcomes: { completed: 38, failed: 4, cancelled: 0 }, successRate: 90.5, failureRate: 9.5 },
    executions: {
      sample: 12, byStatus: { completed: 9, failed: 2, executing: 1 }, successRate: 81.8,
      latencyMs: { avg: 4000, p50: 3200, p95: 9000 }, waitingApproval: 0, oldestApprovalWaitMinutes: null,
      recent: [{ id: 'exec-1', status: 'completed', goal: 'Summarize overdue GST filings', createdAt: new Date().toISOString(), finishedAt: null }],
    },
    workflowRuns: { sample: 3, byStatus: { completed: 2, waiting_approval: 1 }, successRate: 100, waitingApproval: 1, oldestApprovalWaitMinutes: 5 },
    approvals: { waiting: 1, oldestWaitMinutes: 5 },
    connectors: { total: 2, connected: 1, needsAttention: 1, failing: [] },
    tasks: { open: 4, assignedToMe: 1, assignedToAgent: 2 },
    detail: 'admin',
    failures: { windowDays: 30, quotaDenials: 0, billingFailures: 0, connectorFailures: 1, securityDenials: 3, auditSampleSize: 10 },
    ...over,
  };
}

export function renderApp({ api, auth = fakeAuth(), path = '/' } = {}) {
  window.history.replaceState({}, '', path);
  try { window.localStorage.clear(); } catch { /* ignore */ }
  return render(<App authClient={auth} api={api} initialPath={path} />);
}
