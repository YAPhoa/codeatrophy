import { describe, expect, it } from 'vitest';
import { pythonLanguage } from '@codemirror/lang-python';
import { ensureSyntaxTree } from '@codemirror/language';
import { EditorState, Text } from '@codemirror/state';
import { highlightTree, tagHighlighter } from '@lezer/highlight';
import { ROLE_TAGS } from './codeHighlight';
import { loadLanguage } from './editorLanguages';
import { pythonMarks, pythonStyleTags } from './pythonSyntax';

const language = pythonLanguage.configure({ props: [pythonStyleTags] });
/** Classes named after the roles, as the editor's highlight style colours them. */
const highlighter = tagHighlighter(ROLE_TAGS.map(({ role, tags }) => ({ tag: tags, class: role })));

/** The role of every character of the source: the tags' first, the marks over them, as the editor draws them. */
function roleMap(src: string): string[] {
  const roles = Array<string>(src.length).fill('text');
  const tree = language.parser.parse(src);
  highlightTree(tree, highlighter, (from, to, cls) => roles.fill(cls, from, to));
  for (const mark of pythonMarks(tree, Text.of(src.split('\n')))) roles.fill(mark.role, mark.from, mark.to);
  return roles;
}

/** The role of the `nth` occurrence of `needle` in the source (from 0), or the roles it is split between. */
function roleOf(src: string, needle: string, nth = 0): string {
  let at = -1;
  for (let i = 0; i <= nth; i++) {
    at = src.indexOf(needle, at + 1);
    if (at < 0) throw new Error(`no ${nth}th ${needle} in ${src}`);
  }
  return [...new Set(roleMap(src).slice(at, at + needle.length))].join(' ');
}

/** The words of the source in a role. */
function wordsIn(src: string, role: string): string[] {
  const roles = roleMap(src);
  return [...src.matchAll(/[\w@]+|[^\s\w@]/g)].filter((m) => roles[m.index] === role && roles[m.index + m[0].length - 1] === role).map((m) => m[0]);
}

describe('declare', () => {
  it('colours the keywords that declare', () => {
    const src = 'async def f():\n    global g\n    nonlocal n\n    h = lambda v: v\nclass A:\n    pass\ntype Grid = list[int]\n';
    expect(wordsIn(src, 'declare')).toEqual(['async', 'def', 'global', 'nonlocal', 'lambda', 'class', 'type']);
  });

  it('leaves `async` of a loop or a with, and `type` called, to other roles', () => {
    const src = 'async def f():\n    async for x in y:\n        async with a as b:\n            t = type(x)\n';
    expect(roleOf(src, 'async', 1)).toBe('control');
    expect(roleOf(src, 'async', 2)).toBe('control');
    expect(roleOf(src, 'type')).toBe('type');
  });
});

describe('control', () => {
  it('colours the keywords that steer or import', () => {
    const src = [
      'import heapq',
      'from typing import List',
      'import collections as col',
      'for i in range(3):',
      '    if i: continue',
      '    elif i: break',
      '    else: pass',
      'while x: return y',
      'try: raise E from None',
      'except E as e: yield from g',
      'finally: await z',
      'del x',
      'assert x',
      'with o as f: pass',
      'match c:',
      '    case 1: pass',
      '',
    ].join('\n');
    expect(wordsIn(src, 'control')).toEqual([
      'import', 'from', 'import', 'import', 'as', 'for', 'in', 'if', 'continue', 'elif', 'break', 'else', 'pass', 'while', 'return',
      'try', 'raise', 'from', 'except', 'as', 'yield', 'from', 'finally', 'await', 'del', 'assert', 'with', 'as', 'pass', 'match', 'case', 'pass',
    ]);
  });

  it('`in` of a loop or a comprehension steers; `in` as a membership test does not', () => {
    const src = 'for c in s:\n    ok = c in "ab"\nr = [x for x in a if x in b]\nd = {k: v for k, v in z}\n';
    expect(roleOf(src, 'in', 0)).toBe('control');
    expect(roleOf(src, 'in', 1)).toBe('operatorWord');
    expect(roleOf(src, 'in', 2)).toBe('control');
    expect(roleOf(src, 'in', 3)).toBe('operatorWord');
    expect(roleOf(src, 'in', 4)).toBe('control');
  });

  it('`from` imports or chains; it never declares', () => {
    const src = 'from a import b\ndef f():\n    raise E from None\n    yield from g\n';
    expect([0, 1, 2].map((n) => roleOf(src, 'from', n))).toEqual(['control', 'control', 'control']);
    expect(roleOf(src, 'def')).toBe('declare');
  });
});

