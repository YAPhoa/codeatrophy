import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { readString, writeString } from './storage';

/**
 * Reduce motion (Settings, Appearance), On or Off, kept in the browser as
 * `codeatrophy:motion`: `reduce` for On, `full` for Off. Until either is
 * chosen, nothing is stored and the OS decides (`prefers-reduced-motion:
 * reduce` is On), followed live; once chosen, the OS is no longer asked.
 * While it is on, `<html>` carries `data-motion="reduce"`, which the
 * stylesheets key on: nothing moves, and fades keep their durations
 * (tokens.css, base.css). index.html sets the attribute before the first
 * paint by the same rule; keep the two in step.
 */
export type ReduceMotion = 'on' | 'off';

const MOTION_KEY = 'motion';
const OS_REDUCED = '(prefers-reduced-motion: reduce)';
const motionListeners = new Set<() => void>();

/** What was chosen, if anything: `reduce` (On) or `full` (Off). */
function storedMotion(): 'full' | 'reduce' | null {
  const v = readString(MOTION_KEY);
  return v === 'full' || v === 'reduce' ? v : null;
}

function osReducesMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia?.(OS_REDUCED).matches === true;
}

/** Whether motion is reduced, from what was chosen (if anything) and the OS's setting. */
export function reduceMotionFor(stored: 'full' | 'reduce' | null, osReduced: boolean): ReduceMotion {
  if (stored) return stored === 'reduce' ? 'on' : 'off';
  return osReduced ? 'on' : 'off';
}

export function getReduceMotion(): ReduceMotion {
  return reduceMotionFor(storedMotion(), osReducesMotion());
}

function applyMotion(): void {
  if (getReduceMotion() === 'on') document.documentElement.dataset.motion = 'reduce';
  else delete document.documentElement.dataset.motion;
}

function notifyMotion(): void {
  applyMotion();
  motionListeners.forEach((fn) => fn());
}

/** Choose On or Off; from then on the OS's setting is not consulted. */
export function setReduceMotion(value: ReduceMotion): void {
  writeString(MOTION_KEY, value === 'on' ? 'reduce' : 'full');
  notifyMotion();
}

/** Apply the setting, and follow the OS's while nothing has been chosen. */
export function initMotion(): void {
  applyMotion();
  window.matchMedia?.(OS_REDUCED).addEventListener?.('change', notifyMotion);
}

function subscribeMotion(fn: () => void): () => void {
  motionListeners.add(fn);
  return () => motionListeners.delete(fn);
}

/** Whether motion is reduced now, as the setting shows it. */
export function useReduceMotion(): ReduceMotion {
  return useSyncExternalStore(subscribeMotion, getReduceMotion, () => 'off');
}

/** Whether motion is reduced now, as applied to the page (`data-motion`). */
export function prefersReducedMotion(): boolean {
  return typeof document !== 'undefined' && document.documentElement.dataset.motion === 'reduce';
}

// Tokens are read from the stylesheet once and kept: a style read forces a
// style recalculation, and these are read while rendering. Nothing is kept
// while the stylesheet is missing (in unit tests), so a later read still finds it.
const tokenCache = new Map<string, string>();

export function token(name: string): string {
  const cached = tokenCache.get(name);
  if (cached !== undefined) return cached;
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  if (value) tokenCache.set(name, value);
  return value;
}

/**
 * How long something closing plays its exit before it unmounts, in ms: a
 * duration token, `--duration-quick` unless told otherwise. Exits are fades
 * (whatever moves in them is neutral while motion is reduced, see base.css),
 * so they play with motion reduced too. Nil where the stylesheet is not
 * loaded (in unit tests), so it goes at once. Anything else timed in JS that
 * fades reads its duration here too.
 */
export function exitDuration(name = '--duration-quick'): number {
  return parseDuration(token(name));
}

/**
 * The duration of something that only moves (a slide, a FLIP, a sliding
 * indicator, a width easing): `exitDuration`, but nil while motion is
 * reduced, when it lands at once.
 */
export function movementDuration(name = '--duration-quick'): number {
  return prefersReducedMotion() ? 0 : exitDuration(name);
}

/**
 * A CSS time as milliseconds. The unit has to be read, not assumed: the
 * production build's minifier rewrites `250ms` as `.25s` wherever that is
 * shorter, custom properties included, so the same token reads `250ms` from
 * the dev server and `.25s` from a build.
 */
