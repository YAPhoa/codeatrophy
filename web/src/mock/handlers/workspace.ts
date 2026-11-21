// Working copies: the code being written on a problem, one per language
// (docs/api.md, "Working copies").

import type { WorkingCopy } from '../../api/types';
import type { MockDb, StoredItem, StoredWorkingCopy } from '../db';
import { byteLength, LIMITS, normaliseText } from '../db';
import type { Handler, Req } from '../http';
import { HttpError, invalid, noContent, objectBody, ok } from '../http';
import { isLanguage } from '../util';

/** The problem behind a workspace route: `404` for no item, `422` for a reading. */
function problemOf(db: MockDb, id: string): StoredItem {
  const item = db.getItem(id);
  if (item.type !== 'problem') throw invalid('item', 'is a reading; only problems have working copies');
  return item;
}

/** Any canonical language id, whether or not the judge offers it. */
function languageOf(req: Req): string {
  const language = req.params.language!;
  if (!isLanguage(language)) throw invalid('language', 'unknown language');
  return language;
}

/** As the scenario `workspace-fail` asks: a write that does not get through. */
function refuseIfFailing(db: MockDb): void {
  if (db.workspaceWritesFail) throw new HttpError(500, 'internal', 'working copy writes fail in this mock scenario');
}

const view = ({ language, source, updatedAt }: StoredWorkingCopy): WorkingCopy => ({ language, source, updatedAt });

/** Most recently updated first; the counter orders writes within the same second. */
function listCopies(db: MockDb, itemId: string): WorkingCopy[] {
  return db.workingCopies
    .filter((w) => w.itemId === itemId)
    .sort((a, b) => (a.updatedAt === b.updatedAt ? b.seq - a.seq : a.updatedAt < b.updatedAt ? 1 : -1))
    .map(view);
}

function putCopy(db: MockDb, req: Req) {
  const item = problemOf(db, req.params.id!);
  const language = languageOf(req);
  const raw = objectBody(req);
  if (raw.source === undefined || raw.source === null) throw invalid('source', 'is required');
  if (typeof raw.source !== 'string') throw invalid('source', 'must be a string');
  const source = normaliseText(raw.source);
  if (byteLength(source) > LIMITS.maxSourceBytes) throw invalid('source', `must be at most ${LIMITS.maxSourceBytes} bytes`);
  refuseIfFailing(db);

  // Last write wins. The item's revision and updatedAt stay as they are.
  const existing = db.workingCopies.find((w) => w.itemId === item.id && w.language === language);
  const copy = existing ?? { itemId: item.id, language, source, updatedAt: '', seq: 0 };
  copy.source = source;
  copy.updatedAt = db.now();
  copy.seq = db.nextSeq();
  if (!existing) db.workingCopies.push(copy);
  db.onWorkingCopiesChange?.();
  return ok(view(copy));
}

function deleteCopy(db: MockDb, req: Req) {
  const item = problemOf(db, req.params.id!);
  const language = languageOf(req);
  refuseIfFailing(db);
  const before = db.workingCopies.length;
  db.workingCopies = db.workingCopies.filter((w) => !(w.itemId === item.id && w.language === language));
  if (db.workingCopies.length !== before) db.onWorkingCopiesChange?.();
  // Also when there was none.
  return noContent();
}

export function workspaceRoutes(db: MockDb): [string, string, Handler][] {
  return [
    ['GET', '/items/:id/workspace', (req) => ok({ items: listCopies(db, problemOf(db, req.params.id!).id) })],
    ['PUT', '/items/:id/workspace/:language', (req) => putCopy(db, req)],
    ['DELETE', '/items/:id/workspace/:language', (req) => deleteCopy(db, req)],
  ];
}
