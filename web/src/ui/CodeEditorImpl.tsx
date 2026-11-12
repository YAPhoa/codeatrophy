import { useEffect, useRef } from 'react';
import { basicSetup, minimalSetup } from 'codemirror';
import { Annotation, Compartment, EditorState, type Extension } from '@codemirror/state';
import { EditorView, keymap, placeholder as placeholderExt } from '@codemirror/view';
import { indentWithTab } from '@codemirror/commands';
import { HighlightStyle, indentUnit, StreamLanguage, syntaxHighlighting } from '@codemirror/language';
import { tags as t } from '@lezer/highlight';
import { cx } from './Button';

export interface EditorShortcut {
  /** CodeMirror key name, e.g. `Mod-Enter`. */
  key: string;
  run: () => void;
}

export interface CodeEditorProps {
  value: string;
  onChange?: (value: string) => void;
  /** A language id from the API (`python`, `cpp`, …), `markdown`, or null for plain text. */
  language?: string | null;
  readOnly?: boolean;
  ariaLabel: string;
  className?: string;
  /** Prose mode: soft-wrapped lines and no gutters. */
  prose?: boolean;
  placeholder?: string;
  shortcuts?: readonly EditorShortcut[];
  autoFocus?: boolean;
}

/** Marks a transaction that mirrors a new `value` prop, so it is not echoed back through `onChange`. */
const externalChange = Annotation.define<boolean>();

// Colours come from CSS custom properties, so one theme serves light and dark.
const theme = EditorView.theme({
  '&': { color: 'var(--text)', backgroundColor: 'transparent', height: '100%', fontSize: '13px' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { fontFamily: 'var(--font-mono)', lineHeight: '1.55', overflow: 'auto' },
  '.cm-content': { caretColor: 'var(--text)', padding: '8px 0' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--text)' },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
    backgroundColor: 'var(--editor-selection)',
  },
  '.cm-gutters': { backgroundColor: 'transparent', color: 'var(--text-3)', border: 'none', paddingLeft: '4px' },
  '.cm-activeLine': { backgroundColor: 'var(--editor-active-line)' },
  '.cm-activeLineGutter': { backgroundColor: 'var(--editor-active-line)', color: 'var(--text-2)' },
  '.cm-foldPlaceholder': { backgroundColor: 'var(--surface-3)', border: 'none', color: 'var(--text-2)' },
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
  { tag: [t.heading], color: 'var(--text)', fontWeight: '650' },
  { tag: [t.strong], fontWeight: '650' },
  { tag: [t.emphasis], fontStyle: 'italic' },
  { tag: [t.link, t.url], color: 'var(--syn-fn)' },
  { tag: [t.monospace], color: 'var(--syn-string)' },
  { tag: [t.quote], color: 'var(--text-2)' },
  { tag: [t.invalid], color: 'var(--danger)' },
]);

/** Load the CodeMirror language support for a language id on demand. */
async function loadLanguage(id: string | null | undefined): Promise<Extension> {
  switch (id) {
    case 'python':
      return (await import('@codemirror/lang-python')).python();
    case 'c':
    case 'cpp':
      return (await import('@codemirror/lang-cpp')).cpp();
    case 'java':
      return (await import('@codemirror/lang-java')).java();
    case 'javascript':
      return (await import('@codemirror/lang-javascript')).javascript();
    case 'typescript':
      return (await import('@codemirror/lang-javascript')).javascript({ typescript: true });
    case 'go':
      return (await import('@codemirror/lang-go')).go();
    case 'rust':
      return (await import('@codemirror/lang-rust')).rust();
    case 'csharp':
      return StreamLanguage.define((await import('@codemirror/legacy-modes/mode/clike')).csharp);
    case 'kotlin':
      return StreamLanguage.define((await import('@codemirror/legacy-modes/mode/clike')).kotlin);
    case 'ruby':
      return StreamLanguage.define((await import('@codemirror/legacy-modes/mode/ruby')).ruby);
    case 'markdown':
      return (await import('@codemirror/lang-markdown')).markdown();
    default:
      return [];
  }
}

/**
 * CodeMirror 6 wrapped as a controlled component. Tab indents; press Escape
 * and then Tab to move focus out of the editor with the keyboard.
 */
export default function CodeEditorImpl({ value, onChange, language, readOnly = false, ariaLabel, className, prose = false, placeholder, shortcuts, autoFocus }: CodeEditorProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  const shortcutsRef = useRef(shortcuts);
  const compartments = useRef({ language: new Compartment(), readOnly: new Compartment() });

  useEffect(() => {
    onChangeRef.current = onChange;
    shortcutsRef.current = shortcuts;
  });

  // The set of shortcut keys is fixed for the lifetime of an editor; their
  // handlers are looked up at call time so they can change freely.
  const shortcutKeys = (shortcuts ?? []).map((s) => s.key).join(' ');

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const { language: langC, readOnly: roC } = compartments.current;
    const keys = shortcutKeys ? shortcutKeys.split(' ') : [];
    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: value,
        extensions: [
          keymap.of(
            keys.map((key) => ({
              key,
              run: () => {
                shortcutsRef.current?.find((s) => s.key === key)?.run();
                return true;
              },
            })),
          ),
          prose ? minimalSetup : basicSetup,
          keymap.of([indentWithTab]),
          indentUnit.of('    '),
          prose ? EditorView.lineWrapping : [],
          theme,
          syntaxHighlighting(highlight),
          langC.of([]),
          roC.of([EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly)]),
          placeholder ? placeholderExt(placeholder) : [],
          EditorView.contentAttributes.of({ 'aria-label': ariaLabel, tabindex: '0' }),
          EditorView.updateListener.of((update) => {
            if (update.docChanged && update.transactions.some((tr) => !tr.annotation(externalChange))) {
              onChangeRef.current?.(update.state.doc.toString());
            }
          }),
        ],
      }),
    });
    viewRef.current = view;
    if (autoFocus) view.focus();
    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // The editor is created once; later prop changes are applied by the effects below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prose, shortcutKeys]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (current !== value) {
      view.dispatch({ changes: { from: 0, to: current.length, insert: value }, annotations: externalChange.of(true) });
    }
  }, [value]);

  useEffect(() => {
    let cancelled = false;
    void loadLanguage(language).then((ext) => {
      if (!cancelled) viewRef.current?.dispatch({ effects: compartments.current.language.reconfigure(ext) });
    });
    return () => {
      cancelled = true;
    };
  }, [language, prose, shortcutKeys]);

  useEffect(() => {
    viewRef.current?.dispatch({
      effects: compartments.current.readOnly.reconfigure([EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly)]),
    });
  }, [readOnly]);

  return <div ref={hostRef} className={cx('code-editor', prose && 'code-editor-prose', className)} />;
}
