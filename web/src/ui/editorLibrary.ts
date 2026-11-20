/*
 * Standard-library completion for the code editor, from a table per language
 * (./libraries): the members of a module, namespace or class after its
 * qualifier (`heapq.`, `std::`, `Math.`), the library's names on their own,
 * and common methods after any other `.`, ranked low since there is no type
 * to go by.
 *
 * Picking a name whose module is not imported yet adds the import in the same
 * transaction, after the imports already there or else at the top. For a
 * "solution only" problem the solver's code runs after the runner's prefix
 * (see `codeBefore`): what the prefix imports is not imported again, and
 * when an import could not legally follow the prefix (a Java import after a
 * class, say) the name is completed without one.
 */

import { ifNotIn, insertCompletionText, pickedCompletion, type Completion, type CompletionContext, type CompletionSource } from '@codemirror/autocomplete';
import type { Language } from '@codemirror/language';
import { Facet, type ChangeSet, type EditorState, type Extension, type Text } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import type { LibraryName, LibraryTable } from './libraries/table';

/** Code that runs before the editor's text, such as a runner's prefix: completion's imports take it into account. */
export const codeBefore = Facet.define<string | null, string | null>({ combine: (values) => values.find((v) => v != null) ?? null });

/** Syntax nodes inside which nothing is completed: comments and strings, in the LR grammars and the legacy modes. */
const NO_COMPLETION_IN = [
  'LineComment',
  'BlockComment',
  'Comment',
  'String',
  'FormatString',
  'RawString',
  'TemplateString',
  'RegExp',
  'CharLiteral',
  'StringLiteral',
  'CharacterLiteral',
  'TextBlock',
  'Char',
  'Rune',
  'SystemLibString',
  'comment',
  'string',
  'string-2',
  'string.special',
];

/**
 * Whether a line, up to the cursor, ends inside a string the parser has not
 * closed: some grammars (Java's) recover from an unterminated string without
 * a String node.
 */
function inOpenString(before: string): boolean {
  const quotes = before.replace(/\\./g, '').replace(/'[^'\n]'/g, '').match(/"/g);
  return quotes !== null && quotes.length % 2 === 1;
}

/** An insertion of an import into the solver's code. */
interface ImportChange {
  from: number;
  to?: number;
  insert: string;
}

/** How one language imports: the notation of a table's `import` fields. */
interface Importer {
  /** The statement that imports `target`, as the user is told about it. */
  statement(target: string): string;
  /** What `code` imports: whether it makes `target` available. */
  scan(code: string): (target: string) => boolean;
  /** Whether code that runs after `prefix` may import anything itself. */
  allowedAfter(prefix: string): boolean;
  /** Whether the solver's code, running after a prefix, can take an import at its head. */
  allowedIn?(doc: Text): boolean;
  /** The change that adds the import of `target` to `doc`. */
  insert(doc: Text, target: string): ImportChange;
  /** A line that is an import, where nothing is imported for what is typed. */
  importLine: RegExp;
  /** For Python: what to offer in `from m import …` (a qualifier) and `import …` (the modules). */
  importing?(head: string): string | 'modules' | null;
}

