import { describe, expect, it } from 'vitest';
import { describeCases, describeChanges, describeRun, describeUsage, formatBytes, formatDuration, formatMemoryKb, formatMs, formatRunTime, formatTokens, isFailedVerdict, plural, readingMinutes, relativeTime, withUnit } from './format';
import type { Verdict } from '../api/types';

describe('format', () => {
  const now = Date.parse('2026-06-15T12:00:00Z');

  it('formats relative times', () => {
    expect(relativeTime('2026-06-15T11:59:40Z', now)).toBe('just now');
    expect(relativeTime('2026-06-15T09:00:00Z', now)).toMatch(/3 hr/);
    expect(relativeTime('2026-06-14T12:00:00Z', now)).toBe('yesterday');
    expect(relativeTime('2026-04-15T12:00:00Z', now)).toMatch(/2 mo/);
    expect(relativeTime('2024-01-01T00:00:00Z', now)).toMatch(/2024/);
    expect(relativeTime('not a date', now)).toBe('');
  });

  it('formats sizes and durations', () => {
    expect(formatBytes(512)).toBe('512\u00a0B');
    expect(formatBytes(52428800)).toBe('50\u00a0MB');
    expect(formatMemoryKb(262144)).toBe('256\u00a0MB');
    expect(formatMemoryKb(9120)).toBe('8.9\u00a0MB');
    expect(formatMs(48)).toBe('48\u00a0ms');
    expect(formatMs(2000)).toBe('2\u00a0s');
  });

  it('pluralises', () => {
    expect(plural(1, 'case')).toBe('1 case');
    expect(plural(0, 'case')).toBe('0 cases');
    expect(plural(2, 'min', 'min')).toBe('2 min');
  });

  it('estimates reading time with a floor of one minute', () => {
    expect(readingMinutes('')).toBe(1);
    expect(readingMinutes(Array.from({ length: 660 }, () => 'word').join(' '))).toBe(3);
  });
});

describe('formatRunTime', () => {
  it('shows the measured time of a run that finished', () => {
    expect(formatRunTime(48, 'accepted', 2000)).toBe('48\u00a0ms');
    expect(formatRunTime(1500, 'wrong_answer', 2000)).toBe('1.5\u00a0s');
    expect(formatRunTime(2000, 'accepted', 2000)).toBe('2\u00a0s');
  });

  it('shows a time-limit verdict as exceeding the limit, not the time the program was stopped at', () => {
    expect(formatRunTime(3100, 'time_limit_exceeded', 2000)).toBe('> 2\u00a0s');
    expect(formatRunTime(600, 'time_limit_exceeded', 500)).toBe('> 500\u00a0ms');
  });

  it('treats any time over the limit the same way, whatever the overall verdict', () => {
    // The slowest case of a submission can be a time-limit case even when an earlier case decided the verdict.
    expect(formatRunTime(3100, 'wrong_answer', 2000)).toBe('> 2\u00a0s');
    expect(formatRunTime(3100, null, 2000)).toBe('> 2\u00a0s');
  });

  it('falls back to the measured time when the limit is not known', () => {
    expect(formatRunTime(3100, 'time_limit_exceeded', undefined)).toBe('3.1\u00a0s');
  });
});

describe('describeCases', () => {
  it('counts the cases, the samples and the hidden ones', () => {
    expect(describeCases(13, 2)).toBe('13 test cases · 2 samples · 11 hidden');
    expect(describeCases(7, 1)).toBe('7 test cases · 1 sample · 6 hidden');
    expect(describeCases(2, 1)).toBe('2 test cases · 1 sample · 1 hidden');
  });

  it('leaves out a part with nothing in it', () => {
    expect(describeCases(5, 5)).toBe('5 test cases · all samples');
    expect(describeCases(5, 0)).toBe('5 test cases · all hidden');
    expect(describeCases(1, 1)).toBe('1 test case · 1 sample');
    expect(describeCases(1, 0)).toBe('1 test case · 1 hidden');
  });

  it('handles a problem without cases', () => {
    expect(describeCases(0, 0)).toBe('No test cases');
  });
});

