import { describe, expect, it } from 'vitest';
import { formatMemoryKb, formatRunTime } from './format';
import { replaceNeedsConfirm, submissionFigures, submissionHref } from './submissions';

describe('submissionFigures', () => {
  const base = { passedCount: 7, totalCount: 8, timeMs: 48, memoryKb: 9318 };

  it('gives the count, the runtime and the memory of a judged submission', () => {
    expect(submissionFigures({ ...base, verdict: 'wrong_answer' }, 2000)).toEqual({ passed: '7/8', runtime: formatRunTime(48, 'wrong_answer', 2000), memory: formatMemoryKb(9318) });
  });

  it('shows a time limit verdict as over the limit', () => {
    expect(submissionFigures({ ...base, verdict: 'time_limit_exceeded', timeMs: 2400 }, 2000).runtime).toMatch(/^> 2\s?s$/u);
  });

  it('gives no figures for compile and judge errors, or while judging', () => {
    for (const verdict of ['compile_error', 'internal_error', null] as const) {
      expect(submissionFigures({ ...base, verdict }, 2000)).toEqual({ passed: null, runtime: null, memory: null });
    }
  });

  it('gives no count for a program only executed, and no memory without a time', () => {
    expect(submissionFigures({ ...base, verdict: 'executed' }, 2000).passed).toBeNull();
    expect(submissionFigures({ ...base, verdict: 'accepted', totalCount: 0, passedCount: 0 }, 2000).passed).toBeNull();
    expect(submissionFigures({ ...base, verdict: 'accepted', timeMs: null }, 2000)).toEqual({ passed: '7/8', runtime: null, memory: null });
  });
});

describe('replaceNeedsConfirm', () => {
  it('asks only when the language has work of its own that the code would replace', () => {
    expect(replaceNeedsConfirm('print(1)', '# starter', 'print(2)')).toBe(true);
    expect(replaceNeedsConfirm('print(1)', undefined, 'print(2)')).toBe(true);
  });

  it('does not ask for no work, empty work, the starter code, or the same code', () => {
    expect(replaceNeedsConfirm(null, '# starter', 'print(2)')).toBe(false);
    expect(replaceNeedsConfirm(undefined, undefined, 'print(2)')).toBe(false);
    expect(replaceNeedsConfirm('  \n', '# starter', 'print(2)')).toBe(false);
    expect(replaceNeedsConfirm('# starter', '# starter', 'print(2)')).toBe(false);
    expect(replaceNeedsConfirm('print(2)', '# starter', 'print(2)')).toBe(false);
  });
});

describe('submissionHref', () => {
  it('opens the Submissions tab on the submission', () => {
    expect(submissionHref('i 1', 's/2')).toBe('/items/i%201?tab=submissions&submission=s%2F2');
  });
});
