import type { ReactNode } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import type { LargeCaseReport, SourceCode } from '../../api/types';
import { describeLargeCase, summariseLargeCases } from '../../lib/checks';
import { languageName } from '../../lib/languages';
import { Button, cx } from '../../ui/Button';
import { CodeEditor } from '../../ui/CodeEditor';
import { InfoTip } from '../../ui/InfoTip';

interface LargeCaseSummaryProps {
  reports: readonly LargeCaseReport[];
  /** The problem's time limit, to set the reference solution's time against. */
  timeLimitMs?: number;
  /** Whether the large cases are shown; the caller lists them. */
  open: boolean;
  onToggle: () => void;
  /** Said of them behind an "i" by the summary. */
  info?: ReactNode;
  className?: string;
}

/**
 * What became of the large test cases of a generation: a line that sums
 * them up, and a toggle for the cases themselves, which the caller lists
 * after it. Open, it gives the line of each case that has no place in that
 * list, or whose reference solution was slow. Nothing when none were asked
 * for.
 */
export function LargeCaseSummary({ reports, timeLimitMs, open, onToggle, info, className }: LargeCaseSummaryProps) {
  if (reports.length === 0) return null;
  const lines = reports.map((r) => describeLargeCase(r, timeLimitMs));
  const summary = summariseLargeCases(reports, lines);
  // Each line the summary's tone comes from, so a warning is never left unexplained.
  const told = lines.filter((line, i) => reports[i]!.status !== 'added' || line.tone === 'warn');
  return (
    <section className={cx('large-cases', className)} aria-label="Large test cases">
      <div className="large-case-row">
        <div className="field-label-row">
          <p className={`check-line tone-${summary.tone}`} role="status">
            {summary.text}
          </p>
          {info && <InfoTip label="About large cases">{info}</InfoTip>}
        </div>
        <span className="spacer" />
        <Button size="sm" variant="ghost" icon={open ? <EyeOff size={14} /> : <Eye size={14} />} aria-expanded={open} onClick={onToggle}>
          {open ? 'Hide large cases' : 'Show large cases'}
        </Button>
      </div>
      {open && told.length > 0 && (
        <ul className="large-case-list">
          {told.map((line, i) => (
            <li key={i} className={`check-line tone-${line.tone}`}>
              {line.text}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * The generator program of a large test case, read-only. `of` names the
 * case, e.g. "case 3"; `labelClassName` matches the label to those of the
 * case's data.
 */
export function LargeCaseGenerator({ generator, of, labelClassName = 'io-label' }: { generator: SourceCode; of: string; labelClassName?: string }) {
  return (
    <div className="io-block">
      <div className={labelClassName}>
        Generator<span className="io-note"> · {languageName(generator.language)}</span>
      </div>
      <div className="editor-frame large-case-generator">
        <CodeEditor value={generator.source} language={generator.language} readOnly ariaLabel={`Generator of ${of}, ${languageName(generator.language)} (read-only)`} />
      </div>
    </div>
  );
}
