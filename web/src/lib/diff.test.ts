import { describe, expect, it } from 'vitest';
import { collapseContext, diffLines, inlineChange, outputsMatch, splitLines } from './diff';

describe('splitLines', () => {
  it('ignores one trailing newline but keeps interior blank lines', () => {
    expect(splitLines('a\n\nb\n')).toEqual(['a', '', 'b']);
    expect(splitLines('')).toEqual([]);
    expect(splitLines('a\r\nb')).toEqual(['a', 'b']);
  });
});

describe('outputsMatch', () => {
  it('tokens mode ignores all whitespace differences, including line breaks', () => {
    expect(outputsMatch('1 2 3\n', '1  2\n3', 'tokens')).toBe(true);
    expect(outputsMatch('1 2 3', '1 2 4', 'tokens')).toBe(false);
    expect(outputsMatch('12', '1 2', 'tokens')).toBe(false);
  });

  it('exact mode ignores only trailing whitespace and trailing blank lines', () => {
    expect(outputsMatch('a b\nc\n', 'a b  \nc\n\n\n', 'exact')).toBe(true);
    expect(outputsMatch('a b\n', 'a  b\n', 'exact')).toBe(false);
    expect(outputsMatch('a\n\nb', 'a\nb', 'exact')).toBe(false);
    expect(outputsMatch(' a', 'a', 'exact')).toBe(false);
  });
});

describe('diffLines', () => {
  it('reports identical outputs as all same', () => {
    const d = diffLines('1\n2\n', '1\n2\n');
    expect(d.changes).toBe(0);
    expect(d.rows.map((r) => r.kind)).toEqual(['same', 'same']);
  });

  it('pairs a replaced line as a single change row with both line numbers', () => {
    const d = diffLines('1\n2\n3\n', '1\nX\n3\n');
    expect(d.rows.map((r) => r.kind)).toEqual(['same', 'change', 'same']);
    expect(d.rows[1]).toMatchObject({ kind: 'change', left: '2', right: 'X', leftNo: 2, rightNo: 2 });
  });

  it('reports missing and extra lines on the correct side', () => {
    expect(diffLines('1\n2\n3', '1\n3').rows.map((r) => r.kind)).toEqual(['same', 'del', 'same']);
    const extra = diffLines('1\n3', '1\n2\n3');
    expect(extra.rows.map((r) => r.kind)).toEqual(['same', 'add', 'same']);
    expect(extra.rows[1]).toMatchObject({ kind: 'add', right: '2', rightNo: 2 });
  });

  it('keeps line numbers aligned after an insertion', () => {
    const d = diffLines('a\nb', 'x\na\nb');
    expect(d.rows[2]).toMatchObject({ kind: 'same', leftNo: 2, rightNo: 3 });
  });

  it('treats lines that differ only in whitespace as the same in tokens mode', () => {
    expect(diffLines('1 2 3', '1   2 3  ', 'tokens').changes).toBe(0);
    expect(diffLines('1 2 3', '1   2 3', 'exact').changes).toBe(1);
    expect(diffLines('1 2 3', '1 2 3   ', 'exact').changes).toBe(0);
  });

  it('handles an empty side', () => {
    expect(diffLines('', 'a\nb').rows.map((r) => r.kind)).toEqual(['add', 'add']);
    expect(diffLines('a', '').rows.map((r) => r.kind)).toEqual(['del']);
    expect(diffLines('', '').rows).toEqual([]);
  });

  it('pairs uneven runs: extra removed lines after the paired ones', () => {
    const d = diffLines('a\nb\nc\nz', 'x\nz');
    expect(d.rows.map((r) => r.kind)).toEqual(['change', 'del', 'del', 'same']);
  });
});

describe('inlineChange', () => {
  it('isolates the differing middle', () => {
    expect(inlineChange('0 1 2', '0 9 2')).toEqual({ prefix: '0 ', leftMid: '1', rightMid: '9', suffix: ' 2' });
  });

  it('does not let prefix and suffix overlap', () => {
    expect(inlineChange('aa', 'aaa')).toEqual({ prefix: 'aa', leftMid: '', rightMid: 'a', suffix: '' });
    expect(inlineChange('abc', 'abc')).toEqual({ prefix: 'abc', leftMid: '', rightMid: '', suffix: '' });
  });
});

describe('collapseContext', () => {
  const lines = (n: number, change?: number) =>
    Array.from({ length: n }, (_, i) => (i === change ? 'CHANGED' : `line ${i}`)).join('\n');

  it('hides long unchanged runs but keeps context around a change', () => {
    const rows = collapseContext(diffLines(lines(40), lines(40, 20)).rows, 3);
    expect(rows.map((r) => r.kind)).toEqual(['skip', 'same', 'same', 'same', 'change', 'same', 'same', 'same', 'skip']);
    expect(rows[0]).toEqual({ kind: 'skip', count: 17 });
    expect(rows[8]).toEqual({ kind: 'skip', count: 16 });
  });

  it('leaves short gaps and unchanged-only diffs alone', () => {
    const same = diffLines(lines(30), lines(30)).rows;
    expect(collapseContext(same)).toHaveLength(30);
    const near = collapseContext(diffLines('a\nb\nc\nd\ne', 'A\nb\nc\nd\nE').rows, 1);
    expect(near.some((r) => r.kind === 'skip')).toBe(false);
  });
});
