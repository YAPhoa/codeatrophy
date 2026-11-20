import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { AlertCircle, CheckCircle2, ChevronDown, CircleSlash, Clock, Sparkles, X } from 'lucide-react';
import { api } from '../../api/client';
import { invalidateJobs, isActiveJob, qk, useAiJobs } from '../../api/queries';
import type { AiJob, AiJobStatus } from '../../api/types';
import { exitOnRemove, useChangeCount } from '../../lib/motion';
import { cx, IconButton } from '../../ui/Button';
import { Spinner } from '../../ui/misc';
import { useToast } from '../../ui/Toast';
import { elapsedLabel, jobBelongsTo, jobKindLabel, jobTarget } from './labels';

/** What a finished job came to, in a word. */
const OUTCOME: Record<Exclude<AiJobStatus, 'queued' | 'running'>, string> = { succeeded: 'Ready', failed: 'Failed', cancelled: 'Cancelled' };

function StatusIcon({ status }: { status: AiJobStatus }) {
  switch (status) {
    case 'queued':
      return <Clock size={14} className="job-icon" aria-hidden="true" />;
    case 'running':
      return <Spinner size={14} />;
    case 'succeeded':
      return <CheckCircle2 size={14} className="job-icon tone-ok" aria-hidden="true" />;
    case 'failed':
      return <AlertCircle size={14} className="job-icon tone-danger" aria-hidden="true" />;
    case 'cancelled':
      return <CircleSlash size={14} className="job-icon" aria-hidden="true" />;
  }
}

/** A clock for the elapsed times, ticking only while something runs. */
function useNow(ticking: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!ticking) return;
    setNow(Date.now());
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [ticking]);
  return now;
}

/** Keeps the toasts and the end of a page clear of the window: its height, as `--jobs-tray-space` on the root. */
function useReservedSpace(node: HTMLElement | null) {
  useLayoutEffect(() => {
    const root = document.documentElement;
    if (!node) {
      root.style.removeProperty('--jobs-tray-space');
      return;
    }
    const set = () => root.style.setProperty('--jobs-tray-space', `${Math.ceil(node.getBoundingClientRect().height)}px`);
    set();
    const observer = new ResizeObserver(set);
    observer.observe(node);
    return () => {
      observer.disconnect();
      root.style.removeProperty('--jobs-tray-space');
    };
  }, [node]);
}

/**
 * The jobs window, bottom right on every page: AI generations running and
 * recently finished, which no screen has collected yet. A job whose screen
 * is open is left to that screen. It sits as a small pill until something
 * finishes while the user is elsewhere, then opens to show it; running jobs
 * can be cancelled from it, finished ones opened or dismissed.
 */
export function JobsTray() {
  const location = useLocation();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const jobs = useAiJobs(open);
  const [announce, setAnnounce] = useState('');
  const pathname = location.pathname;
  const all = useMemo(() => jobs.data ?? [], [jobs.data]);
  const shown = useMemo(() => all.filter((j) => !jobBelongsTo(j, pathname)), [all, pathname]);
  const active = shown.filter(isActiveJob).length;
  const now = useNow(active > 0);

  // A job seen running that has finished since: its draft has news, and if
  // its screen is not the one open, the window opens to show it.
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
      setOpen(true);
      setAnnounce(`${jobKindLabel(elsewhere.kind)} “${elsewhere.title}”: ${OUTCOME[elsewhere.status as 'succeeded']?.toLowerCase() ?? ''}`);
    }
  }, [all, pathname, qc]);

  const empty = shown.length === 0;
  const mode = empty ? 'none' : open ? 'panel' : 'pill';
  // A window already there when the app loads is shown at rest; it moves only as it changes.
  const changed = useChangeCount(mode) > 0;
  const [node, setNode] = useState<HTMLElement | null>(null);
  useReservedSpace(empty ? null : node);

  const act = async (call: () => Promise<unknown>) => {
    try {
      await call();
    } catch (e) {
      toast.error(e);
    }
    void invalidateJobs(qc);
  };

  const openJob = (job: AiJob) => {
    const target = jobTarget(job);
    if (!target) return;
    setOpen(false);
    navigate(target);
  };

  const finished = shown.length - active;
  const summary = [active > 0 && `${active} running`, finished > 0 && `${finished} done`].filter(Boolean).join(' · ');

  return (
    <div className="jobs-tray" ref={setNode}>
      <span className="sr-only" role="status">
        {announce}
      </span>
      {mode === 'pill' && (
        <button
          type="button"
          ref={exitOnRemove}
          className={cx('jobs-pill', changed && 'is-arriving', active > 0 && 'is-running')}
          aria-expanded={false}
          aria-label={`AI jobs: ${summary}`}
          onClick={() => setOpen(true)}
        >
          {active > 0 ? <Spinner size={13} /> : <Sparkles size={13} aria-hidden="true" />}
          <span>{summary}</span>
        </button>
      )}
      {mode === 'panel' && (
        <section ref={exitOnRemove} className={cx('jobs-panel', changed && 'is-arriving')} aria-label="AI jobs">
          <header className="jobs-head">
            <Sparkles size={14} aria-hidden="true" />
            <h2>AI jobs</h2>
            <span className="spacer" />
            <IconButton size="sm" label="Minimise AI jobs" icon={<ChevronDown size={16} />} onClick={() => setOpen(false)} />
          </header>
          <ul className="jobs-list">
            {shown.map((job) => {
              const running = isActiveJob(job);
              const since = Date.parse(job.startedAt ?? job.createdAt);
              const meta = job.status === 'queued' ? 'Queued' : running ? elapsedLabel(now - since) : OUTCOME[job.status as 'succeeded'];
              const target = jobTarget(job);
              return (
                <li key={job.id} className={cx('job-row', `is-${job.status}`)}>
                  <StatusIcon status={job.status} />
                  <div className="job-text">
                    <span className="job-title truncate" title={job.title}>
                      {job.title}
                    </span>
                    <span className="job-meta">
                      {jobKindLabel(job.kind)} · <span className={cx(job.status === 'failed' && 'tone-danger', job.status === 'succeeded' && 'tone-ok')}>{meta}</span>
                    </span>
                  </div>
                  {running ? (
                    <button type="button" className="job-action" onClick={() => void act(() => api.ai.cancel(job.id))}>
                      Cancel
                    </button>
                  ) : (
                    <>
                      {target && (
                        <button type="button" className="job-action" onClick={() => openJob(job)}>
                          Open
                        </button>
                      )}
                      <IconButton size="sm" className="job-dismiss" label={`Dismiss ${job.title}`} icon={<X size={14} />} onClick={() => void act(() => api.ai.dismiss(job.id))} />
                    </>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </div>
  );
}
