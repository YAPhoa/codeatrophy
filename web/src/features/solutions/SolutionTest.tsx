import { useCallback, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Check, FlaskConical, X } from 'lucide-react';
import { api } from '../../api/client';
import { qk, useMeta, usePreferences, useTestCases } from '../../api/queries';
import type { Item, VerifyResult } from '../../api/types';
import { summariseVerify } from '../../lib/checks';
import { errorLine } from '../../lib/errors';
import { plural } from '../../lib/format';
import { languageName } from '../../lib/languages';
import { Button } from '../../ui/Button';
import { Spinner } from '../../ui/misc';

type TestState = { status: 'idle' } | { status: 'running' } | { status: 'done'; results: VerifyResult[] } | { status: 'failed'; error: unknown };

export interface SolutionTest {
  state: TestState;
  run: () => void;
  /** Why the solution cannot be run here, or `null` when it can. */
  blocked: string | null;
}

/**
 * Run one of a problem's saved solutions on its test cases and report how it
 * went, without showing its code. With the reference solution the run also
 * refreshes the cases' "verified" marks; with any other it only checks.
 */
export function useSolutionTest(item: Item, solution: { id?: string; language: string; isReference: boolean }): SolutionTest {
  const qc = useQueryClient();
  const judge = useMeta().data?.judge;
  const [state, setState] = useState<TestState>({ status: 'idle' });
  const { id, isReference } = solution;

  const run = useCallback(() => {
    setState({ status: 'running' });
    api.testCases.verify(item.id, false, isReference ? null : (id ?? null)).then(
      ({ results }) => {
        setState({ status: 'done', results });
        if (isReference) void qc.invalidateQueries({ queryKey: qk.testCases(item.id) });
      },
      (error: unknown) => setState({ status: 'failed', error }),
    );
  }, [qc, item.id, id, isReference]);

  const needsRunner = item.problem?.interface === 'function' && !(solution.language in (item.problem.harness ?? {}));
  const blocked = !judge?.enabled
    ? 'No judge engine to run it on'
    : item.testCaseCount === 0
      ? 'No test cases to run it on'
      : needsRunner
        ? `This problem has no runner for ${languageName(solution.language)}`
        : null;
  return { state, run, blocked };
}

export function TestButton({ test, label = 'Run tests' }: { test: SolutionTest; label?: string }) {
  return (
    <Button size="sm" icon={<FlaskConical size={14} />} onClick={test.run} busy={test.state.status === 'running'} disabled={test.blocked !== null} title={test.blocked ?? 'Run it on the test cases'}>
      {label}
    </Button>
  );
}

/** How the last test of a solution went, in a line. Says nothing of the code, and of a hidden case only its number. */
export function TestOutcome({ item, test, className }: { item: Item; test: SolutionTest; className?: string }) {
  const cases = useTestCases(item.id).data ?? [];
  const hiding = usePreferences().hideTestCases;
  const { state } = test;
  if (state.status === 'idle') return null;
  const cls = `check-line${className ? ` ${className}` : ''}`;
  if (state.status === 'running') {
    return (
      <p className={`${cls} tone-neutral`} role="status">
        <Spinner size={12} /> Running on {plural(item.testCaseCount, 'test case')}…
      </p>
    );
  }
  if (state.status === 'failed') {
    return (
      <p className={`${cls} tone-danger`} role="alert">
        {errorLine(state.error)}
      </p>
    );
  }
  const summary = summariseVerify(state.results, cases, hiding, item.problem?.timeLimitMs);
  const passed = summary.total > 0 && summary.passed === summary.total;
  return (
    <p className={`${cls} tone-${passed ? 'ok' : 'danger'}`} role="status">
      {passed ? <Check size={14} aria-hidden="true" /> : <X size={14} aria-hidden="true" />}
      <span>
        Passes {summary.passed} of {plural(summary.total, 'test case')}
        {summary.failure ? `. ${summary.failure}` : ''}
        {summary.slowest && <span className="check-aside"> · slowest {summary.slowest}</span>}
      </span>
    </p>
  );
}
