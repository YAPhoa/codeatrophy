// What running a solution found, in a line: the check that comes with an AI
// draft, and a saved solution tested against a problem's test cases. Neither
// says anything about the solution's code, which stays out of sight.

import type { DraftCheck, LargeCaseReport, RunnerCheck, TestCase, Verdict, VerifyResult } from '../api/types';
import { sentence } from './errors';
import { formatBytes, formatMs, formatRunTime, plural, type Tone } from './format';

export interface CheckLine {
  tone: Tone;
  text: string;
}

/**
 * The check of a draft's reference solution on its test cases. `stale` says
 * the form was edited since, so the numbers no longer describe it.
 */
export function describeDraftCheck(check: DraftCheck | null, stale = false): CheckLine {
  if (!check || (!check.attempted && !check.error)) return { tone: 'neutral', text: 'Not checked' };
  // Not the solution's doing: the engine could not be used.
  if (!check.attempted && check.error) return { tone: 'warn', text: `Not checked. ${sentence(check.error)}` };
  if (stale) return { tone: 'neutral', text: 'Checked before your edits' };
  const count = `${check.passed} of ${plural(check.total, 'test case')}`;
  if (check.error) {
    const partial = check.passed > 0 && check.passed < check.total;
    return { tone: 'danger', text: partial ? `Passes ${count}. ${sentence(check.error)}` : sentence(check.error) };
  }
  return { tone: check.passed === check.total ? 'ok' : 'danger', text: `Passes ${count}` };
}

/**
 * What the check found out about each language's runner, by language. Runners
 * that were not tried are left out, and so is everything once the form has
 * been edited.
 */
export function runnerChecks(check: DraftCheck | null, stale = false): ReadonlyMap<string, RunnerCheck> {
  const tried = stale ? [] : (check?.runners ?? []).filter((r) => r.status !== 'skipped');
  return new Map(tried.map((r) => [r.language, r]));
}

/**
 * What became of one large test case of a generation. When it was added, its
 * name and size, and the reference solution's time against the time limit —
 * a warning once that is more than half of it.
 */
export function describeLargeCase(report: LargeCaseReport, timeLimitMs?: number): CheckLine {
  const named = report.name ? `Large case “${report.name}”` : 'Large case';
  if (report.status !== 'added') {
    return { tone: report.status === 'failed' ? 'warn' : 'neutral', text: report.error ? `${named} not added. ${sentence(report.error)}` : `${named} not added` };
  }
  const parts = [`${named} added`];
  if (report.inputBytes != null) parts.push(formatBytes(report.inputBytes));
  if (report.timeMs != null) parts.push(`reference solution ${formatMs(report.timeMs)}${timeLimitMs ? ` of ${formatMs(timeLimitMs)}` : ''}`);
  const slow = report.timeMs != null && timeLimitMs != null && report.timeMs > timeLimitMs / 2;
  return { tone: slow ? 'warn' : 'ok', text: parts.join(' · ') };
}

/** The large cases of a generation in a line, from each one's line: how many were generated, of how many asked for. */
export function summariseLargeCases(reports: readonly LargeCaseReport[], lines: readonly CheckLine[]): CheckLine {
  const added = reports.filter((r) => r.status === 'added').length;
  const tone = lines.some((l) => l.tone === 'warn') ? 'warn' : added === reports.length ? 'ok' : 'neutral';
  return { tone, text: added === reports.length ? `${plural(added, 'large case')} generated` : `${added} of ${plural(reports.length, 'large case')} generated` };
}

const FAILURE: Record<Verdict, string> = {
  accepted: 'printed a different output',
  executed: 'printed a different output',
  wrong_answer: 'printed a different output',
  time_limit_exceeded: 'ran out of time',
  memory_limit_exceeded: 'ran out of memory',
  runtime_error: 'crashed',
  compile_error: 'did not compile',
  internal_error: 'could not be run by the judge',
};

export interface VerifySummary {
  passed: number;
  total: number;
  /** The slowest case, formatted, or `null` when nothing ran. */
  slowest: string | null;
  /** The first case that did not pass, in a sentence, or `null` when all passed. */
  failure: string | null;
}

/**
 * Sum up a run of a saved solution against the test cases. With `hiding`,
 * a case that is not a sample goes by its number only, as in submission
 * results: its name can give its content away.
 */
export function summariseVerify(
  results: readonly VerifyResult[],
  cases: readonly Pick<TestCase, 'id' | 'name' | 'isSample'>[],
  hiding: boolean,
  timeLimitMs?: number,
): VerifySummary {
  const good = (r: VerifyResult) => r.ok && r.matches;
  const failedAt = results.findIndex((r) => !good(r));
  let failure: string | null = null;
  if (failedAt !== -1) {
    const result = results[failedAt]!;
    const reason = FAILURE[result.verdict];
    if (result.verdict === 'compile_error') failure = 'It did not compile.';
    else {
      const at = cases.findIndex((c) => c.id === result.testCaseId);
      const testCase = cases[at];
      const shown = testCase !== undefined && testCase.name !== '' && (testCase.isSample || !hiding);
      failure = `Case ${(at === -1 ? failedAt : at) + 1}${shown ? ` (${testCase.name})` : ''} ${reason}.`;
    }
  }
  const slowest = results.reduce<VerifyResult | null>((max, r) => (max === null || (r.timeMs ?? 0) > (max.timeMs ?? 0) ? r : max), null);
  return {
    passed: results.filter(good).length,
    total: results.length,
    // A compile error or an engine failure measures nothing.
    slowest: slowest?.timeMs ? formatRunTime(slowest.timeMs, slowest.verdict, timeLimitMs) : null,
    failure,
  };
}
