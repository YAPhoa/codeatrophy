import { useEffect, useMemo, useRef, useState } from 'react';
import { minimalSetup } from 'codemirror';
import { autocompletion, closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import {
  bracketMatching,
  defaultHighlightStyle,
  foldGutter,
  foldKeymap,
  HighlightStyle,
  indentOnInput,
  indentUnit,
  syntaxHighlighting,
} from '@codemirror/language';
import { highlightSelectionMatches, searchKeymap } from '@codemirror/search';
import { Annotation, Compartment, EditorState, Prec, type Extension } from '@codemirror/state';
import {
  crosshairCursor,
  Decoration,
  drawSelection,
  dropCursor,
  EditorView,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  placeholder as placeholderExt,
  rectangularSelection,
  ViewPlugin,
  type DecorationSet,
  type ViewUpdate,
} from '@codemirror/view';
import { tags as t } from '@lezer/highlight';
import { usePreferences } from '../api/queries';
import { cx } from './Button';
import { documentWords, loadLanguage } from './editorLanguages';
import { codeBefore } from './editorLibrary';
import { FONT_SIZE_DEFAULT, lineHeightFor, resolveEditorOptions, type EditorOptions } from './editorOptions';
import { foldRegionEffects, regionFolding, unfoldAllEffects } from './editorRegions';
import { runnerExtension, type RunnerCode } from './editorRunner';

export interface EditorShortcut {
  /** CodeMirror key name, e.g. `Mod-Enter`. */
  key: string;
  run: () => void;
}

export interface CodeEditorProps {
  value: string;
  onChange?: (value: string) => void;
  /** A language id from the API (`python`, `cpp`, …), `markdown`, `json`, or null for plain text. */
  language?: string | null;
  readOnly?: boolean;
  ariaLabel: string;
  className?: string;
  /**
   * Prose mode, for Markdown bodies and notes: soft-wrapped lines, no
   * gutters, and none of the user's code-editor preferences.
   */
  prose?: boolean;
  /** Wrap long lines whatever the preference says: for text that is read, such as raw JSON. */
  wrap?: boolean;
  placeholder?: string;
  shortcuts?: readonly EditorShortcut[];
  autoFocus?: boolean;
  /**
   * Fold the marked regions (see lib/regions.ts) whenever the text comes
   * from outside rather than from typing: when the editor opens and when
   * `value` is replaced. For the solve editor.
   */
  foldRegions?: boolean;
  /**
   * The runner of a "Solution only" problem, shown above and below the code
   * as collapsed rows that expand to it, read-only. It is not part of the
   * text. For the solve editor.
   */
  runner?: RunnerCode | null;
  /**
   * Code that runs before this editor's text without being shown, such as
   * the runner prefix of a stub: completion does not import again what it
   * imports, nor add an import that could not follow it. `runner` sets it.
   */
  runsAfter?: string | null;
}

/** Marks a transaction that mirrors a new `value` prop, so it is not echoed back through `onChange`. */
const externalChange = Annotation.define<boolean>();

// Colours come from CSS custom properties, so one theme serves light and
// dark. The type size comes from two more, set on each editor from the user's
// preferences (see `metrics` below).
const theme = EditorView.theme({
  '&': { color: 'var(--text)', backgroundColor: 'transparent', height: '100%', fontSize: `var(--editor-font-size, ${FONT_SIZE_DEFAULT}px)` },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': {
    fontFamily: 'var(--font-mono)',
    lineHeight: `var(--editor-line-height, ${lineHeightFor(FONT_SIZE_DEFAULT)}px)`,
    overflow: 'auto',
  },
  '.cm-content': { caretColor: 'var(--text)', padding: '8px 0' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--text)' },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
    backgroundColor: 'var(--editor-selection)',
  },
  '.cm-gutters': { backgroundColor: 'transparent', color: 'var(--text-3)', border: 'none', paddingLeft: '4px' },
  '.cm-activeLine': { backgroundColor: 'var(--editor-active-line)' },
  '.cm-activeLineGutter': { backgroundColor: 'var(--editor-active-line)', color: 'var(--text-2)' },
  '.cm-foldPlaceholder': { backgroundColor: 'var(--surface-3)', border: 'none', color: 'var(--text-2)', margin: '0 4px', padding: '0 4px' },
  // The runner rows of the solve editor (see editorRunner.ts), set like code lines.
  '.cm-runner-toggle': {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    width: '100%',
    height: `var(--editor-line-height, ${lineHeightFor(FONT_SIZE_DEFAULT)}px)`,
    padding: '0 2px 0 6px',
    border: 'none',
    borderRadius: 0,
    background: 'none',
    color: 'var(--text-3)',
    font: 'inherit',
    textAlign: 'left',
    cursor: 'pointer',
  },
  '.cm-runner-toggle:hover': { backgroundColor: 'var(--editor-active-line)', color: 'var(--text-2)' },
  '.cm-runner-toggle:focus-visible': { outline: '2px solid var(--focus)', outlineOffset: '-2px' },
  '.cm-runner-chevron': { flex: 'none', transition: 'transform 120ms ease' },
  '.cm-runner-toggle[aria-expanded="true"] .cm-runner-chevron': { transform: 'rotate(90deg)' },
  '.cm-runner-more': { padding: '0 4px', borderRadius: 'var(--radius-sm)', backgroundColor: 'var(--surface-3)', color: 'var(--text-2)' },
  '.cm-runner-code': { opacity: '0.55', cursor: 'default' },
  '.cm-runner-line': { padding: '0 2px 0 6px' },
  // Where the runner meets the solver's code, while it is expanded.
  '.cm-runner-prefix.cm-runner-open': { borderBottom: '1px dashed var(--border-strong)' },
  '.cm-runner-suffix.cm-runner-open': { borderTop: '1px dashed var(--border-strong)' },
  '.cm-matchingBracket, &.cm-focused .cm-matchingBracket': {
    backgroundColor: 'var(--surface-3)',
    outline: '1px solid var(--border-strong)',
  },
  '.cm-selectionMatch': { backgroundColor: 'var(--surface-3)' },
  '.cm-placeholder': { color: 'var(--text-3)' },
  '.cm-tooltip': {
    backgroundColor: 'var(--surface)',
    color: 'var(--text)',
    border: '1px solid var(--border-strong)',
    borderRadius: 'var(--radius)',
    boxShadow: 'var(--shadow-pop)',
  },
  '.cm-tooltip.cm-tooltip-autocomplete > ul': { fontFamily: 'var(--font-mono)' },
  '.cm-tooltip-autocomplete ul li[aria-selected]': { backgroundColor: 'var(--accent-soft)', color: 'var(--text)' },
  '.cm-panels': { backgroundColor: 'var(--surface-2)', color: 'var(--text)', borderColor: 'var(--border)' },
  '.cm-panels.cm-panels-bottom': { borderTop: '1px solid var(--border)' },
  '.cm-textfield': {
    backgroundColor: 'var(--surface)',
    border: '1px solid var(--border-strong)',
    borderRadius: 'var(--radius-sm)',
    color: 'var(--text)',
  },
  '.cm-button': {
    backgroundImage: 'none',
    backgroundColor: 'var(--surface)',
    border: '1px solid var(--border-strong)',
    borderRadius: 'var(--radius-sm)',
    color: 'var(--text)',
  },
});

