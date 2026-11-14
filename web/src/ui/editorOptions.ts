import type { EditorPreferences } from '../api/types';

/*
 * Turning the user's editor preferences into the concrete values an editor
 * is configured with. Kept free of CodeMirror imports so it can be used (and
 * tested) without loading the editor.
 */

export const FONT_SIZE_MIN = 10;
export const FONT_SIZE_MAX = 24;
export const FONT_SIZE_DEFAULT = 14;

export const TAB_SIZES = [2, 4, 8] as const;
export type TabSize = (typeof TAB_SIZES)[number];
export const TAB_SIZE_DEFAULT: TabSize = 4;

/** Prose editors (Markdown bodies and notes) have fixed metrics of their own. */
const PROSE_FONT_SIZE = 14;
const PROSE_LINE_HEIGHT = 21;

/** The nearest allowed font size, in whole pixels. Anything that is not a number gives the default. */
export function clampFontSize(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return FONT_SIZE_DEFAULT;
  return Math.min(FONT_SIZE_MAX, Math.max(FONT_SIZE_MIN, Math.round(value)));
}

export function isTabSize(value: unknown): value is TabSize {
  return (TAB_SIZES as readonly unknown[]).includes(value);
}

/** A valid tab size; anything else gives the default. */
export function normalizeTabSize(value: unknown): TabSize {
  return isTabSize(value) ? value : TAB_SIZE_DEFAULT;
}

/**
 * Line height in pixels for a code font size: one and a half times the font
 * size, rounded to a whole pixel so that lines land on the pixel grid.
 */
export function lineHeightFor(fontSize: number): number {
  return Math.round(fontSize * 1.5);
}

/** What one editor is configured with. */
export interface EditorOptions {
  autocomplete: boolean;
  closeBrackets: boolean;
  matchBrackets: boolean;
  lineWrapping: boolean;
  /** Width of a tab character, in columns. */
  tabSize: TabSize;
  /** The text inserted for one level of indentation. */
  indentUnit: string;
  /** Pixels. */
  fontSize: number;
  /** Pixels. */
  lineHeight: number;
}

/**
 * The options for one editor. Code editors follow the preferences, except
 * that `wrap` wraps long lines whatever they say. Prose editors always wrap,
 * keep their own type size, and leave out the aids that only make sense for
 * code.
 */
export function resolveEditorOptions(prefs: EditorPreferences, mode: { prose?: boolean; wrap?: boolean } = {}): EditorOptions {
  if (mode.prose) {
    return {
      autocomplete: false,
      closeBrackets: false,
      matchBrackets: false,
      lineWrapping: true,
      tabSize: TAB_SIZE_DEFAULT,
      indentUnit: ' '.repeat(TAB_SIZE_DEFAULT),
      fontSize: PROSE_FONT_SIZE,
      lineHeight: PROSE_LINE_HEIGHT,
    };
  }
  const tabSize = normalizeTabSize(prefs.tabSize);
  const fontSize = clampFontSize(prefs.fontSize);
  return {
    autocomplete: prefs.autocomplete !== false,
    closeBrackets: prefs.closeBrackets !== false,
    matchBrackets: prefs.matchBrackets !== false,
    lineWrapping: mode.wrap === true || prefs.lineWrapping === true,
    tabSize,
    indentUnit: ' '.repeat(tabSize),
    fontSize,
    lineHeight: lineHeightFor(fontSize),
  };
}
