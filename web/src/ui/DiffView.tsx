import { useMemo } from 'react';
import { Download, EyeOff } from 'lucide-react';
import type { CompareMode } from '../api/types';
import { collapseContext, diffLines, inlineChange, outputsMatch, type DiffRow } from '../lib/diff';
import { isLargeText, textFilename } from '../lib/largeText';
import { Button, cx } from './Button';
import { saveText } from './LargeText';

interface DiffViewProps {
  expected: string;
  actual: string;
  mode?: CompareMode;
  leftLabel?: string;
  rightLabel?: string;
  /**
   * How the two sides relate. `expected-actual` (default): the left side is
   * what was wanted and the right side is what came out, so differences on
   * the right are the faulty ones. `before-after`: the left side is the older
   * or superseded text and the right side the one that holds now.
   */
  variant?: 'expected-actual' | 'before-after';
  /** What downloaded outputs are named after, when they are too large to show. */
  downloadName?: string;
}

function Cell({ row, side }: { row: DiffRow; side: 'left' | 'right' }) {
  if (row.kind === 'same') return <>{side === 'left' ? row.left : row.right}</>;
  if (row.kind === 'change') {
    const c = inlineChange(row.left, row.right);
    return (
      <>
        {c.prefix}
        <mark>{side === 'left' ? c.leftMid : c.rightMid}</mark>
        {c.suffix}
      </>
    );
  }
  if (row.kind === 'del') return <>{side === 'left' ? row.left : ''}</>;
  return <>{side === 'right' ? row.right : ''}</>;
}

/**
 * Side-by-side comparison of expected and actual output, with differing lines
 * marked. When either is too large to show, only whether they differ is
 * said, and both are offered as downloads.
 */
export function DiffView(props: DiffViewProps) {
  return isLargeText(props.expected) || isLargeText(props.actual) ? <LargeOutputs {...props} /> : <LineDiff {...props} />;
}

function LargeOutputs({ expected, actual, mode = 'exact', leftLabel = 'Expected', rightLabel = 'Your output', downloadName = 'output' }: DiffViewProps) {
  // Outputs that were cut at a size limit can differ only beyond the cut, so a match is not claimed outright.
  const same = useMemo(() => outputsMatch(expected, actual, mode), [expected, actual, mode]);
  return (
    <div className="concealed large-text" role="group" aria-label={`${leftLabel} compared with ${rightLabel}`}>
      <EyeOff size={16} aria-hidden="true" />
      <span className="grow">{same ? 'No difference found' : 'The outputs differ'}; too large to show.</span>
      <Button size="sm" icon={<Download size={14} />} title="Download" onClick={() => saveText(expected, textFilename(downloadName, leftLabel))}>
        {leftLabel}
      </Button>
      <Button size="sm" icon={<Download size={14} />} title="Download" onClick={() => saveText(actual, textFilename(downloadName, rightLabel))}>
        {rightLabel}
      </Button>
    </div>
  );
}

function LineDiff({ expected, actual, mode = 'exact', leftLabel = 'Expected', rightLabel = 'Your output', variant = 'expected-actual' }: DiffViewProps) {
  const leftClass = variant === 'expected-actual' ? 'diff-good' : 'diff-bad';
  const rightClass = variant === 'expected-actual' ? 'diff-bad' : 'diff-good';
  const diff = useMemo(() => diffLines(expected, actual, mode), [expected, actual, mode]);
  const rows = useMemo(() => collapseContext(diff.rows), [diff]);

  return (
    <div className="diff">
      <table className="diff-table">
        <caption className="sr-only">
          {leftLabel} compared with {rightLabel}: {diff.changes} differing {diff.changes === 1 ? 'line' : 'lines'}
        </caption>
        <colgroup>
          <col className="diff-col-no" />
          <col />
          <col className="diff-col-no" />
          <col />
        </colgroup>
        <thead>
          <tr>
            <th scope="col" colSpan={2}>
              {leftLabel}
            </th>
            <th scope="col" colSpan={2}>
              {rightLabel}
            </th>
          </tr>
        </thead>
        <tbody>
          {diff.rows.length === 0 && (
            <tr>
              <td colSpan={4} className="diff-empty">
                Both are empty.
              </td>
            </tr>
          )}
          {rows.map((row, i) => {
            if (row.kind === 'skip') {
              return (
                <tr key={i} className="diff-skip">
                  <td colSpan={4}>
                    {row.count} unchanged {row.count === 1 ? 'line' : 'lines'}
                  </td>
                </tr>
              );
            }
            const leftMissing = row.kind === 'add';
            const rightMissing = row.kind === 'del';
            return (
              <tr key={i} className={cx(row.kind !== 'same' && 'diff-row-changed')}>
                <td className="diff-no">{leftMissing ? '' : row.leftNo}</td>
                <td className={cx('diff-cell', row.kind !== 'same' && !leftMissing && leftClass, leftMissing && 'diff-blank')}>
                  <span className="sr-only">{row.kind !== 'same' && !leftMissing ? 'expected: ' : ''}</span>
                  <Cell row={row} side="left" />
                </td>
                <td className="diff-no">{rightMissing ? '' : row.rightNo}</td>
                <td className={cx('diff-cell', row.kind !== 'same' && !rightMissing && rightClass, rightMissing && 'diff-blank')}>
                  <span className="sr-only">{row.kind !== 'same' && !rightMissing ? 'actual: ' : ''}</span>
                  <Cell row={row} side="right" />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {diff.changes === 0 && diff.rows.length > 0 && (
        <p className="diff-note">
          No line differs{mode === 'tokens' ? ' once whitespace is ignored' : ''}. The difference may be in line breaks or
          in output that was cut off at the size limit.
        </p>
      )}
      {diff.approximate && <p className="diff-note">The outputs are very long, so lines were compared by position.</p>}
    </div>
  );
}