const stripLineComments = (code: string, marker: string) => code.replace(new RegExp(`${marker}.*$`, 'gm'), '');
const stripComments = (code: string) => stripLineComments(code.replace(/\/\*[\s\S]*?\*\//g, ' '), '//');

/** Braces left open at the end of C-like code, ignoring comments, strings and characters. */
function openBraces(code: string): number {
  let depth = 0;
  for (const ch of stripComments(code).replace(/"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'/g, '')) {
    if (ch === '{') depth++;
    else if (ch === '}') depth--;
  }
  return depth;
}

/** Where imports sit in a file, for placing a new one. */
interface Layout {
  /** A line that is (or starts) an import. */
  import: RegExp;
  /** An import line that does not match this goes on until a line that does `close`. */
  complete?: RegExp;
  close?: RegExp;
  /** A line imports have to follow: `package main`. */
  preamble?: RegExp;
  /** Lines that may come before and between imports: blank lines, comments, other directives. */
  skip: RegExp;
}

/** The insertion of `statement` after the last import at the head of `doc`, else after its preamble, else at the top. */
function placeImport(doc: Text, layout: Layout, statement: string): ImportChange {
  let lastImport = -1;
  let preamble = -1;
  let open = false;
  for (let n = 1; n <= doc.lines; n++) {
    const text = doc.line(n).text;
    if (open) {
      lastImport = n;
      open = !layout.close!.test(text);
    } else if (layout.import.test(text)) {
      lastImport = n;
      open = layout.complete !== undefined && !layout.complete.test(text);
    } else if (layout.preamble?.test(text)) {
      preamble = n;
    } else if (!/^\s*$/.test(text) && !layout.skip.test(text)) {
      break;
    }
  }
  if (lastImport > 0) return { from: doc.line(lastImport).to, insert: `\n${statement}` };
  if (preamble > 0) return { from: doc.line(preamble).to, insert: `\n\n${statement}` };
  // A blank line between the import and the code below it.
  return { from: 0, insert: `${statement}\n${doc.line(1).text.trim() === '' ? '' : '\n'}` };
}

const C_LIKE_SKIP = /^\s*(?:\/\/|\/\*|\*)/;

/** `import a.b.C;` in Java, `import a.b.C` in Kotlin. */
function jvmImporter(semicolon: string): Importer {
  const layout: Layout = { import: /^\s*import\s/, preamble: /^\s*(?:package\s|@file:)/, skip: C_LIKE_SKIP };
  return {
    statement: (target) => `import ${target}${semicolon}`,
    scan(code) {
      const imported = new Set<string>();
      for (const m of stripComments(code).matchAll(/^\s*import\s+(static\s+)?([\w.]*\w(?:\.\*)?)/gm)) {
        if (!m[1] && m[2]) imported.add(m[2]);
      }
      return (target) => {
        const dot = target.lastIndexOf('.');
        const simple = `.${target.slice(dot + 1)}`;
        // Another class of the same name counts as well: a second import would clash with it.
        return imported.has(`${target.slice(0, dot)}.*`) || [...imported].some((i) => i.endsWith(simple));
      };
    },
    // Imports have to come before every declaration of the file.
    allowedAfter: (prefix) =>
      stripComments(prefix)
        .replace(/^\s*(?:package|import)\s+[\w.*]+(?:\s+as\s+\w+)?\s*;?\s*$/gm, '')
        .replace(/^\s*@file:.*$/gm, '')
        .trim() === '',
    insert: (doc, target) => placeImport(doc, layout, `import ${target}${semicolon}`),
    importLine: layout.import,
  };
}

/** `#include <header>` in C and C++. */
function includeImporter(cpp: boolean): Importer {
  const layout: Layout = { import: /^\s*#\s*include\b/, skip: /^\s*(?:\/\/|\/\*|\*|#)/ };
  return {
    statement: (target) => `#include <${target}>`,
    scan(code) {
      const headers = new Set([...stripComments(code).matchAll(/^\s*#\s*include\s*[<"]([^>"]+)[>"]/gm)].map((m) => (m[1] ?? '').trim()));
      return (target) => {
        if (headers.has(target) || (cpp && headers.has('bits/stdc++.h'))) return true;
        // <cstdio> and <stdio.h> are the same header.
        const c = /^c(\w+)$/.exec(target);
        return c !== null && headers.has(`${c[1]}.h`);
      };
    },
    // An include inside a class or namespace would not do.
    allowedAfter: (prefix) => openBraces(prefix) === 0,
    insert: (doc, target) => placeImport(doc, layout, `#include <${target}>`),
    importLine: layout.import,
  };
}

const pythonLayout: Layout = {
  import: /^(?:import|from)\s/,
  complete: /^[^(]*$|\)/,
  close: /\)/,
  skip: /^\s*#/,
};

/** `import module` for `module`, `from module import name` for `module:name`. */
const python: Importer = {
  statement(target) {
    const [module, name] = target.split(':');
    return name ? `from ${module} import ${name}` : `import ${module}`;
  },
  scan(code) {
    const text = stripLineComments(code, '#');
    const modules = new Set<string>();
    const names = new Set<string>();
    for (const m of text.matchAll(/^\s*import\s+([^\n;]+)/gm)) {
      for (const item of (m[1] ?? '').split(',').map((s) => s.trim())) {
        if (/^[\w.]+$/.test(item)) modules.add(item.replace(/\..*/, '')).add(item);
      }
    }
    for (const m of text.matchAll(/^\s*from\s+([\w.]+)\s+import\s+(\([^)]*\)|[^\n;]+)/gm)) {
      for (const item of (m[2] ?? '').replace(/[()\\]/g, ' ').split(',').map((s) => s.trim())) {
        if (/^(?:\w+|\*)$/.test(item)) names.add(`${m[1]}:${item}`);
      }
    }
    return (target) => (target.includes(':') ? names.has(target) || names.has(`${target.split(':')[0]}:*`) : modules.has(target));
  },
  // Not when the solver's code goes inside a block the prefix opens.
  allowedAfter(prefix) {
    const lines = stripLineComments(prefix, '#')
      .split('\n')
      .filter((l) => l.trim() !== '');
    return !lines[lines.length - 1]?.trimEnd().endsWith(':');
  },
  allowedIn(doc) {
    for (const line of doc.iterLines()) if (line.trim() !== '' && !line.trimStart().startsWith('#')) return !/^\s/.test(line);
    return true;
  },
  insert: (doc, target) => placeImport(doc, pythonLayout, python.statement(target)),
  importLine: /^\s*(?:import|from)\s/,
  importing(head) {
    const from = /^\s*from\s+(\w+)\s+import\s+\(?\s*(?:\w+(?:\s+as\s+\w+)?\s*,\s*)*$/.exec(head);
    if (from) return `${from[1]}.`;
    return /^\s*import\s+(?:\w+(?:\s+as\s+\w+)?\s*,\s*)*$|^\s*from\s+$/.test(head) ? 'modules' : null;
  },
};

/** The paths a Rust `use` tree brings in, each with the name it binds. */
function rustUsePaths(tree: string): { path: string; name: string }[] {
  tree = tree.replace(/\s+/g, ' ').trim().replace(/^::/, '');
  const brace = tree.indexOf('{');
  if (brace < 0) {
    const [, path = '', alias] = /^(.*?)(?: as (\w+))?$/.exec(tree) ?? [];
    return [{ path, name: alias ?? path.slice(path.lastIndexOf(':') + 1) }];
  }
  const head = tree.slice(0, brace).replace(/\s/g, '');
  const inner = tree.slice(brace + 1, tree.lastIndexOf('}'));
  const items: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < inner.length; i++) {
    if (inner[i] === '{') depth++;
    else if (inner[i] === '}') depth--;
    else if (inner[i] === ',' && depth === 0) {
      items.push(inner.slice(start, i));
      start = i + 1;
    }
  }
  items.push(inner.slice(start));
  return items
    .map((item) => item.trim())
    .filter((item) => item !== '')
    .flatMap((item) => (item === 'self' ? rustUsePaths(head.replace(/::$/, '')) : rustUsePaths(head + item)));
}

const rustLayout: Layout = { import: /^\s*(?:pub\s+)?use\s/, complete: /;/, close: /;/, skip: /^\s*(?:\/\/|\/\*|\*|#!?\[|extern\s+crate\s)/ };

/** `use path;` for a full path. */
const rust: Importer = {
  statement: (target) => `use ${target};`,
  scan(code) {
    const used = [...stripComments(code).matchAll(/\buse\s+([^;]+);/g)].flatMap((m) => rustUsePaths(m[1] ?? ''));
    return (target) => {
      const cut = target.lastIndexOf('::');
      const module = target.slice(0, cut);
      const name = target.slice(cut + 2);
      return used.some(
        (u) => u.path === target || u.path === `${module}::*` || (u.path === 'std::io::prelude::*' && module === 'std::io') || (u.name === name && u.name !== '*'),
      );
    };
  },
  // `use` cannot go in an impl block; anywhere else it may.
  allowedAfter: (prefix) => openBraces(prefix) === 0,
  insert: (doc, target) => placeImport(doc, rustLayout, `use ${target};`),
  importLine: rustLayout.import,
};

/** `using Namespace;` in C#. */
const csharp: Importer = {
  statement: (target) => `using ${target};`,
  scan(code) {
    const used = new Set([...stripComments(code).matchAll(/^\s*using\s+([\w.]+)\s*;/gm)].map((m) => m[1]));
    return (target) => used.has(target);
  },
  allowedAfter: (prefix) =>
    stripComments(prefix)
      .replace(/^\s*(?:using\s+(?:static\s+)?[\w.]+(?:\s*=\s*[^;]+)?|extern\s+alias\s+\w+)\s*;\s*$/gm, '')
      .trim() === '',
  insert: (doc, target) => placeImport(doc, { import: /^\s*using\s+(?:static\s+)?[\w.]+\s*(?:=[^;]*)?;/, skip: C_LIKE_SKIP }, `using ${target};`),
  importLine: /^\s*using\s/,
};

/** `require 'library'` in Ruby, which may go anywhere. */
const ruby: Importer = {
  statement: (target) => `require '${target}'`,
  scan(code) {
    const required = new Set([...stripLineComments(code, '#').matchAll(/\brequire\s*\(?\s*['"]([^'"]+)['"]/g)].map((m) => m[1]));
    return (target) => required.has(target);
  },
  allowedAfter: () => true,
  insert: (doc, target) => placeImport(doc, { import: /^\s*require\b/, skip: /^\s*#/ }, `require '${target}'`),
  importLine: /^\s*require\b/,
};

/** Go: into the file's import block, which is made when there is a single import or none. */
const go: Importer = {
  statement: (target) => `import "${target}"`,
  scan(code) {
    const text = stripComments(code);
    const paths = new Set<string>();
    for (const m of text.matchAll(/\bimport\s*\(([^)]*)\)/g)) for (const p of (m[1] ?? '').matchAll(/"([^"]+)"/g)) paths.add(p[1] ?? '');
    for (const m of text.matchAll(/\bimport\s+(?:[\w.]+\s+)?"([^"]+)"/g)) paths.add(m[1] ?? '');
    return (target) => paths.has(target);
  },
  // Imports have to come before every other declaration of the file.
  allowedAfter: (prefix) =>
    stripComments(prefix)
      .replace(/\bpackage\s+\w+/g, '')
      .replace(/\bimport\s*\([^)]*\)/g, '')
      .replace(/\bimport\s+(?:[\w.]+\s+)?"[^"]*"/g, '')
      .replace(/;/g, '')
      .trim() === '',
  insert(doc, target) {
    const spec = `"${target}"`;
    let single = -1;
    let pkg = -1;
    for (let n = 1; n <= doc.lines; n++) {
      const text = doc.line(n).text;
      if (/^\s*import\s*\(\s*$/.test(text)) {
        // Before the closing parenthesis, indented like the line above it.
        for (let k = n + 1; k <= doc.lines; k++) {
          const close = doc.line(k);
          if (!/^\s*\)/.test(close.text)) continue;
          const above = doc.line(k - 1).text;
          const indent = k - 1 > n ? /^\s*/.exec(above)![0] : '\t';
          return { from: close.from, insert: `${indent}${spec}\n` };
        }
        break;
      }
      if (/^\s*import\s+(?:[\w.]+\s+)?"[^"]*"\s*$/.test(text)) single = n;
      else if (/^\s*package\s/.test(text)) pkg = n;
      else if (!/^\s*(?:$|\/\/|\/\*|\*)/.test(text) && !/^\s*import\b/.test(text)) break;
    }
    if (single > 0) {
      const line = doc.line(single);
      const existing = line.text.trim().replace(/^import\s+/, '');
      return { from: line.from, to: line.to, insert: `import (\n\t${existing}\n\t${spec}\n)` };
    }
    if (pkg > 0) return { from: doc.line(pkg).to, insert: `\n\nimport ${spec}` };
    return { from: 0, insert: `import ${spec}\n${doc.line(1).text.trim() === '' ? '' : '\n'}` };
  },
  importLine: /^\s*import\b/,
};

const IMPORTERS: Readonly<Record<string, Importer>> = {
  python,
  c: includeImporter(false),
  cpp: includeImporter(true),
  java: jvmImporter(';'),
  kotlin: jvmImporter(''),
  go,
  rust,
  csharp,
  ruby,
};

/** The last result of `fn`, for the same argument. */
function memo<T>(fn: (code: string) => T): (code: string) => T {
  let last: { code: string; value: T } | null = null;
  return (code) => {
    if (last?.code !== code) last = { code, value: fn(code) };
    return last.value;
  };
}

/** What can be imported where the user is completing, worked out as it is needed. */
class Imports {
  private docHas: ((target: string) => boolean) | null = null;
  private prefixHas: ((target: string) => boolean) | null = null;
  readonly prefix: string | null;

  constructor(
    private readonly state: EditorState,
    private readonly importer: Importer,
    private readonly scan: (code: string) => (target: string) => boolean,
    private readonly allowedAfter: (prefix: string) => boolean,
  ) {
    this.prefix = state.facet(codeBefore);
  }

  has(target: string): boolean {
    this.docHas ??= this.scan(this.state.doc.toString());
    if (this.docHas(target)) return true;
    if (this.prefix == null) return false;
    this.prefixHas ??= this.scan(this.prefix);
    return this.prefixHas(target);
  }

  /** The change that imports `target`, or null when nothing is to be added. */
  change(target: string): ImportChange | null {
    if (this.has(target) || !this.allowed) return null;
    return this.importer.insert(this.state.doc, target);
  }

  /** Whether the solver's code may import anything at all. */
  get allowed(): boolean {
    return this.prefix == null || (this.allowedAfter(this.prefix) && (this.importer.allowedIn?.(this.state.doc) ?? true));
  }
}

/** How often each identifier occurs in a document. */
const wordCounts = new WeakMap<Text, Map<string, number>>();

function countWords(doc: Text): Map<string, number> {
  let counts = wordCounts.get(doc);
  if (!counts) {
    counts = new Map();
    for (const m of doc.toString().matchAll(/[A-Za-z_$][\w$]*/g)) counts.set(m[0], (counts.get(m[0]) ?? 0) + 1);
    wordCounts.set(doc, counts);
  }
  return counts;
}

const VALID = /^[\w$]*$/;

/**
 * Completion from `table` for a language, attached as language data so that
 * it runs next to the language's own sources and the document words.
 */
export function libraryCompletion(language: Language, id: string, table: LibraryTable): Extension {
  const importer = IMPORTERS[id] ?? null;
  const scan = importer ? memo(importer.scan) : null;
  const allowedAfter = importer ? memo(importer.allowedAfter) : () => false;
  const qualifiers = Object.keys(table.members).sort((a, b) => b.length - a.length);
  const keywords = [...new Set(table.keywords ?? [])];
  const keywordSet = new Set(keywords);
  const seen = new Set<string>();
  const names = table.names.filter((n) => !keywordSet.has(n.label) && !seen.has(n.label) && seen.add(n.label));

  const applyImport =
    (target: string, text: string) =>
    (view: EditorView, completion: Completion, from: number, to: number): void => {
      const { state } = view;
      const spec = insertCompletionText(state, text, from, to);
      const add = new Imports(state, importer!, scan!, allowedAfter).change(target);
      const extra = [];
      if (add) {
        // Placed against the text as completed, ahead of anything inserted at the same spot.
        const changes = spec.changes as ChangeSet;
        extra.push({ changes: { from: changes.mapPos(add.from, -1), to: changes.mapPos(add.to ?? add.from, -1), insert: add.insert }, sequential: true });
      }
      view.dispatch({ ...spec, annotations: pickedCompletion.of(completion) }, ...extra);
    };

  const option = (name: LibraryName, imports: Imports | null, boost = 0): Completion => {
    const base: Completion = { label: name.label, type: name.type, ...(name.detail ? { detail: name.detail } : {}), ...(boost ? { boost } : {}), ...(name.apply ? { apply: name.apply } : {}) };
    if (!name.import || !imports || imports.has(name.import) || !imports.allowed) return base;
    return { ...base, info: `Adds ${importer!.statement(name.import)}`, apply: applyImport(name.import, name.apply ?? name.label) };
  };

  const source: CompletionSource = (context: CompletionContext) => {
    const { state, pos } = context;
    const line = state.doc.lineAt(pos);
    const before = line.text.slice(0, pos - line.from);
    const word = /[\w$]*$/.exec(before)![0];
    if (/^\d/.test(word) || inOpenString(before)) return null;
    const from = pos - word.length;
    const head = before.slice(0, before.length - word.length);
    const inImport = importer?.importLine.test(line.text) ?? false;
    const imports = importer && !inImport ? new Imports(state, importer, scan!, allowedAfter) : null;
    const result = (options: Completion[]) => (options.length > 0 ? { from, options, validFor: VALID } : null);

    // Python's `from heapq import …` and `import …`.
    const importing = importer?.importing?.(head);
    if (importing === 'modules') return result(names.filter((n) => n.type === 'namespace' && n.import).map((n) => option(n, null)));
    if (importing) return result((table.members[importing] ?? []).map((n) => option(n, null)));

    const qualifier = qualifiers.find((q) => head.endsWith(q) && !/[\w$.:]$/.test(head.slice(0, head.length - q.length)));
    if (qualifier) return result((table.members[qualifier] ?? []).map((n) => option(n, imports)));
    if (/(?:\.|::|->)$/.test(head)) {
      // After a dot that follows a name, a call or an index, not a number.
      if (!head.endsWith('.') || !table.methods || (!word && !context.explicit) || !/[\w$)\]'"]\.$/.test(head) || /(?:^|[^\w$])\d+\.$/.test(head)) return null;
      return result(table.methods.map((n) => option(n, imports, -2)));
    }
    if (!word && !context.explicit) return null;

    // Left to the sources that list them already: the legacy modes' words, and names the document has (used,
    // imported or defined), which the document words or the language's own sources offer.
    const taken = new Set<string>();
    for (const other of state.languageDataAt<unknown>('autocomplete', pos)) {
      if (Array.isArray(other)) for (const o of other as readonly (string | { label: string })[]) taken.add(typeof o === 'string' ? o : o.label);
    }
    const counts = countWords(state.doc);
    const current = /^[\w$]*/.exec(state.sliceDoc(from, line.to))![0];
    const elsewhere = (label: string) => (counts.get(label) ?? 0) > (label === current ? 1 : 0);
    const options: Completion[] = keywords.map((label) => ({ label, type: 'keyword' }));
    for (const name of names) {
      if (taken.has(name.label) || (name.import && elsewhere(name.label))) continue;
      options.push(option(name, imports));
    }
    return result(options);
  };

  return language.data.of({ autocomplete: ifNotIn(NO_COMPLETION_IN, source) });
}
