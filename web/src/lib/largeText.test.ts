import { describe, expect, it } from 'vitest';
import { LARGE_TEXT_BYTES, describeTextSize, isLargeText, textFilename, textStats } from './largeText';

describe('isLargeText', () => {
  it('measures in UTF-8 bytes, from the threshold on', () => {
    expect(isLargeText('')).toBe(false);
    expect(isLargeText('x'.repeat(LARGE_TEXT_BYTES - 1))).toBe(false);
    expect(isLargeText('x'.repeat(LARGE_TEXT_BYTES))).toBe(true);
    // Three bytes each: large well before the character count says so.
    expect(isLargeText('€'.repeat(Math.ceil(LARGE_TEXT_BYTES / 3)))).toBe(true);
    expect(isLargeText('€'.repeat(Math.floor(LARGE_TEXT_BYTES / 3) - 1))).toBe(false);
    expect(isLargeText('abc', 3)).toBe(true);
  });
});

describe('textStats and describeTextSize', () => {
  it('counts lines without a final newline starting another', () => {
    expect(textStats('')).toEqual({ bytes: 0, lines: 0 });
    expect(textStats('1\n')).toEqual({ bytes: 2, lines: 1 });
    expect(textStats('1\n2')).toEqual({ bytes: 3, lines: 2 });
    expect(textStats('\n\n')).toEqual({ bytes: 2, lines: 2 });
  });

  it('says how big it is', () => {
    expect(describeTextSize({ bytes: 183412, lines: 30001 })).toBe('179 KB · 30,001 lines');
    expect(describeTextSize({ bytes: 40, lines: 1 })).toBe('40 B · 1 line');
  });
});

describe('textFilename', () => {
  it('makes a file name from the parts', () => {
    expect(textFilename('Two Sum', '30,000 values', 'input')).toBe('two-sum-30-000-values-input.txt');
    expect(textFilename('Ünïcode', '')).toBe('unicode.txt');
    expect(textFilename('!!!')).toBe('test-data.txt');
  });
});
