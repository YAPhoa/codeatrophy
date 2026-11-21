import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { AlertCircle, CheckCircle2, Info, X } from 'lucide-react';
import { errorLine } from '../lib/errors';
import { isAbort } from '../api/client';
import { exitDuration } from '../lib/motion';
import { titleIfCut } from '../lib/titleIfCut';
import { cx } from './Button';

type ToastKind = 'success' | 'error' | 'info';

interface ToastAction {
  label: string;
  onClick: () => void;
}

interface ToastItem {
  id: number;
  kind: ToastKind;
  message: string;
  action?: ToastAction;
  /** Playing its exit; it is removed once that is over. */
  leaving?: boolean;
}

interface ToastApi {
  success: (message: string, action?: ToastAction) => void;
  info: (message: string, action?: ToastAction) => void;
  /** Accepts a message or any thrown value; cancelled requests are ignored. */
  error: (error: unknown) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

const ICONS = { success: CheckCircle2, error: AlertCircle, info: Info };

/** A toast's time left: running while `handle` is set, paused otherwise. */
interface Countdown {
  handle: number;
  deadline: number;
  remaining: number;
}

/** The least time a toast gets back when the pointer or focus leaves the stack. */
const MIN_RESUME_MS = 2000;

/** How many toasts show at once; one more arriving sends the oldest out. */
const MAX_TOASTS = 4;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const seq = useRef(0);
  // Each toast's countdown. While the pointer is over the stack or focus is
  // in it, every countdown is paused, so an Undo cannot slip away under the
  // pointer; it picks up again on leaving, with at least MIN_RESUME_MS left.
  const timers = useRef(new Map<number, Countdown>());
  // The toasts on show, oldest first; one that is leaving is no longer among them.
  const shown = useRef<number[]>([]);
  const hovered = useRef(false);
  const focused = useRef(false);

  const dismiss = useCallback((id: number) => {
    // Already on its way out, or gone.
    if (!shown.current.includes(id)) return;
    shown.current = shown.current.filter((other) => other !== id);
    const timer = timers.current.get(id);
    if (timer?.handle) window.clearTimeout(timer.handle);
    timers.current.delete(id);
    const remove = () => setToasts((list) => list.filter((t) => t.id !== id));
    // The toast leaving, then its row closing, --duration-fast each; see ui.css.
    const ms = exitDuration('--duration-fast') * 2;
    if (ms === 0) {
      remove();
      return;
    }
    setToasts((list) => list.map((t) => (t.id === id ? { ...t, leaving: true } : t)));
    window.setTimeout(remove, ms);
  }, []);

  const start = useCallback(
    (id: number, timer: Countdown) => {
      timer.deadline = Date.now() + timer.remaining;
      timer.handle = window.setTimeout(() => dismiss(id), timer.remaining);
    },
    [dismiss],
  );

  const setPaused = useCallback(() => {
    const paused = hovered.current || focused.current;
    for (const [id, timer] of timers.current) {
      if (paused && timer.handle) {
        window.clearTimeout(timer.handle);
        timer.handle = 0;
        timer.remaining = Math.max(0, timer.deadline - Date.now());
      } else if (!paused && !timer.handle) {
        timer.remaining = Math.max(timer.remaining, MIN_RESUME_MS);
        start(id, timer);
      }
    }
  }, [start]);

  const push = useCallback(
    (kind: ToastKind, message: string, action?: ToastAction) => {
      const id = ++seq.current;
      setToasts((list) => [...list, { id, kind, message, action }]);
      shown.current.push(id);
      // The oldest leave the stack as any toast does, by its exit, never cut off.
      for (const old of shown.current.slice(0, -MAX_TOASTS)) dismiss(old);
      const timer: Countdown = { handle: 0, deadline: 0, remaining: kind === 'error' ? 9000 : action ? 7000 : 4000 };
      timers.current.set(id, timer);
      if (!hovered.current && !focused.current) start(id, timer);
    },
    [start, dismiss],
  );

  const api = useMemo<ToastApi>(
    () => ({
      success: (m, a) => push('success', m, a),
      info: (m, a) => push('info', m, a),
      error: (e) => {
        if (isAbort(e)) return;
        push('error', typeof e === 'string' ? e : errorLine(e));
      },
    }),
    [push],
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      {createPortal(
        // The live region is there before any toast is, which is what gets a new one read out.
        <div
          className="toasts"
          role="region"
          aria-label="Notifications"
          aria-live="polite"
          onPointerEnter={() => {
            hovered.current = true;
            setPaused();
          }}
          onPointerLeave={() => {
            hovered.current = false;
            setPaused();
          }}
          onFocus={() => {
            focused.current = true;
            setPaused();
          }}
          onBlur={(e) => {
            if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
            focused.current = false;
            setPaused();
          }}
        >
          {toasts.map((t) => {
            const Icon = ICONS[t.kind];
            return (
              // The slot closes up the space a leaving toast held, so the rest of the stack eases into place.
              <div key={t.id} className={cx('toast-slot', t.leaving && 'is-leaving')} inert={t.leaving}>
                <div className={`toast toast-${t.kind}`} role={t.kind === 'error' ? 'alert' : undefined}>
                  <Icon size={16} aria-hidden="true" className="toast-icon" />
                  <span className="grow toast-message" onMouseEnter={titleIfCut}>
                    {t.message}
                  </span>
                  {t.action && (
                    <button
                      type="button"
                      className="toast-action"
                      onClick={() => {
                        t.action?.onClick();
                        dismiss(t.id);
                      }}
                    >
                      {t.action.label}
                    </button>
                  )}
                  <button type="button" className="toast-close" aria-label="Dismiss" onClick={() => dismiss(t.id)}>
                    <X size={14} />
                  </button>
                </div>
              </div>
            );
          })}
        </div>,
        document.body,
      )}
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const api = useContext(ToastContext);
  if (!api) throw new Error('useToast must be used inside ToastProvider');
  return api;
}
