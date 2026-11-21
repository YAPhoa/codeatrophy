import { useEffect } from 'react';
import { BookmarkPlus, History } from 'lucide-react';
import { useSubmissionList } from '../../api/queries';
import type { SubmissionSummary } from '../../api/types';
import { VERDICT_BRIEF, VERDICT_LABEL, absoluteTime, relativeTime, verdictTone } from '../../lib/format';
import { submissionFigures } from '../../lib/submissions';
import { languageName } from '../../lib/languages';
import { IconButton, cx } from '../../ui/Button';
import { EmptyState, ErrorState, PageLoading } from '../../ui/misc';

interface HistoryListProps {
  itemId: string;
  /** The submission whose details were just left: its row takes the focus back. */
  focusId: string | null;
  /** The problem's time limit, to present time-limit verdicts as exceeding it. */
  timeLimitMs: number;
  onOpen: (submissionId: string) => void;
  /** Keep the code of a past submission as a saved solution. */
  onSaveSolution: (submission: SubmissionSummary) => void;
}

const rowId = (submissionId: string) => `history-row-${submissionId}`;

/** Past submissions of a problem, newest first; runs are not kept. Opening one shows its details in place of the list. */
export function HistoryList({ itemId, focusId, timeLimitMs, onOpen, onSaveSolution }: HistoryListProps) {
  const list = useSubmissionList(itemId);
  const ready = list.isSuccess;
  useEffect(() => {
    if (ready && focusId) document.getElementById(rowId(focusId))?.focus();
  }, [ready, focusId]);
  if (list.isPending) return <PageLoading />;
  if (list.isError) return <ErrorState compact error={list.error} onRetry={() => void list.refetch()} />;
  if (list.data.items.length === 0) {
    return (
      // Centred in the pane, where nothing else is.
      <div className="history-empty">
        <EmptyState compact icon={<History size={20} />} title="No submissions yet" />
      </div>
    );
  }
  return (
    <>
      <div className="history">
        {/* Each row names its numbers for screen readers, so the header is for the eye only. */}
        <div className="history-head" aria-hidden="true">
          <span className="history-grid">
            <span>Status</span>
            <span>Language</span>
            <span className="history-count">Passed</span>
            <span className="history-time">Runtime</span>
            <span className="history-memory">Memory</span>
            <span className="history-when">Submitted</span>
          </span>
          <span className="history-head-save" />
        </div>
        <ul className="history-list">
          {list.data.items.map((s) => {
            const figures = submissionFigures(s, timeLimitMs);
            return (
              <li key={s.id} className="history-entry">
                <button type="button" id={rowId(s.id)} className="history-row history-grid" onClick={() => onOpen(s.id)}>
                  <span className={cx('history-verdict', s.verdict ? `tone-${verdictTone(s.verdict)}` : 'tone-neutral')} title={s.verdict ? VERDICT_LABEL[s.verdict] : undefined}>
                    {s.verdict ? VERDICT_BRIEF[s.verdict] : s.status === 'queued' ? 'Queued' : 'Running'}
                    {s.verdict && VERDICT_BRIEF[s.verdict] !== VERDICT_LABEL[s.verdict] && <span className="sr-only"> ({VERDICT_LABEL[s.verdict]})</span>}
                  </span>
                  <span>{languageName(s.language)}</span>
                  <span className="muted history-count">{figures.passed && <><span className="sr-only">Passed </span>{figures.passed}</>}</span>
                  <span className="muted history-time">{figures.runtime && <><span className="sr-only">Runtime </span>{figures.runtime}</>}</span>
                  <span className="muted history-memory">{figures.memory && <><span className="sr-only">Memory </span>{figures.memory}</>}</span>
                  <time className="muted history-when" dateTime={s.createdAt} title={absoluteTime(s.createdAt)}>
                    {relativeTime(s.createdAt)}
                  </time>
                </button>
                <IconButton
                  size="sm"
                  className={cx('history-save', s.verdict === 'accepted' && 'is-suggested')}
                  label="Save the code of this submission as a solution"
                  icon={<BookmarkPlus size={14} />}
                  onClick={() => onSaveSolution(s)}
                />
              </li>
            );
          })}
        </ul>
      </div>
      {list.data.total > list.data.items.length && <p className="muted history-more">Showing the latest {list.data.items.length} of {list.data.total}.</p>}
    </>
  );
}
