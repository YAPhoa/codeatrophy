// Collection and tag endpoints.

import type { MockDb, StoredCollection } from '../db';
import { atMostChars, charCount, LIMITS, normaliseTags, normaliseText, tagProblem } from '../db';
import type { Handler, Req } from '../http';
import { conflict, created, invalid, isStringArray, noContent, notFound, objectBody, ok, Validator } from '../http';
import { uuid } from '../util';

function parseName(raw: Record<string, unknown>, v: Validator, required: boolean): string | undefined {
  if (raw.name === undefined) {
    if (required) v.add('name', 'is required');
    return undefined;
  }
  const name = typeof raw.name === 'string' ? normaliseText(raw.name).trim() : '';
  if (name.length < 1) v.add('name', 'is required');
  else if (charCount(name) > LIMITS.maxCollectionNameChars) v.add('name', atMostChars(LIMITS.maxCollectionNameChars));
  return name;
}

function parseDescription(raw: Record<string, unknown>, v: Validator): string | undefined {
  if (raw.description === undefined) return undefined;
  if (typeof raw.description !== 'string') {
    v.add('description', 'must be a string');
    return undefined;
  }
  const description = normaliseText(raw.description);
  if (charCount(description) > LIMITS.maxCollectionDescriptionChars) {
    v.add('description', atMostChars(LIMITS.maxCollectionDescriptionChars));
  }
  return description;
}

function parseParent(db: MockDb, raw: Record<string, unknown>, v: Validator): string | null | undefined {
  if (raw.parentId === undefined) return undefined;
  if (raw.parentId === null) return null;
  if (typeof raw.parentId !== 'string' || !db.collections.some((c) => c.id === raw.parentId)) {
    v.add('parentId', 'must be the id of an existing collection or null');
    return undefined;
  }
  return raw.parentId;
}

function createCollection(db: MockDb, req: Req) {
  const raw = objectBody(req);
  const v = new Validator();
  const name = parseName(raw, v, true);
  const parentId = parseParent(db, raw, v) ?? null;
  const description = parseDescription(raw, v);
  v.check();
  const now = db.now();
  const c: StoredCollection = {
    id: uuid(),
    name: name!,
    description: description ?? '',
    parentId,
    position: db.siblings(parentId).length,
    itemIds: [],
    createdAt: now,
    updatedAt: now,
  };
  db.collections.push(c);
  return created(db.collectionView(c));
}

function patchCollection(db: MockDb, req: Req) {
  const c = db.getCollection(req.params.id!);
  const raw = objectBody(req);
  const v = new Validator();
  const name = parseName(raw, v, false);
  const parentId = parseParent(db, raw, v);
  const description = parseDescription(raw, v);
  const position = raw.position;
  if (position !== undefined && (typeof position !== 'number' || !Number.isInteger(position) || position < 0)) {
    v.add('position', 'must be a non-negative integer');
  }
  v.check();
  if (parentId != null && (parentId === c.id || db.descendants(c.id).includes(parentId))) {
    throw conflict('a collection cannot be moved under itself or one of its descendants');
  }

  if (name !== undefined) c.name = name;
  if (description !== undefined) c.description = description;

  const newParent = parentId === undefined ? c.parentId : parentId;
  if (newParent !== c.parentId || position !== undefined) {
    const oldParent = c.parentId;
    // Take it out of its current place, then insert among the (new) siblings.
    c.parentId = newParent;
    const others = db.siblings(newParent).filter((x) => x.id !== c.id);
    const index = Math.min(typeof position === 'number' ? position : others.length, others.length);
    others.splice(index, 0, c);
    others.forEach((x, i) => {
      x.position = i;
    });
    if (oldParent !== newParent) db.renumberSiblings(oldParent);
  }
  c.updatedAt = db.now();
  return ok(db.collectionView(c));
}

function deleteCollection(db: MockDb, req: Req) {
  const c = db.getCollection(req.params.id!);
  // Children take the deleted collection's place among its siblings.
  const siblings = db.siblings(c.parentId);
  const children = db.siblings(c.id);
  siblings.splice(siblings.indexOf(c), 1, ...children);
  for (const child of children) child.parentId = c.parentId;
  siblings.forEach((x, i) => {
    x.position = i;
  });
  db.collections = db.collections.filter((x) => x.id !== c.id);
  return noContent();
}

