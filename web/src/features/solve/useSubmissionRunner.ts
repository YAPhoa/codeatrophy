import { useCallback, useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api/client';
import { qk } from '../../api/queries';
import type { Submission, SubmissionMode } from '../../api/types';

const POLL_MS = 700;

/**
 * Starts submissions and follows them to completion. Judging is
 * asynchronous: the POST returns a queued submission, which is then polled
 * until its status is `completed`. `results` fill in as cases finish, so the
 * caller can render live progress from `submission`.
 */
export function useSubmissionRunner(itemId: string) {
  const qc = useQueryClient();
  const [activeId, setActiveId] = useState<string | null>(null);
  const [starting, setStarting] = useState<SubmissionMode | null>(null);
  const [startError, setStartError] = useState<unknown>(null);
  const settled = useRef<string | null>(null);

  const query = useQuery({
    queryKey: qk.submission(activeId ?? ''),
    queryFn: ({ signal }) => api.submissions.get(activeId ?? '', signal),
    enabled: activeId !== null,
    refetchInterval: (q) => (q.state.data?.status === 'completed' ? false : POLL_MS),
    refetchOnWindowFocus: false,
    staleTime: Infinity,
  });

  const submission: Submission | null = activeId ? (query.data ?? null) : null;

  // A finished submission can change the item (status, last verdict) and its history.
  useEffect(() => {
    if (submission?.status === 'completed' && settled.current !== submission.id) {
      settled.current = submission.id;
      void qc.invalidateQueries({ queryKey: qk.submissions(itemId) });
      void qc.invalidateQueries({ queryKey: qk.item(itemId) });
      void qc.invalidateQueries({ queryKey: qk.itemLists });
      void qc.invalidateQueries({ queryKey: qk.stats });
    }
  }, [submission, itemId, qc]);

  const start = useCallback(
    async (language: string, source: string, mode: SubmissionMode, stdin: string | null) => {
      setStarting(mode);
      setStartError(null);
      try {
        const created = await api.submissions.create(itemId, { language, source, mode, stdin });
        qc.setQueryData(qk.submission(created.id), created);
        setActiveId(created.id);
        // Any submission moves a "to do" item to "in progress" right away.
        void qc.invalidateQueries({ queryKey: qk.item(itemId) });
        return created;
      } catch (e) {
        setStartError(e);
        return null;
      } finally {
        setStarting(null);
      }
    },
    [itemId, qc],
  );


  const judging = starting !== null || (submission !== null && submission.status !== 'completed');

  return {
    submission,
    loading: activeId !== null && query.isPending,
    pollError: query.isError ? query.error : null,
    retryPoll: () => void query.refetch(),
    starting,
    startError,
    judging,
    start,
  };
}
