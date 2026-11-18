import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react';
import { readJson, writeJson } from '../lib/storage';
import { cx } from './Button';

interface SplitPaneProps {
  /** `horizontal` puts the panes side by side; `vertical` stacks them. */
  direction: 'horizontal' | 'vertical';
  first: ReactNode;
  second: ReactNode;
  /** Fraction of the space given to the first pane, 0–1. */
  initial?: number;
  min?: number;
  max?: number;
  /** The largest the first pane may grow, in pixels: past it the divider stops, rather than opening empty space. */
  maxFirstPx?: number;
  /** Remember the position under this key. */
  storageKey?: string;
  label: string;
  className?: string;
  /**
   * Minimise one of the panes: `bar` is shown in its place and the other pane
   * takes the space. The pane stays mounted and the divider keeps its
   * position, so restoring brings everything back as it was.
   */
  collapsed?: 'first' | 'second' | null;
  bar?: ReactNode;
}

/** Two panes with a draggable, keyboard-adjustable divider. */
export function SplitPane({ direction, first, second, initial = 0.5, min = 0.2, max = 0.8, maxFirstPx, storageKey, label, className, collapsed = null, bar }: SplitPaneProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [ratio, setRatio] = useState(() => {
    const stored = storageKey ? readJson<number | null>(`split:${storageKey}`, null) : null;
    return typeof stored === 'number' && stored >= min && stored <= max ? stored : initial;
  });
  const dragging = useRef(false);

  useEffect(() => {
    if (storageKey) writeJson(`split:${storageKey}`, ratio);
  }, [ratio, storageKey]);

  // The upper bound as a fraction of the space there is now.
  const upper = useCallback(() => {
    const el = containerRef.current;
    if (!maxFirstPx || !el) return max;
    const size = direction === 'horizontal' ? el.clientWidth : el.clientHeight;
    return size > 0 ? Math.max(min, Math.min(max, maxFirstPx / size)) : max;
  }, [direction, maxFirstPx, min, max]);
  const clamp = useCallback((r: number) => Math.max(min, Math.min(upper(), r)), [min, upper]);

  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!dragging.current || !containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    const r = direction === 'horizontal' ? (e.clientX - rect.left) / rect.width : (e.clientY - rect.top) / rect.height;
    setRatio(clamp(r));
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const back = direction === 'horizontal' ? 'ArrowLeft' : 'ArrowUp';
    const fwd = direction === 'horizontal' ? 'ArrowRight' : 'ArrowDown';
    if (e.key === back) {
      e.preventDefault();
      setRatio((r) => clamp(r - 0.03));
    } else if (e.key === fwd) {
      e.preventDefault();
      setRatio((r) => clamp(r + 0.03));
    } else if (e.key === 'Home') {
      e.preventDefault();
      setRatio(initial);
    }
  };

  const basis = `${(ratio * 100).toFixed(2)}%`;
  return (
    <div ref={containerRef} className={cx('split', `split-${direction}`, className)}>
      {collapsed === 'first' && bar}
      <div
        className={cx('split-pane', collapsed === 'second' && 'split-pane-rest')}
        // The pixel cap also holds when the window grows past the remembered ratio.
        style={collapsed ? undefined : { flexBasis: basis, ...(maxFirstPx ? { [direction === 'horizontal' ? 'maxWidth' : 'maxHeight']: maxFirstPx } : {}) }}
        hidden={collapsed === 'first'}
      >
        {first}
      </div>
      <div
        role="separator"
        hidden={collapsed !== null}
        tabIndex={0}
        aria-label={label}
        aria-orientation={direction === 'horizontal' ? 'vertical' : 'horizontal'}
        aria-valuemin={Math.round(min * 100)}
        aria-valuemax={Math.round(max * 100)}
        aria-valuenow={Math.round(ratio * 100)}
        className="split-handle"
        onPointerDown={(e) => {
          dragging.current = true;
          e.currentTarget.setPointerCapture(e.pointerId);
          e.preventDefault();
        }}
        onPointerMove={onPointerMove}
        onPointerUp={(e) => {
          dragging.current = false;
          e.currentTarget.releasePointerCapture(e.pointerId);
        }}
        onDoubleClick={() => setRatio(initial)}
        onKeyDown={onKeyDown}
      />
      <div className="split-pane split-pane-rest" hidden={collapsed === 'second'}>
        {second}
      </div>
      {collapsed === 'second' && bar}
    </div>
  );
}
