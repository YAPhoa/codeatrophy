// Meta, stats and the item endpoints.

import type {
  CompareMode,
  Difficulty,
  HarnessCode,
  ItemFacets,
  ItemSort,
  ItemSource,
  ItemStatus,
  ItemType,
  ProblemSpec,
  SourceCode,
  Stats,
  TestCase,
  TestCaseInput,
  TestOrigin,
} from '../../api/types';
import type { MockDb, StoredItem } from '../db';
import { atMostChars, byteLength, charCount, DEFAULT_PROBLEM, LIMITS, normaliseTags, normaliseText, tagProblem } from '../db';
import type { Handler, Req } from '../http';
import {
  badRequest,
  boolParam,
  conflict,
  created,
  enumListParam,
  enumParam,
  invalid,
  isRecord,
  isStringArray,
  noContent,
  objectBody,
  ok,
  pagination,
  Validator,
} from '../http';
import { checkProblem } from '../ai';
import { runGenerator } from '../largeCase';
import { isLanguage, sleep, uuid } from '../util';

const TYPES: readonly ItemType[] = ['problem', 'reading'];
const STATUSES: readonly ItemStatus[] = ['todo', 'in_progress', 'done'];
const DIFFICULTIES: readonly Difficulty[] = ['easy', 'medium', 'hard'];
const COMPARE: readonly CompareMode[] = ['tokens', 'exact'];
const ORIGINS: readonly TestOrigin[] = ['manual', 'ai', 'import'];
const SORTS: readonly ItemSort[] = ['updated', 'created', 'title', 'difficulty', 'position', 'relevance'];

/** Fields of `ItemInput` after validation; only keys present in the request are set. */
interface ParsedFields {
  title?: string;
  summary?: string;
  body?: string;
  difficulty?: Difficulty | null;
  tags?: string[];
  status?: ItemStatus;
  favorite?: boolean;
  notes?: string;
  rawInput?: string | null;
  source?: Partial<ItemSource>;
  problem?: Partial<ProblemSpec> | null;
  collectionIds?: string[];
  variantOf?: string | null;
}

function parseSourceCode(value: unknown, field: string, v: Validator): SourceCode | null | undefined {
  if (value === null) return null;
  if (!isRecord(value) || typeof value.source !== 'string' || !isLanguage(value.language)) {
    v.add(field, 'must be null or { language, source } with a known language id');
    return undefined;
  }
  return { language: value.language, source: normaliseText(value.source) };
}

const between = (range: { min: number; max: number }) => `must be between ${range.min} and ${range.max}`;

/** Check a list of tags as stored (already normalised); returns the server's message for the first problem. */
export function tagsProblem(tags: readonly string[]): string | null {
  if (tags.length > LIMITS.maxTags) return `must contain at most ${LIMITS.maxTags} tags`;
  for (const tag of tags) {
    const problem = tagProblem(tag);
    if (problem) return `tag ${JSON.stringify(tag)} ${problem}`;
  }
  return null;
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.host !== '';
  } catch {
    return false;
  }
}

