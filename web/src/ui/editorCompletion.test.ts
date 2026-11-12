import { CompletionContext, type Completion, type CompletionResult, type CompletionSource } from '@codemirror/autocomplete';
import { EditorState } from '@codemirror/state';
import { describe, expect, it } from 'vitest';
import { documentWords, loadLanguage } from './editorLanguages';

/** Everything the completion sources registered for `language` offer at the end of `doc`. */
async function complete(language: string, doc: string): Promise<Completion[]> {
  const state = EditorState.create({ doc, extensions: [await loadLanguage(language), documentWords] });
  const context = new CompletionContext(state, doc.length, false);
  const offered: Completion[] = [];
  for (const source of state.languageDataAt<CompletionSource | readonly (string | Completion)[]>('autocomplete', doc.length)) {
    const result: CompletionResult | null = typeof source === 'function' ? await source(context) : { from: 0, options: source.map((o) => (typeof o === 'string' ? { label: o } : o)) };
    if (result) offered.push(...result.options);
  }
  return offered;
}

const labels = (options: Completion[]) => options.map((o) => o.label);

describe('editor completion', () => {
  it('offers words from the document in every language', async () => {
    for (const language of ['python', 'cpp', 'java', 'go', 'rust', 'javascript', 'typescript', 'csharp', 'kotlin', 'ruby']) {
      const offered = await complete(language, 'prefix_sums = 1\nother = pre');
      expect(labels(offered), language).toContain('prefix_sums');
    }
  });

  it('offers the language keywords next to the document words', async () => {
    expect(labels(await complete('python', 'whi'))).toContain('while');
    expect(labels(await complete('javascript', 'func'))).toContain('function');
    expect(labels(await complete('go', 'fu'))).toContain('func');
    expect(labels(await complete('cpp', 'vec'))).toContain('vector');
    expect(labels(await complete('c', 'pri'))).toContain('printf');
    expect(labels(await complete('java', 'Sys'))).toContain('System');
    expect(labels(await complete('rust', 'prin'))).toContain('println');
    expect(labels(await complete('kotlin', 'fu'))).toContain('fun');
    expect(labels(await complete('ruby', 'de'))).toContain('def');
  });

  it('lists a word only once when the language and the document both have it', async () => {
    const offered = labels(await complete('cpp', 'vector<int> a;\nvec'));
    expect(offered.filter((label) => label === 'vector')).toHaveLength(1);
  });

  it('ranks document words below the language’s own suggestions', async () => {
    const offered = await complete('cpp', 'int total_count = 0;\ntot');
    expect(offered.find((o) => o.label === 'total_count')?.boost).toBe(-1);
  });

  it('keeps keyword suggestions out of comments', async () => {
    expect(labels(await complete('cpp', '// whi'))).not.toContain('while');
  });
});
