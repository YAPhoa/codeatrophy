// Export, import preview and import.

import type { ImportItemState, ImportPreview, ImportResult, ImportStrategy } from '../../api/types';
import type { BundleCollection, BundleItem, ParsedBundle } from '../bundle';
import { buildBundleZip, BundleError, contentHash, parseBundleZip } from '../bundle';
import type { MockDb, StoredCollection, StoredItem } from '../db';
import { atMostChars, charCount, LIMITS, normaliseTags } from '../db';
import type { Handler, Req } from '../http';
import { badRequest, invalid, isStringArray, objectBody, ok, tooLarge } from '../http';
import { sleep, slugify, uuid } from '../util';
import { insertTestCase } from './items';

const STRATEGIES: readonly ImportStrategy[] = ['skip', 'overwrite', 'duplicate'];

/** An item's shareable content, optionally without its solutions or hidden tests. */
function toBundleItem(db: MockDb, item: StoredItem, includeSolutions: boolean, includeHiddenTests: boolean): BundleItem {
  return {
    id: item.id,
    type: item.type,
    title: item.title,
    summary: item.summary,
    difficulty: item.difficulty,
    tags: [...item.tags],
    source: { ...item.source },
    variantOf: item.variantOf,
    body: item.body,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    problem: item.problem
      ? {
          timeLimitMs: item.problem.timeLimitMs,
          memoryLimitKb: item.problem.memoryLimitKb,
          compare: item.problem.compare,
          starterCode: { ...item.problem.starterCode },
        }
      : null,
    // Left out entirely, rather than written as an empty list, when not exported.
    ...(item.problem && includeSolutions
      ? {
          solutions: db.solutionsOf(item.id).map((s) => ({
            name: s.name,
            language: s.language,
            source: s.source,
            notes: s.notes,
            isReference: s.isReference,
          })),
        }
      : {}),
    testCases: db
      .casesOf(item.id)
      .filter((c) => includeHiddenTests || c.isSample)
      .map((c) => ({
        name: c.name,
        stdin: c.stdin,
        expectedStdout: c.expectedStdout,
        isSample: c.isSample,
        origin: c.origin,
        verified: c.verified,
      })),
  };
}