function parseProblem(value: Record<string, unknown>, v: Validator): Partial<ProblemSpec> {
  const out: Partial<ProblemSpec> = {};
  if (value.interface !== undefined) {
    if (value.interface !== 'program' && value.interface !== 'function') v.add('problem.interface', 'must be program or function');
    else out.interface = value.interface;
  }
  if (value.harness !== undefined) {
    const harness: Record<string, HarnessCode> = {};
    for (const [language, code] of Object.entries(isRecord(value.harness) ? value.harness : { '': null })) {
      if (!isLanguage(language) || !isRecord(code) || typeof code.prefix !== 'string' || typeof code.suffix !== 'string') {
        v.add('problem.harness', 'must map known language ids to { prefix, suffix }');
        break;
      }
      if (byteLength(code.prefix) > LIMITS.maxSourceBytes || byteLength(code.suffix) > LIMITS.maxSourceBytes) {
        v.add(`problem.harness.${language}`, `prefix and suffix must each be at most ${LIMITS.maxSourceBytes} bytes`);
        break;
      }
      harness[language] = { prefix: normaliseText(code.prefix), suffix: normaliseText(code.suffix) };
    }
    out.harness = harness;
  }
  if (value.timeLimitMs !== undefined) {
    const n = value.timeLimitMs;
    const range = LIMITS.timeLimitMs;
    if (typeof n !== 'number' || !Number.isInteger(n) || n < range.min || n > range.max) {
      v.add('problem.timeLimitMs', between(range));
    } else out.timeLimitMs = n;
  }
  if (value.memoryLimitKb !== undefined) {
    const n = value.memoryLimitKb;
    const range = LIMITS.memoryLimitKb;
    if (typeof n !== 'number' || !Number.isInteger(n) || n < range.min || n > range.max) {
      v.add('problem.memoryLimitKb', between(range));
    } else out.memoryLimitKb = n;
  }
  if (value.compare !== undefined) {
    if (!COMPARE.includes(value.compare as CompareMode)) v.add('problem.compare', 'must be tokens or exact');
    else out.compare = value.compare as CompareMode;
  }
  if (value.starterCode !== undefined) {
    const sc = value.starterCode;
    if (!isRecord(sc) || !Object.entries(sc).every(([k, src]) => isLanguage(k) && typeof src === 'string')) {
      v.add('problem.starterCode', 'must map known language ids to source text');
    } else {
      out.starterCode = Object.fromEntries(Object.entries(sc as Record<string, string>).map(([k, src]) => [k, normaliseText(src)]));
    }
  }
  if (value.referenceSolution !== undefined) {
    const ref = parseSourceCode(value.referenceSolution, 'problem.referenceSolution', v);
    if (ref !== undefined) out.referenceSolution = ref;
  }
  return out;
}

/** Validate whichever `ItemInput` fields are present. `self` is the item being patched, if any. */
function parseFields(db: MockDb, raw: Record<string, unknown>, v: Validator, self?: StoredItem): ParsedFields {
  const out: ParsedFields = {};
  const tooLarge = `must be at most ${LIMITS.maxTextBytes} bytes`;
  const text = (key: 'body' | 'notes') => {
    if (raw[key] === undefined) return;
    if (typeof raw[key] !== 'string') return v.add(key, 'must be a string');
    const value = normaliseText(raw[key]);
    if (byteLength(value) > LIMITS.maxTextBytes) v.add(key, tooLarge);
    else out[key] = value;
  };

  if (raw.title !== undefined) {
    const title = typeof raw.title === 'string' ? normaliseText(raw.title).trim() : '';
    if (title.length < 1) v.add('title', 'is required');
    else if (charCount(title) > LIMITS.maxTitleChars) v.add('title', atMostChars(LIMITS.maxTitleChars));
    else out.title = title;
  }
  if (raw.summary !== undefined) {
    if (typeof raw.summary !== 'string') v.add('summary', 'must be a string');
    else {
      const summary = normaliseText(raw.summary);
      if (charCount(summary) > LIMITS.maxSummaryChars) v.add('summary', atMostChars(LIMITS.maxSummaryChars));
      else out.summary = summary;
    }
  }
  text('body');
  text('notes');
  if (raw.difficulty !== undefined) {
    if (raw.difficulty !== null && !DIFFICULTIES.includes(raw.difficulty as Difficulty)) {
      v.add('difficulty', 'must be easy, medium, hard or null');
    } else out.difficulty = raw.difficulty as Difficulty | null;
  }
  if (raw.tags !== undefined) {
    if (!isStringArray(raw.tags)) v.add('tags', 'must be an array of strings');
    else {
      const tags = normaliseTags(raw.tags);
      const problem = tagsProblem(tags);
      if (problem) v.add('tags', problem);
      else out.tags = tags;
    }
  }
  if (raw.status !== undefined) {
    if (!STATUSES.includes(raw.status as ItemStatus)) v.add('status', 'must be todo, in_progress or done');
    else out.status = raw.status as ItemStatus;
  }
  if (raw.favorite !== undefined) {
    if (typeof raw.favorite !== 'boolean') v.add('favorite', 'must be a boolean');
    else out.favorite = raw.favorite;
  }
  if (raw.rawInput !== undefined) {
    if (raw.rawInput !== null && typeof raw.rawInput !== 'string') v.add('rawInput', 'must be a string or null');
    else if (raw.rawInput !== null && byteLength(normaliseText(raw.rawInput)) > LIMITS.maxTextBytes) v.add('rawInput', tooLarge);
    else out.rawInput = raw.rawInput === null ? null : normaliseText(raw.rawInput);
  }
  if (raw.source !== undefined) {
    if (!isRecord(raw.source)) v.add('source', 'must be an object');
    else {
      const source: Partial<ItemSource> = {};
      for (const key of ['url', 'note'] as const) {
        const value = raw.source[key];
        if (value === undefined) continue;
        if (value !== null && typeof value !== 'string') {
          v.add(`source.${key}`, 'must be a string or null');
          continue;
        }
        const text = value === null || value.trim() === '' ? null : normaliseText(value).trim();
        if (key === 'url' && text !== null) {
          if (!isHttpUrl(text)) v.add('source.url', 'must be an absolute http or https URL');
          else if (charCount(text) > LIMITS.maxSourceUrlChars) v.add('source.url', atMostChars(LIMITS.maxSourceUrlChars));
        }
        if (key === 'note' && text !== null && charCount(text) > LIMITS.maxSourceNoteChars) {
          v.add('source.note', atMostChars(LIMITS.maxSourceNoteChars));
        }
        source[key] = text;
      }
      out.source = source;
    }
  }
  if (raw.problem !== undefined) {
    if (raw.problem === null) out.problem = null;
    else if (!isRecord(raw.problem)) v.add('problem', 'must be an object or null');
    else out.problem = parseProblem(raw.problem, v);
  }
  if (raw.collectionIds !== undefined) {
    if (!isStringArray(raw.collectionIds)) v.add('collectionIds', 'must be an array of collection ids');
    else if (raw.collectionIds.some((id) => !db.collections.some((c) => c.id === id))) {
      v.add('collectionIds', 'contains an unknown collection id');
    } else out.collectionIds = [...new Set(raw.collectionIds)];
  }
  if (raw.variantOf !== undefined) {
    const id = raw.variantOf;
    if (id === null) out.variantOf = null;
    else if (typeof id !== 'string' || !db.items.has(id)) v.add('variantOf', 'must be the id of an existing item');
    else if (self && id === self.id) v.add('variantOf', 'cannot refer to the item itself');
    else out.variantOf = id;
  }
  return out;
}