function parseItemIds(db: MockDb, req: Req): string[] {
  const raw = objectBody(req);
  if (!isStringArray(raw.itemIds)) throw invalid('itemIds', 'must be an array of item ids');
  if (raw.itemIds.some((id) => !db.items.has(id))) throw invalid('itemIds', 'contains an unknown item id');
  return [...new Set(raw.itemIds)];
}

/** The normalised tag a path names; 404 for one that does not exist. */
function existingTag(db: MockDb, req: Req): string {
  const name = normaliseTags([req.params.name!])[0];
  if (name === undefined || !db.tags.has(name)) throw notFound('tag');
  return name;
}

function renameTag(db: MockDb, req: Req) {
  const old = existingTag(db, req);
  const raw = objectBody(req);
  const next = typeof raw.name === 'string' ? normaliseTags([raw.name])[0] : undefined;
  if (next === undefined) throw invalid('name', 'is required');
  const problem = tagProblem(next);
  if (problem) throw invalid('name', problem);
  if (next !== old) {
    for (const item of db.items.values()) {
      if (!item.tags.includes(old)) continue;
      item.tags = normaliseTags(item.tags.map((t) => (t === old ? next : t)));
      db.touch(item);
    }
    db.tags.delete(old);
    db.tags.add(next);
  }
  return ok({ name: next, count: [...db.items.values()].filter((i) => i.tags.includes(next)).length });
}

function deleteTag(db: MockDb, req: Req) {
  const name = existingTag(db, req);
  for (const item of db.items.values()) {
    if (!item.tags.includes(name)) continue;
    item.tags = item.tags.filter((t) => t !== name);
    db.touch(item);
  }
  db.tags.delete(name);
  return noContent();
}

/** Every tag, empty ones included with a count of 0. */
function listTags(db: MockDb) {
  const counts = new Map<string, number>([...db.tags].map((t) => [t, 0]));
  for (const item of db.items.values()) for (const t of item.tags) counts.set(t, (counts.get(t) ?? 0) + 1);
  const items = [...counts].map(([name, count]) => ({ name, count })).sort((a, b) => (a.name < b.name ? -1 : 1));
  return ok({ items });
}

export function organiseRoutes(db: MockDb): [string, string, Handler][] {
  return [
    ['GET', '/collections', () => ok({ items: db.sortedCollections().map((c) => db.collectionView(c)) })],
    ['POST', '/collections', (req) => createCollection(db, req)],
    ['GET', '/collections/:id', (req) => ok(db.collectionView(db.getCollection(req.params.id!)))],
    ['PATCH', '/collections/:id', (req) => patchCollection(db, req)],
    ['DELETE', '/collections/:id', (req) => deleteCollection(db, req)],
    ['GET', '/collections/:id/items', (req) => ok({ itemIds: [...db.getCollection(req.params.id!).itemIds] })],
    [
      'PUT',
      '/collections/:id/items',
      (req) => {
        const c = db.getCollection(req.params.id!);
        c.itemIds = parseItemIds(db, req);
        return ok({ itemIds: [...c.itemIds] });
      },
    ],
    [
      'POST',
      '/collections/:id/items',
      (req) => {
        const c = db.getCollection(req.params.id!);
        for (const id of parseItemIds(db, req)) if (!c.itemIds.includes(id)) c.itemIds.push(id);
        return ok({ itemIds: [...c.itemIds] });
      },
    ],
    [
      'DELETE',
      '/collections/:id/items/:itemId',
      (req) => {
        const c = db.getCollection(req.params.id!);
        c.itemIds = c.itemIds.filter((id) => id !== req.params.itemId);
        return noContent();
      },
    ],
    ['GET', '/tags', () => listTags(db)],
    ['PATCH', '/tags/:name', (req) => renameTag(db, req)],
    ['DELETE', '/tags/:name', (req) => deleteTag(db, req)],
  ];
}
