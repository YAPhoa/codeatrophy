/*
 * The shape of a language's standard-library table for completion (see
 * ../editorLibrary.ts), and the small notation the tables are written in.
 *
 * The tables cover what short programs reading stdin and writing stdout use,
 * on the toolchains the judge runs (Judge0 1.13.1: Python 3.8, GCC 9 in its
 * default C++14 mode, OpenJDK 13, Go 1.13, Rust 1.40, Node.js 12, Mono 6.6,
 * Kotlin 1.3.70, Ruby 2.7). Nothing newer goes in.
 */

/** One name the library offers. */
export interface LibraryName {
  label: string;
  /** A CodeMirror completion type: function, class, constant, … */
  type: string;
  /** A signature or kind, shown next to the name. */
  detail?: string;
  /** What has to be imported for the name to be usable, in the notation of the language's importer; none when it always is. */
  import?: string;
  /** The text inserted, when it is not the label. */
  apply?: string;
}

export interface LibraryTable {
  /** The language's own words, for the languages whose CodeMirror package offers none. */
  keywords?: readonly string[];
  /** Names offered on their own. */
  names: readonly LibraryName[];
  /** Names offered after a qualifier, keyed by the qualifier as written with its separator: `heapq.`, `std::`. */
  members: Readonly<Record<string, readonly LibraryName[]>>;
  /** Offered after any other `.`, ranked low: there is no type to go by. */
  methods?: readonly LibraryName[];
}

const KINDS: Readonly<Record<string, string>> = {
  f: 'function',
  c: 'class',
  k: 'constant',
  v: 'variable',
  t: 'type',
  i: 'interface',
  e: 'enum',
  n: 'namespace',
  m: 'method',
  p: 'property',
};

export interface Entry extends LibraryName {
  /** Marked with `*`: offered on its own too (see the tables that use it). */
  star: boolean;
}

/**
 * Entries written one per line as `kind label detail…`, where kind is one of
 * the letters in KINDS, optionally followed by `*`. `imports` gives each
 * entry's import: one for all, or one per label.
 */
export function entries(lines: string, imports?: string | ((label: string) => string)): Entry[] {
  const out: Entry[] = [];
  for (const line of lines.split('\n')) {
    const m = /^\s*(\w)(\*?)\s+(\S+)\s*(.*)$/.exec(line);
    if (!m) continue;
    const [, kind = '', star, label = '', detail] = m;
    const type = KINDS[kind];
    if (!type) throw new Error(`unknown kind ${kind} for ${label}`);
    const imp = typeof imports === 'function' ? imports(label) : imports;
    out.push({ label, type, star: star === '*', ...(detail ? { detail } : {}), ...(imp ? { import: imp } : {}) });
  }
  return out;
}

/** Names of one type, space-separated, with no detail. */
export function words(type: string, list: string, imp?: string): LibraryName[] {
  return list
    .trim()
    .split(/\s+/)
    .map((label) => ({ label, type, ...(imp ? { import: imp } : {}) }));
}

/** The entries with another import (or none). */
export function importing(list: readonly LibraryName[], imp: string | undefined): LibraryName[] {
  return list.map(({ import: _, ...rest }) => ({ ...rest, ...(imp ? { import: imp } : {}) }));
}
