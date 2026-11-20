/*
 * Language support for the code editor: loading a language's CodeMirror
 * package on demand, and the completion sources that go with it. Each
 * language's standard-library table (./libraries) is loaded with it.
 */

import { completeAnyWord, type CompletionContext, type CompletionSource } from '@codemirror/autocomplete';
import { type Language, type StreamParser, StreamLanguage } from '@codemirror/language';
import { EditorState, type Extension } from '@codemirror/state';
import { libraryCompletion } from './editorLibrary';
import type { LibraryTable } from './libraries/table';

/**
 * Completes words that already occur in the document. It is registered for
 * every language, so languages without completions of their own still get
 * some, and it runs next to a language's own sources rather than replacing
 * them. A word that one of those sources offers at the same position is left
 * to that source, so nothing is listed twice.
 */
const completeDocumentWords: CompletionSource = (context: CompletionContext) => {
  const words = completeAnyWord(context);
  if (!words || 'then' in words) return words;
  const taken = new Set<string>();
  for (const other of context.state.languageDataAt<unknown>('autocomplete', context.pos)) {
    if (other === completeDocumentWords) continue;
    const offered = typeof other === 'function' ? (other as CompletionSource)(context) : { options: other };
    // Sources that answer asynchronously are not waited for.
    if (!offered || 'then' in offered || !Array.isArray(offered.options)) continue;
    for (const option of offered.options as readonly (string | { label: string })[]) {
      taken.add(typeof option === 'string' ? option : option.label);
    }
  }
  // Ranked just below a language's own suggestions when both match equally well.
  return { ...words, options: words.options.filter((o) => !taken.has(o.label)).map((o) => ({ ...o, boost: -1 })) };
};

export const documentWords = EditorState.languageData.of(() => [{ autocomplete: completeDocumentWords }]);

/** A language with its library completion, the two loaded side by side. */
async function withLibrary(id: string, load: Promise<[Extension, Language]>, table: Promise<{ default: LibraryTable }>): Promise<Extension> {
  const [[support, language], { default: library }] = await Promise.all([load, table]);
  return [support, libraryCompletion(language, id, library)];
}

/** A legacy mode, which brings its keywords as its own completion. */
async function legacy(id: string, mode: Promise<StreamParser<unknown>>, table: Promise<{ default: LibraryTable }>): Promise<Extension> {
  return withLibrary(
    id,
    mode.then((m): [Extension, Language] => {
      const language = StreamLanguage.define(m);
      return [language, language];
    }),
    table,
  );
}

/** Load the CodeMirror language support for a language id on demand. */
export async function loadLanguage(id: string | null | undefined): Promise<Extension> {
  switch (id) {
    case 'python':
      return withLibrary(
        id,
        import('@codemirror/lang-python').then((m) => [m.python(), m.pythonLanguage]),
        import('./libraries/python'),
      );
    case 'c':
    case 'cpp':
      return withLibrary(
        id,
        import('@codemirror/lang-cpp').then((m) => [m.cpp(), m.cppLanguage]),
        id === 'c' ? import('./libraries/c') : import('./libraries/cpp'),
      );
    case 'java':
      return withLibrary(
        id,
        import('@codemirror/lang-java').then((m) => [m.java(), m.javaLanguage]),
        import('./libraries/java'),
      );
    case 'javascript':
      return withLibrary(
        id,
        import('@codemirror/lang-javascript').then((m) => [m.javascript(), m.javascriptLanguage]),
        import('./libraries/javascript'),
      );
    case 'typescript':
      return withLibrary(
        id,
        import('@codemirror/lang-javascript').then((m) => [m.javascript({ typescript: true }), m.typescriptLanguage]),
        import('./libraries/javascript'),
      );
    case 'go':
      return withLibrary(
        id,
        import('@codemirror/lang-go').then((m) => [m.go(), m.goLanguage]),
        import('./libraries/go'),
      );
    case 'rust':
      return withLibrary(
        id,
        import('@codemirror/lang-rust').then((m) => [m.rust(), m.rustLanguage]),
        import('./libraries/rust'),
      );
    case 'csharp':
      return legacy(id, import('@codemirror/legacy-modes/mode/clike').then((m) => m.csharp), import('./libraries/csharp'));
    case 'kotlin':
      return legacy(id, import('@codemirror/legacy-modes/mode/clike').then((m) => m.kotlin), import('./libraries/kotlin'));
    case 'ruby':
      return legacy(id, import('@codemirror/legacy-modes/mode/ruby').then((m) => m.ruby), import('./libraries/ruby'));
    case 'json': {
      // The mode names keys "property", which the highlighter has to be told about.
      const [{ json }, { tags }] = await Promise.all([import('@codemirror/legacy-modes/mode/javascript'), import('@lezer/highlight')]);
      return StreamLanguage.define({ ...json, tokenTable: { property: tags.propertyName } });
    }
    case 'markdown':
      return (await import('@codemirror/lang-markdown')).markdown();
    default:
      return [];
  }
}
