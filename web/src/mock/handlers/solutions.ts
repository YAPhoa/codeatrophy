// Saved solutions of a problem.

import type { SolutionRun } from '../../api/types';
import type { MockDb, SolutionFields, StoredItem } from '../db';
import { atMostChars, byteLength, charCount, LIMITS, normaliseText } from '../db';
import type { Handler, Req } from '../http';
import { created, invalid, noContent, objectBody, ok, Validator } from '../http';
import { isLanguage } from '../util';
import { checkRevision } from './items';

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001F\u007F-\u009F]/;

/** The item behind a solution route; solutions only exist on problems. */
function problemOf(db: MockDb, id: string): StoredItem {
  const item = db.getItem(id);
  if (item.type !== 'problem') throw invalid('item', 'is a reading; only problems have solutions');
  return item;
}

/** Validate whichever `SolutionInput` fields are present; only those are set on the result. */
function parseSolutionInput(raw: Record<string, unknown>, v: Validator): Partial<SolutionFields> {
  const out: Partial<SolutionFields> = {};
  const text = (key: 'name' | 'language' | 'source' | 'notes'): string | undefined => {
    const value = raw[key];
    if (value === undefined) return undefined;
    if (value === null) v.add(key, 'cannot be null');
    else if (typeof value !== 'string') v.add(key, 'must be a string');
    else return normaliseText(value);
    return undefined;
  };

  const name = text('name')?.trim();
  if (name !== undefined) {
    if (name === '') v.add('name', 'is required');
    else if (charCount(name) > LIMITS.maxSolutionNameChars) v.add('name', atMostChars(LIMITS.maxSolutionNameChars));
    else if (CONTROL.test(name)) v.add('name', 'must be a single line without control characters');
    else out.name = name;
  }
  // Any language the app knows, whether or not the judge currently offers it.
  const language = text('language');
  if (language !== undefined) {
    if (!isLanguage(language)) v.add('language', 'unknown language');
    else out.language = language;
  }
  const source = text('source');
  if (source !== undefined) {
    if (source.trim() === '') v.add('source', 'is required');
    else if (byteLength(source) > LIMITS.maxSourceBytes) v.add('source', `must be at most ${LIMITS.maxSourceBytes} bytes`);
    else out.source = source;
  }
  const notes = text('notes');
  if (notes !== undefined) {
    if (charCount(notes) > LIMITS.maxSolutionNotesChars) v.add('notes', atMostChars(LIMITS.maxSolutionNotesChars));
    else out.notes = notes;
  }
  if (raw.isReference !== undefined) {
    if (raw.isReference === null) v.add('isReference', 'cannot be null');
    else if (typeof raw.isReference !== 'boolean') v.add('isReference', 'must be a boolean');
    else out.isReference = raw.isReference;
  }
  return out;
}

/**
 * The figures of a submission as the last run of a new solution, or `null`
 * when it did not judge exactly that code on the item's test cases: missing,
 * of another item, still being judged, on custom input, ended by a judge
 * error, or of another language or source.
 */
function submissionRun(db: MockDb, itemId: string, fields: Pick<SolutionFields, 'language' | 'source'>, submissionId: unknown): SolutionRun | null {
  if (typeof submissionId !== 'string') return null;
  const s = db.submissions.find((x) => x.id === submissionId);
  if (!s || s.itemId !== itemId || s.status !== 'completed' || s.finishedAt === null) return null;
  if (s.verdict === null || s.verdict === 'internal_error' || s.results.some((r) => r.testCaseId === null)) return null;
  if (s.language !== fields.language || normaliseText(s.source) !== fields.source) return null;
  return { passed: s.passedCount, total: s.totalCount, timeMs: s.timeMs, memoryKb: s.memoryKb, ranAt: s.finishedAt };
}

function createSolution(db: MockDb, req: Req) {
  const raw = objectBody(req);
  const v = new Validator();
  for (const key of ['name', 'language', 'source'] as const) if (raw[key] === undefined) v.add(key, 'is required');
  const input = parseSolutionInput(raw, v);
  if (raw.submissionId !== undefined && raw.submissionId !== null && typeof raw.submissionId !== 'string') v.add('submissionId', 'must be a string');
  v.check();

  const item = problemOf(db, req.params.id!);
  checkRevision(item, raw);
  db.requireSolutionRoom(item.id);

  const before = db.referenceView(item.id);
  const fields = {
    name: input.name!,
    language: input.language!,
    source: input.source!,
    notes: input.notes ?? '',
    isReference: input.isReference ?? false,
  };
  // Figures a client sends are never taken; only those of a submission the mock judged.
  const solution = db.insertSolution(item.id, fields, db.now(), submissionRun(db, item.id, fields, raw.submissionId));
  db.recordSolutionChange(item, before);
  return created(db.solutionView(solution));
}

function patchSolution(db: MockDb, req: Req) {
  const solution = db.getSolution(req.params.id!);
  const item = db.getItem(solution.itemId);
  const raw = objectBody(req);
  checkRevision(item, raw);
  const v = new Validator();
  const input = parseSolutionInput(raw, v);
  if (raw.submissionId !== undefined && raw.submissionId !== null) v.add('submissionId', 'only applies when creating a solution');
  v.check();

  // A request that leaves every field as it was changes nothing, not even a timestamp.
  const changed = (Object.keys(input) as (keyof SolutionFields)[]).some((key) => input[key] !== solution[key]);
  if (!changed) return ok(db.solutionView(solution));

  const before = db.referenceView(item.id);
  if (input.isReference === true && !solution.isReference) db.clearReference(item.id);
  // The figures of the last run belong to the code that ran.
  if ((input.language !== undefined && input.language !== solution.language) || (input.source !== undefined && input.source !== solution.source)) {
    solution.lastRun = null;
  }
  Object.assign(solution, input);
  solution.updatedAt = db.now();
  db.recordSolutionChange(item, before);
  return ok(db.solutionView(solution));
}

function deleteSolution(db: MockDb, req: Req) {
  const solution = db.getSolution(req.params.id!);
  const item = db.getItem(solution.itemId);
  // Deleting the reference solution leaves the item without one.
  const before = db.referenceView(item.id);
  db.solutions = db.solutions.filter((s) => s.id !== solution.id);
  db.recordSolutionChange(item, before);
  return noContent();
}

export function solutionRoutes(db: MockDb): [string, string, Handler][] {
  return [
    [
      'GET',
      '/items/:id/solutions',
      (req) => ok({ items: db.solutionsOf(problemOf(db, req.params.id!).id).map((s) => db.solutionView(s)) }),
    ],
    ['POST', '/items/:id/solutions', (req) => createSolution(db, req)],
    ['PATCH', '/solutions/:id', (req) => patchSolution(db, req)],
    ['DELETE', '/solutions/:id', (req) => deleteSolution(db, req)],
  ];
}
