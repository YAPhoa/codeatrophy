// What the pretend AI provider writes for `POST /ai/code`: the starter code
// of a problem's languages, or a "solution only" problem's stubs and
// runners, worked out from its statement and its first sample.
//
// A full program's starter code reads the sample's lines into variables
// named as the statement's Input section names them (`amount`, $n$), inside
// the folded input region. Like the templates it has to build on the judge's
// old toolchains (see JUDGE_LANGUAGES in db.ts): Python 3.8, GCC 9.2 in its
// default C++14, Java 13, Node.js 12, Go 1.13.

import type { HarnessCode } from '../api/types';
import { starterCode } from '../lib/starterTemplates';
import type { Signature, ValueType } from './harness';
import { functionKit } from './harness';

/** One value of the input, or a line of them. */
interface Variable {
  name: string;
  numeric: boolean;
  /** A whole line of values, however many. */
  list: boolean;
}

/** The names the statement's Input section gives, line by line: `code` spans and single-letter $math$. */
function inputNames(body: string): string[][] {
  const section = /^## Input[^\n]*\n([\s\S]*?)(?=^## |(?![\s\S]))/m.exec(body)?.[1] ?? '';
  return section
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => Array.from(l.matchAll(/`([A-Za-z_][A-Za-z0-9_]*)`|\$([A-Za-z])\$/g), (m) => m[1] ?? m[2]!));
}

const INT = /^-?\d+$/;

/** The variables the first sample's lines hold, named from the statement where it names them. */
function variablesOf(body: string, stdin: string): Variable[][] {
  const names = inputNames(body);
  const used = new Set<string>();
  const fresh = (want: string | undefined, fallback: string): string => {
    let name = want && !used.has(want) ? want : fallback;
    for (let i = 2; used.has(name); i++) name = `${fallback}${i}`;
    used.add(name);
    return name;
  };
  return stdin
    .replace(/\n+$/, '')
    .split('\n')
    .map((line, i) => {
      const tokens = line.trim().split(/\s+/).filter(Boolean);
      const given = (names[i] ?? []).filter((n) => !used.has(n));
      const numeric = tokens.length > 0 && tokens.every((t) => INT.test(t));
      if (tokens.length > 1 && given.length === tokens.length) return given.map((n) => ({ name: fresh(n, 'v'), numeric, list: false }));
      if (tokens.length <= 1) return [{ name: fresh(given[0], numeric ? 'n' : 's'), numeric, list: false }];
      return [{ name: fresh(given[0], numeric ? 'values' : 'words'), numeric, list: true }];
    });
}

const lines = (...parts: (string | string[])[]): string => parts.flat().join('\n');

function python(vars: Variable[][]): string {
  const read = vars.map((line) => {
    const one = line[0]!;
    if (one.list) return `    ${one.name} = ${one.numeric ? 'list(map(int, input().split()))' : 'input().split()'}`;
    if (line.length > 1) return `    ${line.map((v) => v.name).join(', ')} = ${one.numeric ? 'map(int, input().split())' : 'input().split()'}`;
    return `    ${one.name} = ${one.numeric ? 'int(input())' : 'input().strip()'}`;
  });
  return lines('import sys', '', '', 'def main() -> None:', '    # region input', read, '    # endregion', '    # TODO: compute the answer and print it', '', '', 'if __name__ == "__main__":', '    main()', '');
}

function cpp(vars: Variable[][]): string {
  const read = vars.flatMap((line) => {
    const one = line[0]!;
    const type = one.numeric ? 'long long' : 'string';
    if (one.list) return [`    vector<${type}> ${one.name};`, '    getline(cin, line);', `    { istringstream in(line); ${type} x; while (in >> x) ${one.name}.push_back(x); }`];
    return [`    ${type} ${line.map((v) => v.name).join(', ')};`, '    getline(cin, line);', `    { istringstream in(line); in >> ${line.map((v) => v.name).join(' >> ')}; }`];
  });
  return lines('#include <bits/stdc++.h>', 'using namespace std;', '', 'int main() {', '    // region input', '    string line;', read, '    // endregion', '', '    // TODO: compute the answer and print it', '', '    return 0;', '}', '');
}

function java(vars: Variable[][]): string {
  const read = vars.flatMap((line) => {
    const one = line[0]!;
    if (one.list) {
      return [`        ${one.numeric ? 'long[]' : 'String[]'} ${one.name} = ${one.numeric ? 'Arrays.stream(in.readLine().trim().split("\\\\s+")).mapToLong(Long::parseLong).toArray()' : 'in.readLine().trim().split("\\\\s+")'};`];
    }
    return [
      '        tokens = new StringTokenizer(in.readLine());',
      ...line.map((v) => (v.numeric ? `        long ${v.name} = Long.parseLong(tokens.nextToken());` : `        String ${v.name} = tokens.nextToken();`)),
    ];
  });
  return lines(
    'import java.io.*;',
    'import java.util.*;',
    '',
    'public class Main {',
    '    public static void main(String[] args) throws IOException {',
    '        // region input',
    '        BufferedReader in = new BufferedReader(new InputStreamReader(System.in));',
    '        StringTokenizer tokens;',
    read,
    '        // endregion',
    '        // TODO: compute the answer and print it',
    '    }',
    '}',
    '',
  );
}

