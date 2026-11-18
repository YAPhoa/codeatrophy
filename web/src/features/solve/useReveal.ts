import { useCallback, useMemo, useState } from 'react';
import { usePreferences } from '../../api/queries';

/**
 * Which test cases the user has chosen to look at during this visit.
 *
 * With the "hide test cases" preference on, the content of non-sample cases
 * is kept out of sight — in the list of cases and in results — until the user
 * reveals it, one case at a time or all at once, and hides it again the same
 * way. Nothing is remembered: the next visit starts concealed again.
 */
export interface Reveal {
  /** The preference is on, so hidden cases start out concealed. */
  hiding: boolean;
  /** Whether everything has been revealed for this visit. */
  all: boolean;
  /** True when this case's content must stay out of sight. `id` is `null` for a run that is not tied to a test case. */
  conceals: (testCase: { id: string | null; isSample: boolean }) => boolean;
  reveal: (id: string) => void;
  /** Conceal one revealed case again. */
  hide: (id: string) => void;
  revealAll: () => void;
  /** Conceal everything again. */
  reset: () => void;
}

export function useReveal(): Reveal {
  const hiding = usePreferences().hideTestCases;
  const [all, setAll] = useState(false);
  // Revealed one by one; or, once everything is revealed, hidden again one by one.
  const [ids, setIds] = useState<ReadonlySet<string>>(() => new Set());
  const [rehidden, setRehidden] = useState<ReadonlySet<string>>(() => new Set());

  const reveal = useCallback((id: string) => {
    setIds((prev) => new Set(prev).add(id));
    setRehidden((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  }, []);
  const hide = useCallback((id: string) => {
    setIds((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
    setRehidden((prev) => new Set(prev).add(id));
  }, []);
  const revealAll = useCallback(() => {
    setAll(true);
    setRehidden(new Set());
  }, []);
  const reset = useCallback(() => {
    setAll(false);
    setIds(new Set());
    setRehidden(new Set());
  }, []);

  return useMemo(
    () => ({
      hiding,
      all,
      conceals: (c) => hiding && !c.isSample && c.id !== null && (all ? rehidden.has(c.id) : !ids.has(c.id)),
      reveal,
      hide,
      revealAll,
      reset,
    }),
    [hiding, all, ids, rehidden, reveal, hide, revealAll, reset],
  );
}
