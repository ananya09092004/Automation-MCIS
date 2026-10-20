import { useState } from 'react';
import { Button, Modal, Notice } from './ui.jsx';
import { useApi } from '../lib/apiContext.jsx';
import { useWorkspace } from '../lib/workspace.jsx';
import { useToast } from '../lib/toast.jsx';
import { endpoints } from '../lib/endpoints.js';

const MAX_NAME = 100; // same limit the backend enforces

/** Create a team workspace, or join one with an invitation code. The server
 *  enforces every rule (name length, verified email, invite address, rate limits). */
export default function WorkspaceDialog({ onClose, initialMode = 'create', initialCode = '' }) {
  const api = useApi();
  const { adopt } = useWorkspace();
  const toast = useToast();
  const [mode, setMode] = useState(initialMode);
  const [name, setName] = useState('');
  const [code, setCode] = useState(initialCode);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function submit(e) {
    e.preventDefault();
    setError(null);
    if (mode === 'create') {
      const n = name.trim();
      if (!n) { setError('Give the workspace a name.'); return; }
      if (n.length > MAX_NAME) { setError(`Use at most ${MAX_NAME} characters.`); return; }
      setBusy(true);
      try {
        const ws = await endpoints.createWorkspace(api, n);
        await adopt(ws.id);
        toast.success(`Workspace "${ws.name || n}" created — you are the owner`);
        onClose();
      } catch (err) { setError(err.message); setBusy(false); }
    } else {
      const c = code.trim();
      if (!c) { setError('Paste the invitation code you received.'); return; }
      setBusy(true);
      try {
        const r = await endpoints.acceptInvitation(api, c);
        const ws = r && r.workspace;
        if (ws && ws.id) await adopt(ws.id);
        toast.success(ws && ws.name ? `You joined "${ws.name}"` : 'Invitation accepted');
        onClose();
      } catch (err) { setError(err.message); setBusy(false); }
    }
  }

  return (
    <Modal title="Workspaces" onClose={onClose}>
      <div className="seg" role="tablist" aria-label="Workspace action">
        <button type="button" role="tab" aria-selected={mode === 'create'} onClick={() => { setMode('create'); setError(null); }}>Create</button>
        <button type="button" role="tab" aria-selected={mode === 'join'} onClick={() => { setMode('join'); setError(null); }}>Join with code</button>
      </div>
      <form onSubmit={submit} noValidate style={{ marginTop: 16 }}>
        {mode === 'create' ? (
          <>
            <label className="field">
              <span>Workspace name</span>
              <input value={name} maxLength={MAX_NAME + 20} onChange={(e) => setName(e.target.value)} placeholder="e.g. Acme Operations" aria-invalid={error ? 'true' : undefined} />
            </label>
            <p className="small muted">A team workspace has its own agents, tasks, approvals, audit trail and usage. Data never crosses workspaces. You become its owner and can invite your team.</p>
          </>
        ) : (
          <>
            <label className="field">
              <span>Invitation code</span>
              <input className="mono" value={code} onChange={(e) => setCode(e.target.value)} placeholder="Paste the code from your invitation" autoComplete="off" spellCheck="false" aria-invalid={error ? 'true' : undefined} />
            </label>
            <p className="small muted">Invitations are tied to the email address they were sent to, and that address must be verified.</p>
          </>
        )}
        {error ? <Notice tone="danger">{error}</Notice> : null}
        <div className="modal-foot inline">
          <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant="primary" type="submit" busy={busy}>{mode === 'create' ? 'Create workspace' : 'Join workspace'}</Button>
        </div>
      </form>
    </Modal>
  );
}
