export const STATUS_TONE = {
  completed: 'success', succeeded: 'success', connected: 'success', active: 'success', verified: 'success', approved: 'success',
  failed: 'danger', error: 'danger', rejected: 'danger', expired: 'danger', revoked: 'danger',
  waiting_approval: 'warning', needs_review: 'warning', pending: 'warning', paused: 'warning', degraded: 'warning', unverified: 'warning',
  planning: 'info', executing: 'info', verifying: 'info', running: 'info', created: 'info', queued: 'info',
  green: 'success', yellow: 'warning', red: 'danger',
  cancelled: 'neutral', archived: 'neutral', disconnected: 'neutral', draft: 'neutral', none: 'neutral',
};

export function humanize(s) {
  if (s === null || s === undefined || s === '') return '—';
  const t = String(s).replace(/[_-]+/g, ' ');
  return t.charAt(0).toUpperCase() + t.slice(1);
}

export function fmtNumber(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  return new Intl.NumberFormat('en-US').format(n);
}

export function fmtPercent(n) {
  return n === null || n === undefined ? '—' : `${n}%`;
}

export function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function timeAgo(iso, now = Date.now()) {
  if (!iso) return '—';
  const s = Math.round((now - new Date(iso).getTime()) / 1000);
  if (!Number.isFinite(s)) return '—';
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export function fmtDuration(ms) {
  if (ms === null || ms === undefined) return '—';
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)} s`;
  return `${Math.round(ms / 60000)} min`;
}

export const ACTIVE_EXECUTION = ['created', 'planning', 'executing', 'verifying', 'waiting_approval'];
export const ROLE_LABEL = { owner: 'Owner', admin: 'Admin', member: 'Member' };

/** User-facing task (execution) states. Backend statuses are mapped, never invented. */
export const TASK_STATE = {
  created: 'Queued', planning: 'Planning', executing: 'Running', verifying: 'Verifying',
  waiting_approval: 'Awaiting approval', completed: 'Completed', failed: 'Failed', cancelled: 'Cancelled',
};
export const taskState = (s) => TASK_STATE[s] || humanize(s);
