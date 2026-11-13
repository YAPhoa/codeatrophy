// The large test case of a generation (docs/api.md, "Large test case"). A
// real server runs a generator program the model wrote and then the
// reference solution on what it printed; the mock prints a believable input
// of a few hundred kilobytes itself, the same one every time.

import type { LargeCaseReport, ProblemInterface, SourceCode } from '../api/types';
import type { MockDb } from './db';
import { byteLength } from './db';
import { hash32 } from './util';

/** In the input text or instruction: the generator crashes and no large case is added. */
export const LARGE_FAIL_MARKER = 'MOCK:LARGE-FAIL';
/** In the input text or instruction: the large case is skipped, as when the check's time runs out. */
export const LARGE_SKIP_MARKER = 'MOCK:LARGE-SKIP';

const COUNT = 30_000;
const BOUND = 1_000_000_000;

/** What the model wrote; deterministic, and within what Python 3.8 runs. */
function generatorFor(face: ProblemInterface): SourceCode {
  const print =
    face === 'function'
      ? ['print("[" + ",".join(map(str, values)) + "]")']
      : ['print(n)', 'print(" ".join(map(str, values)))'];
  return {
    language: 'python',
    source: [
      'import random',
      '',
      '# A fixed seed: the same input on every run.',
      'random.seed(20240611)',
      `n = ${COUNT}`,
      `values = [random.randint(-${BOUND}, ${BOUND}) for _ in range(n)]`,
      ...print,
      '',
    ].join('\n'),
  };
}

function values(seed: number): number[] {
  // A small linear congruential generator; Python's is not reproduced.
  let state = seed >>> 0 || 1;
  const out: number[] = [];
  for (let i = 0; i < COUNT; i++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    out.push(Math.floor((state / 0x1_0000_0000) * (2 * BOUND + 1)) - BOUND);
  }
  return out;
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
  /** What the problem is about, for the seed; any text that tells problems apart. */
  title: string;
  face: ProblemInterface;
  timeLimitMs: number;
  referenceSolution: SourceCode | null;
  /** Inputs the case must not repeat. */
  existing: readonly string[];
  /** Where the case will go if it is added. */
  index: number;
  /** Why the reference solution cannot be run at all, as the check found out; `null` if it can. */
  blocked: string | null;
  /** The texts of the request, to look for the markers in. */
  texts: readonly (string | null)[];
  /** In a draft the large case runs within the check's time bound. */
  operation: 'draft' | 'testcases';
}

const asked = (marker: string, texts: readonly (string | null)[]) => texts.some((t) => t?.includes(marker));

/** Build the large case of one generation, or say why there is none. */
export function buildLargeCase(db: MockDb, req: LargeCaseRequest): LargeCase {
  const generator = generatorFor(req.face);
  const none = (status: 'failed' | 'skipped', error: string, extra: Partial<LargeCaseReport> = {}): LargeCase => ({
    report: { status, error, index: null, name: null, inputBytes: null, timeMs: null, generator, ...extra },
    stdin: null,
    expectedStdout: null,
  });
  const judge = db.options.judge;
  if (judge === 'none') return none('skipped', 'there is no judge engine');
  if (judge === 'down') return none('skipped', 'the judge engine could not be reached');
  if (!req.referenceSolution) return none('skipped', 'there is no reference solution');
  if (asked(LARGE_SKIP_MARKER, req.texts)) {
    return none('skipped', req.operation === 'draft' ? 'the check ran out of time before the large case' : 'the judge engine stopped responding before the large case');
  }
  if (asked(LARGE_FAIL_MARKER, req.texts)) {
    return none('failed', 'the generator crashed: IndexError: list index out of range (line 6)');
  }
  if (req.blocked) return none('failed', req.blocked);

  const list = values(hash32(req.title));
  const stdin = req.face === 'function' ? `${JSON.stringify(list)}\n` : `${COUNT}\n${list.join(' ')}\n`;
  if (req.existing.includes(stdin)) return none('failed', 'the generated input repeats an existing case');
  const inputBytes = byteLength(stdin);
  // A believable running time, well inside the limit.
  const timeMs = Math.min(req.timeLimitMs - 1, 120 + (hash32(stdin.slice(0, 64)) % 160));
  return {
    report: { status: 'added', error: null, index: req.index, name: `${COUNT.toLocaleString('en')} values across the full range`, inputBytes, timeMs, generator },
    stdin,
    expectedStdout: `${maxSubarray(list)}\n`,
  };
}

/** Whether a test case's data is large enough that a prompt names it by its size only. */
export const largeForPrompt = (text: string): boolean => text.length > 4096;

/** A test case as a prompt lists it: its input, or its name and size when that is large. */
export function promptCase(c: { name: string; stdin: string; expectedStdout: string }): string {
  if (!largeForPrompt(c.stdin) && !largeForPrompt(c.expectedStdout)) return c.stdin.trimEnd();
  return `(${c.name || 'a case'}: ${byteLength(c.stdin)} bytes of input, ${byteLength(c.expectedStdout)} bytes of output, not shown)`;
}
