import { useCallback, useEffect, useId, useLayoutEffect, useRef, useSyncExternalStore, type ReactNode, type SyntheticEvent } from 'react';
import { createPortal } from 'react-dom';
import { parseDuration, token } from '../lib/motion';

// The rail has one label, shared by every control on it (RailTipLabel draws
// it): the control the pointer or keyboard focus came to last. Its motion
// follows the tooltip tokens in tokens.css: the first label waits
// --duration-micro, then fades and scales in over --duration-quick; it goes in
// --duration-instant; moving on to another control while it shows, the one
// label travels there over --duration-quick, with no wait.

interface Shown {
  id: string;
  label: string;
  anchor: HTMLElement;
}

let shown: Shown | null = null;
// What showed last, kept while it fades out, and when it went.
let last: Shown | null = null;
let hiddenAt = -Infinity;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

function show(next: Shown) {
  if (shown && shown.id === next.id && shown.label === next.label && shown.anchor === next.anchor) return;
  shown = next;
  last = next;
  emit();
}

function hide(id: string) {
  if (shown?.id !== id) return;
  shown = null;
  hiddenAt = performance.now();
  emit();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Names the one control it wraps with the rail's label, beside it to its
 * right, while the pointer is on it or keyboard focus comes to it. The label
 * repeats the control's accessible name, so it is hidden from assistive
 * technology, and the control should carry no `title`.
 *
 * It goes on Escape, when the pointer leaves or presses, when focus leaves,
 * and while the control has a popover of its own open (`aria-expanded`). The
 * wrapper is `display: contents`, so the control lays out as if it were not
 * there. Render RailTipLabel once wherever these are.
 */
export function RailTip({ label, children }: { label: string; children: ReactNode }) {
  const id = useId();
  const wrapRef = useRef<HTMLSpanElement>(null);
  const isShown = useSyncExternalStore(subscribe, () => shown?.id === id, () => false);

  const put = useCallback(() => hide(id), [id]);

  const bring = () => {
    const control = wrapRef.current?.firstElementChild;
    if (!(control instanceof HTMLElement) || control.getAttribute('aria-expanded') === 'true') return;
    show({ id, label, anchor: control });
  };

  // A label whose text changes while it shows (a count) follows it.
  useEffect(() => {
    if (shown?.id === id && shown.label !== label) show({ ...shown, label });
  }, [id, label]);

  // Only events from the control itself: a popover it opened is portalled
  // elsewhere in the page but still bubbles through here.
  const fromControl = (e: SyntheticEvent) => wrapRef.current?.contains(e.target as Node) === true;

  useEffect(() => put, [put]);

  // A popover the control opens while its label shows puts the label away.
  useEffect(() => {
    const control = shown?.id === id ? shown.anchor : null;
    if (!isShown || !control || typeof MutationObserver === 'undefined') return;
    const mo = new MutationObserver(() => {
      if (control.getAttribute('aria-expanded') === 'true') put();
    });
    mo.observe(control, { attributes: true, attributeFilter: ['aria-expanded'] });
    return () => mo.disconnect();
  }, [isShown, id, put]);

  return (
    <span
      ref={wrapRef}
      className="rail-tip-anchor"
      onPointerEnter={(e) => {
        if (e.pointerType !== 'touch' && fromControl(e)) bring();
      }}
      onPointerLeave={put}
      onPointerDown={put}
      onFocus={(e) => {
        if (fromControl(e) && (e.target as Element).matches(':focus-visible')) bring();
      }}
      onBlur={(e) => {
        if (fromControl(e)) put();
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && isShown && fromControl(e)) {
          e.stopPropagation();
          put();
        }
      }}
    >
      {children}
    </span>
  );
}

/** Space between a control and its label, and the least between the label and the window's edge. */
const BESIDE = 8;
const MARGIN = 8;

/**
 * The rail's one label, on the top layer of the page. Always in the page
 * while the rail is, and hidden (`visibility`, once its exit has played)
 * while no label shows, so it never blocks anything; it takes no focus or
 * pointer events. The stylesheet owns every tween (`.rail-tip` in
 * layout.css); this writes where it goes and how wide it is.
 */
export function RailTipLabel() {
  const current = useSyncExternalStore(subscribe, () => shown, () => null);
  const ref = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLSpanElement>(null);
  const text = (current ?? last)?.label ?? '';

  useLayoutEffect(() => {
    const el = ref.current;
    const span = textRef.current;
    if (!el || !span) return;
    if (!current) {
      el.dataset.show = 'false';
      return;
    }
    const place = () => {
      const cs = getComputedStyle(el);
      const width = Math.ceil(span.offsetWidth + parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight) + parseFloat(cs.borderLeftWidth) + parseFloat(cs.borderRightWidth));
      const height = el.offsetHeight;
      const a = current.anchor.getBoundingClientRect();
      const x = Math.max(MARGIN, Math.min(a.right + BESIDE, window.innerWidth - width - MARGIN));
      const y = Math.max(MARGIN, Math.min(a.top + a.height / 2 - height / 2, window.innerHeight - height - MARGIN));
      el.style.width = `${width}px`;
      el.style.setProperty('--tip-x', `${x}px`);
      el.style.setProperty('--tip-y', `${y}px`);
    };
    // Showing, or still fading out from a moment ago: it travels to the new
    // control, with no wait. Otherwise it is put there at once, unseen, and
    // only its entrance plays.
    const travels = el.dataset.show === 'true' || performance.now() - hiddenAt < parseDuration(token('--duration-instant'));
    if (travels) {
      el.dataset.travel = '';
      place();
    } else {
      delete el.dataset.travel;
      el.style.transition = 'none';
      place();
      void el.offsetWidth;
      el.style.transition = '';
    }
    el.dataset.show = 'true';
  }, [current]);

  // Kept beside its control if the window or the rail moves it.
  useEffect(() => {
    if (!current) return;
    const follow = () => {
      const el = ref.current;
      if (!el) return;
      const a = current.anchor.getBoundingClientRect();
      const y = Math.max(MARGIN, Math.min(a.top + a.height / 2 - el.offsetHeight / 2, window.innerHeight - el.offsetHeight - MARGIN));
      el.style.setProperty('--tip-y', `${y}px`);
    };
    window.addEventListener('resize', follow);
    window.addEventListener('scroll', follow, true);
    return () => {
      window.removeEventListener('resize', follow);
      window.removeEventListener('scroll', follow, true);
    };
  }, [current]);

  if (typeof document === 'undefined') return null;
  return createPortal(
    <div ref={ref} className="rail-tip" data-show="false" aria-hidden="true">
      <span ref={textRef} className="rail-tip-text">
        {text}
      </span>
    </div>,
    document.body,
  );
}
