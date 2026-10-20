import { useState } from 'react';
import { Button, Card, PageHeader } from '../components/ui.jsx';
import WorkspaceDialog from '../components/WorkspaceDialog.jsx';
import { useRouter } from '../lib/router.jsx';

/** Reads an invitation code from the link fragment (#invite=…) once and removes
 *  it from the address bar, so it is not kept in history or shared by copy/paste. */
function takeInviteFromHash() {
  if (typeof window === 'undefined') return '';
  const m = /(?:^#|&)invite=([^&]+)/.exec(window.location.hash || '');
  if (!m) return '';
  try { window.history.replaceState(window.history.state, '', window.location.pathname + window.location.search); } catch { /* ignore */ }
  try { return decodeURIComponent(m[1]); } catch { return ''; }
}

export default function JoinWorkspace() {
  const { navigate } = useRouter();
  const [code] = useState(takeInviteFromHash);
  const [open, setOpen] = useState(true);
  return (
    <>
      <PageHeader eyebrow="Workspaces" title="Join a workspace" description="Accept an invitation from your team, or create a workspace of your own." />
      <Card>
        <p className="muted">{code ? 'Your invitation code is ready. Review it and choose Join workspace.' : 'Paste the invitation code you received, or create a new team workspace.'}</p>
        <div className="row">
          <Button variant="primary" onClick={() => setOpen(true)}>{code ? 'Review invitation' : 'Join or create'}</Button>
          <Button variant="ghost" onClick={() => navigate('/')}>Go to dashboard</Button>
        </div>
      </Card>
      {open ? <WorkspaceDialog initialMode={code ? 'join' : 'create'} initialCode={code} onClose={() => { setOpen(false); navigate('/'); }} /> : null}
    </>
  );
}
