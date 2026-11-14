import { useEffect, useLayoutEffect, useRef, useState } from 'react';

export function prefersReducedMotion(): boolean {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
}

/**
 * How long something closing plays its exit before it unmounts, in ms: a
 * duration token, `--duration-quick` unless told otherwise. Nil under reduced
 * motion, and where the stylesheet is not loaded (in unit tests), so it goes
 * at once.
 */
export function exitDuration(token = '--duration-quick'): number {
  if (prefersReducedMotion()) return 0;
  const ms = parseFloat(getComputedStyle(document.documentElement).getPropertyValue(token));
  return Number.isFinite(ms) && ms > 0 ? ms : 0;
}

/**
 * Keeps something mounted for its exit animation after `open` turns false.
 * `mounted` says whether to render it at all; `closing` is true while it
 * plays out, for a class that runs the exit and an `inert` that keeps it out
 * of reach meanwhile. Opening again while it closes picks it straight back up.
 */
export function usePresence(open: boolean): { mounted: boolean; closing: boolean } {
  const [prevOpen, setPrevOpen] = useState(open);
  const [exitMs, setExitMs] = useState(0);
  if (open !== prevOpen) {
    setPrevOpen(open);
    setExitMs(open ? 0 : exitDuration());
  }
  useEffect(() => {
    if (exitMs === 0) return;
    const t = window.setTimeout(() => setExitMs(0), exitMs);
    return () => window.clearTimeout(t);
  }, [exitMs]);
  const closing = !open && exitMs > 0;
  return { mounted: open || closing, closing };
}

/**
 * A ref for an overlay (a dialog's backdrop, a popover) that plays its exit
 * when React removes it, however that happens: its `open` turning false or a
 * parent unmounting it. The moment it is removed, a copy takes its place,
 * marked `is-closing`, inert and hidden from assistive technology, and is
 * dropped once the exit has played (`--duration-quick`). The stylesheet
 * gives `.is-closing` the exit. Under reduced motion it simply goes.
 *
 * Pass it as `ref` directly, or call it from a ref callback of your own and
 * return what it returns.
 */
export function exitOnRemove(node: HTMLElement | null): (() => void) | undefined {
  if (!node) return undefined;
  return () => {
    const ms = exitDuration();
    const parent = node.parentNode;
    if (ms === 0 || !parent) return;
    const next = node.nextSibling;
    const ghost = node.cloneNode(true) as HTMLElement;
    // What a copy does not carry over: typed values and scroll positions.
    const from = [node, ...node.querySelectorAll<HTMLElement>('*')];
    const to = [ghost, ...ghost.querySelectorAll<HTMLElement>('*')];
    const scrolled: [HTMLElement, number, number][] = [];
    from.forEach((el, i) => {
      const copy = to[i]!;
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
        // Nameless, so a copied radio cannot join a group still on the page.
        copy.removeAttribute('name');
        (copy as typeof el).value = el.value;
        if (el instanceof HTMLInputElement) (copy as HTMLInputElement).checked = el.checked;
      }
      if (el.scrollTop || el.scrollLeft) scrolled.push([copy, el.scrollTop, el.scrollLeft]);
      copy.removeAttribute('id');
    });
    ghost.classList.add('is-closing');
    ghost.setAttribute('inert', '');
    ghost.setAttribute('aria-hidden', 'true');
    // Wait for the commit to finish: in development StrictMode detaches and
    // re-attaches a ref without removing anything, and then there is nothing to play.
    queueMicrotask(() => {
      if (node.isConnected) return;
      parent.insertBefore(ghost, next && next.parentNode === parent ? next : null);
      for (const [el, top, left] of scrolled) {
        el.scrollTop = top;
        el.scrollLeft = left;
      }
      window.setTimeout(() => ghost.remove(), ms);
    });
  };
}

/**
 * Slides one indicator (a tab underline, a segmented control's pill) to the
 * selected child instead of drawing it on each child. Writes the child's
 * offset and width to `--indicator-x` and `--indicator-w` on the container and
 * marks it `data-indicator`; the stylesheet draws the indicator from those.
 * With nothing selected the mark comes off and each child draws its own.
 */
export function useSlidingIndicator<T extends HTMLElement>(selector: string) {
  const ref = useRef<T>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (el) placeIndicator(el, selector);
  });

  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => placeIndicator(el, selector));
    ro.observe(el);
    return () => ro.disconnect();
  }, [selector]);

  return ref;
}

function placeIndicator(container: HTMLElement, selector: string) {
  const selected = container.querySelector<HTMLElement>(selector);
  if (!selected || selected.offsetWidth === 0) {
    container.removeAttribute('data-indicator');
    return;
  }
  container.style.setProperty('--indicator-x', `${selected.offsetLeft}px`);
  container.style.setProperty('--indicator-w', `${selected.offsetWidth}px`);
  // The indicator is created in place the first time, so it does not slide in from the edge.
  container.setAttribute('data-indicator', '');
}
