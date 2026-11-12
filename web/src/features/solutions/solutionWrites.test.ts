import { describe, expect, it } from 'vitest';
import { ApiError } from '../../api/client';
import type { Limits, Solution } from '../../api/types';
import { defaultSolutionName, isSolutionLimitError, lineCount, serverFieldErrors, touchesReference, validateSolution } from './solutionWrites';

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

describe('lineCount', () => {
  it('counts lines without counting a final newline as one', () => {
    expect(lineCount('')).toBe(0);
    expect(lineCount('a')).toBe(1);
    expect(lineCount('a\nb\n')).toBe(2);
    expect(lineCount('a\n\nb')).toBe(3);
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
