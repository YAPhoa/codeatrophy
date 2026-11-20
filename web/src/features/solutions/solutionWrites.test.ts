import { describe, expect, it } from 'vitest';
import { ApiError } from '../../api/client';
import type { Limits, Solution } from '../../api/types';
import { defaultSolutionName, describeLastRun, describeRunFigures, isSolutionLimitError, lineCount, savedWithCode, serverFieldErrors, touchesReference, validateSolution } from './solutionWrites';

const limits = { maxSolutionNameChars: 10, maxSolutionNotesChars: 20, maxSourceBytes: 16 } as Limits;

const solution = (name: string): Solution => ({
  id: name,
  itemId: 'item',
  name,
  language: 'python',
  source: 'print(1)',
  notes: '',
  isReference: false,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  lastRun: null,
});

describe('validateSolution', () => {
  it('accepts a named solution with code', () => {
    expect(validateSolution({ name: 'Hash map', source: 'print(1)', notes: '' }, limits)).toEqual({});
  });

  it('requires a name and code', () => {
    const errors = validateSolution({ name: '   ', source: ' \n', notes: '' }, limits);
    expect(errors.name).toBeDefined();
    expect(errors.source).toBeDefined();
  });

  it('applies the limits the server publishes', () => {
    const errors = validateSolution({ name: 'x'.repeat(11), source: 'é'.repeat(9), notes: 'n'.repeat(21) }, limits);
    expect(errors.name).toContain('10');
    // Nine two-byte characters are 18 bytes: the source limit counts bytes, not characters.
    expect(errors.source).toBeDefined();
    expect(errors.notes).toContain('20');
  });

  it('does not guess limits it has not been given', () => {
    expect(validateSolution({ name: 'x'.repeat(500), source: 'print(1)', notes: 'n'.repeat(99_999) }, undefined)).toEqual({});
  });
});

describe('touchesReference', () => {
  const plain = solution('Brute force');
  const reference = { ...solution('Intended'), isReference: true };

  it('is true for a new solution that becomes the reference', () => {
    expect(touchesReference(null, { isReference: true })).toBe(true);
    expect(touchesReference(null, { isReference: false })).toBe(false);
    expect(touchesReference(null, {})).toBe(false);
  });

  it('is true when the reference mark moves', () => {
    expect(touchesReference(plain, { isReference: true })).toBe(true);
    expect(touchesReference(reference, { isReference: false })).toBe(true);
    expect(touchesReference(reference, { isReference: true })).toBe(false);
  });

  it('is true when the code or language of the reference changes, and only then', () => {
    expect(touchesReference(reference, { source: 'print(2)' })).toBe(true);
    expect(touchesReference(reference, { language: 'go' })).toBe(true);
    expect(touchesReference(reference, { source: reference.source, language: reference.language })).toBe(false);
    expect(touchesReference(reference, { name: 'Renamed', notes: 'O(n)' })).toBe(false);
  });

  it('is false for any change to a solution that is not the reference', () => {
    expect(touchesReference(plain, { source: 'print(2)', language: 'go', name: 'x', notes: 'y' })).toBe(false);
  });
});

describe('defaultSolutionName', () => {
  it('names a solution after its language', () => {
    expect(defaultSolutionName('python', [])).toBe('Python solution');
  });

  it('numbers the name when it is taken', () => {
    expect(defaultSolutionName('python', [solution('Python solution')])).toBe('Python solution 2');
    expect(defaultSolutionName('python', [solution('Python solution'), solution('Python solution 2')])).toBe('Python solution 3');
  });
});

describe('savedWithCode', () => {
  const saved = [solution('First'), { ...solution('Mine'), source: 'print(2)' }, { ...solution('Reference'), source: 'print(2)', isReference: true }];

  it('finds the solution that holds the very same code in the same language', () => {
    expect(savedWithCode(saved, { language: 'python', source: 'print(1)' })?.name).toBe('First');
    expect(savedWithCode(saved, { language: 'go', source: 'print(1)' })).toBeUndefined();
    expect(savedWithCode(saved, { language: 'python', source: 'print(1)\n' })).toBeUndefined();
    expect(savedWithCode(undefined, { language: 'python', source: 'print(1)' })).toBeUndefined();
  });

  it('names the reference solution when several hold it', () => {
    expect(savedWithCode(saved, { language: 'python', source: 'print(2)' })?.name).toBe('Reference');
  });
});

