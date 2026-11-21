// How past submissions are presented and reopened on the solve page.

import type { SubmissionSummary } from '../api/types';
import { formatMemoryKb, formatRunTime } from './format';

/** What a submission measured, as the history and the details show it; `null` for a figure not shown. */
export interface SubmissionFigures {
  /** "7/8". */
  passed: string | null;
  runtime: string | null;
  memory: string | null;
}

/**
 * The figures of a submission. Compile and judge errors (and one still being
 * judged) have no meaningful count, time or memory; a program only executed
 * has no count; memory goes with a measured time.
 */
export function submissionFigures(s: Pick<SubmissionSummary, 'verdict' | 'passedCount' | 'totalCount' | 'timeMs' | 'memoryKb'>, timeLimitMs: number): SubmissionFigures {
  const measured = s.verdict !== null && s.verdict !== 'compile_error' && s.verdict !== 'internal_error';
  return {
    passed: measured && s.verdict !== 'executed' && s.totalCount > 0 ? `${s.passedCount}/${s.totalCount}` : null,
    runtime: measured && s.timeMs != null ? formatRunTime(s.timeMs, s.verdict, timeLimitMs) : null,
    memory: measured && s.timeMs != null && s.memoryKb != null ? formatMemoryKb(s.memoryKb) : null,
  };
}

/**
 * Whether opening code in the editor must ask first: only when the language
 * has work of its own there (`current`, what the editor would show for it)
 * that is not empty, not its starter code, and not the very code being
 * opened.
 */
export function replaceNeedsConfirm(current: string | null | undefined, starter: string | undefined, incoming: string): boolean {
  if (current == null || current.trim() === '') return false;
  return current !== (starter ?? '') && current !== incoming;
}

/** The address of a past submission's details on its problem's page. */
export function submissionHref(itemId: string, submissionId: string): string {
  return `/items/${encodeURIComponent(itemId)}?tab=submissions&submission=${encodeURIComponent(submissionId)}`;
}
