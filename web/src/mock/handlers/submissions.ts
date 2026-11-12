// Submission endpoints and the asynchronous judging lifecycle.

import type { Submission, SubmissionMode, SubmissionSummary } from '../../api/types';
import type { MockDb, StoredItem } from '../db';
import { byteLength, LIMITS, normaliseText } from '../db';
import type { Handler, Req } from '../http';
import { accepted, enumParam, invalid, judgeUnavailable, notFound, objectBody, ok, pagination, Validator } from '../http';
import type { Behaviour, CaseSpec } from '../judge';
import { compileOutputFor, detectBehaviour, judgeCase } from '../judge';
import { hash32, uuid } from '../util';

const MODES: readonly SubmissionMode[] = ['run', 'submit'];

export function summaryOf(s: Submission): SubmissionSummary {
  return {
    id: s.id,
    itemId: s.itemId,
    mode: s.mode,
    language: s.language,
    status: s.status,
    verdict: s.verdict,
    passedCount: s.passedCount,
    totalCount: s.totalCount,
    timeMs: s.timeMs,
    memoryKb: s.memoryKb,
    error: s.error,
    createdAt: s.createdAt,
    finishedAt: s.finishedAt,
  };
}

/** A result counts as passed when it is `accepted`, or `executed` for a run with nothing to compare against. */
const passed = (r: { verdict: string }): boolean => r.verdict === 'accepted' || r.verdict === 'executed';

/** Close a submission: aggregate the verdict and apply its effect on the item. */
export function finish(db: MockDb, s: Submission, finishedAt: string, outcome?: 'compile_error' | 'internal_error'): void {
  s.status = 'completed';
  s.finishedAt = finishedAt;
  if (outcome) {
    s.verdict = outcome;
    s.results = [];
    s.passedCount = 0;
  } else {
    // Accepted only if every case is; otherwise the first failure in order.
    s.verdict = s.results.find((r) => r.verdict !== 'accepted')?.verdict ?? 'accepted';
    s.passedCount = s.results.filter(passed).length;
  }
  // The maximum over the results; with none (a compile error, an engine
  // failure) there is nothing to measure. `totalCount` keeps its value.
  s.timeMs = s.results.length > 0 ? Math.max(...s.results.map((r) => r.timeMs)) : null;
  s.memoryKb = s.results.length > 0 ? Math.max(...s.results.map((r) => r.memoryKb)) : null;
  const item = db.items.get(s.itemId);
  if (item && s.mode === 'submit' && s.verdict === 'accepted') item.status = 'done';
}

/** The cases a submission runs: custom stdin, the samples, or everything. */
export function casesFor(db: MockDb, item: StoredItem, mode: SubmissionMode, stdin: string | null): CaseSpec[] {
  if (stdin !== null) {
    return [{ testCaseId: null, name: 'Custom input', isSample: false, stdin, expectedStdout: null }];
  }
  return db
    .casesOf(item.id)
    .filter((c) => mode === 'submit' || c.isSample)
    .map((c) => ({
      testCaseId: c.id,
      name: c.name,
      isSample: c.isSample,
      stdin: c.stdin,
      expectedStdout: c.expectedStdout,
    }));
}

