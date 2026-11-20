import { CompletionContext, type Completion, type CompletionResult, type CompletionSource } from '@codemirror/autocomplete';
import { history, undo } from '@codemirror/commands';
import { EditorState, type TransactionSpec } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import { describe, expect, it } from 'vitest';
import { documentWords, loadLanguage } from './editorLanguages';
import { codeBefore } from './editorLibrary';

interface Offer {
  option: Completion;
  from: number;
  to: number;
}

/** An editor for `doc`, the cursor at its end, with `prefix` as the runner code before it. */
async function editor(language: string, doc: string, prefix: string | null = null): Promise<EditorState> {
  return EditorState.create({ doc, selection: { anchor: doc.length }, extensions: [await loadLanguage(language), documentWords, codeBefore.of(prefix), history()] });
}

/** Everything the completion sources registered for the language offer at the cursor. */
function offers(state: EditorState, explicit = false): Offer[] {
  const pos = state.selection.main.head;
  const context = new CompletionContext(state, pos, explicit);
  const offered: Offer[] = [];
  for (const source of state.languageDataAt<CompletionSource | readonly (string | Completion)[]>('autocomplete', pos)) {
    const result = (typeof source === 'function' ? source(context) : { from: 0, options: source.map((o) => (typeof o === 'string' ? { label: o } : o)) }) as CompletionResult | null;
    if (result) offered.push(...result.options.map((option) => ({ option, from: result.from, to: result.to ?? pos })));
  }
  return offered;
}

async function complete(language: string, doc: string, prefix: string | null = null): Promise<Completion[]> {
  return offers(await editor(language, doc, prefix)).map((o) => o.option);
}

const labels = (options: Completion[]) => options.map((o) => o.label);

/** Pick the option labelled `label` (the one that adds an import, if several) and return the editor afterwards. */
function pick(state: EditorState, label: string): EditorState {
  const found = offers(state).filter((o) => o.option.label === label);
  const offer = found.find((o) => o.option.info) ?? found[0];
  if (!offer) throw new Error(`${label} is not offered`);
  let current = state;
  const view = {
    get state() {
      return current;
    },
    dispatch: (...specs: TransactionSpec[]) => {
      current = current.update(...specs).state;
    },
  } as unknown as EditorView;
  const { apply } = offer.option;
  if (typeof apply === 'function') apply(view, offer.option, offer.from, offer.to);
  else view.dispatch({ changes: { from: offer.from, to: offer.to, insert: apply ?? label } });
  return current;
}

async function picked(language: string, doc: string, label: string, prefix: string | null = null): Promise<string> {
  return pick(await editor(language, doc, prefix), label).doc.toString();
}

function find(options: Completion[], label: string): Completion | undefined {
  return options.find((o) => o.label === label);
}

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
});

describe('library completion: members after a qualifier', () => {
  it('lists a module’s members right after its qualifier, with a signature and a type', async () => {
    const heappush = find(await complete('python', 'import heapq\nheapq.'), 'heappush');
    expect(heappush).toMatchObject({ type: 'function', detail: '(heap, item)' });
    expect(labels(await complete('python', 'collections.de'))).toContain('deque');
    expect(labels(await complete('python', 'import sys\nsys.stdin.'))).toContain('readline');
  });

  it('covers the standard modules of every language', async () => {
    const cases: [string, string, string[]][] = [
      ['cpp', 'std::', ['vector', 'priority_queue', 'sort', 'accumulate', 'make_pair']],
      ['cpp', 'ios::', ['sync_with_stdio']],
      ['java', 'Math.', ['max', 'floorMod', 'PI']],
      ['java', 'Arrays.', ['sort', 'fill', 'asList']],
      ['java', 'Integer.', ['parseInt', 'MAX_VALUE']],
      ['java', 'Character.', ['isDigit']],
      ['java', 'System.out.', ['println']],
      ['java', 'import java.util.', ['ArrayList', 'PriorityQueue']],
      ['go', 'fmt.', ['Println', 'Fscan']],
      ['go', 'sort.', ['Ints', 'Slice']],
      ['go', 'heap.', ['Push', 'Init']],
      ['go', 'strconv.', ['Atoi', 'Itoa']],
      ['rust', 'std::collections::', ['HashMap', 'BinaryHeap']],
      ['rust', 'std::cmp::', ['Reverse', 'Ordering']],
      ['rust', 'std::io::', ['stdin', 'BufRead']],
      ['rust', 'HashMap::', ['new', 'with_capacity']],
      ['rust', 'std::i64::', ['MAX']],
      ['csharp', 'Console.', ['WriteLine', 'ReadLine']],
      ['csharp', 'int.', ['Parse', 'MaxValue']],
      ['kotlin', 'Int.', ['MAX_VALUE']],
      ['kotlin', 'System.', ['in', 'out']],
      ['ruby', 'Math.', ['sqrt']],
      ['ruby', 'Float::', ['INFINITY']],
      ['javascript', 'Math.', ['max', 'floor']],
      ['typescript', 'Number.', ['MAX_SAFE_INTEGER']],
    ];
    for (const [language, doc, expected] of cases) {
      const offered = labels(await complete(language, doc));
      for (const label of expected) expect(offered, `${language} ${doc}`).toContain(label);
    }
  });

  it('offers nothing newer than the judge’s toolchains', async () => {
    expect(labels(await complete('python', 'functools.'))).not.toContain('cache');
    expect(labels(await complete('python', 'math.'))).not.toContain('lcm');
    expect(labels(await complete('python', 'math.'))).toEqual(expect.arrayContaining(['isqrt', 'comb', 'prod']));
    expect(labels(await complete('python', 'itertools.'))).not.toContain('pairwise');
    expect(labels(await complete('cpp', 'std::'))).not.toEqual(expect.arrayContaining(['gcd']));
    for (const label of ['gcd', 'lcm', 'optional', 'string_view', 'ranges', 'format']) expect(labels(await complete('cpp', 'std::'))).not.toContain(label);
    expect(labels(await complete('go', 'math.'))).not.toContain('MaxInt');
    expect(labels(await complete('rust', 'i32::'))).not.toContain('MAX');
  });

  it('keeps keywords and names out of a member list', async () => {
    const offered = labels(await complete('cpp', 'std::'));
    expect(offered).not.toContain('while');
    expect(offered.filter((l) => l === 'vector')).toHaveLength(1);
    expect(labels(await complete('cpp', 'v.whi'))).not.toContain('while');
  });
});

