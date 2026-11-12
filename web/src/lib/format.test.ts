import { describe, expect, it } from 'vitest';
import { describeCases, describeChanges, describeRun, formatRunTime } from './format';

describe('formatRunTime', () => {
  it('shows the measured time of a run that finished', () => {
    expect(formatRunTime(48, 'accepted', 2000)).toBe('48 ms');
    expect(formatRunTime(1500, 'wrong_answer', 2000)).toBe('1.5 s');
    expect(formatRunTime(2000, 'accepted', 2000)).toBe('2 s');
  });

  it('shows a time-limit verdict as exceeding the limit, not the time the program was stopped at', () => {
    expect(formatRunTime(3100, 'time_limit_exceeded', 2000)).toBe('> 2 s');
    expect(formatRunTime(600, 'time_limit_exceeded', 500)).toBe('> 500 ms');
  });

  it('treats any time over the limit the same way, whatever the overall verdict', () => {
    // The slowest case of a submission can be a time-limit case even when an earlier case decided the verdict.
    expect(formatRunTime(3100, 'wrong_answer', 2000)).toBe('> 2 s');
    expect(formatRunTime(3100, null, 2000)).toBe('> 2 s');
  });

  it('falls back to the measured time when the limit is not known', () => {
    expect(formatRunTime(3100, 'time_limit_exceeded', undefined)).toBe('3.1 s');
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
    expect(describeRun('submit', 7, 5)).toBe('Ran 7 test cases — 5 passed');
    expect(describeRun('submit', 7, 7)).toBe('Ran 7 test cases — all passed');
    expect(describeRun('submit', 1, 1)).toBe('Ran 1 test case — 1 passed');
    expect(describeRun('run', 2, 0)).toBe('Ran 2 sample cases — 0 passed');
  });
});

describe('describeChanges', () => {
  it('names saved solutions', () => {
    expect(describeChanges(['starterCode', 'solutions', 'testCases'], 'problem')).toBe('starter code, solutions and test cases');
  });
});
