import type { Difficulty, ItemStatus, ItemType, TestOrigin, Verdict } from '../api/types';

export const STATUS_LABEL: Record<ItemStatus, string> = {
  todo: 'To do',
  in_progress: 'In progress',
  done: 'Done',
};

export const DIFFICULTY_LABEL: Record<Difficulty | 'none', string> = {
  easy: 'Easy',
  medium: 'Medium',
  hard: 'Hard',
  none: 'No difficulty',
};

export const VERDICT_LABEL: Record<Verdict, string> = {
  accepted: 'Accepted',
  wrong_answer: 'Wrong answer',
  time_limit_exceeded: 'Time limit exceeded',
  memory_limit_exceeded: 'Memory limit exceeded',
  runtime_error: 'Runtime error',
  compile_error: 'Compile error',
  internal_error: 'Judge error',
  executed: 'Executed',
};

/** Compact labels for dense lists. */
export const VERDICT_BRIEF: Record<Verdict, string> = {
  accepted: 'Accepted',
  wrong_answer: 'Wrong answer',
  time_limit_exceeded: 'Time limit',
  memory_limit_exceeded: 'Memory limit',
  runtime_error: 'Runtime error',
  compile_error: 'Compile error',
  internal_error: 'Judge error',
  executed: 'Executed',
};

export type Tone = 'ok' | 'warn' | 'danger' | 'neutral' | 'accent';

export function verdictTone(v: Verdict): Tone {
  if (v === 'accepted') return 'ok';
  if (v === 'executed') return 'neutral';
  if (v === 'internal_error') return 'warn';
  return 'danger';
}

export function difficultyTone(d: Difficulty): Tone {
  return d === 'easy' ? 'ok' : d === 'medium' ? 'warn' : 'danger';
}

export const ORIGIN_LABEL: Record<TestOrigin, string> = { manual: 'Manual', ai: 'AI', import: 'Imported' };

const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto', style: 'short' });
const dateFmt = new Intl.DateTimeFormat('en', { year: 'numeric', month: 'short', day: 'numeric' });
const dateTimeFmt = new Intl.DateTimeFormat('en', {
  year: 'numeric',
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

/** "3 hr. ago", "yesterday", "2 mo. ago" — or an absolute date once it is over a year old. */
export function relativeTime(iso: string, now: number = Date.now()): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const diff = t - now;
  const abs = Math.abs(diff);
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (abs < 45_000) return 'just now';
  if (abs < hour) return rtf.format(Math.round(diff / minute), 'minute');
  if (abs < day) return rtf.format(Math.round(diff / hour), 'hour');
  if (abs < 30 * day) return rtf.format(Math.round(diff / day), 'day');
  if (abs < 365 * day) return rtf.format(Math.round(diff / (30 * day)), 'month');
  return dateFmt.format(t);
}

export function absoluteTime(iso: string): string {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? '' : dateTimeFmt.format(t);
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${trim(n / 1024)} KB`;
  return `${trim(n / (1024 * 1024))} MB`;
}

export function formatMemoryKb(kb: number): string {
  return kb < 1024 ? `${kb} KB` : `${trim(kb / 1024)} MB`;
}

export function formatMs(ms: number): string {
  return ms < 1000 ? `${ms} ms` : `${trim(ms / 1000)} s`;
}

/**
 * How long a run took, for display. When a program is stopped for exceeding
 * the time limit, the measured time is the moment it was stopped — the limit
 * plus the judge's grace period — which says nothing about how long it would
 * have run. Show it as exceeding the limit instead.
 */
export function formatRunTime(timeMs: number, verdict: Verdict | null, timeLimitMs: number | undefined): string {
  if (timeLimitMs != null && (verdict === 'time_limit_exceeded' || timeMs > timeLimitMs)) return `> ${formatMs(timeLimitMs)}`;
  return formatMs(timeMs);
}

function trim(n: number): string {
  return n >= 100 ? String(Math.round(n)) : n.toFixed(1).replace(/\.0$/, '');
}

export function plural(n: number, one: string, many: string = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * One line about a problem's test cases. While hidden cases are concealed
 * the line says how many there are and how many are shown as examples —
 * "7 test cases · 2 shown as examples" — without implying anything about the
 * rest.
 */
export function describeCases(total: number, samples: number, hiding: boolean): string {
  if (total === 0) return 'No test cases';
  const count = plural(total, 'test case');
  if (!hiding) return `${count} · ${plural(samples, 'sample')}, ${total - samples} hidden`;
  if (samples === 0) return `${count} · none shown as examples`;
  if (samples === total) return `${count} · ${total === 1 ? 'shown as an example' : 'all shown as examples'}`;
  return `${count} · ${samples} shown as ${samples === 1 ? 'an example' : 'examples'}`;
}

/** "Ran 7 test cases — 5 passed": what a finished run or submission covered. */
export function describeRun(mode: 'run' | 'submit', total: number, passed: number): string {
  return `Ran ${plural(total, mode === 'submit' ? 'test case' : 'sample case')} — ${passed === total && total > 1 ? 'all' : passed} passed`;
}

/** Rough reading time for Markdown text, in minutes (at least 1). */
export function readingMinutes(markdown: string): number {
  const words = markdown.trim().split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.round(words / 220));
}

const CHANGE_LABEL: Record<string, string> = {
  type: 'type',
  title: 'title',
  summary: 'summary',
  body: 'text',
  difficulty: 'difficulty',
  tags: 'tags',
  source: 'source',
  variantOf: 'variant link',
  limits: 'time and memory limits',
  compare: 'output comparison',
  starterCode: 'starter code',
  solutions: 'solutions',
  testCases: 'test cases',
};

/** "title, statement and test cases" — the fields in which a bundled item differs from the local one. */
export function describeChanges(changes: readonly string[], type: ItemType): string {
  const names = changes.map((c) => (c === 'body' && type === 'problem' ? 'statement' : (CHANGE_LABEL[c] ?? c)));
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}
