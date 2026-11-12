// Test case endpoints, including verification against the reference solution.

import type { SourceCode, TestCase, TestCaseInput, VerifyResult } from '../../api/types';
import type { MockDb, StoredItem } from '../db';
import { LIMITS, normaliseText, outputsMatch } from '../db';
import type { Handler, Req } from '../http';
import {
  created,
  invalid,
  isRecord,
  isStringArray,
  judgeUnavailable,
  noContent,
  notFound,
  objectBody,
  ok,
  Validator,
} from '../http';
import { detectBehaviour, failureFor, resourceUsage } from '../judge';
import { hash32, isLanguage, sleep } from '../util';
import { checkRevision, insertTestCase, parseTestCaseInput, tooManyCases } from './items';

/** The item behind a test case route; test cases only exist on problems. */
function problemOf(db: MockDb, id: string): StoredItem {
  const item = db.getItem(id);
  if (item.type !== 'problem') throw invalid('item', 'is a reading; only problems have test cases');
  return item;
}

function getCase(db: MockDb, id: string): TestCase {
  const tc = db.testCases.find((c) => c.id === id);
  if (!tc) throw notFound('test case');
  return tc;
}

function createCase(db: MockDb, req: Req) {
  const item = problemOf(db, req.params.id!);
  const v = new Validator();
  const input = parseTestCaseInput(objectBody(req), v);
  if (db.casesOf(item.id).length >= LIMITS.maxTestCasesPerItem) v.add('testCases', tooManyCases);
  v.check();
  const tc = insertTestCase(db, item.id, input);
  db.touchCases(item);
  return created({ ...tc });
}

function bulkCases(db: MockDb, req: Req) {
  const item = problemOf(db, req.params.id!);
  const raw = objectBody(req);
  // Checked first, as for `PATCH /items/{id}`: a stale request writes nothing.
  checkRevision(item, raw);
  const v = new Validator();
  const inputs: Partial<TestCaseInput>[] = [];
  if (!Array.isArray(raw.cases)) v.add('cases', 'must be an array');
  else raw.cases.forEach((c, i) => inputs.push(parseTestCaseInput(c, v, `cases.${i}.`)));
  if (raw.replace !== undefined && typeof raw.replace !== 'boolean') v.add('replace', 'must be a boolean');
  let reference: SourceCode | null = null;
  if (raw.referenceSolution != null) {
    const ref = raw.referenceSolution;
    if (!isRecord(ref) || !isLanguage(ref.language) || typeof ref.source !== 'string') {
      v.add('referenceSolution', 'must be null or { language, source } with a known language id');
    } else reference = { language: ref.language, source: normaliseText(ref.source) };
  }
  const kept = raw.replace === true ? 0 : db.casesOf(item.id).length;
  if (kept + inputs.length > LIMITS.maxTestCasesPerItem) v.add('cases', tooManyCases);
  v.check();

  if (raw.replace === true) {
    for (const c of db.casesOf(item.id)) db.truth.delete(c.id);
    db.testCases = db.testCases.filter((c) => c.itemId !== item.id);
  }
  for (const input of inputs) insertTestCase(db, item.id, input);
  const hadCases = kept > 0 || raw.replace === true;
  // A reference solution is item content: storing a different one raises the
  // revision. The test cases themselves only move `updatedAt`.
  const current = item.problem?.referenceSolution ?? null;
  if (reference && item.problem && (current?.language !== reference.language || current.source !== reference.source)) {
    item.problem.referenceSolution = reference;
    db.touch(item);
  } else if (inputs.length > 0 || (raw.replace === true && hadCases)) db.touchCases(item);
  return ok({ items: db.casesOf(item.id).map((c) => ({ ...c })) });
}

function patchCase(db: MockDb, req: Req) {
  const tc = getCase(db, req.params.id!);
  const v = new Validator();
  const input = parseTestCaseInput(objectBody(req), v, '', true);
  v.check();

  const ioChanged =
    (input.stdin !== undefined && input.stdin !== tc.stdin) ||
    (input.expectedStdout !== undefined && input.expectedStdout !== tc.expectedStdout);
  const changed = (Object.keys(input) as (keyof TestCaseInput)[]).some((key) => input[key] !== tc[key]);

  // Actually editing the input or the expected output invalidates an earlier
  // verification, unless the same request sets `verified`. Sending a value
  // that is already stored is not an edit.
  if (ioChanged) {
    tc.verified = false;
    db.truth.delete(tc.id);
  }
  Object.assign(tc, input);
  if (changed || ioChanged) {
    tc.updatedAt = db.now();
    db.touchCases(db.getItem(tc.itemId));
  }
  return ok({ ...tc });
}

