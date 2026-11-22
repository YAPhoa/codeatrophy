import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { exitDuration, movementDuration, token, useChangeCount } from '../lib/motion';
import { cx } from './Button';

// Small pieces that animate a change in place. Each plays only when what it
// shows changes after it has mounted; a first render is drawn at rest.

interface IconSwapProps {
  /** What the icon stands for; the swap plays when it changes. */
  swapKey: string | number | boolean;
  children: ReactNode;
  /** Opacity only, without the blur and scale of the swap. */
  plain?: boolean;
  className?: string;
}

/**
 * One icon slot that cross-fades the old icon into the new when `swapKey`
 * changes: both share one grid cell, the old one blurring and shrinking out
 * as the new one comes in (ui.css, `.icon-swap`). The slot keeps its size.
 * The new icon is marked `is-in` while it enters, for a stylesheet to add to
 * the entrance (a check that draws itself).
 */
export function IconSwap({ swapKey, children, plain, className }: IconSwapProps) {
  const [state, setState] = useState<{ key: IconSwapProps['swapKey']; node: ReactNode; leaving: ReactNode; n: number }>({
    key: swapKey,
    node: children,
    leaving: null,
    n: 0,
  });
  let current = state;
  if (state.key !== swapKey) {
    current = { key: swapKey, node: children, leaving: exitDuration('--duration-fast') > 0 ? state.node : null, n: state.n + 1 };
    setState(current);
  }
  const { n, leaving } = current;
  useEffect(() => {
    if (n === 0) return;
    const t = window.setTimeout(() => setState((s) => (s.n === n ? { ...s, leaving: null } : s)), exitDuration('--duration-fast'));
    return () => window.clearTimeout(t);
  }, [n]);
  return (
    <span className={cx('icon-swap', plain && 'is-plain', className)}>
      {leaving != null && (
        <span key={`out-${n}`} className="icon-swap-out" aria-hidden="true">
          {leaving}
        </span>
      )}
      <span key={`in-${n}`} className={cx('icon-swap-icon', n > 0 && 'is-in')}>
        {children}
      </span>
    </span>
  );
}

/** Where two labels part: how many letters they share at the start and at the end. */
export function sharedEnds(a: string, b: string): [number, number] {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let end = 0;
  while (end < a.length - start && end < b.length - start && a[a.length - 1 - end] === b[b.length - 1 - end]) end++;
  return [start, end];
}

/**
 * A short label that changes in place ("Copy" to "Copied"): the letters both
 * texts share stay put, only the part that differs cross-blurs, and its width
 * eases from the old part's to the new one's. The text is drawn for sight
 * only; give the accessible name elsewhere.
 */
export function MorphText({ text }: { text: string }) {
  const [state, setState] = useState<{ text: string; from: string | null; n: number }>({ text, from: null, n: 0 });
  let current = state;
  if (state.text !== text) {
    current = { text, from: exitDuration('--duration-fast') > 0 ? state.text : null, n: state.n + 1 };
    setState(current);
  }
  const { from, n } = current;
  const swapRef = useRef<HTMLSpanElement>(null);

  useLayoutEffect(() => {
    const swap = swapRef.current;
    const out = swap?.firstElementChild;
    const next = swap?.lastElementChild;
    if (!swap || !out || !next || typeof swap.animate !== 'function') return;
    const fade = exitDuration('--duration-quick');
    // The width eases only while motion is not reduced; the cross-fade plays either way.
    const resize = movementDuration('--duration-fast');
    const easing = token('--ease-out') || 'ease-out';
    const blur = `blur(${token('--blur-small') || '2px'})`;
    if (resize > 0) swap.animate([{ width: `${out.getBoundingClientRect().width}px` }, { width: `${next.getBoundingClientRect().width}px` }], { duration: resize, easing });
    out.animate([{ opacity: 1, filter: 'blur(0)' }, { opacity: 0, filter: blur }], { duration: fade, easing, fill: 'forwards' });
    next.animate([{ opacity: 0, filter: blur }, { opacity: 1, filter: 'blur(0)' }], { duration: fade, easing });
    const t = window.setTimeout(() => setState((s) => (s.n === n ? { ...s, from: null } : s)), Math.max(fade, resize));
    return () => window.clearTimeout(t);
  }, [n]);

  if (from === null) return <span className="morph">{text}</span>;
  const [start, end] = sharedEnds(from, text);
  return (
    <span className="morph">
      {text.slice(0, start)}
      <span ref={swapRef} className="morph-swap" key={n}>
        <span>{from.slice(start, from.length - end)}</span>
        <span>{text.slice(start, text.length - end)}</span>
      </span>
      {text.slice(text.length - end)}
    </span>
  );
}

/**
 * A short status beside a control ("Saving…", then "Saved") that changes in
 * place: its icon swaps and its words morph instead of cutting from one to
 * the next. What shows is drawn for sight only; the same words sit out of
 * sight in a live region of their own, so each state is announced once and
 * whole, never the halves of a morph. An empty `text` shows nothing.
 */
export function StatusSwap({ icon, text }: { icon?: ReactNode; text: string }) {
  return (
    <>
      <span className="status-swap" aria-hidden="true">
        <IconSwap swapKey={text}>{icon}</IconSwap>
        <MorphText text={text} />
      </span>
      <span className="sr-only" role="status">
        {text}
      </span>
    </>
  );
}

/**
 * Words that change in place where they may wrap, which MorphText cannot
 * (it holds to one line): the new words blur in where the old ones were
 * (ui.css, `.text-swap`). Plays when `swapKey` changes after it has mounted.
 * The words are the page's own, so a live region around them reads only the
 * new state.
 */
export function TextSwap({ swapKey, className, children }: { swapKey: string | number | boolean; className?: string; children: ReactNode }) {
  const n = useChangeCount(swapKey);
  return (
    <span key={n} className={cx('text-swap', n > 0 && 'is-in', className)}>
      {children}
    </span>
  );
}

/**
 * A count that cross-fades the digits that changed, in place: the old digit
 * leaves and the new one arrives, rising when the number went up and falling
 * when it went down (`.num-change` in ui.css). Digits that stayed do not move.
 */
export function NumberChange({ value }: { value: number }) {
  const [state, setState] = useState<{ value: number; prev: number | null; n: number }>({ value, prev: null, n: 0 });
  let current = state;
  if (state.value !== value) {
    current = { value, prev: exitDuration('--duration-medium') > 0 ? state.value : null, n: state.n + 1 };
    setState(current);
  }
  const { prev, n } = current;
  useEffect(() => {
    if (n === 0) return;
    const t = window.setTimeout(() => setState((s) => (s.n === n ? { ...s, prev: null } : s)), exitDuration('--duration-medium'));
    return () => window.clearTimeout(t);
  }, [n]);

  const text = String(value);
  if (prev === null) return <>{text}</>;
  const old = String(prev);
  const same = old.length === text.length;
  return (
    <span key={n} className="num-change" style={{ '--num-dir': value >= prev ? 1 : -1 } as CSSProperties}>
      {[...text].map((ch, i) =>
        same && old[i] === ch ? (
          ch
        ) : (
          <span key={i} className="num-slot">
            {same && (
              <span className="num-old" aria-hidden="true">
                {old[i]}
              </span>
            )}
            <span className="num-new">{ch}</span>
          </span>
        ),
      )}
    </span>
  );
}
