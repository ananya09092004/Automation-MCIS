import { useRef, useState } from 'react';
import { Button, Modal, Notice } from './ui.jsx';
import { useApi } from '../lib/apiContext.jsx';
import { useWorkspace } from '../lib/workspace.jsx';
import { useRouter } from '../lib/router.jsx';
import { useToast } from '../lib/toast.jsx';
import { endpoints } from '../lib/endpoints.js';
import { newIdempotencyKey } from '../lib/api.js';

export const MAX_GOAL = 2000; // same limit the backend enforces

/** Starts a real agent execution (POST /executions). Risky steps still pause for approval server-side. */
export default function AskNexusDialog({ onClose }) {
  const api = useApi();
  const { workspaceId, current } = useWorkspace();
  const { navigate } = useRouter();
  const toast = useToast();
  const [goal, setGoal] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  // One key per dialog: a double-submit or retry replays instead of starting twice.
  const key = useRef(newIdempotencyKey());

  const trimmed = goal.trim();
  const invalid = !trimmed ? 'Describe what Nexus should do.' : trimmed.length > MAX_GOAL ? `Keep it under ${MAX_GOAL} characters.` : null;

  async function submit(e) {
    e.preventDefault();
    if (invalid || busy) { setError(invalid); return; }
    setBusy(true);
    setError(null);
    try {
      const exec = await endpoints.startExecution(api, workspaceId, trimmed, key.current);
      toast.success('Task started');
      onClose();
      navigate(`/tasks/${exec.id}`);
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  return (
    <Modal title="Ask Nexus" onClose={onClose}>
      <form onSubmit={submit} noValidate>
        <label className="field">
          <span>What should Nexus do{current ? ` in ${current.name}` : ''}?</span>
          <textarea
            rows={5}
            value={goal}
            onChange={(e) => setGoal(e.target.value)}
            placeholder="e.g. Read the latest GST filing status for ACME Traders and summarize anything overdue"
            aria-invalid={error ? 'true' : undefined}
            maxLength={MAX_GOAL + 200}
          />
          <span className={`hint ${trimmed.length > MAX_GOAL ? 'text-danger' : ''}`}>{trimmed.length}/{MAX_GOAL}</span>
        </label>
        <Notice tone="info">Risky steps pause for approval according to your workspace policy. Nothing is sent or deleted without the required approval.</Notice>
        {error ? <p className="form-error" role="alert">{error}</p> : null}
        <div className="modal-foot inline">
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" busy={busy}>Start task</Button>
        </div>
      </form>
    </Modal>
  );
}