const highlight = HighlightStyle.define([
  { tag: [t.keyword, t.controlKeyword, t.moduleKeyword, t.operatorKeyword, t.definitionKeyword], color: 'var(--syn-keyword)' },
  { tag: [t.string, t.special(t.string), t.character, t.regexp], color: 'var(--syn-string)' },
  { tag: [t.number, t.bool, t.null, t.atom], color: 'var(--syn-number)' },
  { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], color: 'var(--syn-comment)', fontStyle: 'italic' },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.macroName], color: 'var(--syn-fn)' },
  { tag: [t.typeName, t.className, t.namespace, t.standard(t.typeName)], color: 'var(--syn-type)' },
  { tag: [t.meta, t.annotation, t.processingInstruction, t.self], color: 'var(--syn-meta)' },
  { tag: [t.heading], color: 'var(--text)', fontWeight: '600' },
  { tag: [t.strong], fontWeight: '600' },
  { tag: [t.emphasis], fontStyle: 'italic' },
  { tag: [t.link, t.url], color: 'var(--syn-fn)' },
  { tag: [t.monospace], color: 'var(--syn-string)' },
  { tag: [t.quote], color: 'var(--text-2)' },
  { tag: [t.invalid], color: 'var(--danger)' },
]);

const activeLine = Decoration.line({ class: 'cm-activeLine' });

function cursorLines(view: EditorView): DecorationSet {
  const starts = new Set<number>();
  for (const range of view.state.selection.ranges) {
    if (range.empty) starts.add(view.state.doc.lineAt(range.head).from);
  }
  return Decoration.set([...starts].map((from) => activeLine.range(from)), true);
}

/**
 * `highlightActiveLine`, but only for a cursor: the line's background is
 * opaque, so on the line a selection ends on it would hide the selection.
 */
