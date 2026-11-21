import { describe, expect, it } from 'vitest';
import { pythonLanguage } from '@codemirror/lang-python';
import { ensureSyntaxTree } from '@codemirror/language';
import { EditorState } from '@codemirror/state';
import { loadLanguage } from './editorLanguages';
import { highlightTree, tagHighlighter, tags as t } from '@lezer/highlight';
import { parameterName, pythonTypeTags } from './pythonTypes';

const language = pythonLanguage.configure({ props: [pythonTypeTags] });
const highlighter = tagHighlighter([
  { tag: parameterName, class: 'param' },
  { tag: t.typeName, class: 'type' },
  { tag: t.className, class: 'type' },
  { tag: t.variableName, class: 'var' },
  { tag: t.propertyName, class: 'prop' },
]);

/** Each highlighted word of the source with its class. */
function classes(src: string): [string, string][] {
  const out: [string, string][] = [];
  highlightTree(language.parser.parse(src), highlighter, (from, to, cls) => out.push([src.slice(from, to), cls]));
  return out;
}
const typed = (src: string) => classes(src).filter(([, c]) => c === 'type').map(([w]) => w);

describe('Python annotations', () => {
  it('colour every name in a parameter or return annotation as a type, at any nesting', () => {
    expect(typed('def f(self, nums: list[int], m: dict[str, list[Optional[ListNode]]]) -> List[int] | None:\n    pass\n')).toEqual([
      'list', 'int', 'dict', 'str', 'list', 'Optional', 'ListNode', 'List', 'int',
    ]);
  });

  it('colour a dotted type in a variable annotation, and a class name', () => {
    expect(typed('x: tree.Node = make()\nclass A(Base):\n    pass\n')).toEqual(['tree', 'Node', 'A']);
  });

  it('leave names outside annotations as they were', () => {
    const words = classes('def f(nums: list[int]) -> int:\n    total = len(nums)\n    return total.real\n');
    expect(words).toContainEqual(['nums', 'var']);
    expect(words).toContainEqual(['total', 'var']);
    expect(words).toContainEqual(['real', 'prop']);
    expect(words.filter(([w]) => w === 'nums' || w === 'total').every(([, c]) => c !== 'type')).toBe(true);
  });
});

it('the editor loads Python with its annotations tagged as types', async () => {
  const doc = 'def f(nums: list[int]) -> int:\n    pass\n';
  const state = EditorState.create({ doc, extensions: [await loadLanguage('python')] });
  const tree = ensureSyntaxTree(state, doc.length, 5000);
  expect(tree).not.toBeNull();
  const words: string[] = [];
  highlightTree(tree!, highlighter, (from, to, cls) => {
    if (cls === 'type') words.push(doc.slice(from, to));
  });
  expect(words).toEqual(['list', 'int', 'int']);
});

it('a parameter is marked where it is declared, not where it is used', () => {
  const words = classes('class Trie:\n    def search(self, word: str, k=None) -> bool:\n        word = word + "x"\n        return k\n');
  expect(words.filter(([, c]) => c === 'param').map(([w]) => w)).toEqual(['self', 'word', 'k']);
  expect(words.filter(([w]) => w === 'word').map(([, c]) => c)).toEqual(['param', 'var', 'var']);
});

it('`from` in an import is a module keyword, not a declaring one like def and class', () => {
  const kw = tagHighlighter([
    { tag: t.moduleKeyword, class: 'module' },
    { tag: t.controlKeyword, class: 'control' },
    { tag: t.definitionKeyword, class: 'define' },
  ]);
  const src = 'from functools import cache\nclass A:\n    def f(self):\n        raise E from None\n';
  const out: string[] = [];
  highlightTree(language.parser.parse(src), kw, (from, to, cls) => out.push(`${src.slice(from, to)}:${cls}`));
  expect(out).toEqual(['from:module', 'import:module', 'class:define', 'def:define', 'raise:control', 'from:control']);
});
