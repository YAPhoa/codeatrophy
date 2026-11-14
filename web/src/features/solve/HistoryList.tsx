import { BookmarkPlus, History } from 'lucide-react';
import { useSubmissionList } from '../../api/queries';
import type { SubmissionSummary } from '../../api/types';
import { VERDICT_BRIEF, VERDICT_LABEL, absoluteTime, formatRunTime, relativeTime, verdictTone } from '../../lib/format';
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

/** Past runs and submissions of a problem, newest first. Opening one shows its results and code. */
export function HistoryList({ itemId, activeId, timeLimitMs, onOpen, onSaveSolution }: HistoryListProps) {
  const list = useSubmissionList(itemId);
  if (list.isPending) return <PageLoading />;
  if (list.isError) return <ErrorState compact error={list.error} onRetry={() => void list.refetch()} />;
  if (list.data.items.length === 0) {
    return (
      <EmptyState compact icon={<History size={20} />} title="No submissions yet">
        Runs and submissions appear here, with the code you sent, so you can go back to an earlier attempt.
      </EmptyState>
    );
  }
  return (
    <>
      <ul className="history">
        {list.data.items.map((s) => (
          <li key={s.id} className="history-entry">
            <button type="button" className={cx('history-row', activeId === s.id && 'is-active')} onClick={() => onOpen(s.id)} aria-current={activeId === s.id || undefined}>
              <span className={cx('history-verdict', s.verdict ? `tone-${verdictTone(s.verdict)}` : 'tone-neutral')} title={s.verdict ? VERDICT_LABEL[s.verdict] : undefined}>
                {s.verdict ? VERDICT_BRIEF[s.verdict] : s.status === 'queued' ? 'Queued' : 'Running'}
                {s.verdict && VERDICT_BRIEF[s.verdict] !== VERDICT_LABEL[s.verdict] && <span className="sr-only"> ({VERDICT_LABEL[s.verdict]})</span>}
              </span>
              <span className="history-mode">{s.mode === 'submit' ? 'Submit' : 'Run'}</span>
              <span>{languageName(s.language)}</span>
              <span className="muted history-count">{s.verdict && !['executed', 'compile_error', 'internal_error'].includes(s.verdict) && s.totalCount > 0 ? `${s.passedCount}/${s.totalCount}` : ''}</span>
              <span className="muted history-time">{s.timeMs != null && s.verdict !== 'compile_error' && s.verdict !== 'internal_error' ? formatRunTime(s.timeMs, s.verdict, timeLimitMs) : ''}</span>
              <time className="muted history-when" dateTime={s.createdAt} title={absoluteTime(s.createdAt)}>
                {relativeTime(s.createdAt)}
              </time>
            </button>
            <IconButton
              size="sm"
              className={cx('history-save', s.mode === 'submit' && s.verdict === 'accepted' && 'is-suggested')}
              label={`Save the code of this ${s.mode === 'submit' ? 'submission' : 'run'} as a solution`}
              icon={<BookmarkPlus size={14} />}
              onClick={() => onSaveSolution(s)}
            />
          </li>
        ))}
      </ul>
      {list.data.total > list.data.items.length && <p className="muted history-more">Showing the latest {list.data.items.length} of {list.data.total}.</p>}
    </>
  );
}
