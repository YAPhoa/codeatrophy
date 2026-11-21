import { useCallback, useEffect, useRef, useState } from 'react';
import { readJson, remove, writeJson } from './storage';

/**
 * State that survives a reload: mirrored to localStorage shortly after each
 * change. Used for work in progress that must not be lost (capture input, a
 * draft under review). `clear` forgets the stored copy and stops saving, for
 * a page about to be left: what is shown stays, so the page does not empty
 * itself before the next one takes over.
 */
export function useStoredState<T>(key: string, initial: () => T): [T, (update: T | ((prev: T) => T)) => void, () => void] {
  const [value, setValue] = useState<T>(() => readJson<T | null>(key, null) ?? initial());
  const cleared = useRef(false);

  useEffect(() => {
    if (cleared.current) return;
    const t = window.setTimeout(() => {
      if (!cleared.current) writeJson(key, value);
    }, 250);
    return () => {
      window.clearTimeout(t);
      // Flush on unmount or key change so the last edit is not lost.
      if (!cleared.current) writeJson(key, value);
    };
  }, [key, value]);

  const clear = useCallback(() => {
    cleared.current = true;
    remove(key);
  }, [key]);

  return [value, setValue, clear];
}
