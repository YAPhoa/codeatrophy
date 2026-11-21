import { useEffect, useRef, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, FileQuestion, SquarePen } from 'lucide-react';
import { api, isApiError } from '../../api/client';
import { qk } from '../../api/queries';
import type { CompareMode, Solution, Submission } from '../../api/types';
import { VERDICT_LABEL, absoluteTime, relativeTime, verdictTone } from '../../lib/format';
import { languageName } from '../../lib/languages';
import { submissionFigures, submissionHref } from '../../lib/submissions';
import { Button, cx } from '../../ui/Button';
import { Clamped, OutputClamp } from '../../ui/Clamped';
import { CodeEditor } from '../../ui/CodeEditor';
import { CopyButton, EmptyState, ErrorState, PageLoading } from '../../ui/misc';
import { lineCount, savedWithCode } from '../solutions/solutionWrites';
import { SaveSolutionAction, SubmissionOutcome } from './ResultPanel';
import type { Reveal } from './useReveal';

/** Lines of output, and of code, shown before "Show more". */
const OUTPUT_LINES = 6;
const CODE_LINES = 15;
const POLL_MS = 700;

interface SubmissionDetailsProps {
  itemId: string;
  submissionId: string;
  compare: CompareMode;
  timeLimitMs: number;
  reveal: Reveal;
  /** Move the focus to the details as they open (they were opened from the list). */
  focusOnOpen: boolean;
  onBack: () => void;
  /** Why a language's code cannot go into the editor here, or `null` when it can. */
  blockedReason: (language: string) => string | null;
  onOpenInEditor: (submission: Submission) => void;
  onSaveSolution: (submission: Submission) => void;
  /** Submissions whose code was saved as a solution during this visit. */
  savedFrom: ReadonlySet<string>;
  solutions: readonly Solution[] | undefined;
}

/** One past submission, in place of the list in the Submissions tab: its verdict, figures, outcome and code. */
export function SubmissionDetails(props: SubmissionDetailsProps) {
  const { itemId, submissionId, onBack } = props;
  const query = useQuery({
    queryKey: qk.submission(submissionId),
    queryFn: ({ signal }) => api.submissions.get(submissionId, signal),
    // One still being judged fills in; a finished one never changes.
    refetchInterval: (q) => (q.state.data && q.state.data.status !== 'completed' ? POLL_MS : false),
    refetchOnWindowFocus: false,
    staleTime: Infinity,
    retry: (count, error) => !(isApiError(error) && error.code === 'not_found') && count < 2,
  });
  // Another problem's submission is not this page's to show.
  const elsewhere = query.data !== undefined && query.data.itemId !== itemId;

  const back = (
    <Button size="sm" variant="ghost" className="submission-back" icon={<ArrowLeft size={14} />} onClick={onBack}>
      All submissions
    </Button>
  );

  if (query.isPending) return <PageLoading />;
  if ((query.isError && isApiError(query.error) && query.error.code === 'not_found') || elsewhere) {
    return (
      <div className="submission">
        {back}
        <EmptyState compact icon={<FileQuestion size={20} />} title="This submission does not exist" />
      </div>
    );
  }
  if (query.isError) {
    return (
      <div className="submission">
        {back}
        <ErrorState compact error={query.error} onRetry={() => void query.refetch()} />
      </div>
    );
  }
  return <Details {...props} submission={query.data} back={back} />;
}

function Details({ submission: s, back, compare, timeLimitMs, reveal, focusOnOpen, blockedReason, onOpenInEditor, onSaveSolution, savedFrom, solutions, itemId }: SubmissionDetailsProps & { submission: Submission; back: ReactNode }) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (focusOnOpen) heading.current?.focus();
    // Only as the details open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.id]);

  const done = s.status === 'completed';
  const figures = submissionFigures(s, timeLimitMs);
  const blocked = blockedReason(s.language);
  const kept = done ? savedWithCode(solutions, s) : undefined;
  const link = `${window.location.origin}${submissionHref(itemId, s.id)}`;

  return (
    <article className="submission" aria-labelledby="submission-heading">
      {back}
      <header className="submission-head">
        <h2 id="submission-heading" ref={heading} tabIndex={-1} className={cx('submission-verdict', s.verdict ? `tone-${verdictTone(s.verdict)}` : 'tone-neutral')}>
          {s.verdict ? VERDICT_LABEL[s.verdict] : s.status === 'queued' ? 'Queued…' : 'Running…'}
        </h2>
        <p className="submission-facts muted">
          <time dateTime={s.createdAt} title={absoluteTime(s.createdAt)}>
            {relativeTime(s.createdAt)}
          </time>
          <span>{languageName(s.language)}</span>
          {figures.passed && <span>{figures.passed} passed</span>}
          {figures.runtime && <span title="Slowest case">{figures.runtime}</span>}
          {figures.memory && <span title="Peak memory">{figures.memory}</span>}
        </p>
      </header>

      <div className="row-wrap submission-actions">
        <Button size="sm" icon={<SquarePen size={14} />} onClick={() => onOpenInEditor(s)} disabled={blocked !== null} title={blocked ?? 'Put this code into the editor'}>
          Open in editor
        </Button>
        {done && s.source.trim() !== '' && (
          <SaveSolutionAction
            onSaveSolution={() => onSaveSolution(s)}
            savedAsSolution={savedFrom.has(s.id)}
            alreadySaved={kept ? { name: kept.name, to: `/items/${itemId}/solutions` } : null}
          />
        )}
        <CopyButton text={link} label="Copy link" />
      </div>

      <OutputClamp.Provider value={OUTPUT_LINES}>
        <div className="result submission-outcome">
          <SubmissionOutcome submission={s} compare={compare} timeLimitMs={timeLimitMs} reveal={reveal} />
        </div>
      </OutputClamp.Provider>

      <section className="io-block submission-code" aria-label="Code">
        <div className="io-label">Code</div>
        <Clamped lines={CODE_LINES} total={lineCount(s.source)}>
          <CodeEditor value={s.source} language={s.language} readOnly ariaLabel={`Code of this ${languageName(s.language)} submission (read-only)`} />
        </Clamped>
      </section>
    </article>
  );
}
