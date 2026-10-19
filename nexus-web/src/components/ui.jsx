import { useEffect, useRef } from 'react';
import { STATUS_TONE, humanize } from '../lib/format.js';

export function PageHeader({ title, description, actions }) {
  return (
    <header className="page-header">
      <div>
        <h1>{title}</h1>
        {description ? <p className="muted">{description}</p> : null}
      </div>
      {actions ? <div className="page-actions">{actions}</div> : null}
    </header>
  );
}

export function Card({ title, actions, children, className = '', ...rest }) {
  return (
    <section className={`card ${className}`} {...rest}>
      {title || actions ? (
        <div className="card-head">
          {title ? <h2>{title}</h2> : <span />}
          {actions || null}
        </div>
      ) : null}
      {children}
    </section>
  );
}

export function Stat({ label, value, hint, tone, testId }) {
  return (
    <div className={`stat ${tone ? `stat-${tone}` : ''}`} data-testid={testId}>
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      {hint ? <div className="stat-hint">{hint}</div> : null}
    </div>
  );
}

export function Badge({ status, children }) {
  const tone = STATUS_TONE[status] || 'neutral';
  return <span className={`badge badge-${tone}`}>{children || humanize(status)}</span>;
}

export function Button({ variant = 'secondary', size, busy, children, className = '', ...rest }) {
  return (
    <button
      type="button"
      className={`btn btn-${variant} ${size === 'sm' ? 'btn-sm' : ''} ${className}`}
      disabled={busy || rest.disabled}
      aria-busy={busy ? 'true' : undefined}
      {...rest}
    >
      {busy ? <span className="spinner" aria-hidden="true" /> : null}
      {children}
    </button>
  );
}

export function Loading({ label = 'Loading…' }) {
  return (
    <div className="state state-loading" role="status">
      <span className="spinner" aria-hidden="true" /> {label}
    </div>
  );
}

export function EmptyState({ title, children, action }) {
  return (
    <div className="state state-empty">
      <div className="state-title">{title}</div>
      {children ? <div className="muted">{children}</div> : null}
      {action ? <div className="state-action">{action}</div> : null}
    </div>
  );
}

export function ErrorState({ error, onRetry, title = 'Could not load this' }) {
  const status = error && error.status;
  return (
    <div className="state state-error" role="alert">
      <div className="state-title">{title}</div>
      <div className="muted">{(error && error.message) || 'Something went wrong.'}</div>
      {onRetry && status !== 403 && status !== 404 ? <Button size="sm" onClick={onRetry}>Try again</Button> : null}
    </div>
  );
}

/** Renders loading / error / content for a useResource() result. */
export function Resource({ res, children, loadingLabel, errorTitle }) {
  if (res.loading && !res.data) return <Loading label={loadingLabel} />;
  if (res.error && !res.data) return <ErrorState error={res.error} onRetry={res.reload} title={errorTitle} />;
  return children(res.data);
}

export function Modal({ title, onClose, children, footer }) {
  const ref = useRef(null);
  useEffect(() => {
    const prev = document.activeElement;
    const el = ref.current && ref.current.querySelector('input, textarea, select, button');
    if (el) el.focus();
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('keydown', onKey); if (prev && prev.focus) prev.focus(); };
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={title} ref={ref}>
        <div className="modal-head">
          <h2>{title}</h2>
          <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}>×</button>
        </div>
        <div className="modal-body">{children}</div>
        {footer ? <div className="modal-foot">{footer}</div> : null}
      </div>
    </div>
  );
}

export function Notice({ tone = 'info', title, children }) {
  return (
    <div className={`notice notice-${tone}`} role={tone === 'danger' ? 'alert' : 'note'}>
      {title ? <strong>{title}</strong> : null}
      <div>{children}</div>
    </div>
  );
}
