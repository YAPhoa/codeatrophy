// The large test cases of a generation (docs/api.md, "Large test cases"). A
// real server runs the generator programs the model wrote and then the
// reference solution on what each printed; the mock prints believable inputs
// of a few hundred kilobytes itself, one shape per case asked for, the same
// every time. A test case saved with one of those generators "runs" it again
// (`runGenerator`): the program names its shape and seed, which is all the
// mock needs to print the same input.

import type { LargeCaseReport, ProblemInterface, SourceCode } from '../api/types';
import type { MockDb } from './db';
import { byteLength } from './db';
import { hash32 } from './util';

/** In the input text or instruction: every generator crashes and no large case is added. */
export const LARGE_FAIL_MARKER = 'MOCK:LARGE-FAIL';
/** In the input text or instruction: the large cases are skipped, as when the check's time runs out. */
export const LARGE_SKIP_MARKER = 'MOCK:LARGE-SKIP';
/** In the input text or instruction: the model wrote one generator fewer than asked for, so the last case is not added. */
export const LARGE_SHORT_MARKER = 'MOCK:LARGE-SHORT';

const COUNT = 30_000;
const BOUND = 1_000_000_000;

/** A pseudo-random value in [0, 1) at each call; a small linear congruential generator, as Python's is not reproduced. */
function lcg(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

const between = (next: () => number, low: number, high: number) => low + Math.floor(next() * (high - low + 1));

/**
 * What a generator prints, one per large case asked for and each a different
 * way for a slow solution to fail: the name the model gives it, the values,
 * and the Python line that builds them.
 */
interface Shape {
  name: string;
  values: (seed: number) => number[];
  python: string;
}

const SHAPES: readonly Shape[] = [
  {
    name: `${COUNT.toLocaleString('en')} values across the full range`,
    values: (seed) => {
      const next = lcg(seed);
      return Array.from({ length: COUNT }, () => between(next, -BOUND, BOUND));
    },
    python: `values = [random.randint(-${BOUND}, ${BOUND}) for _ in range(n)]`,
  },
  {
    name: `${COUNT.toLocaleString('en')} values in descending order`,
    values: (seed) => {
      const next = lcg(seed);
      return Array.from({ length: COUNT }, () => between(next, -BOUND, BOUND)).sort((a, b) => b - a);
    },
    python: `values = sorted((random.randint(-${BOUND}, ${BOUND}) for _ in range(n)), reverse=True)`,
  },
  {
    name: `${COUNT.toLocaleString('en')} copies of the largest value`,
    values: () => Array.from({ length: COUNT }, () => BOUND),
    python: `values = [${BOUND}] * n`,
  },
  {
    name: `${COUNT.toLocaleString('en')} values alternating between the extremes`,
    values: () => Array.from({ length: COUNT }, (_, i) => (i % 2 === 0 ? BOUND : -BOUND)),
    python: `values = [${BOUND} if i % 2 == 0 else -${BOUND} for i in range(n)]`,
  },
  {
    name: `${COUNT.toLocaleString('en')} negative values`,
    values: (seed) => {
      const next = lcg(seed);
      return Array.from({ length: COUNT }, () => between(next, -BOUND, -1));
    },
    python: `values = [random.randint(-${BOUND}, -1) for _ in range(n)]`,
  },
];

/** What the model wrote for one shape; deterministic, and within what Python 3.8 runs. `seed` also decides the values the mock prints. */
function generatorFor(shape: Shape, face: ProblemInterface, seed: number): SourceCode {
  const print =
    face === 'function'
      ? [FUNCTION_PRINT]
      : ['print(n)', 'print(" ".join(map(str, values)))'];
  return {
    language: 'python',
    source: [
      'import random',
      '',
      '# A fixed seed: the same input on every run.',
      `random.seed(${seed})`,
      `n = ${COUNT}`,
      shape.python,
      ...print,
      '',
    ].join('\n'),
  };
}

const FUNCTION_PRINT = 'print("[" + ",".join(map(str, values)) + "]")';

/** The input a generator prints, as one of the shapes lays it out. */
const inputOf = (values: readonly number[], face: ProblemInterface): string =>
  face === 'function' ? `${JSON.stringify(values)}\n` : `${values.length}\n${values.join(' ')}\n`;

/**
 * What a generator prints, for one the mock wrote: the shape and seed are
 * read back from its source. `null` for any other program, which the mock
 * cannot run.
 */
export function runGenerator(generator: SourceCode): string | null {
  const seed = /random\.seed\((\d+)\)/.exec(generator.source);
  const shape = SHAPES.find((s) => generator.source.includes(s.python));
  if (generator.language !== 'python' || !seed || !shape) return null;
  return inputOf(shape.values(Number(seed[1])), generator.source.includes(FUNCTION_PRINT) ? 'function' : 'program');
}

function maxSubarray(list: readonly number[]): number {
  let best = list[0] ?? 0;
  let running = 0;
  for (const v of list) {
    running = Math.max(v, running + v);
    best = Math.max(best, running);
  }
  return best;
}

export interface LargeCase {
  report: LargeCaseReport;
  /** The case to append, when it was added. */
  stdin: string | null;
  expectedStdout: string | null;
}

export interface LargeCaseRequest {
  /** How many large cases were asked for, 1 or more. */
  count: number;
  /** What the problem is about, for the seed; any text that tells problems apart. */
  title: string;
  face: ProblemInterface;
  timeLimitMs: number;
  referenceSolution: SourceCode | null;
  /** Inputs the cases must not repeat. */
  existing: readonly string[];
  /** Where the first case will go if it is added; the others follow it. */
  index: number;
  /** Why the large cases are not tried, as the check found out; `null` if they are. */
  blocked: string | null;
  /** The texts of the request, to look for the markers in. */
  texts: readonly (string | null)[];
  /** In a draft the large cases run within the check's time bound. */
  operation: 'draft' | 'testcases';
}

const asked = (marker: string, texts: readonly (string | null)[]) => texts.some((t) => t?.includes(marker));

/** Build the large cases of one generation, one entry per case asked for, each added or saying why not. */
export function buildLargeCases(db: MockDb, req: LargeCaseRequest): LargeCase[] {
  const short = asked(LARGE_SHORT_MARKER, req.texts);
  const seen = [...req.existing];
  let added = 0;
  return Array.from({ length: req.count }, (_, i): LargeCase => {
    const none = (status: 'failed' | 'skipped', error: string, extra: Partial<LargeCaseReport> = {}): LargeCase => ({
      report: { status, error, index: null, name: null, inputBytes: null, timeMs: null, generator: null, ...extra },
      stdin: null,
      expectedStdout: null,
    });
    if (short && i === req.count - 1) return none('failed', 'the model wrote fewer generators than asked for');
    const shape = SHAPES[i % SHAPES.length]!;
    const seed = hash32(`${req.title}#${i}`);
    const written = { name: shape.name, generator: generatorFor(shape, req.face, seed) };
    const judge = db.options.judge;
    if (judge === 'none') return none('skipped', 'there is no judge engine', written);
    if (judge === 'down') return none('skipped', 'the judge engine could not be reached', written);
    if (!req.referenceSolution) return none('skipped', 'there is no reference solution', written);
    if (asked(LARGE_SKIP_MARKER, req.texts)) {
      return none('skipped', req.operation === 'draft' ? 'the check ran out of time before the large cases' : 'the judge engine stopped responding before the large cases', written);
    }
    if (asked(LARGE_FAIL_MARKER, req.texts)) {
      return none('failed', 'the generator crashed: IndexError: list index out of range (line 6)', written);
    }
    if (req.blocked) return none('skipped', req.blocked, written);

    const list = shape.values(seed);
    const stdin = inputOf(list, req.face);
    if (seen.includes(stdin)) return none('failed', 'the generated input repeats an existing case', written);
    seen.push(stdin);
    const inputBytes = byteLength(stdin);
    // A believable running time, well inside the limit.
    const timeMs = Math.min(req.timeLimitMs - 1, 120 + (hash32(stdin.slice(0, 64) + i) % 160));
    return {
      report: { status: 'added', error: null, index: req.index + added++, name: shape.name, inputBytes, timeMs, generator: written.generator },
      stdin,
      expectedStdout: `${maxSubarray(list)}\n`,
    };
  });
}

/** Whether a test case's data is large enough that a prompt names it by its size only. */
export const largeForPrompt = (text: string): boolean => text.length > 4096;

/** A test case as a prompt lists it: its input, or its name and size when that is large. */
export function promptCase(c: { name: string; stdin: string; expectedStdout: string }): string {
  if (!largeForPrompt(c.stdin) && !largeForPrompt(c.expectedStdout)) return c.stdin.trimEnd();
  return `(${c.name || 'a case'}: ${byteLength(c.stdin)} bytes of input, ${byteLength(c.expectedStdout)} bytes of output, not shown)`;
}