/** Validate a `TestCaseInput`. With `partial`, `expectedStdout` is not required. */
export function parseTestCaseInput(
  raw: unknown,
  v: Validator,
  prefix = '',
  partial = false,
): Partial<TestCaseInput> {
  const out: Partial<TestCaseInput> = {};
  if (!isRecord(raw)) {
    v.add(prefix || 'body', 'must be an object');
    return out;
  }
  if (raw.name !== undefined) {
    if (typeof raw.name !== 'string') v.add(`${prefix}name`, 'must be a string');
    else if (charCount(raw.name) > LIMITS.maxTestCaseNameChars) v.add(`${prefix}name`, atMostChars(LIMITS.maxTestCaseNameChars));
    else out.name = normaliseText(raw.name);
  }
  // Input and expected output are stored byte for byte: no line-ending normalisation.
  for (const key of ['stdin', 'expectedStdout'] as const) {
    const value = raw[key];
    if (value === undefined) continue;
    if (typeof value !== 'string') v.add(prefix + key, 'must be a string');
    else if (byteLength(value) > LIMITS.maxTestDataBytes) v.add(prefix + key, `must be at most ${LIMITS.maxTestDataBytes} bytes`);
    else out[key] = value;
  }
  if (!partial && raw.expectedStdout === undefined) v.add(`${prefix}expectedStdout`, 'is required');
  for (const key of ['isSample', 'verified'] as const) {
    if (raw[key] === undefined) continue;
    if (typeof raw[key] !== 'boolean') v.add(prefix + key, 'must be a boolean');
    else out[key] = raw[key];
  }
  if (raw.origin !== undefined) {
    if (!ORIGINS.includes(raw.origin as TestOrigin)) v.add(`${prefix}origin`, 'must be manual, ai or import');
    else out.origin = raw.origin as TestOrigin;
  }
  // A generator prints the input. Given alone it is run here, and what it
  // printed is the case's stdin; on create, given with the stdin it printed,
  // both are stored as they are.
  const generator = raw.generator;
  if (generator === null) out.generator = null;
  else if (generator !== undefined) {
    if (!isRecord(generator) || !isLanguage(generator.language) || typeof generator.source !== 'string') {
      v.add(`${prefix}generator`, 'must be null or { language, source } with a known language id');
    } else if (raw.stdin !== undefined) {
      if (partial) v.add(`${prefix}generator`, 'cannot be given together with stdin');
      else out.generator = { language: generator.language, source: normaliseText(generator.source) };
    } else {
      const program = { language: generator.language, source: normaliseText(generator.source) };
      const printed = runGenerator(program);
      if (printed === null) v.add(`${prefix}generator`, 'did not run: the generator crashed');
      else if (byteLength(printed) > LIMITS.maxLargeInputBytes) v.add(`${prefix}generator`, `printed more than ${LIMITS.maxLargeInputBytes} bytes`);
      else {
        out.generator = program;
        out.stdin = printed;
      }
    }
  }
  return out;
}