describe('operatorWord', () => {
  it('colours and, or, not, is and `not in`', () => {
    const src = 'x = a and b or not c\ny = a is not None\nz = a not in b\n';
    expect(wordsIn(src, 'operatorWord')).toEqual(['and', 'or', 'not', 'is', 'not', 'not', 'in']);
  });

  it('leaves a name that contains one alone', () => {
    expect(roleOf('index = isle\n', 'index')).toBe('text');
    expect(roleOf('index = isle\n', 'isle')).toBe('text');
  });
});

describe('constant, number, string, comment', () => {
  it('colours True, False and None as constants, and a name like them as nothing', () => {
    const src = 'print(True, False, None, none)\n';
    expect(wordsIn(src, 'constant')).toEqual(['True', 'False', 'None']);
    expect(roleOf(src, 'none')).toBe('text');
  });

  it('colours numbers of every form, and not a name with digits', () => {
    const src = 'x = 10**5 + 3.14 - 0x1F + 1e-9 + 2j + n2\n';
    for (const n of ['10', '5', '3.14', '0x1F', '1e-9', '2j']) expect(roleOf(src, n), n).toBe('number');
    expect(roleOf(src, 'n2')).toBe('text');
  });

  it('colours strings and docstrings as strings, and comments as comments', () => {
    const src = 'class A:\n    """Doc."""\n    s = "x"  # note\n';
    expect(roleOf(src, '"""Doc."""')).toBe('string');
    expect(roleOf(src, '"x"')).toBe('string');
    expect(roleOf(src, '# note')).toBe('comment');
    expect(roleOf(src, 's =')).toBe('text');
  });
});

describe('stringPart and escape', () => {
  it('colours prefixes, the braces of an f-string, its conversion and format spec', () => {
    const src = 'a = f"{url!r}: {data:>10}"\nb = r"x" + rb"y" + b"z" + F"w"\n';
    expect(roleOf(src, 'f"', 0).split(' ')[0]).toBe('stringPart');
    expect(roleOf(src, '{')).toBe('stringPart');
    expect(roleOf(src, '}')).toBe('stringPart');
    expect(roleOf(src, '!r')).toBe('stringPart');
    expect(roleOf(src, ':>10')).toBe('stringPart');
    expect(roleOf(src, 'r"x"')).toBe('stringPart string');
    expect(roleOf(src, 'rb')).toBe('stringPart');
    expect(roleOf(src, 'b"z', 0).split(' ')[0]).toBe('stringPart');
    expect(roleOf(src, 'F')).toBe('stringPart');
  });

  it('leaves the text of a string and the code in its braces as they were', () => {
    const src = 'a = f"x {url} y"\nf = 1\n';
    expect(roleOf(src, 'x ')).toBe('string');
    expect(roleOf(src, 'url')).toBe('text');
    expect(roleOf(src, 'f = ')).toBe('text');
    expect(roleOf('s = "rb"\n', 'rb')).toBe('string');
  });

  it('colours escapes, but not in a raw string', () => {
    const src = 'a = "x\\n" + b"\\x00" + f"{a}\\t"\nr = r"\\d+"\n';
    expect(roleOf(src, '\\n')).toBe('escape');
    expect(roleOf(src, '\\x00')).toBe('escape');
    expect(roleOf(src, '\\t')).toBe('escape');
    expect(roleOf(src, '\\d+')).toBe('string');
  });
});

describe('function and decorator', () => {
  it('colours functions where defined and every call: own functions, methods, built-ins', () => {
    const src = 'def helper(x):\n    return x\nclass A:\n    def run(self):\n        self.helper(len(helper(1)))\n';
    expect(roleOf(src, 'helper', 0)).toBe('function');
    expect(roleOf(src, 'run')).toBe('function');
    expect(roleOf(src, 'helper', 1)).toBe('function');
    expect(roleOf(src, 'len')).toBe('function');
    expect(roleOf(src, 'helper', 2)).toBe('function');
  });

  it('leaves a function named but not called alone, and an exception raised to the type colour', () => {
    const src = 'f = helper\nraise ValueError("bad")\n';
    expect(roleOf(src, 'helper')).toBe('text');
    expect(roleOf(src, 'ValueError')).toBe('type');
  });

  it('colours a whole decorator, @ and name, dotted or called', () => {
    const src = 'class A:\n    @staticmethod\n    def f(): pass\n    @lru_cache(maxsize=None)\n    def g(): pass\n    @functools.wraps(h)\n    def k(): pass\n';
    expect(roleOf(src, '@staticmethod')).toBe('decorator');
    expect(roleOf(src, '@lru_cache')).toBe('decorator');
    expect(roleOf(src, '@functools.wraps')).toBe('decorator');
  });

  it('leaves the arguments of a decorator to their own roles', () => {
    const src = '@lru_cache(maxsize=None)\ndef g(): pass\n@wraps(h)\ndef k(): pass\n';
    expect(roleOf(src, 'maxsize')).toBe('parameter');
    expect(roleOf(src, 'None')).toBe('constant');
    expect(roleOf(src, '(h)')).toBe('text');
  });
});

