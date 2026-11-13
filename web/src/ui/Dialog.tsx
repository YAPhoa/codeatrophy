import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { Button, IconButton, cx } from './Button';

interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  footer?: ReactNode;
  size?: 'sm' | 'md' | 'lg';
  /** Do not close on Escape or a click on the backdrop (while a request is in flight, say). */
  locked?: boolean;
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"]), [contenteditable="true"]';

let openDialogs = 0;

/** Modal dialog: traps focus, closes on Escape, restores focus to the opener. */
export function Dialog({ open, onClose, title, children, footer, size = 'md', locked }: DialogProps) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();

  useEffect(() => {
    if (!open) return;
    const opener = document.activeElement as HTMLElement | null;
    const root = document.getElementById('root');
    openDialogs++;
    root?.setAttribute('inert', '');
    const el = ref.current;
    const first = el?.querySelector<HTMLElement>('[data-autofocus]') ?? el?.querySelector<HTMLElement>('.dialog-body ' + FOCUSABLE.split(', ').join(', .dialog-body '));
    (first ?? el)?.focus();
    return () => {
      openDialogs--;
      if (openDialogs === 0) root?.removeAttribute('inert');
      opener?.focus?.();
    };
  }, [open]);

  if (!open) return null;

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape' && !locked) {
      e.stopPropagation();
      onClose();
      return;
    }
    if (e.key !== 'Tab') return;
    // Popovers opened from inside the dialog render outside it; leave their focus handling alone.
    if (!ref.current?.contains(e.target as Node)) return;
    const focusable = Array.from(ref.current.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((n) => n.offsetParent !== null);
    if (focusable.length === 0) {
      e.preventDefault();
      return;
    }
    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  return createPortal(
    <div
      className="dialog-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !locked) onClose();
      }}
      onKeyDown={onKeyDown}
    >
      <div ref={ref} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} className={cx('dialog', `dialog-${size}`)}>
        <header className="dialog-header">
          <h2 id={titleId}>{title}</h2>
          <IconButton label="Close" size="sm" icon={<X size={16} />} onClick={onClose} disabled={locked} />
        </header>
        <div className="dialog-body">{children}</div>
        {footer && <footer className="dialog-footer">{footer}</footer>}
      </div>
    </div>,
    document.body,
  );
}

interface ConfirmOptions {
  title: string;
  body?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
}

type ConfirmFn = (options: ConfirmOptions) => Promise<boolean>;

const ConfirmContext = createContext<ConfirmFn | null>(null);

/** Provides `useConfirm()`: `if (await confirm({ title: 'Delete?' })) …`. */
export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<(ConfirmOptions & { resolve: (ok: boolean) => void }) | null>(null);

  const confirm = useCallback<ConfirmFn>(
    (options) => new Promise<boolean>((resolve) => setState({ ...options, resolve })),
    [],
  );

  const settle = (ok: boolean) => {
    state?.resolve(ok);
    setState(null);
  };

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      <Dialog
        open={state !== null}
        onClose={() => settle(false)}
        title={state?.title ?? ''}
        size="sm"
        footer={
          <>
            {/* A destructive confirm opens on Cancel, so a stray Enter does not delete anything. */}
            <Button onClick={() => settle(false)} data-autofocus={state?.danger ? true : undefined}>
              {state?.cancelLabel ?? 'Cancel'}
            </Button>
            <Button variant={state?.danger ? 'danger' : 'primary'} onClick={() => settle(true)} data-autofocus={state?.danger ? undefined : true}>
              {state?.confirmLabel ?? 'Confirm'}
            </Button>
          </>
        }
      >
        {state?.body && <div className="dialog-text">{state.body}</div>}
      </Dialog>
    </ConfirmContext.Provider>
  );
}

export function useConfirm(): ConfirmFn {
  const fn = useContext(ConfirmContext);
  if (!fn) throw new Error('useConfirm must be used inside ConfirmProvider');
  return fn;
}
