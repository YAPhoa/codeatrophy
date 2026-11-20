import { useCallback, useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api, jobError } from '../../api/client';
import { invalidateJobs, isActiveJob } from '../../api/queries';
import type { AiJob, AiJobDetail, AiJobKind } from '../../api/types';

/** How often a job under way is looked at. */
const POLL_MS = 1500;

export interface ScreenJobOutcome<R> {
  result: R;
  /** Started on this visit to the screen, so what it was asked from is still what is on screen. */
  startedHere: boolean;
  job: AiJobDetail<R>;
}

interface ScreenJobOptions<R> {
  kind: AiJobKind;
  itemId: string;
  /** The screen's own address, given as the job's `origin` and used to find the job again. */
  origin: string;
  /**
   * A job finished with a result. Return `true` once it has been applied, so
   * it is collected; `false` leaves it to be offered again (see `collect`).
   */
  onResult: (outcome: ScreenJobOutcome<R>) => boolean;
}

/**
 * A screen's AI generation, which runs as a job on the server: leaving the
 * screen does not stop it, and coming back finds it again by its kind, item
 * and origin. While it runs the screen shows its progress; when it is done
 * the result is handed to `onResult` once, and the job is collected
 * (`pickup`) so it is not offered again, here or in the jobs window. A
 * failure is shown as `error` and collected too.
 */
export function useScreenJob<R>({ kind, itemId, origin, onResult }: ScreenJobOptions<R>) {
  const qc = useQueryClient();
  const [job, setJob] = useState<AiJob | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [starting, setStarting] = useState(false);
  const startedHere = useRef(new Set<string>());
  const handled = useRef(new Set<string>());
  const onResultRef = useRef(onResult);
  useEffect(() => {
    onResultRef.current = onResult;
  });

  /** A job that has finished: hand its outcome over, and collect it. */
  const finish = useCallback(
    async (finished: AiJob) => {
      if (handled.current.has(finished.id)) return;
      handled.current.add(finished.id);
      setJob(null);
      const detail = await api.ai.job<R>(finished.id).catch(() => null);
      if (!detail) return;
      let collect = true;
      if (detail.status === 'succeeded' && detail.result !== null) {
        collect = onResultRef.current({ result: detail.result, startedHere: startedHere.current.has(detail.id), job: detail });
      } else if (detail.status === 'failed' && detail.error) {
        setError(jobError(detail.error));
      }
      if (collect) await api.ai.pickup(detail.id).catch(() => undefined);
      void invalidateJobs(qc);
    },
    [qc],
  );

  // On arrival, the screen's job from an earlier visit, running or finished and not collected yet.
  useEffect(() => {
    let live = true;
    api.ai.jobs({ kind, itemId, limit: 50 }).then(
      ({ items }) => {
        if (!live) return;
        const mine = items.find((j) => j.origin === origin);
        if (!mine) return;
        if (isActiveJob(mine)) setJob(mine);
        else void finish(mine);
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [kind, itemId, origin, finish]);

  // Follow the job under way until it finishes.
  const following = job?.id;
  useEffect(() => {
    if (!following) return;
    let live = true;
    const t = window.setInterval(() => {
      api.ai.job(following).then(
        (latest) => {
          if (!live) return;
          if (isActiveJob(latest)) setJob(latest);
          else void finish(latest);
        },
        () => undefined,
      );
    }, POLL_MS);
    return () => {
      live = false;
      window.clearInterval(t);
    };
  }, [following, finish]);

  /** Start a generation; a request turned down at once is shown as `error`. */
  const start = useCallback(
    async (begin: () => Promise<AiJob>) => {
      setError(null);
      setStarting(true);
      try {
        const started = await begin();
        startedHere.current.add(started.id);
        setJob(started);
        void invalidateJobs(qc);
      } catch (e) {
        setError(e);
      } finally {
        setStarting(false);
      }
    },
    [qc],
  );

  /** Stop the job under way; nothing comes of it. */
  const cancel = useCallback(async () => {
    const current = job;
    if (!current) return;
    handled.current.add(current.id);
    setJob(null);
    await api.ai.cancel(current.id).catch(() => undefined);
    await api.ai.pickup(current.id).catch(() => undefined);
    void invalidateJobs(qc);
  }, [job, qc]);

  /** Collect a result `onResult` left on offer, once it is applied or declined. */
  const collect = useCallback(
    async (id: string) => {
      await api.ai.pickup(id).catch(() => undefined);
      void invalidateJobs(qc);
    },
    [qc],
  );

  const running = job !== null || starting;
  const startedAt = job ? Date.parse(job.startedAt ?? job.createdAt) : starting ? Date.now() : null;
  return { running, startedAt, error, clearError: () => setError(null), start, cancel, collect };
}