export function parseDuration(value: string): number {
  const match = /^\s*([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)(ms|s)\s*$/i.exec(value);
  if (!match) return 0;
  const ms = parseFloat(match[1]!) * (match[2]!.toLowerCase() === 's' ? 1000 : 1);
  return Number.isFinite(ms) && ms > 0 ? ms : 0;
}

/**
 * How long a load may take before it is shown as loading. Most loads are
 * quicker, and then no indicator ever appears, so none flashes.
 */
export const LOADING_SHOWS_AFTER_MS = 400;

/**
 * Whether a loading indicator should be shown: once `loading` has been true
 * for LOADING_SHOWS_AFTER_MS. Timed here rather than with `animation-delay`,
 * so the wait is the same however the stylesheet treats motion. Give the
 * indicator `loading-delay` and `is-pending` until this is true: it keeps its
 * size meanwhile, and fades in once shown.
 */
export function useLoadingShown(loading = true): boolean {
  const [state, setState] = useState({ loading, shown: false });
  let current = state;
  if (state.loading !== loading) {
    current = { loading, shown: false };
    setState(current);
  }
  useEffect(() => {
    if (!loading) return;
    const t = window.setTimeout(() => setState((s) => (s.loading ? { ...s, shown: true } : s)), LOADING_SHOWS_AFTER_MS);
    return () => window.clearTimeout(t);
  }, [loading]);
  return loading && current.shown;
}

/**
 * How many times `value` has changed since the component mounted: 0 on the
 * first render. Key an element on it, or add a class once it is above 0, to
 * play an entrance on a change and never on mount, so a screen opened on
 * data that was already so (a favourite, a finished item) stays still.
 */
export function useChangeCount<T>(value: T): number {
  const [seen, setSeen] = useState({ value, count: 0 });
  if (!Object.is(seen.value, value)) {
    const next = { value, count: seen.count + 1 };
    setSeen(next);
    return next.count;
  }
  return seen.count;
}

/**
 * Eases an element from where it was drawn before a layout change back to
 * where it now is, on transform only (a FLIP). `from` is its box before the
 * change; call this after the change is laid out, in a layout effect.
 */
export function slideFrom(el: HTMLElement, from: DOMRect, name = '--duration-slow'): void {
  const to = el.getBoundingClientRect();
  const dx = from.left - to.left;
  const dy = from.top - to.top;
  const ms = movementDuration(name);
  if ((dx === 0 && dy === 0) || ms === 0 || typeof el.animate !== 'function') return;
  el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], { duration: ms, easing: token('--ease-out') || 'ease-out' });
}

/**
 * Keeps something mounted for its exit animation after `open` turns false.
 * `mounted` says whether to render it at all; `closing` is true while it
 * plays out, for a class that runs the exit and an `inert` that keeps it out
 * of reach meanwhile. Opening again while it closes picks it straight back up.
 * The exit lasts `--duration-quick` unless another duration token is named.
 */
