import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { BookmarkCheck, BookmarkPlus, Check, CircleCheck, Clock, Cpu, Eye, EyeOff, History, Loader2, Minus, RotateCcw, X } from 'lucide-react';
import type { CompareMode, Submission, SubmissionResult, Verdict } from '../../api/types';
import { VERDICT_LABEL, absoluteTime, describeRun, formatMemoryKb, formatRunTime, relativeTime, verdictTone } from '../../lib/format';
import { languageName } from '../../lib/languages';
import { isLargeText, textFilename } from '../../lib/largeText';
import { Button, cx } from '../../ui/Button';
import { DiffView } from '../../ui/DiffView';
import { LargeText } from '../../ui/LargeText';
import { Callout } from '../../ui/misc';
import type { Reveal } from './useReveal';

function CaseIcon({ verdict }: { verdict: Verdict }) {
  if (verdict === 'accepted') return <Check size={12} aria-hidden="true" />;
  if (verdict === 'executed') return <Minus size={12} aria-hidden="true" />;
  return <X size={12} aria-hidden="true" />;
}

interface OutputProps {
  label: string;
  note?: string | null;
  text: string;
  tone?: 'danger';
  wrap?: boolean;
  /** Name of the file a large text downloads as; derived from the label otherwise. */
  filename?: string;
}

/** A stream or a test case's data, labelled; a large one kept out of sight, as a download. */
export function Output({ label, note, text, tone, wrap, filename }: OutputProps) {
  return (
    <div className="io-block">
      <div className="io-label">
        {label}
        {note && <span className="io-note"> · {note}</span>}
      </div>
      {isLargeText(text) ? (
        <LargeText text={text} filename={filename ?? textFilename(label)} label={label} />
      ) : (
        <pre translate="no" className={cx('code-block', wrap && 'code-block-wrap', text === '' && 'code-block-empty', tone === 'danger' && 'code-block-danger')}>{text}</pre>
      )}
    </div>
  );
}

/** The server returns at most this much of each input and output stream. */
const SHOWN_BYTES = 64 * 1024;

/**
 * For a "Solution only" problem the program that ran has runner code around
 * the solver's. The server rewrites line numbers to the solver's own lines
 * and labels locations inside the runner; this says how to read them.
 */
export function lineOffsetNote(lineOffset: number | undefined): string | null {
  return lineOffset != null && lineOffset > 0 ? 'Line numbers refer to your code; <runner …> is the hidden runner.' : null;
}

const VERDICT_HELP: Partial<Record<Verdict, string>> = {
  wrong_answer: 'The program ran, but its output differs from the expected output.',
  time_limit_exceeded: 'The program did not finish within the time limit.',
  memory_limit_exceeded: 'The program used more memory than the limit allows.',
  runtime_error: 'The program crashed or exited with a non-zero status.',
  internal_error: 'The judge could not run this case.',
};

interface CaseDetailProps {
  result: SubmissionResult;
  /** Position among the results, from 1. */
  number: number;
  compare: CompareMode;
  timeLimitMs: number;
  reveal: Reveal;
  lineOffset: number;
}

function CaseDetail({ result, number, compare, timeLimitMs, reveal, lineOffset }: CaseDetailProps) {
  const concealed = reveal.conceals({ id: result.testCaseId, isSample: result.isSample });
  const failedCompare = result.verdict === 'wrong_answer' && result.expectedStdout !== null;
  // After a crash the error output is the first thing to read; otherwise it is a footnote.
  const crashed = result.verdict === 'runtime_error';
  const cut = [result.stdin, result.expectedStdout ?? '', result.stdout, result.stderr].some((text) => text.length >= SHOWN_BYTES / 4 && new Blob([text]).size >= SHOWN_BYTES);
  const stderr = result.stderr !== '' ? <Output label="Error output (stderr)" note={lineOffsetNote(lineOffset)} text={result.stderr} tone="danger" wrap /> : null;
  return (
    <div className="case-detail">
      <div className="row-wrap case-detail-head">
        <strong>{concealed ? `Case ${number}` : result.name || 'Test case'}</strong>
        <span className={`verdict-text tone-${verdictTone(result.verdict)}`}>{VERDICT_LABEL[result.verdict]}</span>
        {result.isSample ? <span className="chip">sample</span> : result.testCaseId ? <span className="chip">hidden</span> : null}
        <span className="muted">
          {formatRunTime(result.timeMs, result.verdict, timeLimitMs)} · {formatMemoryKb(result.memoryKb)}
        </span>
      </div>
      {VERDICT_HELP[result.verdict] && <p className="case-help">{VERDICT_HELP[result.verdict]}</p>}
      {crashed && stderr}
      {concealed ? (
        <div className="concealed">
          <EyeOff size={16} aria-hidden="true" />
          <span className="grow">The input and output of this hidden test case are kept out of sight.</span>
          <Button size="sm" icon={<Eye size={14} />} onClick={() => result.testCaseId && reveal.reveal(result.testCaseId)}>
            Reveal this case
          </Button>
          <Button size="sm" variant="ghost" onClick={reveal.revealAll}>
            Reveal all
          </Button>
        </div>
      ) : (
        <CaseIo result={result} number={number} compare={compare} failedCompare={failedCompare} />
      )}
      {!crashed && stderr}
      {!concealed && cut && <p className="case-help">Long input and output are cut off at 64&nbsp;KiB here; the judge compared the complete output.</p>}
    </div>
  );
}