function deleteCase(db: MockDb, req: Req) {
  const tc = getCase(db, req.params.id!);
  db.testCases = db.testCases.filter((c) => c.id !== tc.id);
  db.truth.delete(tc.id);
  db.renumberCases(tc.itemId);
  db.touchCases(db.getItem(tc.itemId));
  return noContent();
}

function reorderCases(db: MockDb, req: Req) {
  const item = problemOf(db, req.params.id!);
  const raw = objectBody(req);
  const cases = db.casesOf(item.id);
  const ids = raw.ids;
  if (
    !isStringArray(ids) ||
    ids.length !== cases.length ||
    new Set(ids).size !== ids.length ||
    !cases.every((c) => ids.includes(c.id))
  ) {
    throw invalid('ids', "must be exactly the item's test case ids");
  }
  const changed = cases.some((c, i) => ids[i] !== c.id);
  for (const c of cases) c.position = ids.indexOf(c.id);
  if (changed) db.touchCases(item);
  return ok({ items: db.casesOf(item.id).map((c) => ({ ...c })) });
}

/**
 * "Run" the reference solution on every case. Nothing is executed: the
 * solution is assumed to print the stored expected output, except for cases
 * with an entry in `db.truth`, and except when the solution carries one of
 * the judge's failure markers.
 */
async function verify(db: MockDb, req: Req) {
  const item = problemOf(db, req.params.id!);
  const raw = objectBody(req);
  if (raw.updateExpected !== undefined && typeof raw.updateExpected !== 'boolean') {
    throw invalid('updateExpected', 'must be a boolean');
  }
  // Nothing is changed when the engine is missing or cannot be reached.
  if (db.options.judge === 'none') throw judgeUnavailable();
  if (db.options.judge === 'down') throw judgeUnavailable('the judge engine is not reachable');
  const reference = item.problem?.referenceSolution;
  if (!reference) throw invalid('referenceSolution', 'is not set on this problem');

  const cases = db.casesOf(item.id);
  for (let i = 0; i < cases.length; i++) await sleep(db.delay('verifyCase'));

  const behaviour = detectBehaviour(reference.source, undefined);
  const limits = { timeLimitMs: item.problem!.timeLimitMs, memoryLimitKb: item.problem!.memoryLimitKb };
  let casesChanged = false;
  const results: VerifyResult[] = cases.map((tc, i) => {
    const usage = resourceUsage(reference.language, hash32(`${tc.id}:verify`));
    const failure = failureFor(behaviour, i, cases.length, reference.language, limits);
    if (failure) {
      return {
        testCaseId: tc.id,
        ok: false,
        matches: false,
        actualStdout: '',
        verdict: failure.verdict,
        stderr: failure.stderr,
        timeMs: failure.timeMs ?? usage.timeMs,
      };
    }
    const actual = db.truth.get(tc.id) ?? tc.expectedStdout;
    const matches = outputsMatch(actual, tc.expectedStdout, item.problem!.compare);
    if (matches) {
      if (!tc.verified) {
        tc.verified = true;
        casesChanged = true;
      }
    } else if (raw.updateExpected === true) {
      tc.expectedStdout = actual;
      tc.verified = true;
      tc.updatedAt = db.now();
      db.truth.delete(tc.id);
      casesChanged = true;
    }
    return {
      testCaseId: tc.id,
      ok: true,
      matches,
      actualStdout: actual,
      verdict: 'executed',
      stderr: '',
      timeMs: usage.timeMs,
    };
  });
  if (casesChanged) db.touchCases(item);
  return ok({ results });
}

export function testCaseRoutes(db: MockDb): [string, string, Handler][] {
  return [
    [
      'GET',
      '/items/:id/testcases',
      (req) => ok({ items: db.casesOf(problemOf(db, req.params.id!).id).map((c) => ({ ...c })) }),
    ],
    ['POST', '/items/:id/testcases', (req) => createCase(db, req)],
    ['POST', '/items/:id/testcases/bulk', (req) => bulkCases(db, req)],
    ['PUT', '/items/:id/testcases/order', (req) => reorderCases(db, req)],
    ['POST', '/items/:id/testcases/verify', (req) => verify(db, req)],
    ['PATCH', '/testcases/:id', (req) => patchCase(db, req)],
    ['DELETE', '/testcases/:id', (req) => deleteCase(db, req)],
  ];
}
