import { BookmarkPlus, History } from 'lucide-react';
import { useSubmissionList } from '../../api/queries';
import type { SubmissionSummary } from '../../api/types';
import { VERDICT_BRIEF, VERDICT_LABEL, absoluteTime, formatMemoryKb, formatRunTime, relativeTime, verdictTone } from '../../lib/format';
import { languageName } from '../../lib/languages';
import { IconButton, cx } from '../../ui/Button';
import { EmptyState, ErrorState, PageLoading } from '../../ui/misc';

interface HistoryListProps {
  itemId: string;
  activeId: string | null;
  /** The problem's time limit, to present time-limit verdicts as exceeding it. */
  timeLimitMs: number;
  onOpen: (submissionId: string) => void;
  /** Keep the code of a past submission as a saved solution. */
  onSaveSolution: (submission: SubmissionSummary) => void;
}

/** Past submissions of a problem, newest first; runs are not kept. Opening one shows its results and code. */
export function HistoryList({ itemId, activeId, timeLimitMs, onOpen, onSaveSolution }: HistoryListProps) {
  const list = useSubmissionList(itemId);
  if (list.isPending) return <PageLoading />;
  if (list.isError) return <ErrorState compact error={list.error} onRetry={() => void list.refetch()} />;
  if (list.data.items.length === 0) {
    return (
      <EmptyState compact icon={<History size={20} />} title="No submissions yet">
        Each submission is kept here with its code.
      </EmptyState>
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
            // Compile and judge errors have no meaningful count, time or memory.
            const measured = s.verdict !== null && s.verdict !== 'compile_error' && s.verdict !== 'internal_error';
            return (
              <li key={s.id} className="history-entry">
                <button type="button" className={cx('history-row history-grid', activeId === s.id && 'is-active')} onClick={() => onOpen(s.id)} aria-current={activeId === s.id || undefined}>
                  <span className={cx('history-verdict', s.verdict ? `tone-${verdictTone(s.verdict)}` : 'tone-neutral')} title={s.verdict ? VERDICT_LABEL[s.verdict] : undefined}>
                    {s.verdict ? VERDICT_BRIEF[s.verdict] : s.status === 'queued' ? 'Queued' : 'Running'}
                    {s.verdict && VERDICT_BRIEF[s.verdict] !== VERDICT_LABEL[s.verdict] && <span className="sr-only"> ({VERDICT_LABEL[s.verdict]})</span>}
                  </span>
                  <span>{languageName(s.language)}</span>
                  <span className="muted history-count">{measured && s.verdict !== 'executed' && s.totalCount > 0 && <><span className="sr-only">Passed </span>{s.passedCount}/{s.totalCount}</>}</span>
                  <span className="muted history-time">{measured && s.timeMs != null && <><span className="sr-only">Runtime </span>{formatRunTime(s.timeMs, s.verdict, timeLimitMs)}</>}</span>
                  <span className="muted history-memory">{measured && s.timeMs != null && s.memoryKb != null && <><span className="sr-only">Memory </span>{formatMemoryKb(s.memoryKb)}</>}</span>
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
