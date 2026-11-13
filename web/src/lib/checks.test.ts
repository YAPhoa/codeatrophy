import { describe, expect, it } from 'vitest';
import type { DraftCheck, VerifyResult } from '../api/types';
import { describeDraftCheck, runnerChecks, summariseVerify } from './checks';

const check = (change: Partial<DraftCheck> = {}): DraftCheck => ({ attempted: true, engine: 'judge0', passed: 2, total: 2, error: null, runners: [], ...change });

describe('describeDraftCheck', () => {
  it('says how many test cases the solution passes', () => {
    expect(describeDraftCheck(check())).toEqual({ tone: 'ok', text: 'Passes 2 of 2 test cases' });
    expect(describeDraftCheck(check({ passed: 1, total: 1 }))).toEqual({ tone: 'ok', text: 'Passes 1 of 1 test case' });
  });

  it('gives the failure in a sentence, with the count when some passed', () => {
    expect(describeDraftCheck(check({ passed: 1, error: 'Example 2: expected 3, but the reference solution printed 4' }))).toEqual({
      tone: 'danger',
      text: 'Passes 1 of 2 test cases. Example 2: expected 3, but the reference solution printed 4.',
    });
    expect(describeDraftCheck(check({ passed: 0, error: 'the reference solution did not compile' }))).toEqual({ tone: 'danger', text: 'The reference solution did not compile.' });
    expect(describeDraftCheck(check({ passed: 1 })).tone).toBe('danger');
  });

  it('says so when nothing was checked', () => {
    expect(describeDraftCheck(null).text).toBe('Not checked');
    expect(describeDraftCheck(check({ attempted: false, engine: null, passed: 0 })).text).toBe('Not checked');
    // An engine that could not be reached is reported as the reason.
    expect(describeDraftCheck(check({ attempted: false, passed: 0, error: 'judge engine unreachable' }))).toEqual({ tone: 'warn', text: 'Not checked. Judge engine unreachable.' });
  });

  it('does not repeat a check the form has moved on from', () => {
    expect(describeDraftCheck(check(), true)).toEqual({ tone: 'neutral', text: 'Checked before your edits' });
    expect(describeDraftCheck(null, true).text).toBe('Not checked');
  });
});

describe('runnerChecks', () => {
  const runners: DraftCheck['runners'] = [
    { language: 'go', status: 'failed', error: 'the go harness did not compile' },
    { language: 'java', status: 'skipped', error: null },
    { language: 'python', status: 'ok', error: null },
  ];

  it('gives what was found out by language, without the runners that were not tried', () => {
    const found = runnerChecks(check({ runners }));
    expect([...found.keys()]).toEqual(['go', 'python']);
    expect(found.get('go')).toMatchObject({ status: 'failed', error: 'the go harness did not compile' });
    expect(found.get('python')?.status).toBe('ok');
  });

  it('says nothing after an edit, without a check, or for a server that sends no runners', () => {
    expect(runnerChecks(check({ runners }), true).size).toBe(0);
    expect(runnerChecks(null).size).toBe(0);
    const { runners: _runners, ...older } = check();
    expect(runnerChecks(older as DraftCheck).size).toBe(0);
  });
});

describe('summariseVerify', () => {
  const cases = [
    { id: 'a', name: 'Example 1', isSample: true },
    { id: 'b', name: 'Example 2', isSample: true },
    { id: 'c', name: 'All negative', isSample: false },
  ];
  const result = (testCaseId: string, change: Partial<VerifyResult> = {}): VerifyResult => ({ testCaseId, ok: true, matches: true, actualStdout: '', verdict: 'executed', stderr: '', timeMs: 20, ...change });

  it('counts the cases that passed and finds the slowest', () => {
    const summary = summariseVerify([result('a'), result('b', { timeMs: 41 }), result('c')], cases, true);
    expect(summary).toEqual({ passed: 3, total: 3, slowest: '41 ms', failure: null });
  });

  it('names the first case that did not pass', () => {
    const results = [result('a'), result('b', { matches: false }), result('c', { ok: false, matches: false, verdict: 'runtime_error' })];
    expect(summariseVerify(results, cases, true)).toMatchObject({ passed: 1, total: 3, failure: 'Case 2 (Example 2) printed a different output.' });
  });

  it('gives a hidden case by its number only while test cases are hidden', () => {
    const results = [result('a'), result('b'), result('c', { ok: false, matches: false, verdict: 'runtime_error', stderr: 'Traceback…' })];
    expect(summariseVerify(results, cases, true).failure).toBe('Case 3 crashed.');
    expect(summariseVerify(results, cases, false).failure).toBe('Case 3 (All negative) crashed.');
  });

  it('never quotes error output, which can contain the code', () => {
    const results = cases.map((c) => result(c.id, { ok: false, matches: false, verdict: 'compile_error', stderr: 'main.py:3: secret = 42', timeMs: 0 }));
    const summary = summariseVerify(results, cases, false);
    expect(summary).toEqual({ passed: 0, total: 3, slowest: null, failure: 'It did not compile.' });
  });

  it('shows a run stopped at the time limit as exceeding it', () => {
    const results = [result('a'), result('b', { ok: false, matches: false, verdict: 'time_limit_exceeded', timeMs: 3100 })];
    expect(summariseVerify(results, cases, true, 2000)).toMatchObject({ slowest: '> 2 s', failure: 'Case 2 (Example 2) ran out of time.' });
  });

  it('has nothing to say about a problem without test cases', () => {
    expect(summariseVerify([], [], true)).toEqual({ passed: 0, total: 0, slowest: null, failure: null });
  });
});