function CaseIo({ result, number, compare, failedCompare }: { result: SubmissionResult; number: number; compare: CompareMode; failedCompare: boolean }) {
  const file = (what: string) => textFilename(result.name || `case ${number}`, what);
  return (
    <>
      <Output label="Input" text={result.stdin} filename={file('input')} />
      {failedCompare ? (
        <div className="io-block">
          <div className="io-label">Expected vs. your output</div>
          <DiffView expected={result.expectedStdout ?? ''} actual={result.stdout} mode={compare} downloadName={result.name || `case ${number}`} />
        </div>
      ) : (
        <div className="io-pair">
          {result.expectedStdout !== null && <Output label="Expected output" text={result.expectedStdout} filename={file('expected-output')} />}
          <Output label={result.expectedStdout === null ? 'Output' : 'Your output'} text={result.stdout} filename={file('output')} />
        </div>
      )}
    </>
  );
}

interface ResultPanelProps {
  submission: Submission;
  compare: CompareMode;
  /** Set when the panel shows a past submission rather than one just started. */
  historic: boolean;
  /** The problem's time limit, to present time-limit verdicts as exceeding it. */
  timeLimitMs: number;
  reveal: Reveal;
  onLoadCode?: () => void;
  onClose?: () => void;
  /** Keep this submission's code as one of the problem's saved solutions. */
  onSaveSolution?: () => void;
  /** The code of this submission has been saved as a solution during this visit. */
  savedAsSolution?: boolean;
  /** A saved solution that already holds this very code, and where the saved solutions are. */
  alreadySaved?: { name: string; to: string } | null;
}

