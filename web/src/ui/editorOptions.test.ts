import { describe, expect, it } from 'vitest';
import type { EditorPreferences } from '../api/types';
import { clampFontSize, FONT_SIZE_MAX, FONT_SIZE_MIN, isTabSize, lineHeightFor, normalizeTabSize, resolveEditorOptions } from './editorOptions';
import { parseWholeNumber } from './Field';

const defaults: EditorPreferences = {
  autocomplete: true,
  closeBrackets: true,
  matchBrackets: true,
  lineWrapping: false,
  tabSize: 4,
  fontSize: 14,
};

describe('clampFontSize', () => {
  it('keeps sizes inside the range', () => {
    expect(clampFontSize(10)).toBe(10);
    expect(clampFontSize(14)).toBe(14);
    expect(clampFontSize(24)).toBe(24);
  });

  it('pulls sizes outside the range to the nearest end', () => {
    expect(clampFontSize(3)).toBe(10);
    expect(clampFontSize(-5)).toBe(10);
    expect(clampFontSize(40)).toBe(24);
  });

  it('rounds to whole pixels', () => {
    expect(clampFontSize(13.4)).toBe(13);
    expect(clampFontSize(13.5)).toBe(14);
  });

  it('falls back to the default for anything that is not a number', () => {
    expect(clampFontSize(Number.NaN)).toBe(14);
    expect(clampFontSize(Number.POSITIVE_INFINITY)).toBe(14);
    expect(clampFontSize('16')).toBe(14);
    expect(clampFontSize(undefined)).toBe(14);
  });
});

describe('parseWholeNumber', () => {
  const parseFontSize = (text: string) => parseWholeNumber(text, FONT_SIZE_MIN, FONT_SIZE_MAX);

  it('accepts whole numbers in range', () => {
    expect(parseFontSize('10')).toBe(10);
    expect(parseFontSize(' 16 ')).toBe(16);
    expect(parseFontSize('24')).toBe(24);
    expect(parseWholeNumber('1', 1, 30)).toBe(1);
  });

  it('rejects everything else, so a half-typed value is not acted on', () => {
    for (const text of ['', '1', '9', '25', '160', '14.5', '-14', '1e1', 'abc']) {
      expect(parseFontSize(text), text).toBeNull();
    }
    expect(parseWholeNumber('0', 1, 30)).toBeNull();
    expect(parseWholeNumber('31', 1, 30)).toBeNull();
  });
});

describe('tab size', () => {
  it('recognises the allowed sizes only', () => {
    expect([2, 4, 8].every(isTabSize)).toBe(true);
    expect([0, 1, 3, 6, 16, '4', null].some(isTabSize)).toBe(false);
  });

  it('normalises anything else to the default', () => {
    expect(normalizeTabSize(8)).toBe(8);
    expect(normalizeTabSize(3)).toBe(4);
    expect(normalizeTabSize('2')).toBe(4);
  });
});

describe('lineHeightFor', () => {
  it('is a whole number of pixels that grows with the font size', () => {
    expect(lineHeightFor(10)).toBe(15);
    expect(lineHeightFor(13)).toBe(20);
    expect(lineHeightFor(14)).toBe(21);
    expect(lineHeightFor(24)).toBe(36);
  });
});

describe('resolveEditorOptions', () => {
  it('maps the default preferences', () => {
    expect(resolveEditorOptions(defaults)).toEqual({
      autocomplete: true,
      closeBrackets: true,
      matchBrackets: true,
      lineWrapping: false,
      tabSize: 4,
      indentUnit: '    ',
      fontSize: 14,
      lineHeight: 21,
    });
  });

  it('follows each preference in a code editor', () => {
    const options = resolveEditorOptions({ autocomplete: false, closeBrackets: false, matchBrackets: false, lineWrapping: true, tabSize: 2, fontSize: 18 });
    expect(options).toEqual({
      autocomplete: false,
      closeBrackets: false,
      matchBrackets: false,
      lineWrapping: true,
      tabSize: 2,
      indentUnit: '  ',
      fontSize: 18,
      lineHeight: 27,
    });
  });

  it('indents by the tab size, in spaces', () => {
    expect(resolveEditorOptions({ ...defaults, tabSize: 8 }).indentUnit).toBe(' '.repeat(8));
  });

  it('repairs values the server would not have sent', () => {
    const odd = { ...defaults, tabSize: 3, fontSize: 99 } as unknown as EditorPreferences;
    expect(resolveEditorOptions(odd)).toMatchObject({ tabSize: 4, indentUnit: '    ', fontSize: 24, lineHeight: 36 });
  });

  it('keeps prose editors wrapped, at their own size, whatever the preferences say', () => {
    const prose = resolveEditorOptions({ autocomplete: true, closeBrackets: true, matchBrackets: true, lineWrapping: false, tabSize: 8, fontSize: 22 }, { prose: true });
    expect(prose).toEqual({
      autocomplete: false,
      closeBrackets: false,
      matchBrackets: false,
      lineWrapping: true,
      tabSize: 4,
      indentUnit: '    ',
      fontSize: 13,
      lineHeight: 20.15,
    });
    expect(resolveEditorOptions({ ...defaults, lineWrapping: true, fontSize: 10 }, { prose: true })).toEqual(prose);
  });
});
