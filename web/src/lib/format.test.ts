import { describe, expect, it } from 'vitest';
import { describeCases, describeChanges, describeRun, describeUsage, formatDuration, formatRunTime, formatTokens, isFailedVerdict, sameDay, withUnit } from './format';
import type { Verdict } from '../api/types';

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
  it('says how many cases there are and how many are examples while the rest are concealed', () => {
    expect(describeCases(7, 2, true)).toBe('7 test cases · 2 shown as examples');
    expect(describeCases(7, 1, true)).toBe('7 test cases · 1 shown as an example');
    expect(describeCases(5, 0, true)).toBe('5 test cases · none shown as examples');
    expect(describeCases(2, 2, true)).toBe('2 test cases · all shown as examples');
    expect(describeCases(1, 1, true)).toBe('1 test case · shown as an example');
  });

  it('splits samples and hidden cases when nothing is concealed', () => {
    expect(describeCases(7, 2, false)).toBe('7 test cases · 2 samples, 5 hidden');
    expect(describeCases(1, 1, false)).toBe('1 test case · 1 sample, 0 hidden');
  });

  it('handles a problem without cases', () => {
    expect(describeCases(0, 0, true)).toBe('No test cases');
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
  it('names saved solutions', () => {
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
  it('groups digits and keeps the unit on the same line', () => {
    expect(withUnit(10000, 'ms')).toBe(`${(10000).toLocaleString()}\u00a0ms`);
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

describe('sameDay', () => {
  it('compares local calendar days, not 24-hour spans', () => {
    const at = (h: number, d = 18) => new Date(2026, 10, d, h, 30).toISOString();
    expect(sameDay(at(0), at(23))).toBe(true);
    expect(sameDay(at(23), at(0, 19))).toBe(false);
    expect(sameDay(at(12), at(12, 17))).toBe(false);
  });
});
