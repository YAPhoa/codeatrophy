// "Solution only" problems in the mock: putting together the program that
// runs, and writing the stub and the runner for a plain function signature.
//
// The generated code follows the convention of docs/api.md: the runner reads
// one JSON value per line, one line per argument, and prints one JSON value.
// Like the starter templates it has to build on the judge's old toolchains
// (see JUDGE_LANGUAGES in db.ts).

import type { HarnessCode } from '../api/types';

const line = (text: string): string => (text === '' || text.endsWith('\n') ? text : `${text}\n`);

/**
 * The program that runs for a submitted source: the prefix, the source and
 * the suffix, each starting on a new line. `lineOffset` is how many lines
 * come before the source. Without a harness the source is the program.
 */
export function assemble(harness: HarnessCode | undefined, source: string): { program: string; lineOffset: number } {
  if (!harness) return { program: source, lineOffset: 0 };
  const prefix = line(harness.prefix);
  return { program: prefix + line(source) + harness.suffix, lineOffset: prefix.split('\n').length - 1 };
}

export type ValueType = 'int' | 'int[]' | 'string' | 'bool';

export interface Signature {
  /** Function name, in camelCase. */
  name: string;
  params: { name: string; type: ValueType }[];
  returns: ValueType;
}

/** The languages `functionKit` can write a stub and a runner for. */
export const KIT_LANGUAGES: readonly string[] = ['python', 'java', 'javascript', 'go'];

const PYTHON_TYPES: Record<ValueType, string> = { int: 'int', 'int[]': 'list[int]', string: 'str', bool: 'bool' };
const JAVA_TYPES: Record<ValueType, string> = { int: 'int', 'int[]': 'int[]', string: 'String', bool: 'boolean' };
const JS_TYPES: Record<ValueType, string> = { int: 'number', 'int[]': 'number[]', string: 'string', bool: 'boolean' };
const GO_TYPES: Record<ValueType, string> = { int: 'int', 'int[]': '[]int', string: 'string', bool: 'bool' };

function python(sig: Signature): { stub: string; harness: HarnessCode } {
  const params = sig.params.map((p) => `, ${p.name}: ${PYTHON_TYPES[p.type]}`).join('');
  return {
    stub: `class Solution:\n    def ${sig.name}(self${params}) -> ${PYTHON_TYPES[sig.returns]}:\n        `,
    harness: {
      // The import from __future__ lets the stub's annotations use list[int] on Python 3.8.
      prefix: 'from __future__ import annotations\n\nimport json\nimport sys\n\n',
      suffix: [
        '',
        '',
        'if __name__ == "__main__":',
        '    _args = [json.loads(_line) for _line in sys.stdin.read().splitlines() if _line.strip()]',
        `    print(json.dumps(Solution().${sig.name}(*_args), separators=(",", ":")))`,
        '',
      ].join('\n'),
    },
  };
}

const JAVA_READ: Record<ValueType, string> = {
  int: 'Integer.parseInt(in.readLine().trim())',
  'int[]': 'Json.ints(in.readLine())',
  string: 'Json.string(in.readLine())',
  bool: 'Boolean.parseBoolean(in.readLine().trim())',
};

const JAVA_JSON = String.raw`
class Json {
    static int[] ints(String line) {
        String body = line.trim();
        body = body.substring(1, body.length() - 1).trim();
        if (body.isEmpty()) return new int[0];
        String[] parts = body.split(",");
        int[] values = new int[parts.length];
        for (int i = 0; i < parts.length; i++) values[i] = Integer.parseInt(parts[i].trim());
        return values;
    }

    static String string(String line) {
        String body = line.trim();
        return body.substring(1, body.length() - 1).replace("\\\"", "\"").replace("\\\\", "\\");
    }

    static String text(int value) {
        return String.valueOf(value);
    }

    static String text(boolean value) {
        return String.valueOf(value);
    }

    static String text(String value) {
        return "\"" + value.replace("\\", "\\\\").replace("\"", "\\\"") + "\"";
    }

    static String text(int[] values) {
        StringBuilder out = new StringBuilder("[");
        for (int i = 0; i < values.length; i++) {
            if (i > 0) out.append(',');
            out.append(values[i]);
        }
        return out.append(']').toString();
    }
}
`;