/** Live progress and the final outcome of one submission, case by case. */
export function ResultPanel({ submission: s, compare, historic, timeLimitMs, reveal, onLoadCode, onClose, onSaveSolution, savedAsSolution, alreadySaved }: ResultPanelProps) {
  const done = s.status === 'completed';
  const firstFailed = s.results.findIndex((r) => r.verdict !== 'accepted' && r.verdict !== 'executed');
  const [picked, setPicked] = useState<number | null>(null);
  useEffect(() => setPicked(null), [s.id]);
  // Until the user picks a case, follow the most useful one: the first failure, else the first case.
  const selected = picked ?? (firstFailed !== -1 ? firstFailed : s.results.length > 0 ? 0 : null);
  const current = selected != null ? s.results[selected] : undefined;
  const custom = s.mode === 'run' && s.results.length > 0 && s.results.every((r) => r.testCaseId === null);
  const finished = s.results.length;
  const tone = s.verdict ? verdictTone(s.verdict) : 'neutral';
  // Judged while on screen: this very submission was seen running, so its
  // verdict is news. A past one, or one opened already finished, is not.
  const [judged, setJudged] = useState({ id: s.id, done, fresh: false });
  let fresh = judged.fresh;
  if (judged.id !== s.id || judged.done !== done) {
    fresh = judged.id === s.id && !judged.done && done && !historic;
    setJudged({ id: s.id, done, fresh });
  }
  const celebrate = fresh && s.verdict === 'accepted';
  const saveSolution = savedAsSolution ? (
    <span className="result-saved">
      <BookmarkCheck size={14} aria-hidden="true" />
      Saved as a solution
    </span>
  ) : alreadySaved ? (
    <Link to={alreadySaved.to} className="result-saved" title="Open the saved solutions">
      <BookmarkCheck size={14} aria-hidden="true" />
      <span className="truncate">Already saved as “{alreadySaved.name}”</span>
    </Link>
  ) : onSaveSolution ? (
    <Button size="sm" icon={<BookmarkPlus size={14} />} onClick={onSaveSolution}>
      Save as solution
    </Button>
  ) : null;

  return (
    <div className="result">
      {historic && (
        <div className="result-historic">
          <History size={14} aria-hidden="true" />
          <span className="grow">
            {s.mode === 'submit' ? 'Submission' : 'Run'} from <time title={absoluteTime(s.createdAt)}>{relativeTime(s.createdAt)}</time> · {languageName(s.language)}
          </span>
          {onLoadCode && (
            <Button size="sm" icon={<RotateCcw size={14} />} onClick={onLoadCode}>
              Load this code
            </Button>
          )}
          {saveSolution}
          {onClose && (
            <Button size="sm" variant="ghost" onClick={onClose}>
              Close
            </Button>
          )}
        </div>
      )}

      <div className={cx('result-head', `tone-${tone}`, celebrate && 'is-fresh')} role="status" aria-live="polite">
        {!done ? (
          <>
            <Loader2 size={18} className="spin" aria-hidden="true" />
            <div className="grow">
              <div className="result-verdict">{s.status === 'queued' ? 'Queued…' : `Running… ${finished} of ${s.totalCount} done`}</div>
              <div
                className="progress"
                role="progressbar"
                aria-label="Judging progress"
                aria-valuemin={0}
                aria-valuemax={Math.max(1, s.totalCount)}
                aria-valuenow={finished}
              >
                <div className="progress-fill" style={{ transform: `scaleX(${s.totalCount > 0 ? finished / s.totalCount : 0})` }} />
              </div>
            </div>
          </>
        ) : (
          <>
            {s.verdict === 'accepted' && (
              <span className="result-check" aria-hidden="true">
                <CircleCheck size={18} />
              </span>
            )}
            <div className="result-verdict">{s.verdict ? VERDICT_LABEL[s.verdict] : 'Finished'}</div>
            {!custom && s.verdict !== 'compile_error' && s.verdict !== 'internal_error' && (
              <span className="result-count">{describeRun(s.mode, s.totalCount, s.passedCount)}</span>
            )}
            <span className="spacer" />
            <span className="result-stats">
              {s.timeMs != null && s.results.length > 0 && (
                <span title="Slowest case">
                  <Clock size={12} aria-hidden="true" /> {formatRunTime(s.timeMs, s.verdict, timeLimitMs)}
                </span>
              )}
              {s.memoryKb != null && s.results.length > 0 && (
                <span title="Peak memory">
                  <Cpu size={12} aria-hidden="true" /> {formatMemoryKb(s.memoryKb)}
                </span>
              )}
              {custom && <span className="muted">custom input</span>}
            </span>
            {/* An accepted submission is the natural moment to keep the code; offered once, in place, never as a prompt. */}
            {!historic && s.mode === 'submit' && s.verdict === 'accepted' && saveSolution}
          </>
        )}
      </div>

      {done && s.verdict === 'internal_error' && (
        <Callout tone="warn" title="The judge could not complete this run">
          {s.error ?? 'The judge engine reported an internal error.'} Your code was not at fault; try again in a moment.
        </Callout>
      )}

      {done && s.verdict === 'compile_error' && (
        <div className="io-block">
          <div className="io-label">
            Compiler output
            {lineOffsetNote(s.lineOffset) && <span className="io-note"> · {lineOffsetNote(s.lineOffset)}</span>}
          </div>
          <pre translate="no" className="code-block code-block-danger compile-output">{s.compileOutput || 'The compiler reported an error but produced no output.'}</pre>
        </div>
      )}

      {s.compileOutput !== '' && s.verdict !== 'compile_error' && done && (
        <details className="compile-warnings">
          <summary>Compiler output (warnings)</summary>
          <pre translate="no" className="code-block">{s.compileOutput}</pre>
        </details>
      )}

      {(s.results.length > 0 || (!done && s.totalCount > 0)) && !custom && (
        <ol className="case-chips" aria-label="Test cases">
          {Array.from({ length: Math.max(s.totalCount, s.results.length) }, (_, i) => {
            const r = s.results[i];
            if (!r) {
              return (
                <li key={i}>
                  <span className="case-chip is-pending">
                    <span className="sr-only">Case </span>
                    {i + 1}
                    <span className="sr-only">: waiting</span>
                  </span>
                </li>
              );
            }
            // The name of a concealed case can give its content away, so it goes by its number.
            const name = reveal.conceals({ id: r.testCaseId, isSample: r.isSample }) ? '' : r.name;
            return (
              <li key={i}>
                <button
                  type="button"
                  className={cx('case-chip', `tone-${verdictTone(r.verdict)}`, selected === i && 'is-selected')}
                  aria-pressed={selected === i}
                  aria-label={`Case ${i + 1}${name ? `, ${name}` : ''}: ${VERDICT_LABEL[r.verdict]}`}
                  title={`${name || `Case ${i + 1}`}: ${VERDICT_LABEL[r.verdict]}`}
                  onClick={() => setPicked(i)}
                >
                  <CaseIcon verdict={r.verdict} />
                  {i + 1}
                </button>
              </li>
            );
          })}
        </ol>
      )}

      {current && selected != null && <CaseDetail result={current} number={selected + 1} compare={compare} timeLimitMs={timeLimitMs} reveal={reveal} lineOffset={s.lineOffset} />}
    </div>
  );
}
