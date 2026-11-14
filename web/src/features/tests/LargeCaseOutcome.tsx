import { useState } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import type { LargeCaseReport } from '../../api/types';
import { describeLargeCase } from '../../lib/checks';
import { languageName } from '../../lib/languages';
import { Button, cx } from '../../ui/Button';
import { CodeEditor } from '../../ui/CodeEditor';

interface LargeCaseOutcomesProps {
  reports: readonly LargeCaseReport[];
  /** The problem's time limit, to set the reference solution's time against. */
  timeLimitMs?: number;
  className?: string;
}

/** What became of the large test cases of a generation, a line each, in order. Nothing when none were asked for. */
export function LargeCaseOutcomes({ reports, timeLimitMs, className }: LargeCaseOutcomesProps) {
  if (reports.length === 0) return null;
  // The toggles of several cases need names of their own: a case's name when no other has it, else its position.
  const which = (report: LargeCaseReport, i: number) =>
    report.name && reports.filter((r) => r.name === report.name).length === 1 ? `“${report.name}”` : `large case ${i + 1}`;
  return (
    <ul className={cx('large-cases', className)} aria-label="Large test cases">
      {reports.map((report, i) => (
        <li key={i}>
          <LargeCaseOutcome report={report} which={which(report, i)} timeLimitMs={timeLimitMs} />
        </li>
      ))}
    </ul>
  );
}

interface LargeCaseOutcomeProps {
  report: LargeCaseReport;
  /** What tells the case apart from the others, for the names of its controls. */
  which: string;
  timeLimitMs?: number;
}

/**
 * What became of one large test case, in a line, with the generator program
 * the model wrote one click away, read-only.
 */
function LargeCaseOutcome({ report, which, timeLimitMs }: LargeCaseOutcomeProps) {
  const [open, setOpen] = useState(false);
  const line = describeLargeCase(report, timeLimitMs);
  const generator = report.generator;
  return (
    <div className="large-case">
      <div className="large-case-row">
        <p className={`check-line tone-${line.tone}`} role="status">
          {line.text}
        </p>
        <span className="spacer" />
        {generator && (
          <Button
            size="sm"
            variant="ghost"
            icon={open ? <EyeOff size={14} /> : <Eye size={14} />}
            aria-expanded={open}
            aria-label={`${open ? 'Hide' : 'Show'} generator of ${which}`}
            onClick={() => setOpen((v) => !v)}
          >
            {open ? 'Hide generator' : 'Show generator'}
          </Button>
        )}
      </div>
      {open && generator && (
        <div className="editor-frame large-case-generator">
          <CodeEditor value={generator.source} language={generator.language} readOnly ariaLabel={`Generator of ${which}, ${languageName(generator.language)} (read-only)`} />
        </div>
      )}
    </div>
  );
}
