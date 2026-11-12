// Saved solutions of a problem.

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

function createSolution(db: MockDb, req: Req) {
  const raw = objectBody(req);
  const v = new Validator();
  for (const key of ['name', 'language', 'source'] as const) if (raw[key] === undefined) v.add(key, 'is required');
  const input = parseSolutionInput(raw, v);
  v.check();

  const item = problemOf(db, req.params.id!);
  checkRevision(item, raw);
  db.requireSolutionRoom(item.id);

  const before = db.referenceView(item.id);
  const solution = db.insertSolution(item.id, {
    name: input.name!,
    language: input.language!,
    source: input.source!,
    notes: input.notes ?? '',
    isReference: input.isReference ?? false,
  });
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
  v.check();

  // A request that leaves every field as it was changes nothing, not even a timestamp.
  const changed = (Object.keys(input) as (keyof SolutionFields)[]).some((key) => input[key] !== solution[key]);
  if (!changed) return ok(db.solutionView(solution));

  const before = db.referenceView(item.id);
  if (input.isReference === true && !solution.isReference) db.clearReference(item.id);
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
