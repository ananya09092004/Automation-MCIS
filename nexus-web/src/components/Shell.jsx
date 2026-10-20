import { useState } from 'react';
import { Link, useRouter } from '../lib/router.jsx';
import { useAuth } from '../lib/auth.jsx';
import { useWorkspace } from '../lib/workspace.jsx';
import { useToast } from '../lib/toast.jsx';
import { ROLE_LABEL } from '../lib/format.js';
import { Button } from './ui.jsx';
import Icon, { Brand } from './icons.jsx';
import AskNexusDialog from './AskNexusDialog.jsx';
import WorkspaceDialog from './WorkspaceDialog.jsx';

export const NAV_GROUPS = [
  { label: 'Operate', items: [
    { to: '/', label: 'Dashboard', icon: 'dashboard' },
    { to: '/tasks', label: 'Tasks', icon: 'tasks' },
    { to: '/agents', label: 'AI Agents', icon: 'agents' },
    { to: '/workflows', label: 'Workflows', icon: 'workflows' },
    { to: '/approvals', label: 'Approvals', icon: 'approvals' },
  ] },
  { label: 'Govern', items: [
    { to: '/security', label: 'Agent Firewall', icon: 'firewall' },
    { to: '/activity', label: 'Activity', icon: 'activity' },
    { to: '/integrations', label: 'Integrations', icon: 'integrations' },
  ] },
  { label: 'Workspace', items: [
    { to: '/billing', label: 'Usage & Billing', icon: 'billing' },
    { to: '/team', label: 'Team', icon: 'team' },
    { to: '/settings', label: 'Settings', icon: 'settings' },
  ] },
];
export const NAV = NAV_GROUPS.flatMap((g) => g.items);

function isActive(path, to) {
  return to === '/' ? path === '/' : path === to || path.startsWith(`${to}/`);
}

function VerifyBanner() {
  const { user, sendVerification } = useAuth();
  const toast = useToast();
  const [sent, setSent] = useState(false);
  if (!user || user.emailVerified !== false) return null;
  async function resend() {
    try { await sendVerification(); setSent(true); toast.success('Verification email sent'); } catch { toast.error('Could not send the email. Try again shortly.'); }
  }
  return (
    <div className="banner banner-warning" role="status">
      <Icon name="alert" size={16} />
      <span>Verify <strong>{user.email}</strong> to accept workspace invitations. Then sign out and back in.</span>
      <Button size="sm" variant="ghost" onClick={resend} disabled={sent}>{sent ? 'Email sent' : 'Resend email'}</Button>
    </div>
  );
}

export default function Shell({ children }) {
  const { path } = useRouter();
  const { user, signOut } = useAuth();
  const { workspaces, current, select, role } = useWorkspace();
  const [asking, setAsking] = useState(false);
  const [wsDialog, setWsDialog] = useState(false);
  const [navOpen, setNavOpen] = useState(false);
  const who = (user && (user.displayName || user.email)) || '?';

  return (
    <div className={`shell ${navOpen ? 'nav-open' : ''}`}>
      <a href="#main" className="skip-link">Skip to content</a>
      <aside className="sidebar" aria-label="Main navigation">
        <Brand />
        <nav>
          {NAV_GROUPS.map((g) => (
            <div className="nav-group" key={g.label} role="group" aria-label={`${g.label} pages`}>
              <div className="nav-group-label" aria-hidden="true">{g.label}</div>
              {g.items.map((n) => {
                const active = isActive(path, n.to);
                return (
                  <Link key={n.to} to={n.to} className={`nav-item ${active ? 'active' : ''}`} aria-current={active ? 'page' : undefined} onClick={() => setNavOpen(false)}>
                    <Icon name={n.icon} />{n.label}
                  </Link>
                );
              })}
            </div>
          ))}
        </nav>
        <div className="sidebar-foot">
          <div className="live"><span className="dot dot-signal" aria-hidden="true" />{current ? (current.is_personal ? 'Personal workspace' : 'Team workspace') : 'Workspace'}</div>
          <div className="small" style={{ color: 'var(--ink-muted)' }}>Data stays inside this workspace.</div>
        </div>
      </aside>
      <div className="nav-scrim" onClick={() => setNavOpen(false)} aria-hidden="true" />
      <div className="main">
        <header className="topbar">
          <button type="button" className="icon-btn menu-btn" aria-label="Toggle navigation" aria-expanded={navOpen} onClick={() => setNavOpen((v) => !v)}><Icon name="menu" size={20} /></button>
          <div className="ws-switch">
            <label>
              <span className="sr-only">Workspace</span>
              <select value={current ? current.id : ''} onChange={(e) => select(e.target.value)} aria-label="Workspace">
                {workspaces.map((w) => (
                  <option key={w.id} value={w.id}>{w.is_personal ? `${w.name} (personal)` : w.name}</option>
                ))}
              </select>
            </label>
            <button type="button" className="icon-btn" aria-label="Create or join a workspace" title="Create or join a workspace" onClick={() => setWsDialog(true)}><Icon name="plus" size={18} /></button>
          </div>
          {role ? <span className="role-pill">{ROLE_LABEL[role] || role}</span> : null}
          <div className="topbar-spacer" />
          <Button variant="signal" onClick={() => setAsking(true)} aria-label="Ask Nexus"><Icon name="spark" size={16} /><span className="ask-label">Ask Nexus</span></Button>
          <div className="user-menu">
            <span className="avatar" aria-hidden="true">{who.charAt(0).toUpperCase()}</span>
            <span className="user-email">{user && user.email}</span>
            <Button size="sm" variant="ghost" onClick={() => signOut()} aria-label="Sign out" title="Sign out"><Icon name="logout" size={16} /></Button>
          </div>
        </header>
        <VerifyBanner />
        <main className="content" id="main" tabIndex={-1}>{children}</main>
      </div>
      {asking ? <AskNexusDialog onClose={() => setAsking(false)} /> : null}
      {wsDialog ? <WorkspaceDialog onClose={() => setWsDialog(false)} /> : null}
    </div>
  );
}