export const tooManyCases = `must contain at most ${LIMITS.maxTestCasesPerItem} test cases`;

/** Append a test case to an item. Does not touch the item's revision or modification time. */
export function insertTestCase(db: MockDb, itemId: string, input: Partial<TestCaseInput>): TestCase {
  const now = db.now();
  const tc: TestCase = {
    id: uuid(),
    itemId,
    position: db.casesOf(itemId).length,
    name: input.name ?? '',
    stdin: input.stdin ?? '',
    expectedStdout: input.expectedStdout ?? '',
    isSample: input.isSample ?? false,
    origin: input.origin ?? 'manual',
    verified: input.verified ?? false,
    generator: input.generator ?? null,
    createdAt: now,
    updatedAt: now,
  };
  db.testCases.push(tc);
  return tc;
}

/** Replace an item's collection membership with exactly `collectionIds`. */
export function setMembership(db: MockDb, itemId: string, collectionIds: readonly string[]): void {
  for (const c of db.collections) {
    const wanted = collectionIds.includes(c.id);
    const member = c.itemIds.includes(itemId);
    if (wanted && !member) c.itemIds.push(itemId);
    if (!wanted && member) c.itemIds = c.itemIds.filter((x) => x !== itemId);
  }
}

// ---- Search -----------------------------------------------------------------