describe('library completion: methods after any other dot', () => {
  it('offers common methods once a letter is typed, ranked below the document words', async () => {
    const append = find(await complete('python', 'nums = []\nnums.app'), 'append');
    expect(append?.boost).toBe(-2);
    expect(labels(await complete('cpp', 'v.push'))).toContain('push_back');
    expect(labels(await complete('python', 'nums.'))).not.toContain('append');
  });

  it('offers none after a number', async () => {
    expect(labels(await complete('python', 'x = 1.a'))).not.toContain('append');
  });
});

describe('library completion: auto-import', () => {
  it('adds a Python import at the top, or after the imports there', async () => {
    expect(await picked('python', 'class Solution:\n    pass\n\nq = deq', 'deque')).toBe('from collections import deque\n\nclass Solution:\n    pass\n\nq = deque');
    expect(await picked('python', 'import sys\nimport math\n\nx = hea', 'heapq')).toBe('import sys\nimport math\nimport heapq\n\nx = heapq');
    expect(await picked('python', 'from __future__ import annotations\nfrom typing import (\n    List,\n)\n\nh = heapq.heappu', 'heappush')).toBe(
      'from __future__ import annotations\nfrom typing import (\n    List,\n)\nimport heapq\n\nh = heapq.heappush',
    );
  });

  it('says what it will add', async () => {
    expect(find(await complete('python', 'deq'), 'deque')).toMatchObject({ detail: 'collections', info: 'Adds from collections import deque' });
    expect(find(await complete('cpp', 'priority_q'), 'priority_queue')?.info).toBe('Adds #include <queue>');
  });

  it('imports nothing that is imported already', async () => {
    expect(await picked('python', 'import heapq\nheapq.heappu', 'heappush')).toBe('import heapq\nheapq.heappush');
    expect(find(await complete('python', 'from collections import *\nq = deq'), 'deque')?.info).toBeUndefined();
    expect(await picked('cpp', '#include <bits/stdc++.h>\nusing namespace std;\npriority_q', 'priority_queue')).toBe('#include <bits/stdc++.h>\nusing namespace std;\npriority_queue');
    expect(await picked('cpp', '#include <stdio.h>\nint main() { std::pri', 'printf')).toBe('#include <stdio.h>\nint main() { std::printf');
    expect(await picked('java', 'import java.util.*;\n\npublic class Main {\n  ArrayL', 'ArrayList')).toBe('import java.util.*;\n\npublic class Main {\n  ArrayList');
    expect(await picked('rust', 'use std::collections::{HashMap, HashSet};\nfn main() {\n    HashSe', 'HashSet')).toBe('use std::collections::{HashMap, HashSet};\nfn main() {\n    HashSet');
    expect(await picked('rust', 'use std::io::{self, Read};\nfn main() {\n    io', 'io')).toBe('use std::io::{self, Read};\nfn main() {\n    io');
    expect(await picked('go', 'package main\n\nimport (\n\t"fmt"\n)\n\nfunc main() {\n\tfmt.Prin', 'Println')).toBe('package main\n\nimport (\n\t"fmt"\n)\n\nfunc main() {\n\tfmt.Println');
  });

  it('adds a C++ include after the others', async () => {
    expect(await picked('cpp', '#include <iostream>\nusing namespace std;\n\nint main() {\n    priority_q', 'priority_queue')).toBe(
      '#include <iostream>\n#include <queue>\nusing namespace std;\n\nint main() {\n    priority_queue',
    );
    expect(await picked('cpp', 'int main() {\n    std::sor', 'sort')).toBe('#include <algorithm>\n\nint main() {\n    std::sort');
    expect(await picked('c', '#include <stdio.h>\n\nint main(void) {\n    strl', 'strlen')).toBe('#include <stdio.h>\n#include <string.h>\n\nint main(void) {\n    strlen');
  });

  it('adds a Java import after the others or the package', async () => {
    expect(await picked('java', 'import java.io.*;\n\npublic class Main {\n  ArrayL', 'ArrayList')).toBe('import java.io.*;\nimport java.util.ArrayList;\n\npublic class Main {\n  ArrayList');
    expect(await picked('java', 'package demo;\n\npublic class Main {\n  int[] a; void f() { Arrays.so', 'sort')).toBe(
      'package demo;\n\nimport java.util.Arrays;\n\npublic class Main {\n  int[] a; void f() { Arrays.sort',
    );
    expect(find(await complete('java', 'Mat'), 'Math')?.info).toBeUndefined();
  });

  it('adds a Go import to the block, making one when needed', async () => {
    expect(await picked('go', 'package main\n\nimport "fmt"\n\nfunc main() {\n\tsort.In', 'Ints')).toBe('package main\n\nimport (\n\t"fmt"\n\t"sort"\n)\n\nfunc main() {\n\tsort.Ints');
    expect(await picked('go', 'package main\n\nimport (\n\t"fmt"\n)\n\nfunc main() {\n\tstrings.Fie', 'Fields')).toBe(
      'package main\n\nimport (\n\t"fmt"\n\t"strings"\n)\n\nfunc main() {\n\tstrings.Fields',
    );
    expect(await picked('go', 'package main\n\nfunc main() {\n\theap.Pu', 'Push')).toBe('package main\n\nimport "container/heap"\n\nfunc main() {\n\theap.Push');
  });

  it('adds a use, using, import or require in the other languages', async () => {
    expect(await picked('rust', 'use std::io;\n\nfn main() {\n    let m = HashM', 'HashMap')).toBe('use std::io;\nuse std::collections::HashMap;\n\nfn main() {\n    let m = HashMap');
    expect(await picked('rust', 'fn main() {\n    let o = Ordering::Le', 'Less')).toBe('use std::cmp::Ordering;\n\nfn main() {\n    let o = Ordering::Less');
    expect(await picked('csharp', 'using System;\n\nclass P {\n  Dictiona', 'Dictionary')).toBe('using System;\nusing System.Collections.Generic;\n\nclass P {\n  Dictionary');
    expect(await picked('kotlin', 'fun main() {\n    val x = ab', 'abs')).toBe('import kotlin.math.abs\n\nfun main() {\n    val x = abs');
    expect(await picked('ruby', "n = gets.to_i\ns = Se", 'Set')).toBe("require 'set'\n\nn = gets.to_i\ns = Set");
  });

  it('is one transaction, undone in one step', async () => {
    const before = await editor('python', 'import sys\n\nq = deq');
    const after = pick(before, 'deque');
    expect(after.doc.toString()).toBe('import sys\nfrom collections import deque\n\nq = deque');
    expect(after.selection.main.head).toBe(after.doc.length);
    let state = after;
    undo({ state, dispatch: (tr) => (state = tr.state) });
    expect(state.doc.toString()).toBe('import sys\n\nq = deq');
  });

  it('imports nothing while an import is being written', async () => {
    expect(await picked('python', 'from collections import de', 'deque')).toBe('from collections import deque');
    expect(await picked('python', 'import hea', 'heapq')).toBe('import heapq');
    expect(await picked('java', 'import java.util.ArrayL', 'ArrayList')).toBe('import java.util.ArrayList');
  });

  it('lists a name once when the document has it already', async () => {
    const offered = labels(await complete('python', 'from collections import deque\nq = deq'));
    expect(offered.filter((l) => l === 'deque')).toHaveLength(1);
  });
});