const highlightCursorLine = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = cursorLines(view);
    }
    update(update: ViewUpdate) {
      if (update.docChanged || update.selectionSet) this.decorations = cursorLines(update.view);
    }
  },
  { decorations: (plugin) => plugin.decorations },
);

/**
 * The fixed part of a code editor: the `basicSetup` of the `codemirror`
 * package without bracket matching, bracket closing and completion, which
 * follow the user's preferences and are configured separately.
 */
const codeSetup: Extension = [
  lineNumbers(),
  highlightActiveLineGutter(),
  highlightSpecialChars(),
  history(),
  // The default markers' "Fold line" / "Unfold line" tooltips left out.
  foldGutter({
    markerDOM: (open) => {
      const marker = document.createElement('span');
      marker.textContent = open ? '⌄' : '›';
      return marker;
    },
  }),
  drawSelection(),
  dropCursor(),
  EditorState.allowMultipleSelections.of(true),
  indentOnInput(),
  syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
  rectangularSelection(),
  crosshairCursor(),
  highlightCursorLine,
  highlightSelectionMatches(),
  regionFolding,
  keymap.of([...defaultKeymap, ...searchKeymap, ...historyKeymap, ...foldKeymap]),
];

/**
 * The parts of an editor that change during its life, each in a compartment
 * of its own so that it can be replaced without rebuilding the editor.
 */
const labelExtension = (label: string) => EditorView.contentAttributes.of({ 'aria-label': label, tabindex: '0' });

function createCompartments() {
  return {
    language: new Compartment(),
    readOnly: new Compartment(),
    autocomplete: new Compartment(),
    closeBrackets: new Compartment(),
    matchBrackets: new Compartment(),
    lineWrapping: new Compartment(),
    indent: new Compartment(),
    metrics: new Compartment(),
    runner: new Compartment(),
    codeBefore: new Compartment(),
    label: new Compartment(),
  };
}

/** The extension for each compartment that follows the user's preferences. */
const optionExtensions = {
  autocomplete: (o: EditorOptions): Extension => (o.autocomplete ? [autocompletion(), documentWords] : []),
  closeBrackets: (o: EditorOptions): Extension => (o.closeBrackets ? [closeBrackets(), keymap.of(closeBracketsKeymap)] : []),
  matchBrackets: (o: EditorOptions): Extension => (o.matchBrackets ? bracketMatching() : []),
  lineWrapping: (o: EditorOptions): Extension => (o.lineWrapping ? EditorView.lineWrapping : []),
  indent: (o: EditorOptions): Extension => [EditorState.tabSize.of(o.tabSize), indentUnit.of(o.indentUnit)],
  metrics: (o: EditorOptions): Extension =>
    EditorView.editorAttributes.of({ style: `--editor-font-size: ${o.fontSize}px; --editor-line-height: ${o.lineHeight}px` }),
};

const OPTION_KEYS = Object.keys(optionExtensions) as (keyof typeof optionExtensions)[];

/** Fold the outermost marked regions of the editor's text. */
function foldMarkedRegions(view: EditorView): void {
  const effects = foldRegionEffects(view.state.doc);
  if (effects.length > 0) view.dispatch({ effects });
}

/**
 * CodeMirror 6 wrapped as a controlled component. Tab indents; press Escape
 * and then Tab to move focus out of the editor with the keyboard.
 *
 * Every editor reads the user's editor preferences itself and applies a
 * change at once, in place: the text, selection and undo history are kept.
 */
