import { useCallback, useEffect, useRef, type ReactNode } from 'react';
import { useBlocker } from 'react-router';
import { Button } from './Button';
import { Dialog } from './Dialog';

interface LeaveGuardOptions {
  /** Whether the page holds work that leaving would lose. */
  when: boolean;
  title?: string;
  /** What would be lost, in a sentence. */
  body: ReactNode;
  stayLabel?: string;
  leaveLabel?: string;
}

/**
 * Guards unsaved work against being left behind: moving to another page asks
 * first, and closing or reloading the tab brings up the browser's own
 * prompt. A change of query string or hash on the same page is not leaving.
 *
 * Render `dialog` somewhere in the page. Call `allow()` right before a
 * navigation the page makes itself once the work is safe (after a save).
 * A page can hold one guard: the router supports a single blocker.
 */
export function useLeaveGuard({ when, title = 'Leave without saving?', body, stayLabel = 'Stay', leaveLabel = 'Discard and leave' }: LeaveGuardOptions): {
  dialog: ReactNode;
  allow: () => void;
} {
  const allowed = useRef(false);
  const blocker = useBlocker(({ currentLocation, nextLocation }) => when && !allowed.current && currentLocation.pathname !== nextLocation.pathname);

  useEffect(() => {
    if (!when) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (!allowed.current) e.preventDefault();
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [when]);

  const allow = useCallback(() => {
    allowed.current = true;
  }, []);

  const dialog = (
    <Dialog
      open={blocker.state === 'blocked'}
      onClose={() => blocker.reset?.()}
      title={title}
      size="sm"
      footer={
        <>
          <Button onClick={() => blocker.reset?.()} data-autofocus>
            {stayLabel}
          </Button>
          <Button variant="danger" onClick={() => blocker.proceed?.()}>
            {leaveLabel}
          </Button>
        </>
      }
    >
      <div className="dialog-text">{body}</div>
    </Dialog>
  );

  return { dialog, allow };
}
