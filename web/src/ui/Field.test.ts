import { describe, expect, it } from 'vitest';
import { parseWholeNumber, settleTyped } from './Field';

describe('parseWholeNumber', () => {
  it('takes a whole number in range only', () => {
    expect(parseWholeNumber(' 12 ', 1, 30)).toBe(12);
    expect(parseWholeNumber('31', 1, 30)).toBeNull();
    expect(parseWholeNumber('0', 1, 30)).toBeNull();
    expect(parseWholeNumber('2.5', 1, 30)).toBeNull();
    expect(parseWholeNumber('', 1, 30)).toBeNull();
  });
});

describe('settleTyped', () => {
  it('brings a number out of range to the nearer bound, and says so', () => {
    expect(settleTyped('500', 8, 1, 30)).toEqual({ value: 30, clamped: true });
    expect(settleTyped('0', 8, 1, 30)).toEqual({ value: 1, clamped: true });
    expect(settleTyped('-3', 8, 1, 30)).toEqual({ value: 1, clamped: true });
  });

  it('rounds a number in range without calling it clamped', () => {
    expect(settleTyped('2.4', 8, 1, 30)).toEqual({ value: 2, clamped: false });
    expect(settleTyped('12', 8, 1, 30)).toEqual({ value: 12, clamped: false });
  });

  it('goes back to the value for an empty field or one that is not a number', () => {
    expect(settleTyped('', 8, 1, 30)).toEqual({ value: 8, clamped: false });
    expect(settleTyped('  ', 8, 1, 30)).toEqual({ value: 8, clamped: false });
    expect(settleTyped('e', 8, 1, 30)).toEqual({ value: 8, clamped: false });
  });
});