describe('type', () => {
  it('colours every name in a parameter or return annotation as a type, at any nesting', () => {
    expect(wordsIn('def f(self, nums: list[int], m: dict[str, list[Optional[ListNode]]]) -> List[int] | None:\n    pass\n', 'type')).toEqual([
      'list', 'int', 'dict', 'str', 'list', 'Optional', 'ListNode', 'List', 'int',
    ]);
  });

  it('colours a dotted type in a variable annotation, a class name, a type alias and a type parameter', () => {
    expect(wordsIn('x: tree.Node = make()\nclass A(Base):\n    pass\ntype Grid = Matrix[Cell]\ndef f[T](x: T): pass\n', 'type')).toEqual([
      'tree', 'Node', 'A', 'Grid', 'Matrix', 'Cell', 'T', 'T',
    ]);
  });

  it('colours built-in types and exceptions wherever they are named', () => {
    const src = 'class Solution(object):\n    def f(self, x):\n        if isinstance(x, int): return list(x)\n        try: pass\n        except (ValueError, KeyError) as e: raise RuntimeError() from e\n';
    expect(wordsIn(src, 'type')).toEqual(['Solution', 'object', 'int', 'list', 'ValueError', 'KeyError', 'RuntimeError']);
  });

  it('leaves names outside annotations, user classes in use, and look-alikes as they were', () => {
    const src = 'def f(nums: list[int]) -> int:\n    total = len(nums)\n    node = TreeNode(total.real)\n    lst = Int = ints\n';
    expect(roleOf(src, 'nums', 1)).toBe('text');
    expect(roleOf(src, 'total')).toBe('text');
    expect(roleOf(src, 'real')).toBe('text');
    expect(roleOf(src, 'TreeNode')).toBe('function');
    expect(wordsIn(src, 'type')).toEqual(['list', 'int', 'int']);
  });
});

describe('parameter', () => {
  it('colours a parameter where it is declared, not where it is used', () => {
    const src = 'class Trie:\n    def search(self, word: str, k=None, *args, **kwargs) -> bool:\n        word = word + "x"\n        return k\nsq = lambda v: v\n';
    expect(wordsIn(src, 'parameter')).toEqual(['self', 'word', 'k', 'args', 'kwargs', 'v']);
    expect(roleOf(src, 'word', 1)).toBe('text');
    expect(roleOf(src, 'return k')).toBe('control text');
  });

  it('colours self and cls everywhere, and a parameter named like a built-in as a parameter', () => {
    const src = 'class A:\n    def f(self, type):\n        self.val = self\n        return cls.make(type)\n';
    expect(wordsIn(src, 'parameter')).toEqual(['self', 'type', 'self', 'self', 'cls']);
    expect(roleOf(src, 'val')).toBe('text');
  });

  it('colours the names of keyword arguments, in calls, bases and class patterns', () => {
    const src = 'print(m, sep="", end=b"")\nclass A(B, metaclass=M): pass\nmatch p:\n    case Point(x=0, y=y): pass\n';
    expect(wordsIn(src, 'parameter')).toEqual(['sep', 'end', 'metaclass', 'x', 'y']);
    // What the pattern captures is a plain name.
    expect(roleOf(src, 'y)')).toBe('text');
  });

  it('leaves positional arguments, comparisons and walruses in a call alone', () => {
    const src = 'print(m, x == 1, (y := 2), z := 3, *rest, **opts)\n';
    expect(wordsIn(src, 'parameter')).toEqual([]);
    expect(roleOf(src, 'm')).toBe('text');
  });
});

it('the editor loads Python with its tags', async () => {
  const doc = 'def f(nums: list[int]) -> int:\n    pass\n';
  const state = EditorState.create({ doc, extensions: [await loadLanguage('python')] });
  const tree = ensureSyntaxTree(state, doc.length, 5000);
  expect(tree).not.toBeNull();
  const words: string[] = [];
  highlightTree(tree!, highlighter, (from, to, cls) => {
    if (cls === 'type' || cls === 'parameter') words.push(`${doc.slice(from, to)}:${cls}`);
  });
  expect(words).toEqual(['nums:parameter', 'list:type', 'int:type', 'int:type']);
});