describe('library completion: after a runner prefix', () => {
  it('does not import what the prefix imports', async () => {
    expect(find(await complete('python', 'q = deq', 'from __future__ import annotations\nfrom collections import deque\n'), 'deque')?.info).toBeUndefined();
    expect(await picked('cpp', 'priority_q', 'priority_queue', '#include <bits/stdc++.h>\nusing namespace std;\n')).toBe('priority_queue');
    expect(await picked('go', 'func f() {\n\tfmt.Prin', 'Println', 'package main\n\nimport (\n\t"fmt"\n)\n')).toBe('func f() {\n\tfmt.Println');
    expect(await picked('rust', 'impl Solution {}\nfn f() { HashM', 'HashMap', 'use std::collections::HashMap;\n\nstruct Solution;\n')).toBe('impl Solution {}\nfn f() { HashMap');
  });

  it('imports in the solver’s code when the prefix allows it', async () => {
    expect(await picked('java', 'class Solution {\n  BufferedR', 'BufferedReader', 'import java.util.*;\n')).toBe('import java.io.BufferedReader;\n\nclass Solution {\n  BufferedReader');
    expect(await picked('go', 'func f() {\n\tsort.In', 'Ints', 'package main\n\nimport (\n\t"fmt"\n)\n')).toBe('import "sort"\n\nfunc f() {\n\tsort.Ints');
    expect(await picked('python', 'class Solution:\n    def f(self):\n        heapq.heappu', 'heappush', 'import json\n\nclass ListNode:\n    def __init__(self):\n        self.next = None\n\n')).toBe(
      'import heapq\n\nclass Solution:\n    def f(self):\n        heapq.heappush',
    );
    expect(await picked('cpp', 'class Solution {\n    priority_q', 'priority_queue', '#include <vector>\nusing namespace std;\nstruct ListNode { int val; };\n')).toBe(
      '#include <queue>\n\nclass Solution {\n    priority_queue',
    );
  });

  it('completes without an import when one could not follow the prefix', async () => {
    const javaPrefix = 'import java.util.*;\n\nclass ListNode {\n  int val;\n}\n';
    const reader = find(await complete('java', 'class Solution {\n  BufferedR', javaPrefix), 'BufferedReader');
    expect(reader?.info).toBeUndefined();
    expect(await picked('java', 'class Solution {\n  BufferedR', 'BufferedReader', javaPrefix)).toBe('class Solution {\n  BufferedReader');
    expect(await picked('go', 'func f() {\n\tsort.In', 'Ints', 'package main\n\nimport "fmt"\n\ntype ListNode struct {\n\tVal int\n}\n')).toBe('func f() {\n\tsort.Ints');
    expect(await picked('rust', '    fn f() { HashM', 'HashMap', 'struct Solution;\nimpl Solution {\n')).toBe('    fn f() { HashMap');
    expect(await picked('cpp', '    priority_q', 'priority_queue', '#include <vector>\nclass Solution {\npublic:\n')).toBe('    priority_queue');
    expect(await picked('kotlin', 'val x = ab', 'abs', 'class ListNode(var v: Int)\n')).toBe('val x = abs');
    expect(await picked('python', '    def f(self):\n        heapq.heappu', 'heappush', 'class Solution:\n')).toBe('    def f(self):\n        heapq.heappush');
    expect(await picked('python', '    def g(self):\n        heapq.heappu', 'heappush', 'class Solution:\n    def f(self):\n        pass\n')).toBe('    def g(self):\n        heapq.heappush');
    expect(await picked('csharp', 'class S { Dictiona', 'Dictionary', 'using System;\npublic class ListNode {}\n')).toBe('class S { Dictionary');
  });
});

