import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { AlertCircle, CheckCircle2, Info, X } from 'lucide-react';
import { errorLine } from '../lib/errors';
import { isAbort } from '../api/client';

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
}

interface ToastApi {
  success: (message: string, action?: ToastAction) => void;
  info: (message: string, action?: ToastAction) => void;
  /** Accepts a message or any thrown value; cancelled requests are ignored. */
  error: (error: unknown) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

const ICONS = { success: CheckCircle2, error: AlertCircle, info: Info };

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const seq = useRef(0);

  const dismiss = useCallback((id: number) => setToasts((list) => list.filter((t) => t.id !== id)), []);

  const push = useCallback(
    (kind: ToastKind, message: string, action?: ToastAction) => {
      const id = ++seq.current;
      setToasts((list) => [...list.slice(-3), { id, kind, message, action }]);
      window.setTimeout(() => dismiss(id), kind === 'error' ? 9000 : action ? 7000 : 4000);
    },
    [dismiss],
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
        <div className="toasts" role="region" aria-label="Notifications" aria-live="polite">
          {toasts.map((t) => {
            const Icon = ICONS[t.kind];
            return (
              <div key={t.id} className={`toast toast-${t.kind}`} role={t.kind === 'error' ? 'alert' : undefined}>
                <Icon size={16} aria-hidden="true" className="toast-icon" />
                <span className="grow">{t.message}</span>
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
