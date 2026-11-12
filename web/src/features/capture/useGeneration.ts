import { useCallback, useEffect, useRef, useState } from 'react';
import { isAbort } from '../../api/client';

interface GenerationState {
  running: boolean;
  /** When the current call started (ms since epoch), for the elapsed-time display. */
  startedAt: number | null;
  error: unknown;
}

/**
 * Runs one long AI request at a time with cancellation. A cancelled call
 * resolves to `undefined` and is not reported as an error; a failed call
 * leaves `error` set so the caller can show it next to the untouched input.
 */
export function useGeneration() {
  const [state, setState] = useState<GenerationState>({ running: false, startedAt: null, error: null });
  const controller = useRef<AbortController | null>(null);

  const cancel = useCallback(() => {
    controller.current?.abort();
    controller.current = null;
    setState((s) => (s.running ? { running: false, startedAt: null, error: null } : s));
  }, []);

  // Abandon an in-flight request when the screen is left.
  useEffect(() => () => controller.current?.abort(), []);

  const run = useCallback(async <T,>(call: (signal: AbortSignal) => Promise<T>): Promise<T | undefined> => {
    controller.current?.abort();
    const ac = new AbortController();
    controller.current = ac;
    setState({ running: true, startedAt: Date.now(), error: null });
    try {
      const result = await call(ac.signal);
      if (ac.signal.aborted) return undefined;
      setState({ running: false, startedAt: null, error: null });
      return result;
    } catch (err) {
      if (ac.signal.aborted || isAbort(err)) return undefined;
      setState({ running: false, startedAt: null, error: err });
      return undefined;
    } finally {
      if (controller.current === ac) controller.current = null;
    }
  }, []);

  const clearError = useCallback(() => setState((s) => ({ ...s, error: null })), []);

  return { ...state, run, cancel, clearError };
}
