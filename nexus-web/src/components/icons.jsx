// Inline SVG icons (no icon library). 24×24 grid, stroke = currentColor.
import { useId } from 'react';
const P = {
  dashboard: <><rect x="3.5" y="3.5" width="7" height="7" rx="1.5" /><rect x="13.5" y="3.5" width="7" height="4.5" rx="1.5" /><rect x="13.5" y="11" width="7" height="9.5" rx="1.5" /><rect x="3.5" y="13.5" width="7" height="7" rx="1.5" /></>,
  agents: <><rect x="5" y="7" width="14" height="11" rx="3" /><path d="M12 7V4" /><circle cx="12" cy="3.5" r="0.9" /><circle cx="9.5" cy="12" r="1.1" /><circle cx="14.5" cy="12" r="1.1" /><path d="M9.5 15.3h5" /><path d="M3 11.5v3M21 11.5v3" /></>,
  tasks: <><path d="M8 6.5h12M8 12h12M8 17.5h12" /><path d="M3.5 5.2l1.4 1.3 2-2.2" /><path d="M3.5 10.7l1.4 1.3 2-2.2" /><circle cx="4.8" cy="17.5" r="1.1" /></>,
  workflows: <><circle cx="6" cy="6" r="2.2" /><circle cx="6" cy="18" r="2.2" /><circle cx="18" cy="12" r="2.2" /><path d="M6 8.2v7.6" /><path d="M8.2 6.2c5 0 7.8 1.6 7.8 3.6" /><path d="M8.2 17.8c5 0 7.8-1.6 7.8-3.6" /></>,
  approvals: <><path d="M12 3.2l7 2.8v5.3c0 4.3-2.9 7.6-7 9.5-4.1-1.9-7-5.2-7-9.5V6z" /><path d="M8.8 12.2l2.2 2.2 4.3-4.6" /></>,
  firewall: <><path d="M12 3.2l7 2.8v5.3c0 4.3-2.9 7.6-7 9.5-4.1-1.9-7-5.2-7-9.5V6z" /><path d="M5.5 10.5h13M12 6.5v14" /></>,
  integrations: <><path d="M9 3.5v4M15 3.5v4" /><path d="M6.5 7.5h11v3.5a5.5 5.5 0 01-11 0z" /><path d="M12 16.5v4" /></>,
  activity: <path d="M3 12h4l2.5-6 5 12 2.5-6h4" />,
  billing: <><path d="M4.5 16a8 8 0 1115 0" /><path d="M12 16l3.5-5" /><circle cx="12" cy="16" r="1.2" /><path d="M4 20h16" /></>,
  team: <><circle cx="9" cy="8.5" r="3" /><path d="M3.5 19c.6-3 2.8-4.7 5.5-4.7s4.9 1.7 5.5 4.7" /><circle cx="17" cy="9.5" r="2.4" /><path d="M16.5 14.4c2.2.2 3.7 1.7 4.1 4.1" /></>,
  settings: <><path d="M4 7h9M17 7h3M4 17h3M11 17h9" /><circle cx="15" cy="7" r="2" /><circle cx="9" cy="17" r="2" /></>,
  plus: <path d="M12 5v14M5 12h14" />,
  chart: <><path d="M4 20h16" /><rect x="6" y="11" width="3" height="6" rx="1" /><rect x="11" y="7" width="3" height="10" rx="1" /><rect x="16" y="13" width="3" height="4" rx="1" /></>,
  compare: <><rect x="3.5" y="4.5" width="7" height="15" rx="1.5" /><rect x="13.5" y="4.5" width="7" height="15" rx="1.5" /><path d="M6 9h2M6 12.5h2M16 9h2M16 12.5h2" /></>,
  spark: <><path d="M12 3.5l1.9 5.1 5.1 1.9-5.1 1.9L12 17.5l-1.9-5.1L5 10.5l5.1-1.9z" /><path d="M18.5 16.5l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z" /></>,
  user: <><circle cx="12" cy="8.5" r="3.5" /><path d="M5 20c.8-3.6 3.6-5.6 7-5.6s6.2 2 7 5.6" /></>,
  tool: <path d="M14.7 6.3a4 4 0 00-5 5L4 17v3h3l5.7-5.7a4 4 0 005-5l-2.5 2.5-2.3-.7-.7-2.3z" />,
  lock: <><rect x="5" y="10.5" width="14" height="10" rx="2" /><path d="M8 10.5V8a4 4 0 018 0v2.5" /></>,
  eye: <><path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" /><circle cx="12" cy="12" r="2.8" /></>,
  eyeOff: <><path d="M4 4l16 16" /><path d="M9.9 6A9.6 9.6 0 0112 5.5c6 0 9.5 6.5 9.5 6.5a16 16 0 01-2.7 3.4M6.6 7.6C4 9.4 2.5 12 2.5 12s3.5 6.5 9.5 6.5a9 9 0 004.1-1" /></>,
  menu: <path d="M4 7h16M4 12h16M4 17h16" />,
  check: <path d="M5 12.5l4.5 4.5L19 7.5" />,
  x: <path d="M6 6l12 12M18 6L6 18" />,
  alert: <><path d="M12 4l9 16H3z" /><path d="M12 10v4.5" /><circle cx="12" cy="17.2" r="0.6" /></>,
  arrow: <path d="M5 12h14M13 6l6 6-6 6" />,
  logout: <><path d="M14 4.5h4.5v15H14" /><path d="M10 8l-4 4 4 4M6 12h10" /></>,
};

export default function Icon({ name, size = 18, className = '', title }) {
  return (
    <svg className={`icon ${className}`} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden={title ? undefined : 'true'} role={title ? 'img' : undefined}
      focusable="false">
      {title ? <title>{title}</title> : null}
      {P[name] || null}
    </svg>
  );
}

/** Nexus mark: three agents joined through one secured centre node. */
export function BrandMark({ size = 30 }) {
  // Unique gradient id per instance: a shared id breaks when the first copy is display:none.
  const gid = `nx-g-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  return (
    <svg className="brand-mark" width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#6d6af8" />
          <stop offset="1" stopColor="#2bc5d9" />
        </linearGradient>
      </defs>
      <rect width="32" height="32" rx="9" fill={`url(#${gid})`} />
      <g stroke="#fff" strokeWidth="1.8" strokeLinecap="round" fill="none" opacity="0.95">
        <path d="M16 16L9 9.5M16 16l7-6.5M16 16v8" />
      </g>
      <circle cx="9" cy="9.5" r="2.4" fill="#fff" />
      <circle cx="23" cy="9.5" r="2.4" fill="#fff" />
      <circle cx="16" cy="24" r="2.4" fill="#fff" />
      <circle cx="16" cy="16" r="3.4" fill="#0b1120" stroke="#fff" strokeWidth="1.6" />
    </svg>
  );
}

export function Brand({ size }) {
  return (
    <span className="brand">
      <BrandMark size={size} />
      <span className="brand-name">Nexus</span>
    </span>
  );
}
