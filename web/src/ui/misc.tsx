import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { AlertTriangle, Check, Copy, Info, Loader2, RotateCw, XCircle } from 'lucide-react';
import type { Tone } from '../lib/format';
import { describeError } from '../lib/errors';
import { Button, cx } from './Button';

export function Badge({ tone = 'neutral', children, title, className }: { tone?: Tone; children: ReactNode; title?: string; className?: string }) {
  return (
    <span className={cx('badge', `badge-${tone}`, className)} title={title}>
      {children}
    </span>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="kbd">{children}</kbd>;
}

export function Spinner({ size = 16, label }: { size?: number; label?: string }) {
  return (
    <span className="spin-wrap" role={label ? 'status' : undefined}>
      <Loader2 size={size} className="spin" aria-hidden="true" />
      {label && <span className="sr-only">{label}</span>}
    </span>
  );
}

export function PageLoading({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="page-state" role="status">
      <Loader2 size={20} className="spin" aria-hidden="true" />
      <span>{label}</span>
    </div>
  );
}

interface EmptyStateProps {
  icon?: ReactNode;
  title: string;
  children?: ReactNode;
  actions?: ReactNode;
  compact?: boolean;
}

export function EmptyState({ icon, title, children, actions, compact }: EmptyStateProps) {
  return (
    <div className={cx('empty', compact && 'empty-compact')}>
      {icon && (
        <div className="empty-icon" aria-hidden="true">
          {icon}
        </div>
      )}
      <h2 className="empty-title">{title}</h2>
      {children && <div className="empty-text">{children}</div>}
      {actions && <div className="empty-actions">{actions}</div>}
    </div>
  );
}

interface ErrorStateProps {
  error: unknown;
  onRetry?: () => void;
  compact?: boolean;
  /** Overrides the generic title for the error code. */
  title?: string;
}

/** Full presentation of a failed load or action, with the way forward that fits the error. */
export function ErrorState({ error, onRetry, compact, title }: ErrorStateProps) {
  const view = describeError(error);
  return (
    <div className={cx('empty', 'empty-error', compact && 'empty-compact')} role="alert">
      <div className="empty-icon" aria-hidden="true">
        <XCircle size={compact ? 18 : 26} />
      </div>
      <h2 className="empty-title">{title ?? view.title}</h2>
      <div className="empty-text">{view.message}</div>
      <div className="empty-actions">
        {view.action === 'ai-settings' && (
          <Link className="btn btn-default" to="/settings#ai">
            Open AI settings
          </Link>
        )}
        {view.action === 'judge-settings' && (
          <Link className="btn btn-default" to="/settings#judge">
            Judge status
          </Link>
        )}
        {onRetry && (view.action === 'retry' || view.action === 'judge-settings' || view.action === undefined) && (
          <Button icon={<RotateCw size={14} />} onClick={onRetry}>
            Try again
          </Button>
        )}
        {view.action === 'reload' && (
          <Button icon={<RotateCw size={14} />} onClick={onRetry ?? (() => window.location.reload())}>
            Reload
          </Button>
        )}
      </div>
    </div>
  );
}

interface CalloutProps {
  tone?: 'info' | 'warn' | 'danger' | 'ok';
  title?: ReactNode;
  children?: ReactNode;
  actions?: ReactNode;
  className?: string;
  role?: 'alert' | 'status' | 'note';
}

const CALLOUT_ICON = { info: Info, warn: AlertTriangle, danger: XCircle, ok: Check };

/** An inline notice: explanation, warning or error, optionally with actions. */
export function Callout({ tone = 'info', title, children, actions, className, role = 'note' }: CalloutProps) {
  const Icon = CALLOUT_ICON[tone];
  return (
    <div className={cx('callout', `callout-${tone}`, className)} role={role}>
      <Icon size={16} className="callout-icon" aria-hidden="true" />
      <div className="callout-body">
        {title && <div className="callout-title">{title}</div>}
        {children && <div className="callout-text">{children}</div>}
        {actions && <div className="callout-actions">{actions}</div>}
      </div>
    </div>
  );
}

/** Inline presentation of an action error (a failed save, a failed AI call). */
export function ErrorCallout({ error, onRetry, title }: { error: unknown; onRetry?: () => void; title?: string }) {
  const view = describeError(error);
  // The server's summary already states the first field's problem; the list
  // only adds something when there are several.
  const all = Object.entries(view.fields ?? {});
  const fields = all.length === 1 && all[0] && view.message.toLowerCase().includes(all[0][1].toLowerCase()) ? [] : all;
  return (
    <Callout
      tone="danger"
      role="alert"
      title={title ?? view.title}
      actions={
        <>
          {view.action === 'ai-settings' && <Link to="/settings#ai">Open AI settings</Link>}
          {view.action === 'judge-settings' && <Link to="/settings#judge">Judge status</Link>}
          {onRetry && view.action !== 'ai-settings' && (
            <Button size="sm" icon={<RotateCw size={13} />} onClick={onRetry}>
              Try again
            </Button>
          )}
        </>
      }
    >
      {view.message}
      {fields.length > 0 && (
        <ul className="callout-fields">
          {fields.map(([k, v]) => (
            <li key={k}>
              <code>{k}</code> {v}
            </li>
          ))}
        </ul>
      )}
    </Callout>
  );
}

export function CopyButton({ text, label = 'Copy', size = 'sm' }: { text: string; label?: string; size?: 'sm' | 'md' }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  return (
    <Button
      size={size}
      icon={copied ? <Check size={14} /> : <Copy size={14} />}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
        } catch {
          // Clipboard access needs a secure context; fall back to a selection-based copy.
          const ta = document.createElement('textarea');
          ta.value = text;
          ta.style.position = 'fixed';
          ta.style.opacity = '0';
          document.body.appendChild(ta);
          ta.select();
          document.execCommand('copy');
          ta.remove();
        }
        setCopied(true);
        window.clearTimeout(timer.current);
        timer.current = window.setTimeout(() => setCopied(false), 1600);
      }}
    >
      <span aria-live="polite">{copied ? 'Copied' : label}</span>
    </Button>
  );
}

