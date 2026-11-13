import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { useLocation, useNavigation, useSearchParams, type SetURLSearchParams } from 'react-router';

// View state that a link should be able to carry (the open tab, a filter, the
// step of a flow) lives in the query string. Each value is ordinary state
// that is mirrored into the URL, so the page reacts at once and the address
// catches up; a value at its default is left out of the URL.

/** Writes made in the same tick, applied in one navigation so none overwrites another. */
let pending: { changes: Map<string, string | null>; push: boolean } | null = null;

function write(key: string, value: string | null, push: boolean, setParams: SetURLSearchParams): void {
  if (!pending) {
    const batch = { changes: new Map<string, string | null>(), push: false };
    const page = window.location.pathname;
    pending = batch;
    queueMicrotask(() => {
      pending = null;
      // The page was left in the meantime: its parameters mean nothing where the user is now.
      if (window.location.pathname !== page) return;
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          for (const [k, v] of batch.changes) {
            if (v === null) next.delete(k);
            else next.set(k, v);
          }
          return next;
        },
        { replace: !batch.push },
      );
    });
  }
  pending.changes.set(key, value);
  pending.push ||= push;
}

/**
 * Mirror a value into the query parameter `key`. `current` is the parameter
 * the value stands for (`null` to leave it out). `onExternal` is called when
 * the parameter changes from outside: a link to this page, or Back and
 * Forward.
 *
 * By default a change replaces the history entry, so Back leaves the page
 * rather than stepping through tabs. With `push` each change is an entry of
 * its own, for a step the user expects Back to undo.
 */
export function useUrlMirror(key: string, current: string | null, onExternal: (raw: string | null) => void, push = false): void {
  const [params, setParams] = useSearchParams();
  const raw = params.get(key);
  const { pathname } = useLocation();
  // On the way to another page (a save that then navigates, say) the address is
  // left alone: a write would cut that navigation short.
  const leaving = useNavigation().state !== 'idle';
  const leavingRef = useRef(leaving);
  // A new function whenever the query string changes; kept in a ref so that alone does not count as a change of value.
  const setParamsRef = useRef(setParams);
  // The parameter as last written or read here, to tell these writes from a change made elsewhere.
  const known = useRef(raw);
  const mounted = useRef(false);
  const onExternalRef = useRef(onExternal);
  useEffect(() => {
    onExternalRef.current = onExternal;
    leavingRef.current = leaving;
    setParamsRef.current = setParams;
  });

  useEffect(() => {
    if (raw === known.current) return;
    known.current = raw;
    onExternalRef.current(raw);
  }, [raw]);

  // Back and Forward are taken from the browser itself. A step back made
  // right after a write can return to the address this page last rendered
  // with, and then nothing above would see a change.
  useEffect(() => {
    const onPop = () => {
      // Gone to another page: this one is about to leave the screen.
      if (window.location.pathname !== pathname) return;
      const now = new URLSearchParams(window.location.search).get(key);
      if (now === known.current) return;
      known.current = now;
      onExternalRef.current(now);
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [key, pathname]);

  useEffect(() => {
    // What the page opens with only corrects the address; it is not a step to go back over.
    const first = !mounted.current;
    mounted.current = true;
    // The browser can already be at the next page while this one is still on screen.
    if (leavingRef.current || window.location.pathname !== pathname) return;
    if (current === known.current) return;
    known.current = current;
    write(key, current, push && !first, setParamsRef.current);
  }, [key, current, push, pathname]);
}

/**
 * Component state kept in the query parameter `key`. `parse` turns the
 * parameter (or `null` when absent) into a value and decides the default;
 * `format` gives the parameter for a value, or `null` to leave it out.
 */
export function useUrlState<T>(key: string, parse: (raw: string | null) => T, format: (value: T) => string | null): [T, Dispatch<SetStateAction<T>>] {
  const [params] = useSearchParams();
  const [value, setValue] = useState<T>(() => parse(params.get(key)));
  useUrlMirror(key, format(value), (raw) => setValue(parse(raw)));
  return [value, setValue];
}

/** One of a fixed set of values (a tab) in the query string; `fallback` is left out of the URL. */
export function useUrlChoice<T extends string>(key: string, values: readonly T[], fallback: T): [T, Dispatch<SetStateAction<T>>] {
  const parse = useCallback((raw: string | null): T => ((values as readonly string[]).includes(raw ?? '') ? (raw as T) : fallback), [values, fallback]);
  const format = useCallback((value: T): string | null => (value === fallback ? null : value), [fallback]);
  return useUrlState(key, parse, format);
}

/** Free text (a filter) in the query string; empty text is left out of the URL. */
export function useUrlText(key: string): [string, Dispatch<SetStateAction<string>>] {
  return useUrlState(key, parseText, formatText);
}

const parseText = (raw: string | null): string => raw ?? '';
const formatText = (value: string): string | null => (value === '' ? null : value);
