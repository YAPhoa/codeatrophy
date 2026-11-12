import { useMemo } from 'react';
import type { CompareMode } from '../api/types';
import { collapseContext, diffLines, inlineChange, type DiffRow } from '../lib/diff';
import { cx } from './Button';

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

/** Side-by-side comparison of expected and actual output, with differing lines marked. */
export function DiffView({ expected, actual, mode = 'exact', leftLabel = 'Expected', rightLabel = 'Your output', variant = 'expected-actual' }: DiffViewProps) {
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