function createSubmission(db: MockDb, req: Req) {
  const item = db.getItem(req.params.id!);
  if (item.type !== 'problem') throw invalid('item', 'is a reading; only problems can be run');
  if (db.options.judge === 'none') throw judgeUnavailable();

  const raw = objectBody(req);
  const v = new Validator();
  const language = raw.language;
  if (typeof language !== 'string' || !db.judgeLanguages.some((l) => l.id === language)) {
    v.add('language', 'is not offered by the judge engine');
  }
  const source = raw.source;
  if (typeof source !== 'string' || source.trim() === '') v.add('source', 'is required');
  else if (byteLength(source) > LIMITS.maxSourceBytes) {
    v.add('source', `must be at most ${LIMITS.maxSourceBytes} bytes`);
  }
  if (!MODES.includes(raw.mode as SubmissionMode)) v.add('mode', 'must be run or submit');
  const mode = raw.mode as SubmissionMode;
  const stdin = raw.stdin ?? null;
  if (stdin !== null && typeof stdin !== 'string') v.add('stdin', 'must be a string or null');
  else if (mode === 'submit' && stdin !== null) v.add('stdin', 'must be null in submit mode');
  else if (typeof stdin === 'string' && byteLength(stdin) > LIMITS.maxTestDataBytes) {
    v.add('stdin', `must be at most ${LIMITS.maxTestDataBytes} bytes`);
  }
  v.check();

  const cases = casesFor(db, item, mode, stdin as string | null);
  if (cases.length === 0) {
    throw invalid('testCases', mode === 'submit' ? 'there are no test cases to run' : 'there are no sample test cases to run');
  }

  const submission: Submission = {
    id: uuid(),
    itemId: item.id,
    mode,
    language: language as string,
    source: normaliseText(source as string),
    status: 'queued',
    verdict: null,
    passedCount: 0,
    totalCount: cases.length,
    timeMs: null,
    memoryKb: null,
    compileOutput: '',
    error: null,
    results: [],
    createdAt: db.now(),
    finishedAt: null,
  };
  db.submissions.push(submission);
  if (item.status === 'todo') item.status = 'in_progress';

  const behaviour: Behaviour =
    db.options.judge === 'down' ? 'ie' : detectBehaviour(submission.source, item.problem?.starterCode[submission.language]);
  const response = accepted(structuredClone(submission));
  judge(db, submission, cases, behaviour, item);
  return response;
}

/** Advance a submission through queued → running → completed on timers. */
function judge(db: MockDb, s: Submission, cases: CaseSpec[], behaviour: Behaviour, item: StoredItem): void {
  const limits = { timeLimitMs: item.problem!.timeLimitMs, memoryLimitKb: item.problem!.memoryLimitKb };
  const seed = hash32(s.id);
  // Stop quietly if the item (and with it the submission) was deleted meanwhile.
  const alive = () => db.submissions.includes(s);

  const step = (index: number) => {
    if (!alive()) return;
    if (index >= cases.length) {
      finish(db, s, db.now());
      return;
    }
    const result = judgeCase(cases[index]!, index, cases.length, behaviour, s.language, limits, seed);
    s.results.push(result);
    if (passed(result)) s.passedCount++;
    setTimeout(() => step(index + 1), index + 1 >= cases.length ? 0 : db.delay('judgeCase'));
  };

  setTimeout(() => {
    if (!alive()) return;
    s.status = 'running';
    setTimeout(() => {
      if (!alive()) return;
      if (behaviour === 'ie') {
        s.error =
          db.options.judge === 'down'
            ? 'judge engine unreachable: Post "http://judge0:2358/submissions": dial tcp: connection refused'
            : 'judge engine returned an unexpected response (HTTP 500)';
        finish(db, s, db.now(), 'internal_error');
      } else if (behaviour === 'ce') {
        s.compileOutput = compileOutputFor(s.language);
        finish(db, s, db.now(), 'compile_error');
      } else {
        step(0);
      }
    }, db.delay('judgeCase'));
  }, db.delay('judgeQueue'));
}

function getSubmission(db: MockDb, req: Req) {
  const s = db.submissions.find((x) => x.id === req.params.id);
  if (!s) throw notFound('submission');
  return ok(structuredClone(s));
}

function listSubmissions(db: MockDb, req: Req) {
  const item = db.getItem(req.params.id!);
  const mode = enumParam(req.query, 'mode', MODES);
  const { limit, offset } = pagination(req.query, LIMITS.maxPageSize);
  const all = db.submissions.filter((s) => s.itemId === item.id && (!mode || s.mode === mode)).reverse();
  return ok({ items: all.slice(offset, offset + limit).map(summaryOf), total: all.length });
}

export function submissionRoutes(db: MockDb): [string, string, Handler][] {
  return [
    ['POST', '/items/:id/submissions', (req) => createSubmission(db, req)],
    ['GET', '/items/:id/submissions', (req) => listSubmissions(db, req)],
    ['GET', '/submissions/:id', (req) => getSubmission(db, req)],
  ];
}
