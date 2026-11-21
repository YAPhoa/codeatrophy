import { useEffect, useMemo, useState, type RefObject } from 'react';
import { Link } from 'react-router';
import { AlertCircle, CheckCircle2, ChevronDown, CircleSlash, Clock, Sparkles, X } from 'lucide-react';
import { api } from '../../api/client';
import { isActiveJob, useDrafts } from '../../api/queries';
import type { AiJobStatus } from '../../api/types';
import { cx, IconButton } from '../../ui/Button';
import { Spinner } from '../../ui/misc';
import { Popover } from '../../ui/Popover';
import { OUTCOME, useJobs } from './JobsContext';
import { elapsedLabel, jobKindLabel, jobLink } from './labels';

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

/** The rows, mounted only while the list is open, so the clock ticks only then. */
function JobsList({ onLeave }: { onLeave: () => void }) {
  const { shown, active, act } = useJobs();
  const now = useNow(active > 0);
  const drafts = useDrafts();
  const draftIds = useMemo(() => (drafts.data ? new Set(drafts.data.map((d) => d.id)) : null), [drafts.data]);
  return (
    <ul className="jobs-list">
      {shown.map((job) => {
        const running = isActiveJob(job);
        const since = Date.parse(job.startedAt ?? job.createdAt);
        const meta = job.status === 'queued' ? 'Queued' : running ? elapsedLabel(now - since) : OUTCOME[job.status as 'succeeded'];
        return (
          <li key={job.id} className={cx('job-row', `is-${job.status}`)}>
            {/* The row is the link; its buttons sit beside it, not inside. */}
            <Link to={jobLink(job, draftIds)} className="job-link" onClick={onLeave}>
              <StatusIcon status={job.status} />
              <span className="job-text">
                <span className="job-title truncate" title={job.title}>
                  {job.title}
                </span>
                <span className="job-meta">
                  {jobKindLabel(job.kind)} · <span className={cx(job.status === 'failed' && 'tone-danger', job.status === 'succeeded' && 'tone-ok')}>{meta}</span>
                </span>
              </span>
            </Link>
            {running ? (
              <button type="button" className="job-action" onClick={() => void act(() => api.ai.cancel(job.id))}>
                Cancel
              </button>
            ) : (
              <IconButton size="sm" className="job-dismiss" label={`Dismiss ${job.title}`} icon={<X size={14} />} onClick={() => void act(() => api.ai.dismiss(job.id))} />
            )}
          </li>
        );
      })}
    </ul>
  );
}

/**
 * The AI jobs list, opened from the sidebar's jobs entry (`anchorRef`) and
 * placed above the footer it sits in (`placeRef`). Running jobs can be
 * cancelled from it, finished ones dismissed; every row leads to where its
 * job is looked at.
 */
export function JobsPopover({ anchorRef, placeRef, id }: { anchorRef: RefObject<HTMLElement | null>; placeRef: RefObject<HTMLElement | null>; id: string }) {
  const { open, opened, setOpen } = useJobs();
  const close = () => setOpen(false);
  return (
    <Popover
      anchorRef={anchorRef}
      placeRef={placeRef}
      open={open}
      onClose={close}
      side="above"
      role="region"
      label="AI jobs"
      id={id}
      className="jobs-panel"
      // Opened by a job finishing, it leaves focus where the user was working.
      noAutoFocus={opened === 'auto'}
    >
      {/* Tabbing out of it closes it; focus going nowhere (a row dismissed) does not. */}
      <div
        className="jobs-body"
        onBlur={(e) => {
          const to = e.relatedTarget;
          const popover = e.currentTarget.parentElement;
          if (to && !popover?.contains(to) && !anchorRef.current?.contains(to)) close();
        }}
      >
        <header className="jobs-head">
          <Sparkles size={14} aria-hidden="true" />
          <h2>AI jobs</h2>
          <span className="spacer" />
          <IconButton
            size="sm"
            label="Minimise AI jobs"
            icon={<ChevronDown size={16} />}
            onClick={() => {
              close();
              anchorRef.current?.focus();
            }}
          />
        </header>
        <JobsList onLeave={close} />
      </div>
    </Popover>
  );
}
