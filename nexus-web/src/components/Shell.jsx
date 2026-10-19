import { useState } from 'react';
import { Link, useRouter } from '../lib/router.jsx';
import { useAuth } from '../lib/auth.jsx';
import { useWorkspace } from '../lib/workspace.jsx';
import { ROLE_LABEL } from '../lib/format.js';
import { Button } from './ui.jsx';
import AskNexusDialog from './AskNexusDialog.jsx';

export const NAV = [
  { to: '/', label: 'Dashboard', icon: '▦' },
  { to: '/agents', label: 'AI Agents', icon: '◎' },
  { to: '/tasks', label: 'Tasks', icon: '▶' },
  { to: '/workflows', label: 'Workflows', icon: '⇄' },
  { to: '/approvals', label: 'Approvals', icon: '✓' },
  { to: '/integrations', label: 'Integrations', icon: '⧉' },
  { to: '/activity', label: 'Activity', icon: '≡' },
  { to: '/billing', label: 'Usage & Billing', icon: '◔' },
  { to: '/team', label: 'Team', icon: '☰' },
  { to: '/settings', label: 'Settings', icon: '⚙' },
];

function isActive(path, to) {
  return to === '/' ? path === '/' : path === to || path.startsWith(`${to}/`);
}

export default function Shell({ children }) {
  const { path } = useRouter();
  const { user, signOut } = useAuth();
  const { workspaces, current, select, role } = useWorkspace();
  const [asking, setAsking] = useState(false);
  const [navOpen, setNavOpen] = useState(false);

  return (
    <div className={`shell ${navOpen ? 'nav-open' : ''}`}>
      <aside className="sidebar" aria-label="Main navigation">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">N</span>
          <span className="brand-name">Nexus</span>
        </div>
        <nav>
          {NAV.map((n) => (
            <Link key={n.to} to={n.to} className={`nav-item ${isActive(path, n.to) ? 'active' : ''}`} aria-current={isActive(path, n.to) ? 'page' : undefined} onClick={() => setNavOpen(false)}>
              <span className="nav-icon" aria-hidden="true">{n.icon}</span>{n.label}
            </Link>
          ))}
        </nav>
      </aside>
      <div className="main">
        <header className="topbar">
          <button type="button" className="icon-btn menu-btn" aria-label="Toggle navigation" onClick={() => setNavOpen((v) => !v)}>☰</button>
          <label className="ws-switch">
            <span className="sr-only">Workspace</span>
            <select value={current ? current.id : ''} onChange={(e) => select(e.target.value)} aria-label="Workspace">
              {workspaces.map((w) => (
                <option key={w.id} value={w.id}>{w.is_personal ? `${w.name} (personal)` : w.name}</option>
              ))}
            </select>
          </label>
          {role ? <span className="role-pill">{ROLE_LABEL[role] || role}</span> : null}
          <div className="topbar-spacer" />
          <Button variant="primary" onClick={() => setAsking(true)}>+ Ask Nexus</Button>
          <div className="user-menu">
            <span className="avatar" aria-hidden="true">{((user && (user.displayName || user.email)) || '?').charAt(0).toUpperCase()}</span>
            <span className="user-email">{user && user.email}</span>
            <Button size="sm" variant="ghost" onClick={() => signOut()}>Sign out</Button>
          </div>
        </header>
        <main className="content" id="main">{children}</main>
      </div>
      {asking ? <AskNexusDialog onClose={() => setAsking(false)} /> : null}
    </div>
  );
}