function javascript(vars: Variable[][]): string {
  const read = vars.map((line, i) => {
    const one = line[0]!;
    const split = `lines[${i}].trim().split(/\\s+/)${one.numeric ? '.map(Number)' : ''}`;
    if (one.list) return `const ${one.name} = ${split};`;
    if (line.length > 1) return `const [${line.map((v) => v.name).join(', ')}] = ${split};`;
    return `const ${one.name} = ${one.numeric ? `Number(lines[${i}])` : `lines[${i}].trim()`};`;
  });
  return lines('// region input', 'const lines = require("fs").readFileSync(0, "utf8").split("\\n");', read, '// endregion', '', '// TODO: compute the answer and print it with console.log', '');
}

function go(vars: Variable[][]): string {
  const numeric = vars.some((line) => line.some((v) => v.numeric));
  const read = vars.flatMap((line, i) => {
    const one = line[0]!;
    const next = ['\tin.Scan()', `\tfields ${i === 0 ? ':=' : '='} strings.Fields(in.Text())`];
    if (one.list) {
      return one.numeric
        ? [...next, `\tvar ${one.name} []int`, '\tfor _, f := range fields {', '\t\tv, _ := strconv.Atoi(f)', `\t\t${one.name} = append(${one.name}, v)`, '\t}']
        : [...next, `\t${one.name} := fields`];
    }
    return [...next, ...line.map((v, j) => (v.numeric ? `\t${v.name}, _ := strconv.Atoi(fields[${j}])` : `\t${v.name} := fields[${j}]`))];
  });
  const names = vars.flat().map((v) => v.name);
  return lines(
    'package main',
    '',
    'import (',
    '\t"bufio"',
    '\t"os"',
    ...(numeric ? ['\t"strconv"'] : []),
    '\t"strings"',
    ')',
    '',
    'func main() {',
    '\t// region input',
    '\tin := bufio.NewScanner(os.Stdin)',
    '\tin.Buffer(make([]byte, 1<<20), 1<<26)',
    read,
    '\t// endregion',
    '',
    '\t// TODO: compute the answer and print it',
    // Go refuses variables that are never used; this line goes once they are.
    `\t${names.map(() => '_').join(', ')} = ${names.join(', ')}`,
    '}',
    '',
  );
}

const PROGRAM_WRITERS: Record<string, (vars: Variable[][]) => string> = { python, cpp, java, javascript, go };

/** The type of one JSON value, or of a line that is not JSON. */
function valueType(text: string): ValueType {
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value === 'boolean') return 'bool';
    if (typeof value === 'string') return 'string';
    if (Array.isArray(value)) return 'int[]';
    if (typeof value === 'number') return 'int';
  } catch {
    // Not JSON: the sample is a full program's input.
  }
  const tokens = text.trim().split(/\s+/);
  return tokens.every((t) => INT.test(t)) ? (tokens.length > 1 ? 'int[]' : 'int') : 'string';
}

/** A function's name from the problem's title, in camelCase. */
function functionName(title: string): string {
  const words = title
    .replace(/\(.*?\)/g, ' ')
    .split(/[^A-Za-z0-9]+/)
    .filter((w) => /^[A-Za-z]/.test(w));
  if (words.length === 0) return 'solve';
  return words.map((w, i) => (i === 0 ? w.toLowerCase() : w[0]!.toUpperCase() + w.slice(1).toLowerCase())).join('');
}

/** The signature a statement and its first sample suggest: one parameter per input line. */
function signatureOf(title: string, body: string, sample: { stdin: string; expectedStdout: string } | undefined): Signature {
  const names = inputNames(body).flat();
  const used = new Set<string>();
  const params = (sample?.stdin.replace(/\n+$/, '').split('\n') ?? ['[]']).map((line, i) => {
    let name = names.find((n) => !used.has(n)) ?? String.fromCharCode(97 + i);
    if (used.has(name)) name = `arg${i + 1}`;
    used.add(name);
    return { name, type: valueType(line) };
  });
  return { name: functionName(title), params, returns: sample ? valueType(sample.expectedStdout.trim()) : 'int' };
}

export interface CodeAsk {
  title: string;
  body: string;
  face: 'program' | 'function';
  languages: readonly string[];
  samples: readonly { stdin: string; expectedStdout: string }[];
}

/**
 * The code a model writes for each language asked for. A language the mock
 * has no writer for gets its generic starter code in a full program, and is
 * left out of a "solution only" problem, as a model can leave one out.
 */
export function writeCode(ask: CodeAsk): { starterCode: Record<string, string>; harness: Record<string, HarnessCode> } {
  const sample = ask.samples[0];
  if (ask.face === 'function') return functionKit(signatureOf(ask.title, ask.body, sample), ask.languages);
  const generic = starterCode(ask.languages);
  const vars = sample && sample.stdin.trim() !== '' ? variablesOf(ask.body, sample.stdin) : null;
  const out: Record<string, string> = {};
  for (const language of ask.languages) {
    const write = PROGRAM_WRITERS[language];
    const code = vars && write ? write(vars) : generic[language];
    if (code !== undefined) out[language] = code;
  }
  return { starterCode: out, harness: {} };
}
