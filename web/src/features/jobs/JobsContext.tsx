import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useLocation } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { invalidateJobs, isActiveJob, qk, useAiJobs } from '../../api/queries';
import type { AiJob, AiJobStatus } from '../../api/types';
import { useToast } from '../../ui/Toast';
import { jobBelongsTo, jobKindLabel } from './labels';

/** What a finished job came to, in a word. */
export const OUTCOME: Record<Exclude<AiJobStatus, 'queued' | 'running'>, string> = { succeeded: 'Ready', failed: 'Failed', cancelled: 'Cancelled' };

export interface JobsState {
  /** The jobs no open screen has collected; the open screen's own are left to it. */
  shown: AiJob[];
  /** How many of them are queued or running. */
  active: number;
  /** "1 running · 2 done". */
  summary: string;
  /** Whether the jobs have loaded once. */
  loaded: boolean;
  /** Whether the list is open. */
  open: boolean;
  /** It opened by itself, for a job that finished elsewhere: focus stays where it was. */
  opened: 'user' | 'auto';
  setOpen: (open: boolean) => void;
  /** Runs a cancel or dismiss, saying so if it fails, then looks at the jobs again. */
  act: (call: () => Promise<unknown>) => Promise<void>;
}

const JobsContext = createContext<JobsState | null>(null);

export function useJobs(): JobsState {
  const jobs = useContext(JobsContext);
  if (!jobs) throw new Error('useJobs must be used inside JobsProvider');
  return jobs;
}

/**
 * The AI jobs, for the sidebar's jobs entry: generations running and
 * recently finished that no screen has collected yet. A job whose screen is
 * open is left to that screen. When a job seen running finishes while its
 * screen is not open, the list opens by itself to show it, if the sidebar
 * is on screen (`canOpen`), and the finish is announced either way.
 */
export function JobsProvider({ canOpen, children }: { canOpen: boolean; children: ReactNode }) {
  const pathname = useLocation().pathname;
  const qc = useQueryClient();
  const toast = useToast();
  const [state, setState] = useState<{ open: boolean; opened: 'user' | 'auto' }>({ open: false, opened: 'user' });
  const [announce, setAnnounce] = useState('');
  // Closed while the sidebar is out of sight (a closed drawer), or with nothing to list.
  const watching = state.open && canOpen;
  const jobs = useAiJobs(watching);
  const all = useMemo(() => jobs.data ?? [], [jobs.data]);
  const shown = useMemo(() => all.filter((j) => !jobBelongsTo(j, pathname)), [all, pathname]);
  const open = watching && shown.length > 0;
  if (state.open && !open) setState({ open: false, opened: 'user' });

  // A job seen running that has finished since: its draft has news, and if
  // its screen is not the one open, the list opens to show it.
  const last = useRef(new Map<string, AiJobStatus>());
  useEffect(() => {
    let elsewhere: AiJob | null = null;
    let drafts = false;
    for (const job of all) {
      const before = last.current.get(job.id);
      if (before && isActiveJob({ status: before }) && !isActiveJob(job)) {
        if (job.draftId) drafts = true;
        if (job.status !== 'cancelled' && !jobBelongsTo(job, pathname)) elsewhere = job;
      }
    }
    last.current = new Map(all.map((j) => [j.id, j.status]));
    if (drafts) void qc.invalidateQueries({ queryKey: qk.draftsAll });
    if (elsewhere) {
      if (canOpen) setState((s) => (s.open ? s : { open: true, opened: 'auto' }));
      setAnnounce(`${jobKindLabel(elsewhere.kind)} “${elsewhere.title}”: ${OUTCOME[elsewhere.status as 'succeeded']?.toLowerCase() ?? ''}`);
    }
  }, [all, pathname, qc, canOpen]);

  const setOpen = useCallback((next: boolean) => setState({ open: next, opened: 'user' }), []);

  const act = useCallback(
    async (call: () => Promise<unknown>) => {
      try {
        await call();
      } catch (e) {
        toast.error(e);
      }
      void invalidateJobs(qc);
    },
    [qc, toast],
  );

  const active = shown.filter(isActiveJob).length;
  const finished = shown.length - active;
  const summary = [active > 0 && `${active} running`, finished > 0 && `${finished} done`].filter(Boolean).join(' · ');
  const loaded = jobs.isSuccess;
  const value = useMemo<JobsState>(
    () => ({ shown, active, summary, loaded, open, opened: state.opened, setOpen, act }),
    [shown, active, summary, loaded, open, state.opened, setOpen, act],
  );

  return (
    <JobsContext.Provider value={value}>
      {children}
      <span className="sr-only" role="status">
        {announce}
      </span>
    </JobsContext.Provider>
  );
}
