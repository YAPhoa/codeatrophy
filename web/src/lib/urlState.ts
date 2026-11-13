import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { useSearchParams, type SetURLSearchParams } from 'react-router';

// View state that a link should be able to carry (the open tab, a filter)
// lives in the query string. Each value is ordinary component state that is
// mirrored into the URL, so the page reacts at once and the address catches
// up; a value at its default is left out of the URL. Changes replace the
// history entry: Back leaves the page rather than stepping through tabs.

/** Writes made in the same tick, applied in one navigation so none overwrites another. */
let pending: Map<string, string | null> | null = null;

function write(key: string, value: string | null, setParams: SetURLSearchParams): void {
  if (!pending) {
    pending = new Map();
    queueMicrotask(() => {
      const changes = pending!;
      pending = null;
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          for (const [k, v] of changes) {
            if (v === null) next.delete(k);
            else next.set(k, v);
          }
          return next;
        },
        { replace: true },
      );
    });
  }
  pending.set(key, value);
}

/**
 * Component state kept in the query parameter `key`. `parse` turns the
 * parameter (or `null` when absent) into a value and decides the default;
 * `format` gives the parameter for a value, or `null` to leave it out.
 */
export function useUrlState<T>(key: string, parse: (raw: string | null) => T, format: (value: T) => string | null): [T, Dispatch<SetStateAction<T>>] {
  const [params, setParams] = useSearchParams();
  const raw = params.get(key);
  const [value, setValue] = useState<T>(() => parse(raw));
  // The parameter as this hook last wrote or read it, to tell its own writes from a change made elsewhere.
  const known = useRef(raw);
  const parseRef = useRef(parse);
  const formatRef = useRef(format);
  useEffect(() => {
    parseRef.current = parse;
    formatRef.current = format;
  });

  // The address changed underneath (a link to this page with another value): follow it.
  useEffect(() => {
    if (raw === known.current) return;
    known.current = raw;
    setValue(parseRef.current(raw));
  }, [raw]);

  // The value changed here: put it in the address.
  useEffect(() => {
    const next = formatRef.current(value);
    if (next === known.current) return;
    known.current = next;
    write(key, next, setParams);
  }, [key, value, setParams]);

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
