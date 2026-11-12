/*
 * Language support for the code editor: loading a language's CodeMirror
 * package on demand, and the completion sources that go with it.
 */

import { completeAnyWord, completeFromList, ifNotIn, type CompletionContext, type CompletionSource } from '@codemirror/autocomplete';
import { type LRLanguage, StreamLanguage } from '@codemirror/language';
import { EditorState, type Extension } from '@codemirror/state';
import { EDITOR_KEYWORDS } from './editorKeywords';

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

/** Syntax nodes inside which keyword completion would only get in the way. */
const NO_KEYWORDS_IN = ['LineComment', 'BlockComment', 'String', 'RawString', 'CharLiteral', 'StringLiteral', 'CharacterLiteral', 'TextBlock', 'Char'];

/**
 * Keyword and standard-library completions for a language whose package has
 * none of its own, attached as language data so that they run next to the
 * word completion above.
 */
function keywordCompletion(language: LRLanguage, id: string): Extension {
  const list = EDITOR_KEYWORDS[id];
  if (!list) return [];
  const keywords = new Set(list.keywords);
  const options = [
    ...[...keywords].map((label) => ({ label, type: 'keyword' })),
    ...[...new Set(list.library)].filter((label) => !keywords.has(label)).map((label) => ({ label, type: 'variable' })),
  ];
  return language.data.of({ autocomplete: ifNotIn(NO_KEYWORDS_IN, completeFromList(options)) });
}

/** Load the CodeMirror language support for a language id on demand. */
export async function loadLanguage(id: string | null | undefined): Promise<Extension> {
  switch (id) {
    case 'python':
      return (await import('@codemirror/lang-python')).python();
    case 'c':
    case 'cpp': {
      const { cpp, cppLanguage } = await import('@codemirror/lang-cpp');
      return [cpp(), keywordCompletion(cppLanguage, id)];
    }
    case 'java': {
      const { java, javaLanguage } = await import('@codemirror/lang-java');
      return [java(), keywordCompletion(javaLanguage, id)];
    }
    case 'javascript':
      return (await import('@codemirror/lang-javascript')).javascript();
    case 'typescript':
      return (await import('@codemirror/lang-javascript')).javascript({ typescript: true });
    case 'go':
      return (await import('@codemirror/lang-go')).go();
    case 'rust': {
      const { rust, rustLanguage } = await import('@codemirror/lang-rust');
      return [rust(), keywordCompletion(rustLanguage, id)];
    }
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
