// Output comparison and a small line diff, used to show "expected vs actual"
// for a failed test case.

import type { CompareMode } from '../api/types';

/** Split program output into lines, ignoring the final newline. */
export function splitLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function normalizeLine(line: string, mode: CompareMode): string {
  return mode === 'tokens' ? line.trim().split(/\s+/).join(' ') : line.replace(/\s+$/, '');
}

/**
 * Whether two outputs are equal under a compare mode, mirroring the server:
 * `tokens` compares whitespace-separated tokens; `exact` compares bytes after
 * stripping trailing whitespace on each line and trailing blank lines.
 */
export function outputsMatch(expected: string, actual: string, mode: CompareMode): boolean {
  if (mode === 'tokens') {
    const a = expected.split(/\s+/).filter(Boolean);
    const b = actual.split(/\s+/).filter(Boolean);
    return a.length === b.length && a.every((t, i) => t === b[i]);
  }
  const strip = (s: string) => {
    const lines = s.replace(/\r\n/g, '\n').split('\n').map((l) => l.replace(/\s+$/, ''));
    while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    return lines.join('\n');
  };
  return strip(expected) === strip(actual);
}

export type DiffRow =
  | { kind: 'same'; left: string; right: string; leftNo: number; rightNo: number }
  | { kind: 'change'; left: string; right: string; leftNo: number; rightNo: number }
  | { kind: 'del'; left: string; leftNo: number }
  | { kind: 'add'; right: string; rightNo: number };

export interface LineDiff {
  rows: DiffRow[];
  /** Number of rows that are not `same`. */
  changes: number;
  /** The inputs were too large for an alignment; rows were paired by position instead. */
  approximate: boolean;
}

const MAX_CELLS = 2_500_000;

/**
 * Line diff of `expected` (left) against `actual` (right). Lines that are
 * equal under the compare mode count as the same even if their whitespace
 * differs. A removed line directly followed by an added one is reported as a
 * single `change` row so the two can be shown side by side.
 */
export function diffLines(expected: string, actual: string, mode: CompareMode = 'exact'): LineDiff {
  const left = splitLines(expected);
  const right = splitLines(actual);
  const a = left.map((l) => normalizeLine(l, mode));
  const b = right.map((l) => normalizeLine(l, mode));

  const approximate = a.length * b.length > MAX_CELLS;
  const ops = approximate ? positionalOps(a, b) : lcsOps(a, b);

  const rows: DiffRow[] = [];
  let i = 0;
  let j = 0;
  let k = 0;
  while (k < ops.length) {
    const op = ops[k];
    if (op === 'same') {
      rows.push({ kind: 'same', left: left[i] ?? '', right: right[j] ?? '', leftNo: i + 1, rightNo: j + 1 });
      i++;
      j++;
      k++;
      continue;
    }
    // Collect a run of deletions and additions and pair them up in order.
    let dels = 0;
    let adds = 0;
    while (k < ops.length && ops[k] !== 'same') {
      if (ops[k] === 'del') dels++;
      else adds++;
      k++;
    }
    const paired = Math.min(dels, adds);
    for (let p = 0; p < paired; p++) {
      rows.push({ kind: 'change', left: left[i] ?? '', right: right[j] ?? '', leftNo: i + 1, rightNo: j + 1 });
      i++;
      j++;
    }
    for (let p = paired; p < dels; p++) {
      rows.push({ kind: 'del', left: left[i] ?? '', leftNo: i + 1 });
      i++;
    }
    for (let p = paired; p < adds; p++) {
      rows.push({ kind: 'add', right: right[j] ?? '', rightNo: j + 1 });
      j++;
    }
  }
  return { rows, changes: rows.reduce((n, r) => n + (r.kind === 'same' ? 0 : 1), 0), approximate };
}

type Op = 'same' | 'del' | 'add';

function lcsOps(a: readonly string[], b: readonly string[]): Op[] {
  const n = a.length;
  const m = b.length;
  const width = m + 1;
  // table[i * width + j] = length of the LCS of a[i..] and b[j..]
  const table = new Uint32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i * width + j] =
        a[i] === b[j]
          ? (table[(i + 1) * width + j + 1] ?? 0) + 1
          : Math.max(table[(i + 1) * width + j] ?? 0, table[i * width + j + 1] ?? 0);
    }
  }
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push('same');
      i++;
      j++;
    } else if ((table[(i + 1) * width + j] ?? 0) >= (table[i * width + j + 1] ?? 0)) {
      ops.push('del');
      i++;
    } else {
      ops.push('add');
      j++;
    }
  }
  while (i++ < n) ops.push('del');
  while (j++ < m) ops.push('add');
  return ops;
}

function positionalOps(a: readonly string[], b: readonly string[]): Op[] {
  const ops: Op[] = [];
  const common = Math.min(a.length, b.length);
  for (let i = 0; i < common; i++) {
    if (a[i] === b[i]) ops.push('same');
    else ops.push('del', 'add');
  }
  for (let i = common; i < a.length; i++) ops.push('del');
  for (let i = common; i < b.length; i++) ops.push('add');
  return ops;
}

export interface InlineChange {
  prefix: string;
  leftMid: string;
  rightMid: string;
  suffix: string;
}

/** Split two differing lines into the shared prefix/suffix and the parts that differ. */
export function inlineChange(left: string, right: string): InlineChange {
  const max = Math.min(left.length, right.length);
  let p = 0;
  while (p < max && left[p] === right[p]) p++;
  let s = 0;
  while (s < max - p && left[left.length - 1 - s] === right[right.length - 1 - s]) s++;
  return {
    prefix: left.slice(0, p),
    leftMid: left.slice(p, left.length - s),
    rightMid: right.slice(p, right.length - s),
    suffix: left.slice(left.length - s),
  };
}

export type DiffDisplayRow = DiffRow | { kind: 'skip'; count: number };

/**
 * Hide long runs of unchanged lines, keeping `context` lines around each
 * change, so that a one-line difference in a long text is easy to find. Runs
 * are only collapsed when that actually saves space.
 */
export function collapseContext(rows: readonly DiffRow[], context = 3): DiffDisplayRow[] {
  if (!rows.some((r) => r.kind !== 'same')) return rows.slice();
  const keep = new Array<boolean>(rows.length).fill(false);
  rows.forEach((row, i) => {
    if (row.kind === 'same') return;
    for (let j = Math.max(0, i - context); j <= Math.min(rows.length - 1, i + context); j++) keep[j] = true;
  });
  const out: DiffDisplayRow[] = [];
  let i = 0;
  while (i < rows.length) {
    if (keep[i]) {
      out.push(rows[i] as DiffRow);
      i++;
      continue;
    }
    let j = i;
    while (j < rows.length && !keep[j]) j++;
    // Replacing one or two lines with a marker would not make anything shorter.
    if (j - i <= 2) for (let k = i; k < j; k++) out.push(rows[k] as DiffRow);
    else out.push({ kind: 'skip', count: j - i });
    i = j;
  }
  return out;
}
