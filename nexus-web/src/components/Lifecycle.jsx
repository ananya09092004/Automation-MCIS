import { TASK_STATE } from '../lib/format.js';

// Submitted → planned → executing → verified, as recorded by the server.
// "Awaiting approval" is shown only when the task actually paused for one.
const ORDER = ['created', 'planning', 'executing', 'verifying', 'done'];
const LABEL = { created: 'Queued', planning: 'Planning', executing: 'Running', verifying: 'Verifying', done: 'Done' };

export default function Lifecycle({ status, hadApproval }) {
  const terminal = ['completed', 'failed', 'cancelled'].includes(status);
  const at = status === 'waiting_approval' ? 'executing' : terminal ? 'done' : status;
  const idx = Math.max(0, ORDER.indexOf(at));
  const steps = ORDER.map((k) => ({ key: k, label: k === 'done' ? (terminal ? TASK_STATE[status] : LABEL.done) : LABEL[k] }));
  if (hadApproval || status === 'waiting_approval') steps.splice(3, 0, { key: 'approval', label: 'Approval' });
  const pos = (k) => steps.findIndex((s) => s.key === k);
  const current = status === 'waiting_approval' ? pos('approval') : pos(ORDER[idx]);
  return (
    <ol className={`lifecycle ${status === 'failed' ? 'is-failed' : ''} ${status === 'cancelled' ? 'is-cancelled' : ''}`} aria-label={`Task lifecycle: ${TASK_STATE[status] || status}`}>
      {steps.map((s, i) => {
        const state = i < current || (terminal && i <= current && status === 'completed') ? 'done' : i === current ? 'current' : 'todo';
        return (
          <li key={s.key} className={`lc-step lc-${state}`} aria-current={state === 'current' ? 'step' : undefined}>
            <span className="lc-dot" aria-hidden="true" />
            <span className="lc-label">{s.label}</span>
          </li>
        );
      })}
    </ol>
  );
}