interface TabsProps<T extends string> {
  label: string;
  value: T;
  onChange: (value: T) => void;
  tabs: readonly { value: T; label: ReactNode; count?: number | null }[];
  className?: string;
  /** Prefix for the tab and panel ids; pair with `tabPanelProps`. */
  idBase: string;
}

/** A tab list with roving focus (arrow keys). Render the panel yourself with `tabPanelProps`. */
export function Tabs<T extends string>({ label, value, onChange, tabs, className, idBase }: TabsProps<T>) {
  return (
    <div
      role="tablist"
      aria-label={label}
      className={cx('tabs', className)}
      onKeyDown={(e) => {
        if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
        const i = tabs.findIndex((t) => t.value === value);
        const next = tabs[(i + (e.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length];
        if (next) {
          onChange(next.value);
          requestAnimationFrame(() => document.getElementById(`${idBase}-tab-${next.value}`)?.focus());
        }
      }}
    >
      {tabs.map((t) => (
        <button
          key={t.value}
          type="button"
          role="tab"
          id={`${idBase}-tab-${t.value}`}
          aria-selected={value === t.value}
          aria-controls={`${idBase}-panel-${t.value}`}
          tabIndex={value === t.value ? 0 : -1}
          className={cx('tab', value === t.value && 'is-selected')}
          onClick={() => onChange(t.value)}
        >
          {t.label}
          {t.count != null && <span className="tab-count">{t.count}</span>}
        </button>
      ))}
    </div>
  );
}

export function tabPanelProps(idBase: string, value: string) {
  return { role: 'tabpanel' as const, id: `${idBase}-panel-${value}`, 'aria-labelledby': `${idBase}-tab-${value}` };
}
