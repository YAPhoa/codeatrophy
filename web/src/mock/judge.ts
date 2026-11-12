// A pretend judge. Code is never executed: the verdict is decided by rules
// that a contributor can trigger on purpose.
//
//   - A marker anywhere in the source selects a failure:
//       MOCK:WA   wrong answer on the 2nd case and every 3rd case after it
//       MOCK:TLE  time limit exceeded on the last case
//       MOCK:MLE  memory limit exceeded on the last case
//       MOCK:RE   runtime error (with a stack trace) on every case
//       MOCK:CE   compile error
//       MOCK:IE   internal error, as if the engine failed
//   - Source identical to the problem's starter code prints nothing, so every
//     case is a wrong answer.
//   - Anything else is accepted.

import type { SubmissionResult, Verdict } from '../api/types';

export type Behaviour = 'accepted' | 'starter' | 'wrong' | 'tle' | 'mle' | 're' | 'ce' | 'ie';

const MARKERS: Record<string, Behaviour> = { WA: 'wrong', TLE: 'tle', MLE: 'mle', RE: 're', CE: 'ce', IE: 'ie' };

export function detectBehaviour(source: string, starter: string | undefined): Behaviour {
  const marker = /MOCK:(WA|TLE|MLE|RE|CE|IE)\b/.exec(source);
  if (marker) return MARKERS[marker[1]!]!;
  if (starter !== undefined && source.trim() === starter.trim()) return 'starter';
  return 'accepted';
}

/** Believable time and memory figures for a language, varied by `seed`. */
export function resourceUsage(language: string, seed: number): { timeMs: number; memoryKb: number } {
  const profile: Record<string, [number, number, number, number]> = {
    python: [18, 30, 9000, 700],
    java: [70, 50, 38000, 4000],
    javascript: [38, 30, 30000, 4000],
    typescript: [40, 30, 31000, 4000],
    go: [2, 6, 5200, 800],
  };
  const [time, timeSpread, memory, memorySpread] = profile[language] ?? [1, 5, 3300, 400];
  return { timeMs: time + (seed % timeSpread), memoryKb: memory + ((seed >>> 8) % memorySpread) };
}

/** A different, plausible-looking output: what an off-by-one or a flipped condition would print. */
export function perturbOutput(expected: string): string {
  const flips: Record<string, string> = {
    true: 'false',
    false: 'true',
    True: 'False',
    False: 'True',
    YES: 'NO',
    NO: 'YES',
    Yes: 'No',
    No: 'Yes',
    yes: 'no',
    no: 'yes',
  };
  const words = [...expected.matchAll(/\b(?:true|false|True|False|YES|NO|Yes|No|yes|no)\b/g)];
  const lastWord = words[words.length - 1];
  if (lastWord && lastWord.index !== undefined) {
    const at = lastWord.index;
    return expected.slice(0, at) + flips[lastWord[0]]! + expected.slice(at + lastWord[0].length);
  }
  const numbers = [...expected.matchAll(/-?\d+/g)];
  const last = numbers[numbers.length - 1];
  if (last && last.index !== undefined) {
    const value = Number(last[0]);
    const wrong = value === -1 ? 0 : value - 1 < 0 ? value + 1 : value - 1;
    return expected.slice(0, last.index) + String(wrong) + expected.slice(last.index + last[0].length);
  }
  const tokens = expected.split(/\s+/).filter(Boolean);
  if (tokens.length > 1) return tokens.reverse().join(' ') + '\n';
  return '';
}

export function stackTraceFor(language: string): string {
  switch (language) {
    case 'python':
      return [
        'Traceback (most recent call last):',
        '  File "/box/main.py", line 21, in <module>',
        '    solve()',
        '  File "/box/main.py", line 14, in solve',
        '    best = max(best, values[i + 1])',
        'IndexError: list index out of range',
        '',
      ].join('\n');
    case 'java':
      return [
        'Exception in thread "main" java.lang.ArrayIndexOutOfBoundsException: Index 5 out of bounds for length 5',
        '\tat Main.solve(Main.java:17)',
        '\tat Main.main(Main.java:9)',
        '',
      ].join('\n');
    case 'javascript':
    case 'typescript':
      return [
        '/box/main.js:12',
        '  total += values[i + 1].length;',
        '                         ^',
        '',
        "TypeError: Cannot read properties of undefined (reading 'length')",
        '    at solve (/box/main.js:12:26)',
        '    at Object.<anonymous> (/box/main.js:18:1)',
        '',
      ].join('\n');
    case 'go':
      return [
        'panic: runtime error: index out of range [5] with length 5',
        '',
        'goroutine 1 [running]:',
        'main.main()',
        '\t/box/main.go:19 +0x1d4',
        'exit status 2',
        '',
      ].join('\n');
    case 'rust':
      return [
        "thread 'main' panicked at main.rs:14:22:",
        'index out of bounds: the len is 5 but the index is 5',
        'note: run with `RUST_BACKTRACE=1` environment variable to display a backtrace',
        '',
      ].join('\n');
    default:
      return 'Segmentation fault (core dumped)\n';
  }
}