async function exportBundle(db: MockDb, req: Req) {
  const raw = objectBody(req);
  const scope = raw.scope;
  if (scope !== 'all' && scope !== 'collection' && scope !== 'items') {
    throw invalid('scope', 'must be all, collection or items');
  }
  for (const key of ['includeSolutions', 'includeHiddenTests'] as const) {
    if (raw[key] !== undefined && typeof raw[key] !== 'boolean') throw invalid(key, 'must be a boolean');
  }
  for (const key of ['name', 'description', 'author'] as const) {
    const value = raw[key];
    if (value == null) continue;
    if (typeof value !== 'string') throw invalid(key, 'must be a string');
    const max = key === 'description' ? LIMITS.maxBundleDescriptionChars : LIMITS.maxBundleNameChars;
    if (charCount(value) > max) throw invalid(key, atMostChars(max));
  }
  const includeSolutions = raw.includeSolutions !== false;
  const includeHiddenTests = raw.includeHiddenTests !== false;

  let items: StoredItem[];
  let collections: StoredCollection[] = [];
  let defaultName = 'Codeatrophy library';
  if (scope === 'all') {
    items = [...db.items.values()];
    collections = db.sortedCollections();
  } else if (scope === 'collection') {
    if (typeof raw.collectionId !== 'string') throw invalid('collectionId', 'is required when scope is collection');
    const top = db.collections.find((c) => c.id === raw.collectionId);
    if (!top) throw invalid('collectionId', 'does not exist');
    const ids = [top.id, ...db.descendants(top.id)];
    collections = db.sortedCollections().filter((c) => ids.includes(c.id));
    const memberIds = new Set(collections.flatMap((c) => c.itemIds));
    items = [...db.items.values()].filter((i) => memberIds.has(i.id));
    defaultName = top.name;
  } else {
    if (!isStringArray(raw.itemIds) || raw.itemIds.length === 0) {
      throw invalid('itemIds', 'must list at least one item when scope is items');
    }
    const missing = raw.itemIds.findIndex((id) => !db.items.has(id));
    if (missing !== -1) throw invalid(`itemIds.${missing}`, 'does not exist');
    items = [...new Set(raw.itemIds)].map((id) => db.items.get(id)!);
  }
  items.sort((a, b) => (a.createdAt === b.createdAt ? a.seq - b.seq : a.createdAt < b.createdAt ? -1 : 1));

  const exported = new Set(items.map((i) => i.id));
  const exportedCollections = new Set(collections.map((c) => c.id));
  const name = typeof raw.name === 'string' && raw.name.trim() !== '' ? raw.name.trim() : defaultName;
  await sleep(db.delay('bundle'));
  const bytes = buildBundleZip({
    name,
    description: (raw.description as string | undefined) ?? '',
    author: (raw.author as string | undefined) ?? '',
    createdAt: db.now(),
    includes: { solutions: includeSolutions, hiddenTests: includeHiddenTests },
    items: items.map((item) => toBundleItem(db, item, includeSolutions, includeHiddenTests)),
    collections: collections.map(
      (c): BundleCollection => ({
        id: c.id,
        name: c.name,
        description: c.description,
        // A parent that is not exported is written as a root.
        parentId: c.parentId !== null && exportedCollections.has(c.parentId) ? c.parentId : null,
        position: c.position,
        itemIds: c.itemIds.filter((id) => exported.has(id)),
      }),
    ),
  });
  return {
    status: 200,
    raw: {
      bytes,
      headers: {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="${slugify(name)}.codeatrophy.zip"`,
      },
    },
  };
}

/** Read and validate the uploaded archive of an import request. */
async function readUpload(req: Req): Promise<ParsedBundle> {
  const file = req.form?.get('file');
  if (!file || typeof file === 'string') throw badRequest('the upload must be multipart/form-data with a "file" part');
  if (file.size > LIMITS.maxImportBytes) {
    throw tooLarge(`the bundle exceeds the import limit of ${LIMITS.maxImportBytes} bytes`);
  }
  try {
    const bundle = await parseBundleZip(new Uint8Array(await file.arrayBuffer()));
    for (const item of bundle.items) item.tags = normaliseTags(item.tags);
    return bundle;
  } catch (err) {
    if (err instanceof BundleError) throw invalid('file', err.message);
    throw err;
  }
}

/**
 * Compare a bundle item with the library. The local item is hashed over the
 * same fields the bundle carries: if the bundle carries no solutions, or
 * only sample tests, the local solutions and hidden tests are left out.
 */
function comparison(db: MockDb, incoming: BundleItem): { local: BundleItem; incoming: BundleItem } | null {
  const stored = db.items.get(incoming.id);
  if (!stored) return null;
  const samplesOnly = incoming.testCases.every((c) => c.isSample);
  const hasSolutions = incoming.solutions !== undefined;
  // A link to an item this library does not have would be dropped on import, so it is not a difference.
  const variantOf = incoming.variantOf !== null && db.items.has(incoming.variantOf) ? incoming.variantOf : null;
  return { local: toBundleItem(db, stored, hasSolutions, !samplesOnly), incoming: { ...incoming, variantOf } };
}

function classify(db: MockDb, incoming: BundleItem): ImportItemState {
  const pair = comparison(db, incoming);
  if (!pair) return 'new';
  return contentHash(pair.local) === contentHash(pair.incoming) ? 'unchanged' : 'changed';
}

const sameJson = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
const sortedEntries = (record: Record<string, string> | undefined) => Object.entries(record ?? {}).sort(([a], [b]) => (a < b ? -1 : 1));

/**
 * The content fields in which a bundled item differs from the local one, in
 * the contract's order. Compared over the same fields as the content hash.
 */
function changesOf(db: MockDb, bundled: BundleItem): string[] {
  const pair = comparison(db, bundled);
  if (!pair) return [];
  const { local, incoming } = pair;
  const cases = (item: BundleItem) =>
    item.type === 'problem' ? item.testCases.map((c) => [c.name, c.stdin, c.expectedStdout, c.isSample]) : [];
  const solutions = (item: BundleItem) =>
    item.solutions?.map((s) => [s.name, s.language, s.source, s.notes, s.isReference]) ?? null;
  const checks: [string, boolean][] = [
    ['type', local.type === incoming.type],
    ['title', local.title === incoming.title],
    ['summary', local.summary === incoming.summary],
    ['body', local.body === incoming.body],
    ['difficulty', local.difficulty === incoming.difficulty],
    ['tags', sameJson([...local.tags].sort(), [...incoming.tags].sort())],
    ['source', local.source.url === incoming.source.url && local.source.note === incoming.source.note],
    ['variantOf', local.variantOf === incoming.variantOf],
    [
      'limits',
      local.problem?.timeLimitMs === incoming.problem?.timeLimitMs && local.problem?.memoryLimitKb === incoming.problem?.memoryLimitKb,
    ],
    ['compare', local.problem?.compare === incoming.problem?.compare],
    ['starterCode', sameJson(sortedEntries(local.problem?.starterCode), sortedEntries(incoming.problem?.starterCode))],
    ['solutions', sameJson(solutions(local), solutions(incoming))],
    ['testCases', sameJson(cases(local), cases(incoming))],
  ];
  return checks.filter(([, same]) => !same).map(([field]) => field);
}

async function preview(db: MockDb, req: Req) {
  const bundle = await readUpload(req);
  await sleep(db.delay('bundle'));
  const counts: Record<ImportItemState, number> = { new: 0, changed: 0, unchanged: 0 };
  const items = bundle.items.map((item) => {
    const state = classify(db, item);
    counts[state]++;
    return {
      id: item.id,
      title: item.title,
      type: item.type,
      state,
      testCaseCount: item.testCases.length,
      changes: state === 'changed' ? changesOf(db, item) : [],
    };
  });
  const body: ImportPreview = {
    bundle: {
      name: bundle.name,
      description: bundle.description,
      author: bundle.author,
      formatVersion: bundle.formatVersion,
      createdAt: bundle.createdAt,
    },
    items,
    collections: bundle.collections.map((c) => ({
      id: c.id,
      name: c.name,
      state: db.collections.some((x) => x.id === c.id) ? ('existing' as const) : ('new' as const),
      itemCount: c.itemIds.length,
    })),
    counts,
    warnings: bundle.warnings,
  };
  return ok(body);
}

function createFromBundle(db: MockDb, incoming: BundleItem, id: string): StoredItem {
  const now = db.now();
  const item: StoredItem = {
    id,
    type: incoming.type,
    title: incoming.title,
    summary: incoming.summary,
    body: incoming.body,
    difficulty: incoming.difficulty,
    tags: [...incoming.tags],
    // New items start with default personal state.
    status: 'todo',
    favorite: false,
    notes: '',
    rawInput: null,
    source: { ...incoming.source },
    problem: incoming.problem ? structuredClone(incoming.problem) : null,
    variantOf: incoming.variantOf,
    revision: 1,
    createdAt: incoming.createdAt ?? now,
    updatedAt: now,
    seq: db.nextSeq(),
  };
  db.items.set(id, item);
  for (const s of incoming.solutions ?? []) db.insertSolution(id, s, now);
  for (const c of incoming.testCases) insertTestCase(db, id, c);
  return item;
}

function overwrite(db: MockDb, local: StoredItem, incoming: BundleItem): void {
  local.title = incoming.title;
  local.summary = incoming.summary;
  local.body = incoming.body;
  local.difficulty = incoming.difficulty;
  local.tags = [...incoming.tags];
  local.source = { ...incoming.source };
  local.variantOf = incoming.variantOf;
  if (incoming.problem && local.problem) local.problem = structuredClone(incoming.problem);
  // Solutions are replaced by the bundle's; a bundle exported without
  // solutions must not erase the local ones.
  if (incoming.solutions) {
    db.solutions = db.solutions.filter((s) => s.itemId !== local.id);
    const now = db.now();
    for (const s of incoming.solutions) db.insertSolution(local.id, s, now);
  }
  // Likewise, local hidden cases survive a bundle that carries samples only.
  const samplesOnly = incoming.testCases.every((c) => c.isSample);
  const survivors = samplesOnly ? db.casesOf(local.id).filter((c) => !c.isSample) : [];
  for (const c of db.casesOf(local.id)) if (!survivors.includes(c)) db.truth.delete(c.id);
  db.testCases = db.testCases.filter((c) => c.itemId !== local.id);
  for (const c of incoming.testCases) insertTestCase(db, local.id, c);
  survivors.forEach((c, i) => {
    c.position = incoming.testCases.length + i;
    db.testCases.push(c);
  });
  db.touch(local);
}

async function importBundle(db: MockDb, req: Req) {
  const strategyField = req.form?.get('strategy') ?? 'skip';
  if (typeof strategyField !== 'string' || !STRATEGIES.includes(strategyField as ImportStrategy)) {
    throw invalid('strategy', 'must be skip, overwrite or duplicate');
  }
  const strategy = strategyField as ImportStrategy;
  const bundle = await readUpload(req);
  await sleep(db.delay('bundle'));

  const result: ImportResult = {
    created: 0,
    updated: 0,
    skipped: 0,
    duplicated: 0,
    unchanged: 0,
    collectionsCreated: 0,
    warnings: bundle.warnings,
  };
  // Where each bundle item ended up, for collection membership.
  const localId = new Map<string, string>();
  const fresh: StoredItem[] = [];
  for (const incoming of bundle.items) {
    const state = classify(db, incoming);
    localId.set(incoming.id, incoming.id);
    if (state === 'new') {
      fresh.push(createFromBundle(db, incoming, incoming.id));
      result.created++;
    } else if (state === 'unchanged') {
      result.unchanged++;
    } else if (strategy === 'skip') {
      result.skipped++;
    } else if (strategy === 'overwrite') {
      overwrite(db, db.getItem(incoming.id), incoming);
      result.updated++;
    } else {
      const copy = createFromBundle(db, incoming, uuid());
      fresh.push(copy);
      localId.set(incoming.id, copy.id);
      result.duplicated++;
    }
  }
  // A variant link survives only if its target exists in this library.
  for (const item of [...fresh, ...bundle.items.flatMap((i) => db.items.get(i.id) ?? [])]) {
    if (item.variantOf !== null && !db.items.has(item.variantOf)) item.variantOf = null;
  }

  // Parents before children, so a new child can attach to a parent created just before it.
  const depth = (c: BundleCollection): number => {
    const parent = bundle.collections.find((x) => x.id === c.parentId);
    return parent ? depth(parent) + 1 : 0;
  };
  const ordered = [...bundle.collections].sort((a, b) => depth(a) - depth(b) || a.position - b.position);
  for (const incoming of ordered) {
    const members = incoming.itemIds.flatMap((id) => localId.get(id) ?? []);
    const existing = db.collections.find((c) => c.id === incoming.id);
    if (existing) {
      // Name, description and place in the tree stay as they are locally.
      for (const id of members) if (!existing.itemIds.includes(id)) existing.itemIds.push(id);
      continue;
    }
    const now = db.now();
    db.collections.push({
      id: incoming.id,
      name: incoming.name,
      description: incoming.description,
      parentId: incoming.parentId,
      position: db.siblings(incoming.parentId).length,
      itemIds: [...new Set(members)],
      createdAt: now,
      updatedAt: now,
    });
    result.collectionsCreated++;
  }
  return ok(result);
}

export function bundleRoutes(db: MockDb): [string, string, Handler][] {
  return [
    ['POST', '/export', (req) => exportBundle(db, req)],
    ['POST', '/import/preview', (req) => preview(db, req)],
    ['POST', '/import', (req) => importBundle(db, req)],
  ];
}