const words = (text: string) => text.toLowerCase().split(/[^\p{L}\p{N}+#]+/u).filter(Boolean);

/**
 * A small stand-in for full-text search: every query term must prefix-match
 * a word in the title, summary, body or tags. Returns 0 for no match,
 * otherwise a relevance score that favours title and tag hits.
 */
export function searchScore(item: StoredItem, terms: readonly string[]): number {
  const fields: [string[], number, number][] = [
    [words(item.title), 10, 3],
    [item.tags.flatMap(words), 6, 3],
    [words(item.summary), 4, 3],
    [words(item.body), 1, 5],
  ];
  let score = 0;
  for (const term of terms) {
    let termScore = 0;
    for (const [fieldWords, weight, cap] of fields) {
      const hits = fieldWords.filter((w) => w.startsWith(term)).length;
      termScore += Math.min(hits, cap) * weight;
    }
    if (termScore === 0) return 0;
    score += termScore;
  }
  return score;
}

const DIFFICULTY_RANK: Record<string, number> = { easy: 0, medium: 1, hard: 2 };

/** The filters of `GET /items` and `GET /items/facets`. */
function itemFilter(q: URLSearchParams) {
  return {
    text: (q.get('q') ?? '').trim(),
    type: enumParam(q, 'type', TYPES),
    statuses: enumListParam(q, 'status', STATUSES),
    difficulties: enumListParam<Difficulty | 'none'>(q, 'difficulty', [...DIFFICULTIES, 'none']),
    tags: normaliseTags(q.getAll('tag')),
    // Repeatable; unknown ids simply match nothing.
    ids: q.getAll('id').filter((id) => id !== ''),
    collectionId: q.get('collectionId') || undefined,
    recursive: boolParam(q, 'recursive') ?? false,
    uncollected: boolParam(q, 'uncollected') ?? false,
    variantOf: q.get('variantOf') || undefined,
    favorite: boolParam(q, 'favorite'),
  };
}

type ItemFilter = ReturnType<typeof itemFilter>;

/** The items a filter selects, with their search scores while searching. */
function matchItems(db: MockDb, f: ItemFilter) {
  let memberIds: string[] | null = null;
  if (f.collectionId) {
    const scope = [f.collectionId, ...(f.recursive ? db.descendants(f.collectionId) : [])];
    memberIds = db.collections.filter((c) => scope.includes(c.id)).flatMap((c) => c.itemIds);
  }
  const collected = new Set(db.collections.flatMap((c) => c.itemIds));
  const terms = words(f.text);
  const scores = new Map<string, number>();

  const matches = [...db.items.values()].filter((item) => {
    if (f.ids.length > 0 && !f.ids.includes(item.id)) return false;
    if (f.type && item.type !== f.type) return false;
    if (f.statuses.length > 0 && !f.statuses.includes(item.status)) return false;
    if (f.difficulties.length > 0 && !f.difficulties.includes(item.difficulty ?? 'none')) return false;
    if (!f.tags.every((t) => item.tags.includes(t))) return false;
    if (memberIds && !memberIds.includes(item.id)) return false;
    if (f.uncollected && collected.has(item.id)) return false;
    if (f.variantOf && item.variantOf !== f.variantOf) return false;
    if (f.favorite !== undefined && item.favorite !== f.favorite) return false;
    if (terms.length > 0) {
      const score = searchScore(item, terms);
      if (score === 0) return false;
      scores.set(item.id, score);
    }
    return true;
  });
  return { matches, scores, memberIds };
}

/** Counts by type, status and difficulty, each without its own filter, and by tag with every filter. */
function itemFacets(db: MockDb, req: Req) {
  const f = itemFilter(req.query);
  const out: ItemFacets = {
    byType: { problem: 0, reading: 0 },
    byStatus: { todo: 0, in_progress: 0, done: 0 },
    byDifficulty: { easy: 0, medium: 0, hard: 0, none: 0 },
    byTag: {},
  };
  for (const item of matchItems(db, { ...f, type: undefined }).matches) out.byType[item.type]++;
  for (const item of matchItems(db, { ...f, statuses: [] }).matches) out.byStatus[item.status]++;
  for (const item of matchItems(db, { ...f, difficulties: [] }).matches) out.byDifficulty[item.difficulty ?? 'none']++;
  for (const item of matchItems(db, f).matches) for (const t of item.tags) out.byTag[t] = (out.byTag[t] ?? 0) + 1;
  return ok(out);
}

function listItems(db: MockDb, req: Req) {
  const q = req.query;
  const f = itemFilter(q);
  const sort = enumParam(q, 'sort', SORTS) ?? 'updated';
  const order = enumParam(q, 'order', ['asc', 'desc'] as const);
  const { limit, offset } = pagination(q, LIMITS.maxPageSize);

  if (sort === 'position' && (!f.collectionId || f.recursive)) {
    throw badRequest('sort=position requires a non-recursive collectionId');
  }
  if (sort === 'relevance' && f.text === '') throw badRequest('sort=relevance requires q');

  const { matches, scores, memberIds } = matchItems(db, f);

  // Dates and relevance read best newest/strongest first; everything else ascending.
  const descending = (order ?? (sort === 'updated' || sort === 'created' || sort === 'relevance' ? 'desc' : 'asc')) === 'desc';
  const recency = (a: StoredItem, b: StoredItem) =>
    a.updatedAt === b.updatedAt ? b.seq - a.seq : a.updatedAt < b.updatedAt ? 1 : -1;
  const compare = (a: StoredItem, b: StoredItem): number => {
    switch (sort) {
      case 'updated':
        return a.updatedAt === b.updatedAt ? a.seq - b.seq : a.updatedAt < b.updatedAt ? -1 : 1;
      case 'created':
        return a.createdAt === b.createdAt ? a.seq - b.seq : a.createdAt < b.createdAt ? -1 : 1;
      case 'title':
        return a.title.localeCompare(b.title, 'en', { sensitivity: 'base' });
      case 'difficulty': {
        // Items without a difficulty sort after every graded one, in either direction.
        const ra = a.difficulty ? DIFFICULTY_RANK[a.difficulty]! : null;
        const rb = b.difficulty ? DIFFICULTY_RANK[b.difficulty]! : null;
        if (ra === null || rb === null) return ra === rb ? 0 : (ra === null ? 1 : -1) * (descending ? -1 : 1);
        return ra - rb;
      }
      case 'position':
        return memberIds!.indexOf(a.id) - memberIds!.indexOf(b.id);
      case 'relevance':
        return (scores.get(a.id) ?? 0) - (scores.get(b.id) ?? 0);
    }
  };
  matches.sort((a, b) => {
    const primary = compare(a, b) * (descending ? -1 : 1);
    return primary !== 0 ? primary : recency(a, b);
  });

  return ok({
    items: matches.slice(offset, offset + limit).map((item) => db.summary(item)),
    total: matches.length,
  });
}

// ---- Create, update, delete ---------------------------------------------------

export function createItem(db: MockDb, req: Req) {
  const raw = objectBody(req);
  const v = new Validator();
  if (!TYPES.includes(raw.type as ItemType)) v.add('type', 'must be problem or reading');
  if (raw.title === undefined) v.add('title', 'is required');
  const type = raw.type as ItemType;
  const fields = parseFields(db, raw, v);

  const cases: Partial<TestCaseInput>[] = [];
  if (raw.testCases !== undefined) {
    if (!Array.isArray(raw.testCases)) v.add('testCases', 'must be an array');
    else if (type === 'reading' && raw.testCases.length > 0) v.add('testCases', 'are not allowed on a reading');
    else if (raw.testCases.length > LIMITS.maxTestCasesPerItem) v.add('testCases', tooManyCases);
    else raw.testCases.forEach((tc, i) => cases.push(parseTestCaseInput(tc, v, `testCases.${i}.`)));
  }
  if (type === 'reading' && fields.problem != null) v.add('problem', 'must be null for a reading');
  // The reference solution is not stored on the item: it becomes its first saved solution.
  const { referenceSolution, ...problem } = fields.problem ?? {};
  checkHarness({ ...DEFAULT_PROBLEM, ...problem }, v);
  v.check();

  const now = db.now();
  const item: StoredItem = {
    id: uuid(),
    type,
    title: fields.title!,
    summary: fields.summary ?? '',
    body: fields.body ?? '',
    difficulty: fields.difficulty ?? null,
    tags: fields.tags ?? [],
    status: fields.status ?? 'todo',
    favorite: fields.favorite ?? false,
    notes: fields.notes ?? '',
    rawInput: fields.rawInput ?? null,
    source: { url: fields.source?.url ?? null, note: fields.source?.note ?? null },
    problem: type === 'problem' ? { ...structuredClone(DEFAULT_PROBLEM), ...problem } : null,
    variantOf: fields.variantOf ?? null,
    revision: 1,
    createdAt: now,
    updatedAt: now,
    seq: db.nextSeq(),
  };
  db.items.set(item.id, item);
  if (referenceSolution) db.writeReference(item.id, referenceSolution);
  for (const tc of cases) insertTestCase(db, item.id, tc);
  if (fields.collectionIds) setMembership(db, item.id, fields.collectionIds);
  return created(db.full(item));
}

/** Only a `function` problem has a harness. Checked on the problem as it would be stored. */
function checkHarness(problem: Pick<ProblemSpec, 'interface' | 'harness'>, v: Validator): void {
  if (problem.interface === 'program' && Object.keys(problem.harness).length > 0) {
    v.add('problem.harness', 'must be empty for a program problem');
  }
}

/** Fail with the contract's revision conflict when `expectedRevision` is stale. */
export function checkRevision(item: StoredItem, raw: Record<string, unknown>): void {
  const expected = raw.expectedRevision;
  if (expected === undefined || expected === null) return;
  if (typeof expected !== 'number' || !Number.isInteger(expected)) {
    throw invalid('expectedRevision', 'must be an integer');
  }
  if (expected !== item.revision) {
    throw conflict(`the item has changed since revision ${expected} (current revision is ${item.revision})`, {
      revision: item.revision,
    });
  }
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Run the reference solution of a problem that is not saved yet on its test
 * cases. Validated as `POST /items` validates them; other keys are ignored.
 */
async function checkItem(db: MockDb, req: Req) {
  const raw = objectBody(req);
  const v = new Validator();
  let problem: Partial<ProblemSpec> = {};
  if (raw.type !== undefined && raw.type !== 'problem') v.add('type', 'must be problem');
  if (!isRecord(raw.problem)) v.add('problem', 'is required');
  else problem = parseProblem(raw.problem, v);
  const cases: Partial<TestCaseInput>[] = [];
  if (raw.testCases !== undefined) {
    if (!Array.isArray(raw.testCases)) v.add('testCases', 'must be an array');
    else if (raw.testCases.length > LIMITS.maxTestCasesPerItem) v.add('testCases', tooManyCases);
    else raw.testCases.forEach((tc, i) => cases.push(parseTestCaseInput(tc, v, `testCases.${i}.`)));
  }
  const { referenceSolution = null, ...rest } = problem;
  const spec = { ...structuredClone(DEFAULT_PROBLEM), ...rest, referenceSolution };
  checkHarness(spec, v);
  v.check();
  // As long as the cases take to run.
  if (db.options.judge === 'ok' && referenceSolution) await sleep(cases.length * db.delay('verifyCase'));
  return ok(checkProblem(db, spec, cases.map((c) => ({ name: c.name ?? '', stdin: c.stdin ?? '', expectedStdout: c.expectedStdout ?? '' }))));
}

function patchItem(db: MockDb, req: Req) {
  const item = db.getItem(req.params.id!);
  const raw = objectBody(req);
  const v = new Validator();
  if (raw.type !== undefined && raw.type !== item.type) v.add('type', 'cannot be changed after creation');
  if (raw.testCases !== undefined) v.add('testCases', 'is accepted on create only; use the test case endpoints');
  const fields = parseFields(db, raw, v, item);
  if (item.type === 'reading' && fields.problem != null) v.add('problem', 'must be null for a reading');
  if (item.type === 'problem' && fields.problem === null) v.add('problem', 'cannot be null for a problem');
  if (item.problem && fields.problem) checkHarness({ ...item.problem, ...fields.problem }, v);
  v.check();
  checkRevision(item, raw);

  // The revision goes up only when a content field actually changes; a
  // request that leaves every one of them as it was changes nothing. What
  // `problem.referenceSolution` reports is such a field, although the
  // solution behind it is stored on its own.
  const content = () =>
    JSON.stringify([item.title, item.summary, item.body, item.difficulty, item.tags, item.source, item.problem, item.variantOf, db.referenceView(item.id)]);
  const before = content();
  const { referenceSolution, ...problem } = fields.problem ?? {};
  // First, because it is the one step that can still fail (the item may be full).
  if (referenceSolution !== undefined && item.problem) db.writeReference(item.id, referenceSolution);
  if (fields.title !== undefined) item.title = fields.title;
  if (fields.summary !== undefined) item.summary = fields.summary;
  if (fields.body !== undefined) item.body = fields.body;
  if (fields.difficulty !== undefined) item.difficulty = fields.difficulty;
  if (fields.tags !== undefined) item.tags = fields.tags;
  if (fields.source) item.source = { ...item.source, ...fields.source };
  if (fields.problem && item.problem) item.problem = { ...item.problem, ...problem };
  if (fields.variantOf !== undefined) item.variantOf = fields.variantOf;
  if (before !== content()) db.touch(item);

  // Personal state and membership change neither the revision nor `updatedAt`.
  if (fields.status !== undefined) item.status = fields.status;
  if (fields.favorite !== undefined) item.favorite = fields.favorite;
  if (fields.notes !== undefined) item.notes = fields.notes;
  if (fields.rawInput !== undefined) item.rawInput = fields.rawInput;
  if (fields.collectionIds) setMembership(db, item.id, fields.collectionIds);
  return ok(db.full(item));
}

function editItemText(db: MockDb, req: Req) {
  const item = db.getItem(req.params.id!);
  const raw = objectBody(req);
  const field = raw.field;
  if (field !== 'body' && field !== 'notes') throw invalid('field', 'must be body or notes');
  if (!Array.isArray(raw.edits) || raw.edits.length === 0) throw invalid('edits', 'must be a non-empty array');
  checkRevision(item, raw);

  let text = item[field];
  raw.edits.forEach((edit: unknown, i: number) => {
    if (!isRecord(edit) || typeof edit.oldText !== 'string' || typeof edit.newText !== 'string') {
      throw invalid(`edits.${i}`, 'must be { oldText, newText }');
    }
    if (edit.oldText === '') throw invalid(`edits.${i}`, 'oldText must not be empty');
    const occurrences = text.split(edit.oldText).length - 1;
    if (occurrences !== 1) {
      throw invalid(
        `edits.${i}`,
        occurrences === 0 ? 'oldText was not found' : `oldText occurs ${occurrences} times; it must occur exactly once`,
      );
    }
    text = text.replace(edit.oldText, () => edit.newText as string);
  });
  text = normaliseText(text);
  if (byteLength(text) > LIMITS.maxTextBytes) throw invalid(field, `must be at most ${LIMITS.maxTextBytes} bytes`);

  if (text !== item[field]) {
    item[field] = text;
    if (field === 'body') db.touch(item);
  }
  return ok(db.full(item));
}

function bulk(db: MockDb, req: Req) {
  const raw = objectBody(req);
  if (!isStringArray(raw.ids)) throw invalid('ids', 'must be an array of item ids');
  const items = [...new Set(raw.ids)].flatMap((id) => {
    const item = db.items.get(id);
    return item ? [item] : [];
  });

  switch (raw.action) {
    case 'delete':
      for (const item of items) db.deleteItem(item.id);
      break;
    case 'addTags':
    case 'removeTags': {
      if (!isStringArray(raw.tags)) throw invalid('tags', 'must be an array of strings');
      const tags = normaliseTags(raw.tags);
      const problem = tagsProblem(tags);
      if (problem) throw invalid('tags', problem);
      const next = (current: string[]) =>
        raw.action === 'addTags' ? normaliseTags([...current, ...tags]) : current.filter((t) => !tags.includes(t));
      if (items.some((item) => next(item.tags).length > LIMITS.maxTags)) {
        throw invalid('tags', `must contain at most ${LIMITS.maxTags} tags`);
      }
      for (const item of items) {
        const updated = next(item.tags);
        if (!same(updated, item.tags)) {
          item.tags = updated;
          db.touch(item);
        }
      }
      break;
    }
    case 'setStatus':
      if (!STATUSES.includes(raw.status as ItemStatus)) throw invalid('status', 'must be todo, in_progress or done');
      for (const item of items) item.status = raw.status as ItemStatus;
      break;
    case 'setFavorite':
      if (typeof raw.favorite !== 'boolean') throw invalid('favorite', 'must be a boolean');
      for (const item of items) item.favorite = raw.favorite;
      break;
    case 'addToCollection':
    case 'removeFromCollection': {
      const collection = db.collections.find((c) => c.id === raw.collectionId);
      if (!collection) throw invalid('collectionId', 'must be the id of an existing collection');
      for (const item of items) {
        const member = collection.itemIds.includes(item.id);
        if (raw.action === 'addToCollection' && !member) collection.itemIds.push(item.id);
        if (raw.action === 'removeFromCollection' && member) {
          collection.itemIds = collection.itemIds.filter((x) => x !== item.id);
        }
      }
      break;
    }
    default:
      throw invalid('action', 'is not a known bulk action');
  }
  // The number of the given ids that exist, whether or not the action changed them.
  return ok({ affected: items.length });
}

function stats(db: MockDb) {
  const submits = db.submissions.filter((s) => s.mode === 'submit');
  const out: Stats = {
    items: {
      total: db.items.size,
      byType: { problem: 0, reading: 0 },
      byStatus: { todo: 0, in_progress: 0, done: 0 },
      byDifficulty: { easy: 0, medium: 0, hard: 0, none: 0 },
      favorites: 0,
      uncollected: 0,
    },
    collections: db.collections.length,
    tags: new Set([...db.items.values()].flatMap((i) => i.tags)).size,
    // Runs are not attempts at the problem, so only submits count.
    submissions: {
      total: submits.length,
      accepted: submits.filter((s) => s.verdict === 'accepted').length,
    },
  };
  // The same tests as the `favorite` and `uncollected` filters of the item list.
  const collected = new Set(db.collections.flatMap((c) => c.itemIds));
  for (const item of db.items.values()) {
    out.items.byType[item.type]++;
    out.items.byStatus[item.status]++;
    out.items.byDifficulty[item.difficulty ?? 'none']++;
    if (item.favorite) out.items.favorites++;
    if (!collected.has(item.id)) out.items.uncollected++;
  }
  return ok(out);
}

export function itemRoutes(db: MockDb): [string, string, Handler][] {
  return [
    ['GET', '/meta', () => ok(db.meta())],
    ['GET', '/stats', () => stats(db)],
    ['GET', '/items', (req) => listItems(db, req)],
    ['POST', '/items', (req) => createItem(db, req)],
    ['POST', '/items/bulk', (req) => bulk(db, req)],
    ['POST', '/items/check', (req) => checkItem(db, req)],
    ['GET', '/items/facets', (req) => itemFacets(db, req)],
    ['GET', '/items/:id', (req) => ok(db.full(db.getItem(req.params.id!)))],
    ['PATCH', '/items/:id', (req) => patchItem(db, req)],
    ['POST', '/items/:id/edits', (req) => editItemText(db, req)],
    [
      'DELETE',
      '/items/:id',
      (req) => {
        db.deleteItem(db.getItem(req.params.id!).id);
        return noContent();
      },
    ],
  ];
}