function java(sig: Signature): { stub: string; harness: HarnessCode } {
  const params = sig.params.map((p) => `${JAVA_TYPES[p.type]} ${p.name}`).join(', ');
  return {
    stub: `class Solution {\n    public ${JAVA_TYPES[sig.returns]} ${sig.name}(${params}) {\n        \n    }\n}\n`,
    harness: {
      prefix: 'import java.io.*;\nimport java.util.*;\n\n',
      suffix: [
        '',
        'public class Main {',
        '    public static void main(String[] args) throws IOException {',
        '        BufferedReader in = new BufferedReader(new InputStreamReader(System.in));',
        ...sig.params.map((p) => `        ${JAVA_TYPES[p.type]} ${p.name} = ${JAVA_READ[p.type]};`),
        `        System.out.println(Json.text(new Solution().${sig.name}(${sig.params.map((p) => p.name).join(', ')})));`,
        '    }',
        '}',
        JAVA_JSON,
      ].join('\n'),
    },
  };
}

function javascript(sig: Signature): { stub: string; harness: HarnessCode } {
  return {
    stub: [
      '/**',
      ...sig.params.map((p) => ` * @param {${JS_TYPES[p.type]}} ${p.name}`),
      ` * @return {${JS_TYPES[sig.returns]}}`,
      ' */',
      `function ${sig.name}(${sig.params.map((p) => p.name).join(', ')}) {`,
      '    ',
      '}',
      '',
    ].join('\n'),
    harness: {
      prefix: '"use strict";\n\n',
      suffix: [
        '',
        'const __args = require("fs")',
        '  .readFileSync(0, "utf8")',
        '  .split("\\n")',
        '  .filter(function (line) { return line.trim() !== ""; })',
        '  .map(function (line) { return JSON.parse(line); });',
        `console.log(JSON.stringify(${sig.name}.apply(null, __args)));`,
        '',
      ].join('\n'),
    },
  };
}

function go(sig: Signature): { stub: string; harness: HarnessCode } {
  const params = sig.params.map((p) => `${p.name} ${GO_TYPES[p.type]}`).join(', ');
  return {
    stub: `func ${sig.name}(${params}) ${GO_TYPES[sig.returns]} {\n\t\n}\n`,
    harness: {
      prefix: 'package main\n\nimport (\n\t"bufio"\n\t"encoding/json"\n\t"fmt"\n\t"os"\n)\n\n',
      suffix: [
        '',
        'func main() {',
        '\tin := bufio.NewReader(os.Stdin)',
        ...sig.params.flatMap((p) => [`\tvar ${p.name} ${GO_TYPES[p.type]}`, `\treadArg(in, &${p.name})`]),
        `\tout, _ := json.Marshal(${sig.name}(${sig.params.map((p) => p.name).join(', ')}))`,
        '\tfmt.Println(string(out))',
        '}',
        '',
        'func readArg(in *bufio.Reader, into interface{}) {',
        "\tline, _ := in.ReadString('\\n')",
        '\tif err := json.Unmarshal([]byte(line), into); err != nil {',
        '\t\tpanic(err)',
        '\t}',
        '}',
        '',
      ].join('\n'),
    },
  };
}

const WRITERS: Record<string, (sig: Signature) => { stub: string; harness: HarnessCode }> = { python, java, javascript, go };

/** The stub and the runner for a signature, in each of `languages` the kit knows. */
export function functionKit(
  sig: Signature,
  languages: readonly string[] = KIT_LANGUAGES,
): { starterCode: Record<string, string>; harness: Record<string, HarnessCode> } {
  const starterCode: Record<string, string> = {};
  const harness: Record<string, HarnessCode> = {};
  for (const language of languages) {
    const written = WRITERS[language]?.(sig);
    if (!written) continue;
    starterCode[language] = written.stub;
    harness[language] = written.harness;
  }
  return { starterCode, harness };
}