describe('library completion: strings and comments', () => {
  it('offers nothing inside a string or a comment, keywords included', async () => {
    const cases: [string, string, string][] = [
      ['python', 'x = "heapq.', 'heappush'],
      ['python', '# deq', 'deque'],
      ['python', 'x = f"{1} heapq.', 'heappush'],
      ['cpp', 'auto s = "std::', 'vector'],
      ['cpp', '// priority_q', 'priority_queue'],
      ['cpp', '// whi', 'while'],
      ['java', '// Math.', 'max'],
      ['java', 'String s = "ArrayL', 'ArrayList'],
      ['go', 'var s = "fmt.', 'Println'],
      ['go', '// sort.', 'Ints'],
      ['rust', '// std::collections::', 'HashMap'],
      ['rust', 'let s = "HashM', 'HashMap'],
      ['csharp', '// Console.', 'WriteLine'],
      ['csharp', 'var s = "Dictiona', 'Dictionary'],
      ['kotlin', 'val s = "Int.', 'MAX_VALUE'],
      ['ruby', '# Math.', 'sqrt'],
      ['ruby', 's = "Se', 'Set'],
      ['javascript', '// Math.', 'max'],
      ['javascript', 'const s = `Math.', 'max'],
    ];
    for (const [language, doc, label] of cases) expect(labels(await complete(language, doc)), `${language}: ${doc}`).not.toContain(label);
  });
});