export function compileOutputFor(language: string): string {
  switch (language) {
    case 'python':
      return ['  File "/box/main.py", line 7', '    for i in range(n)', '                     ^', "SyntaxError: expected ':'", ''].join(
        '\n',
      );
    case 'java':
      return ["Main.java:11: error: ';' expected", '        int n = Integer.parseInt(in.readLine())', '                                               ^', '1 error', ''].join(
        '\n',
      );
    case 'javascript':
      return ['/box/main.js:9', '  for (let i = 0; i < n; i++ {', '                             ^', '', "SyntaxError: Unexpected token '{'", ''].join(
        '\n',
      );
    case 'typescript':
      return "main.ts(9,9): error TS2322: Type 'string' is not assignable to type 'number'.\n";
    case 'go':
      return ['# command-line-arguments', './main.go:16:2: declared and not used: total', ''].join('\n');
    case 'rust':
      return [
        'error[E0425]: cannot find value `total` in this scope',
        ' --> main.rs:12:20',
        '   |',
        '12 |     println!("{}", total);',
        '   |                    ^^^^^ not found in this scope',
        '',
        'error: aborting due to 1 previous error',
        '',
      ].join('\n');
    default: {
      const file = language === 'c' ? 'main.c' : 'main.cpp';
      const fn = language === 'c' ? "'main'" : "'int main()'";
      return [
        `${file}: In function ${fn}:`,
        `${file}:14:25: error: expected ';' before 'return'`,
        '   14 |     cout << answer << "\\n"',
        '      |                         ^',
        '      |                         ;',
        '   15 |     return 0;',
        '      |     ~~~~~~',
        '',
      ].join('\n');
    }
  }
}

interface Limits {
  timeLimitMs: number;
  memoryLimitKb: number;
}

/** The failure a behaviour causes on case `index` of `total`, if any. */
/** How long past the time limit the pretend engine lets a program run before stopping it. */
export const TLE_GRACE_MS = 1100;

export function failureFor(
  behaviour: Behaviour,
  index: number,
  total: number,
  language: string,
  limits: Limits,
): { verdict: Verdict; stderr: string; timeMs?: number; memoryKb?: number } | null {
  if (behaviour === 're') return { verdict: 'runtime_error', stderr: stackTraceFor(language) };
  if (index !== total - 1) return null;
  // What an engine reports for a run it had to stop is when it stopped it:
  // the limit plus its grace period, not a measurement of the program.
  if (behaviour === 'tle') return { verdict: 'time_limit_exceeded', stderr: '', timeMs: limits.timeLimitMs + TLE_GRACE_MS };
  if (behaviour === 'mle') return { verdict: 'memory_limit_exceeded', stderr: '', memoryKb: limits.memoryLimitKb };
  return null;
}

export interface CaseSpec {
  testCaseId: string | null;
  name: string;
  isSample: boolean;
  stdin: string;
  /** `null` for a custom-stdin run. */
  expectedStdout: string | null;
}

/** Whether `MOCK:WA` hits this case: the 2nd case and every 3rd after it (or the only case). */
export function wrongAnswerHits(index: number, total: number): boolean {
  return total === 1 || index % 3 === 1;
}

/** The result of one case under a behaviour. */
export function judgeCase(
  spec: CaseSpec,
  index: number,
  total: number,
  behaviour: Behaviour,
  language: string,
  limits: Limits,
  seed: number,
): SubmissionResult {
  const usage = resourceUsage(language, seed + index * 7919);
  const base = {
    testCaseId: spec.testCaseId,
    name: spec.name,
    isSample: spec.isSample,
    stdin: spec.stdin,
    expectedStdout: spec.expectedStdout,
  };
  const failure = failureFor(behaviour, index, total, language, limits);
  if (failure) {
    return {
      ...base,
      verdict: failure.verdict,
      stdout: '',
      stderr: failure.stderr,
      timeMs: failure.timeMs ?? usage.timeMs,
      memoryKb: failure.memoryKb ?? usage.memoryKb,
    };
  }
  if (spec.expectedStdout === null) {
    const lines = spec.stdin === '' ? 0 : spec.stdin.replace(/\n$/, '').split('\n').length;
    const stdout =
      behaviour === 'starter'
        ? ''
        : `(mock judge) the program was not really run; it received ${lines} line(s) of input:\n${spec.stdin}`;
    return { ...base, verdict: 'executed', stdout, stderr: '', ...usage };
  }
  if (behaviour === 'starter') return { ...base, verdict: 'wrong_answer', stdout: '', stderr: '', ...usage };
  if (behaviour === 'wrong' && wrongAnswerHits(index, total)) {
    return { ...base, verdict: 'wrong_answer', stdout: perturbOutput(spec.expectedStdout), stderr: '', ...usage };
  }
  return { ...base, verdict: 'accepted', stdout: spec.expectedStdout, stderr: '', ...usage };
}