describe('describeRun', () => {
  it('counts what ran and what passed', () => {
    expect(describeRun('submit', 7, 5)).toBe('Ran 7 test cases: 5 passed');
    expect(describeRun('submit', 7, 7)).toBe('Ran 7 test cases: all passed');
    expect(describeRun('submit', 1, 1)).toBe('Ran 1 test case: 1 passed');
    expect(describeRun('run', 2, 0)).toBe('Ran 2 sample cases: 0 passed');
  });
});

describe('describeChanges', () => {
  it('describes what differs in an imported item, in the words of its type', () => {
    expect(describeChanges(['title'], 'reading')).toBe('title');
    expect(describeChanges(['body', 'testCases'], 'problem')).toBe('statement and test cases');
    expect(describeChanges(['title', 'body', 'limits', 'somethingNew'], 'reading')).toBe('title, text, time and memory limits and somethingNew');
    expect(describeChanges(['starterCode', 'solutions', 'testCases'], 'problem')).toBe('starter code, solutions and test cases');
  });
});

describe('formatTokens', () => {
  it('keeps small counts whole and shortens the rest', () => {
    expect(formatTokens(0)).toBe('0');
    expect(formatTokens(850)).toBe('850');
    expect(formatTokens(1000)).toBe('1k');
    expect(formatTokens(4380)).toBe('4.4k');
    expect(formatTokens(5210)).toBe('5.2k');
    expect(formatTokens(9960)).toBe('10k');
    expect(formatTokens(61200)).toBe('61k');
    expect(formatTokens(171500)).toBe('172k');
    expect(formatTokens(999_700)).toBe('1M');
    expect(formatTokens(1_240_000)).toBe('1.2M');
  });
});

describe('formatDuration', () => {
  it('rounds to whole seconds from ten up, and counts minutes from sixty', () => {
    expect(formatDuration(380)).toBe('380\u00a0ms');
    expect(formatDuration(5200)).toBe('5.2\u00a0s');
    expect(formatDuration(48200)).toBe('48\u00a0s');
    expect(formatDuration(59600)).toBe('1\u00a0min');
    expect(formatDuration(72400)).toBe('1\u00a0min 12\u00a0s');
  });
});

describe('describeUsage', () => {
  const usage = { logId: null, model: 'claude-haiku-5-5', inputTokens: 5210, outputTokens: 4380, reasoningTokens: null, cacheReadTokens: 0, cacheWriteTokens: 0, durationMs: 48200 };

  it('gives the model, the tokens each way and the time', () => {
    expect(describeUsage(usage)).toBe('claude-haiku-5-5 · 5.2k in · 4.4k out · 48\u00a0s');
  });

  it('leaves out what the provider did not report', () => {
    expect(describeUsage({ ...usage, inputTokens: null, outputTokens: null })).toBe('claude-haiku-5-5 · 48\u00a0s');
    expect(describeUsage({ ...usage, outputTokens: null })).toBe('claude-haiku-5-5 · 5.2k in · 48\u00a0s');
    expect(describeUsage({ ...usage, model: '', inputTokens: null, outputTokens: null, durationMs: 0 })).toBe('');
  });

  it('adds reasoning and cache figures only when there were any', () => {
    expect(describeUsage({ ...usage, reasoningTokens: 1100, cacheReadTokens: 3100 })).toBe('claude-haiku-5-5 · 5.2k in · 4.4k out · 1.1k reasoning · 3.1k cache read · 48\u00a0s');
    expect(describeUsage({ ...usage, reasoningTokens: 0, cacheWriteTokens: 5210 })).toBe('claude-haiku-5-5 · 5.2k in · 4.4k out · 5.2k cache write · 48\u00a0s');
  });
});

describe('withUnit', () => {
  it('rounds a number to a whole one and keeps the unit on the same line', () => {
    expect(withUnit(512, 'ms')).toBe('512\u00a0ms');
    expect(withUnit(2.6, 's')).toBe('3\u00a0s');
    expect(withUnit('1.5', 'MB')).toBe('1.5\u00a0MB');
  });
});

describe('isFailedVerdict', () => {
  it('is true for every verdict that says the code failed, and only for those', () => {
    const failed: Verdict[] = ['wrong_answer', 'time_limit_exceeded', 'memory_limit_exceeded', 'runtime_error', 'compile_error', 'internal_error'];
    for (const v of failed) expect(isFailedVerdict(v)).toBe(true);
    expect(isFailedVerdict('accepted')).toBe(false);
    expect(isFailedVerdict('executed')).toBe(false);
  });
});