export default function CodeEditorImpl({
  value,
  onChange,
  language,
  readOnly = false,
  ariaLabel,
  className,
  prose = false,
  wrap = false,
  placeholder,
  shortcuts,
  autoFocus,
  foldRegions = false,
  runner,
  runsAfter,
}: CodeEditorProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  const shortcutsRef = useRef(shortcuts);
  const foldRegionsRef = useRef(foldRegions);
  const [compartments] = useState(createCompartments);

  const preferences = usePreferences().editor;
  const options = useMemo(() => resolveEditorOptions(preferences, { prose, wrap }), [preferences, prose, wrap]);
  const optionsRef = useRef(options);
  /** The options the live editor is configured with. */
  const appliedRef = useRef(options);

  useEffect(() => {
    onChangeRef.current = onChange;
    shortcutsRef.current = shortcuts;
    optionsRef.current = options;
    foldRegionsRef.current = foldRegions;
  });

  // The runner is compared by its text, so that a new object with the same code changes nothing.
  const runnerPrefix = runner?.prefix ?? null;
  const runnerSuffix = runner?.suffix ?? null;
  const runnerExt = useMemo(
    () => runnerExtension(runnerPrefix === null || runnerSuffix === null ? null : { prefix: runnerPrefix, suffix: runnerSuffix }),
    [runnerPrefix, runnerSuffix],
  );
  const runnerRef = useRef(runnerExt);
  /** The runner extension the live editor is configured with. */
  const appliedRunnerRef = useRef(runnerExt);
  useEffect(() => {
    runnerRef.current = runnerExt;
  });

  const before = runnerPrefix ?? runsAfter ?? null;
  const beforeRef = useRef(before);
  useEffect(() => {
    beforeRef.current = before;
  });

  // The set of shortcut keys is fixed for the lifetime of an editor; their
  // handlers are looked up at call time so they can change freely.
  const shortcutKeys = (shortcuts ?? []).map((s) => s.key).join(' ');

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const { language: langC, readOnly: roC, runner: runnerC, label: labelC } = compartments;
    const initial = optionsRef.current;
    appliedRef.current = initial;
    appliedRunnerRef.current = runnerRef.current;
    const keys = shortcutKeys ? shortcutKeys.split(' ') : [];
    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: value,
        extensions: [
          // The caller's shortcuts win over every other binding for the same
          // key, including the ones completion and bracket closing register
          // at the highest precedence: of two extensions with equal
          // precedence the earlier one is asked first.
          Prec.highest(
            keymap.of(
              keys.map((key) => ({
                key,
                run: () => {
                  shortcutsRef.current?.find((s) => s.key === key)?.run();
                  return true;
                },
              })),
            ),
          ),
          // Ahead of the default keymap, so that Backspace can remove a bracket pair.
          OPTION_KEYS.map((key) => compartments[key].of(optionExtensions[key](initial))),
          prose ? minimalSetup : codeSetup,
          keymap.of([indentWithTab]),
          theme,
          syntaxHighlighting(highlight),
          langC.of([]),
          roC.of([EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly)]),
          runnerC.of(runnerRef.current),
          compartments.codeBefore.of(codeBefore.of(beforeRef.current)),
          placeholder ? placeholderExt(placeholder) : [],
          labelC.of(labelExtension(ariaLabel)),
          EditorView.updateListener.of((update) => {
            if (update.docChanged && update.transactions.some((tr) => !tr.annotation(externalChange))) {
              onChangeRef.current?.(update.state.doc.toString());
            }
          }),
        ],
      }),
    });
    viewRef.current = view;
    if (foldRegionsRef.current) foldMarkedRegions(view);
    if (autoFocus) view.focus();
    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // The editor is created once; later prop changes are applied by the effects below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [compartments, prose, shortcutKeys]);

  // A changed preference reconfigures the live editor.
  useEffect(() => {
    const view = viewRef.current;
    if (!view || appliedRef.current === options) return;
    appliedRef.current = options;
    view.dispatch({ effects: OPTION_KEYS.map((key) => compartments[key].reconfigure(optionExtensions[key](options))) });
    // A new type size or wrapping mode changes every line's height.
    view.requestMeasure();
  }, [compartments, options]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (current !== value) {
      // Code given from outside opens with its regions folded; what was folded before goes first.
      const fold = foldRegionsRef.current;
      const unfold = fold ? unfoldAllEffects(view.state) : [];
      if (unfold.length > 0) view.dispatch({ effects: unfold });
      view.dispatch({ changes: { from: 0, to: current.length, insert: value }, annotations: externalChange.of(true) });
      if (fold) foldMarkedRegions(view);
    }
  }, [value]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view || appliedRunnerRef.current === runnerExt) return;
    appliedRunnerRef.current = runnerExt;
    view.dispatch({ effects: compartments.runner.reconfigure(runnerExt) });
  }, [compartments, runnerExt]);

  useEffect(() => {
    viewRef.current?.dispatch({ effects: compartments.codeBefore.reconfigure(codeBefore.of(before)) });
  }, [compartments, before]);

  useEffect(() => {
    let cancelled = false;
    void loadLanguage(language).then((ext) => {
      if (!cancelled) viewRef.current?.dispatch({ effects: compartments.language.reconfigure(ext) });
    });
    return () => {
      cancelled = true;
    };
  }, [compartments, language, prose, shortcutKeys]);

  useEffect(() => {
    viewRef.current?.dispatch({
      effects: compartments.readOnly.reconfigure([EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly)]),
    });
  }, [compartments, readOnly]);

  // A label can change with the editor's place, as a test case's number does.
  useEffect(() => {
    viewRef.current?.dispatch({ effects: compartments.label.reconfigure(labelExtension(ariaLabel)) });
  }, [compartments, ariaLabel]);

  return <div ref={hostRef} className={cx('code-editor', prose && 'code-editor-prose', className)} />;
}
