/*
 * Code colours. A theme gives one colour to each role, in a light and a dark
 * version that follow the app's own (`data-theme` on <html>, lib/theme.ts).
 * Everything that colours code reads the roles as `--code-<role>` custom
 * properties (`var(--code-operator-word)`): the editor (ui/codeHighlight.ts,
 * ui/CodeEditorImpl.tsx), highlighted code blocks in Markdown
 * (styles/markdown.css) and the preview in Preferences. A new theme is one
 * more object in CODE_THEMES.
 *
 * A value is any CSS colour, and may name an app token (`var(--surface)`) so
 * that it stays in step with the app. Every text role keeps 4.5:1 against
 * the backgrounds it is drawn on (codeThemes.test.ts checks it).
 */

/** What gets coloured in code. */
export const SYNTAX_ROLES = [
  /** Anything no other role takes: names, operators, punctuation. */
  'text',
  /** Keywords that declare: def class lambda global nonlocal async; const let function. */
  'declare',
  /** Keywords that steer or import: if for return try raise yield import from with as. */
  'control',
  /** Operators that are words: and or not is, and `in` as a membership test. */
  'operatorWord',
  /** True False None; true false null nil. */
  'constant',
  'number',
  /** Strings, docstrings included. */
  'string',
  /** The parts of a string that are not its text: prefixes (f r b), f-string braces, `!r`, `:>10`. */
  'stringPart',
  /** Escapes in a string: `\n`, `\x00`. */
  'escape',
  'comment',
  /** Functions where they are defined and where they are called. */
  'function',
  /** A decorator, its `@` and name. */
  'decorator',
  /** Classes where they are defined, names in annotations, built-in types and exceptions. */
  'type',
  /** Parameters where they are declared, `self` and `cls`, keyword arguments. */
  'parameter',
  /** Annotations, preprocessor lines, attributes and keys. */
  'meta',
  /** Text that does not parse; removed lines of a diff. */
  'invalid',
] as const;

/** The editor around the code. */
export const CHROME_ROLES = [
  /** Behind the code in the editor. */
  'background',
  /** Behind code shown outside the editor: code blocks in Markdown, the preview in Preferences. */
  'blockBackground',
  'gutterBackground',
  /** Line numbers and fold markers; the runner rows of the solve editor. */
  'gutterText',
  /** The line the cursor is on. */
  'activeLine',
  'activeLineGutter',
  'activeLineGutterText',
  'selection',
  /** Other occurrences of the selected text; the matching bracket. */
  'selectionMatch',
  /** Lines drawn in the editor: the matching bracket's outline, the edges of the runner. */
  'border',
  'cursor',
  /** The placeholder of folded code, and the line count of a collapsed runner. */
  'foldPlaceholder',
  'foldPlaceholderText',
  /** The hint shown in an empty editor. */
  'placeholder',
] as const;

export const CODE_ROLES = [...SYNTAX_ROLES, ...CHROME_ROLES] as const;

export type SyntaxRole = (typeof SYNTAX_ROLES)[number];
export type ChromeRole = (typeof CHROME_ROLES)[number];
export type CodeRole = SyntaxRole | ChromeRole;

/** One colour per role, for one of the app's modes. */
export type CodeColours = Record<CodeRole, string>;

export interface CodeTheme {
  id: string;
  name: string;
  light: CodeColours;
  dark: CodeColours;
}

/** The editor's chrome follows the app's surfaces in both modes, so it names the same tokens. */
const codeatrophyChrome = {
  text: 'var(--text)',
  invalid: 'var(--danger)',
  background: 'var(--surface)',
  blockBackground: 'var(--surface-2)',
  gutterBackground: 'var(--surface)',
  gutterText: 'var(--text-3)',
  activeLineGutterText: 'var(--text-2)',
  selection: 'var(--selection)',
  selectionMatch: 'var(--surface-3)',
  border: 'var(--border-strong)',
  cursor: 'var(--text)',
  foldPlaceholder: 'var(--surface-3)',
  foldPlaceholderText: 'var(--text-2)',
  placeholder: 'var(--text-3)',
} as const;

export const codeatrophyTheme: CodeTheme = {
  id: 'codeatrophy',
  name: 'Codeatrophy',
  light: {
    ...codeatrophyChrome,
    declare: '#7d3fc4',
    control: '#b0247f',
    operatorWord: '#7d3fc4',
    constant: '#7d3fc4',
    number: '#a24e00',
    string: '#0b6b4c',
    stringPart: '#7d3fc4',
    escape: '#8a6400',
    comment: '#5f646c',
    function: '#1c58b5',
    decorator: '#1c58b5',
    type: '#8f4a00',
    parameter: '#0b5f7f',
    meta: '#9a3168',
    activeLine: '#ebf0ed',
    activeLineGutter: '#ebf0ed',
  },
  dark: {
    ...codeatrophyChrome,
    declare: '#c3a6ff',
    control: '#ee8ad2',
    operatorWord: '#c3a6ff',
    constant: '#c3a6ff',
    number: '#f0a56a',
    string: '#7fdcb2',
    stringPart: '#c3a6ff',
    escape: '#d7ba7d',
    comment: '#8e949e',
    function: '#86b4ff',
    decorator: '#86b4ff',
    type: '#efc66f',
    parameter: '#9cdcfe',
    meta: '#f29bc3',
    activeLine: '#171f2b',
    activeLineGutter: '#171f2b',
  },
};

export const CODE_THEMES: readonly CodeTheme[] = [codeatrophyTheme];

/** The custom property of a role: `operatorWord` is `--code-operator-word`. */
export function roleProperty(role: CodeRole): string {
  return `--code-${role.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;
}

/** A role's colour, for a style: `var(--code-operator-word)`. */
export function roleColor(role: CodeRole): string {
  return `var(${roleProperty(role)})`;
}

function declarations(colours: CodeColours): string {
  return CODE_ROLES.map((role) => `  ${roleProperty(role)}: ${colours[role]};`).join('\n');
}

/** A theme as CSS: its roles' custom properties for the light mode and for the dark. */
export function codeThemeCss(theme: CodeTheme): string {
  return `:root {\n${declarations(theme.light)}\n}\n:root[data-theme='dark'] {\n${declarations(theme.dark)}\n}\n`;
}

const STYLE_ID = 'code-theme';

/** Put a theme's custom properties on the page, replacing the theme there before. Called once as the app starts. */
export function applyCodeTheme(theme: CodeTheme = codeatrophyTheme): void {
  let style = document.getElementById(STYLE_ID);
  if (!style) {
    style = document.createElement('style');
    style.id = STYLE_ID;
    document.head.appendChild(style);
  }
  style.textContent = codeThemeCss(theme);
}