describe('lineCount', () => {
  it('counts lines without counting a final newline as one', () => {
    expect(lineCount('')).toBe(0);
    expect(lineCount('a')).toBe(1);
    expect(lineCount('a\nb\n')).toBe(2);
    expect(lineCount('a\n\nb')).toBe(3);
  });
});

describe('describeRunFigures', () => {
  const nb = '\u00a0';

  it('gives the slowest case and the peak memory of a judged run', () => {
    expect(describeRunFigures({ verdict: 'accepted', timeMs: 48, memoryKb: 9318 }, 2000)).toEqual([`slowest case 48${nb}ms`, `peak 9.1${nb}MB`]);
    expect(describeRunFigures({ verdict: 'wrong_answer', timeMs: 1500, memoryKb: 512 }, 2000)).toEqual([`slowest case 1.5${nb}s`, `peak 512${nb}KB`]);
  });

  it('shows a run stopped at the time limit as exceeding it', () => {
    expect(describeRunFigures({ verdict: 'time_limit_exceeded', timeMs: 3000, memoryKb: 9318 }, 2000)).toEqual([`slowest case > 2${nb}s`, `peak 9.1${nb}MB`]);
  });

  it('says code that was never run is not judged yet', () => {
    expect(describeRunFigures(undefined, 2000)).toEqual(['not judged yet']);
  });

  it('says nothing when the judge measured nothing', () => {
    expect(describeRunFigures({ verdict: 'compile_error', timeMs: null, memoryKb: null }, 2000)).toEqual([]);
    expect(describeRunFigures({ verdict: 'internal_error', timeMs: 12, memoryKb: 9318 }, 2000)).toEqual([]);
    expect(describeRunFigures({ verdict: null, timeMs: null, memoryKb: null }, 2000)).toEqual([]);
    expect(describeRunFigures({ verdict: 'accepted', timeMs: null, memoryKb: null }, 2000)).toEqual([]);
  });

  it('gives what was measured when one figure is missing', () => {
    expect(describeRunFigures({ verdict: 'accepted', timeMs: 48, memoryKb: null }, undefined)).toEqual([`slowest case 48${nb}ms`]);
    expect(describeRunFigures({ verdict: 'accepted', timeMs: null, memoryKb: 9318 }, undefined)).toEqual([`peak 9.1${nb}MB`]);
  });
});

describe('describeLastRun', () => {
  const nb = '\u00a0';
  const run = { passed: 13, total: 13, timeMs: 48, memoryKb: 9318, ranAt: '2026-01-01T00:00:00Z' };

  it('gives the cases passed, the slowest case and the peak memory', () => {
    expect(describeLastRun(run, 2000)).toEqual({ passed: '13/13 passed', failed: false, figures: [`slowest 48${nb}ms`, `peak 9.1${nb}MB`] });
  });

  it('says when cases failed', () => {
    expect(describeLastRun({ ...run, passed: 11 }, 2000)).toMatchObject({ passed: '11/13 passed', failed: true });
  });

  it('shows a run stopped at the time limit as exceeding it', () => {
    expect(describeLastRun({ ...run, passed: 12, timeMs: 3100 }, 2000).figures).toEqual([`slowest > 2${nb}s`, `peak 9.1${nb}MB`]);
  });

  it('leaves out what the judge did not measure', () => {
    expect(describeLastRun({ ...run, passed: 0, timeMs: null, memoryKb: null }, 2000)).toEqual({ passed: '0/13 passed', failed: true, figures: [] });
  });
});

describe('server errors', () => {
  it('maps validation errors onto the form fields', () => {
    const err = new ApiError(422, 'validation_failed', 'invalid solution', { name: 'is required', notes: 'is too long' });
    expect(serverFieldErrors(err)).toEqual({ fields: { name: 'is required', notes: 'is too long' }, rest: false });
  });

  it('reports what the form cannot show', () => {
    const err = new ApiError(422, 'validation_failed', 'invalid solution', { isReference: 'must be a boolean' });
    expect(serverFieldErrors(err).rest).toBe(true);
    expect(serverFieldErrors(new Error('offline')).rest).toBe(true);
  });

  it('tells the solutions limit from a revision conflict', () => {
    expect(isSolutionLimitError(new ApiError(409, 'conflict', 'too many solutions', {}))).toBe(true);
    expect(isSolutionLimitError(new ApiError(409, 'conflict', 'stale', { revision: 'expected 3, current 4' }))).toBe(false);
    expect(isSolutionLimitError(new ApiError(422, 'validation_failed', 'bad', {}))).toBe(false);
  });
});