export function usePresence(open: boolean, exitToken = '--duration-quick'): { mounted: boolean; closing: boolean } {
  const [prevOpen, setPrevOpen] = useState(open);
  const [exitMs, setExitMs] = useState(0);
  if (open !== prevOpen) {
    setPrevOpen(open);
    setExitMs(open ? 0 : exitDuration(exitToken));
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
 * dropped once the exit has played (`--duration-quick` unless another
 * duration token is named). The stylesheet gives `.is-closing` the exit.
 * Anything not yet drawn (a tooltip still waiting to show) simply goes; one
 * caught partway into its entrance leaves from as far as it got. With motion
 * reduced the exit still plays, as a fade.
 *
 * Pass it as `ref` directly, or call it from a ref callback of your own and
 * return what it returns.
 */
export function exitOnRemove(node: HTMLElement | null, exitToken = '--duration-quick'): (() => void) | undefined {
  if (!node) return undefined;
  return () => {
    const ms = exitDuration(exitToken);
    const parent = node.parentNode;
    if (ms === 0 || !parent) return;
    // Read while it is still in the page: the copy starts its exit afresh, at full strength.
    const shown = parseFloat(getComputedStyle(node).opacity);
    if (shown === 0) return;
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
    if (shown < 1) ghost.style.opacity = String(shown);
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
 *
 * It measures only when something could have moved it: on mount, when a
 * child's class changes (the selection), when children come or go, and when
 * the container or a child changes size. Re-renders that change none of
 * those (a parent typing into a search box) read no layout.
 *
 * The move itself animates only `transform`: the indicator takes its new
 * width at once and plays from where it was, scaled to its old width, back to
 * scale 1 (`pseudo` names the pseudo-element that draws it, and `inset` how
 * much narrower than the child it is drawn).
 *
 * With `axis: 'y'` it follows a vertical list instead (an outline's marker):
 * it writes the child's `--indicator-x`, `--indicator-y` and `--indicator-h`,
 * and plays the move on transform, scaled to the old height.
 */
export function useSlidingIndicator<T extends HTMLElement>(
  selector: string,
  { pseudo, inset = 0, axis = 'x' }: { pseudo: '::before' | '::after'; inset?: number; axis?: 'x' | 'y' },
) {
  const ref = useRef<T>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const place = () => (axis === 'y' ? placeVertical(el, selector, pseudo) : placeIndicator(el, selector, pseudo, inset));
    place();
    if (typeof MutationObserver === 'undefined') return;
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(place);
    const observeSizes = () => {
      if (!ro) return;
      ro.disconnect();
      ro.observe(el);
      for (const child of el.children) ro.observe(child);
    };
    observeSizes();
    const mo = new MutationObserver((records) => {
      if (records.some((r) => r.type === 'childList' && r.target === el)) observeSizes();
      place();
    });
    mo.observe(el, { subtree: true, childList: true, attributes: true, attributeFilter: ['class'] });
    return () => {
      mo.disconnect();
      ro?.disconnect();
    };
  }, [selector, pseudo, inset, axis]);

  return ref;
}

const placed = new WeakMap<HTMLElement, { x: number; w: number }>();

function placeIndicator(container: HTMLElement, selector: string, pseudo: string, inset: number) {
  const selected = container.querySelector<HTMLElement>(selector);
  if (!selected || selected.offsetWidth === 0) {
    container.removeAttribute('data-indicator');
    placed.delete(container);
    return;
  }
  const x = selected.offsetLeft;
  const w = selected.offsetWidth;
  const prev = placed.get(container);
  if (prev && prev.x === x && prev.w === w) return;
  placed.set(container, { x, w });
  container.style.setProperty('--indicator-x', `${x}px`);
  container.style.setProperty('--indicator-w', `${w}px`);
  // The indicator is created in place the first time, so it does not slide in from the edge.
  container.setAttribute('data-indicator', '');
  const ms = movementDuration('--duration-fast');
  if (!prev || ms === 0 || typeof container.animate !== 'function') return;
  const scale = Math.max(0, prev.w - inset) / Math.max(1, w - inset);
  container.animate(
    [{ transform: `translateX(${prev.x}px) scaleX(${scale})` }, { transform: `translateX(${x}px) scaleX(1)` }],
    { duration: ms, easing: token('--ease-out') || 'ease-out', pseudoElement: pseudo },
  );
}

const placedVertical = new WeakMap<HTMLElement, { x: number; y: number; h: number; since: number }>();

/**
 * How long after it first appears a vertical marker moves without sliding: an
 * outline marks the heading in view, and while a long page is still laying
 * out (lazy Markdown, fonts) that can change once or twice on its own.
 */
const SETTLE_MS = 600;

function placeVertical(container: HTMLElement, selector: string, pseudo: string) {
  const selected = container.querySelector<HTMLElement>(selector);
  if (!selected || selected.offsetHeight === 0) {
    container.removeAttribute('data-indicator');
    placedVertical.delete(container);
    return;
  }
  const x = selected.offsetLeft;
  const y = selected.offsetTop;
  const h = selected.offsetHeight;
  const prev = placedVertical.get(container);
  if (prev && prev.x === x && prev.y === y && prev.h === h) return;
  const since = prev?.since ?? performance.now();
  placedVertical.set(container, { x, y, h, since });
  container.style.setProperty('--indicator-x', `${x}px`);
  container.style.setProperty('--indicator-y', `${y}px`);
  container.style.setProperty('--indicator-h', `${h}px`);
  container.setAttribute('data-indicator', '');
  const ms = movementDuration('--duration-fast');
  if (!prev || performance.now() - since < SETTLE_MS || ms === 0 || typeof container.animate !== 'function') return;
  container.animate(
    [{ transform: `translate(${prev.x}px, ${prev.y}px) scaleY(${prev.h / Math.max(1, h)})` }, { transform: `translate(${x}px, ${y}px) scaleY(1)` }],
    { duration: ms, easing: token('--ease-out') || 'ease-out', pseudoElement: pseudo },
  );
}
