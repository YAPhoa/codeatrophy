import { useEffect, useState } from 'react';
import { Check, Clock, Cpu, History, Loader2, Minus, RotateCcw, X } from 'lucide-react';
import type { CompareMode, Submission, SubmissionResult, Verdict } from '../../api/types';
import { VERDICT_LABEL, absoluteTime, formatMemoryKb, formatMs, relativeTime, verdictTone } from '../../lib/format';
import { languageName } from '../../lib/languages';
import { Button, cx } from '../../ui/Button';
import { DiffView } from '../../ui/DiffView';
import { Callout } from '../../ui/misc';

function CaseIcon({ verdict }: { verdict: Verdict }) {
  if (verdict === 'accepted') return <Check size={12} aria-hidden="true" />;
  if (verdict === 'executed') return <Minus size={12} aria-hidden="true" />;
  return <X size={12} aria-hidden="true" />;
}

function Output({ label, text, tone, wrap }: { label: string; text: string; tone?: 'danger'; wrap?: boolean }) {
  return (
    <div className="io-block">
      <div className="io-label">{label}</div>
      <pre className={cx('code-block', wrap && 'code-block-wrap', text === '' && 'code-block-empty', tone === 'danger' && 'code-block-danger')}>{text}</pre>
    </div>
  );
}

/** The server returns at most this much of each input and output stream. */
const SHOWN_BYTES = 64 * 1024;

const VERDICT_HELP: Partial<Record<Verdict, string>> = {
  wrong_answer: 'The program ran, but its output differs from the expected output.',
  time_limit_exceeded: 'The program did not finish within the time limit.',
  memory_limit_exceeded: 'The program used more memory than the limit allows.',
  runtime_error: 'The program crashed or exited with a non-zero status.',
  internal_error: 'The judge could not run this case.',
};

function CaseDetail({ result, compare }: { result: SubmissionResult; compare: CompareMode }) {
  const failedCompare = result.verdict === 'wrong_answer' && result.expectedStdout !== null;
  // After a crash the error output is the first thing to read; otherwise it is a footnote.
  const crashed = result.verdict === 'runtime_error';
  const cut = [result.stdin, result.expectedStdout ?? '', result.stdout, result.stderr].some((text) => text.length >= SHOWN_BYTES / 4 && new Blob([text]).size >= SHOWN_BYTES);
  const stderr = result.stderr !== '' ? <Output label="Error output (stderr)" text={result.stderr} tone="danger" wrap /> : null;
  return (
    <div className="case-detail">
      <div className="row-wrap case-detail-head">
        <strong>{result.name || 'Test case'}</strong>
        <span className={`verdict-text tone-${verdictTone(result.verdict)}`}>{VERDICT_LABEL[result.verdict]}</span>
        {result.isSample ? <span className="chip">sample</span> : result.testCaseId ? <span className="chip">hidden</span> : null}
        <span className="muted">
          {formatMs(result.timeMs)} · {formatMemoryKb(result.memoryKb)}
        </span>
      </div>
      {VERDICT_HELP[result.verdict] && <p className="case-help">{VERDICT_HELP[result.verdict]}</p>}
      {crashed && stderr}
      <Output label="Input" text={result.stdin} />
      {failedCompare ? (
        <div className="io-block">
          <div className="io-label">Expected vs. your output</div>
          <DiffView expected={result.expectedStdout ?? ''} actual={result.stdout} mode={compare} />
        </div>
      ) : (
        <div className="io-pair">
          {result.expectedStdout !== null && <Output label="Expected output" text={result.expectedStdout} />}
          <Output label={result.expectedStdout === null ? 'Output' : 'Your output'} text={result.stdout} />
        </div>
      )}
      {!crashed && stderr}
      {cut && <p className="case-help">Long input and output are cut off at 64 KiB here; the judge compared the complete output.</p>}
    </div>
  );
}

interface ResultPanelProps {
  submission: Submission;
  compare: CompareMode;
  /** Set when the panel shows a past submission rather than one just started. */
  historic: boolean;
  onLoadCode?: () => void;
  onClose?: () => void;
}

/** Live progress and the final outcome of one submission, case by case. */
export function ResultPanel({ submission: s, compare, historic, onLoadCode, onClose }: ResultPanelProps) {
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

  return (
    <div className="result">
      {historic && (
        <div className="result-historic">
          <History size={14} aria-hidden="true" />
          <span className="grow">
            {s.mode === 'submit' ? 'Submission' : 'Run'} from <time title={absoluteTime(s.createdAt)}>{relativeTime(s.createdAt)}</time> · {languageName(s.language)}
          </span>
          {onLoadCode && (
            <Button size="sm" icon={<RotateCcw size={13} />} onClick={onLoadCode}>
              Load this code
            </Button>
          )}
          {onClose && (
            <Button size="sm" variant="ghost" onClick={onClose}>
              Close
            </Button>
          )}
        </div>
      )}

      <div className={cx('result-head', `tone-${tone}`)} role="status" aria-live="polite">
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
                <div className="progress-fill" style={{ width: `${s.totalCount > 0 ? (finished / s.totalCount) * 100 : 0}%` }} />
              </div>
            </div>
          </>
        ) : (
          <>
            <div className="result-verdict">{s.verdict ? VERDICT_LABEL[s.verdict] : 'Finished'}</div>
            {!custom && s.verdict !== 'compile_error' && s.verdict !== 'internal_error' && (
              <span className="result-count">
                {s.passedCount}/{s.totalCount} passed
              </span>
            )}
            <span className="spacer" />
            <span className="result-stats">
              {s.timeMs != null && s.results.length > 0 && (
                <span title="Slowest case">
                  <Clock size={12} aria-hidden="true" /> {formatMs(s.timeMs)}
                </span>
              )}
              {s.memoryKb != null && s.results.length > 0 && (
                <span title="Peak memory">
                  <Cpu size={12} aria-hidden="true" /> {formatMemoryKb(s.memoryKb)}
                </span>
              )}
              <span className="muted">{s.mode === 'submit' ? 'all tests' : custom ? 'custom input' : 'samples'}</span>
            </span>
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
          <div className="io-label">Compiler output</div>
          <pre className="code-block code-block-danger compile-output">{s.compileOutput || 'The compiler reported an error but produced no output.'}</pre>
        </div>
      )}

      {s.compileOutput !== '' && s.verdict !== 'compile_error' && done && (
        <details className="compile-warnings">
          <summary>Compiler output (warnings)</summary>
          <pre className="code-block">{s.compileOutput}</pre>
        </details>
      )}

      {(s.results.length > 0 || (!done && s.totalCount > 0)) && !custom && (
        <ol className="case-chips" aria-label="Test cases">
          {Array.from({ length: Math.max(s.totalCount, s.results.length) }, (_, i) => {
            const r = s.results[i];
            if (!r) {
              return (
                <li key={i}>
                  <span className="case-chip is-pending" aria-label={`Case ${i + 1}: waiting`}>
                    {i + 1}
                  </span>
                </li>
              );
            }
            return (
              <li key={i}>
                <button
                  type="button"
                  className={cx('case-chip', `tone-${verdictTone(r.verdict)}`, selected === i && 'is-selected')}
                  aria-pressed={selected === i}
                  aria-label={`Case ${i + 1}, ${r.name || 'unnamed'}: ${VERDICT_LABEL[r.verdict]}`}
                  title={`${r.name || `Case ${i + 1}`} — ${VERDICT_LABEL[r.verdict]}`}
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

      {current && <CaseDetail result={current} compare={compare} />}
    </div>
  );
}
