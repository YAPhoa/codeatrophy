import { useState } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import type { LargeCaseReport } from '../../api/types';
import { describeLargeCase } from '../../lib/checks';
import { languageName } from '../../lib/languages';
import { Button, cx } from '../../ui/Button';
import { CodeEditor } from '../../ui/CodeEditor';

interface LargeCaseOutcomeProps {
  report: LargeCaseReport;
  /** The problem's time limit, to set the reference solution's time against. */
  timeLimitMs?: number;
  className?: string;
}

/**
 * What became of the large test case of a generation, in a line, with the
 * generator program the model wrote one click away, read-only.
 */
export function LargeCaseOutcome({ report, timeLimitMs, className }: LargeCaseOutcomeProps) {
  const [open, setOpen] = useState(false);
  const line = describeLargeCase(report, timeLimitMs);
  const generator = report.generator;
  return (
    <div className={cx('large-case', className)}>
      <div className="large-case-row">
        <p className={`check-line tone-${line.tone}`} role="status">
          {line.text}
        </p>
        <span className="spacer" />
        {generator && (
          <Button size="sm" variant="ghost" icon={open ? <EyeOff size={14} /> : <Eye size={14} />} aria-expanded={open} onClick={() => setOpen((v) => !v)}>
            {open ? 'Hide generator' : 'Show generator'}
          </Button>
        )}
      </div>
      {open && generator && (
        <div className="editor-frame large-case-generator">
          <CodeEditor value={generator.source} language={generator.language} readOnly ariaLabel={`Generator of the large case, ${languageName(generator.language)} (read-only)`} />
        </div>
      )}
    </div>
  );
}
