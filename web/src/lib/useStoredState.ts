import { useCallback, useEffect, useRef, useState } from 'react';
import { readJson, remove, writeJson } from './storage';

/**
 * State that survives a reload: mirrored to localStorage shortly after each
 * change. Used for work in progress that must not be lost (capture input, a
 * draft under review). `clear` forgets the stored copy and resets the state.
 */
export function useStoredState<T>(key: string, initial: () => T): [T, (update: T | ((prev: T) => T)) => void, () => void] {
  const [value, setValue] = useState<T>(() => readJson<T | null>(key, null) ?? initial());
  const initialRef = useRef(initial);
  const skipWrite = useRef(false);

  useEffect(() => {
    if (skipWrite.current) {
      skipWrite.current = false;
      return;
    }
    const t = window.setTimeout(() => writeJson(key, value), 250);
    return () => {
      window.clearTimeout(t);
      // Flush on unmount or key change so the last edit is not lost.
      if (!skipWrite.current) writeJson(key, value);
    };
  }, [key, value]);

  const clear = useCallback(() => {
    skipWrite.current = true;
    remove(key);
    setValue(initialRef.current());
  }, [key]);

  return [value, setValue, clear];
}
