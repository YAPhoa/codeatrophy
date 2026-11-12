import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { api, ApiError, setTransport } from '../api/client';
import type { Submission } from '../api/types';
import type { MockOptions, MockServer } from './index';
import { JUDGE_LANGUAGES, LIMITS } from './db';
import { buildBundleZip, createMockServer, optionsFromFlags, seedIds } from './index';

let server: MockServer;

function start(options: MockOptions = {}): MockServer {
  server = createMockServer({ speed: 'instant', ...options });
  setTransport(server.fetch);
  return server;
}

/** Resolve to the ApiError a call is expected to fail with. */
async function failure(promise: Promise<unknown>): Promise<ApiError> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof ApiError) return err;
    throw err;
  }
  throw new Error('expected the call to fail');
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Poll a submission until judging finishes, collecting every state seen on the way. */
async function judged(id: string): Promise<{ final: Submission; seen: Submission[] }> {
  const seen: Submission[] = [];
  for (let i = 0; i < 200; i++) {
    const s = await api.submissions.get(id);
    seen.push(s);
    if (s.status === 'completed') return { final: s, seen };
    await tick();
  }
  throw new Error('submission never completed');
}

const zipFile = (bytes: Uint8Array<ArrayBuffer>, name = 'bundle.codeathropy.zip') =>
  new File([bytes], name, { type: 'application/zip' });

async function exportAll(): Promise<File> {
  const { blob, filename } = await api.bundle.export({ scope: 'all', includeSolutions: true, includeHiddenTests: true });
  return new File([blob], filename ?? 'export.zip');
}

beforeEach(() => {
  start();
});

afterEach(() => {
  setTransport(() => Promise.reject(new Error('no transport')));
});

describe('meta and stats', () => {
  it('reports capabilities for the default scenario', async () => {
    const meta = await api.meta();
    expect(meta.ai).toEqual({ enabled: true, provider: 'anthropic', model: 'claude-opus-5-5' });
    expect(meta.judge.enabled).toBe(true);
    expect(meta.judge.healthy).toBe(true);
    expect(meta.judge.languages.map((l) => l.id)).toContain('python');
    expect(meta.mcp).toEqual({ enabled: true, path: '/mcp', url: null, authRequired: false });
  });

  it('publishes every limit and the engine\'s real toolchains', async () => {
    const meta = await api.meta();
    expect(meta.limits).toEqual(LIMITS);
    expect(meta.limits).toMatchObject({
      maxImportBytes: 52428800,
      maxImportUncompressedBytes: 209715200,
      maxImportEntries: 20000,
      maxRequestBytes: 33554432,
      maxPageSize: 200,
      maxSourceBytes: 65536,
      maxTitleChars: 200,
      maxSummaryChars: 5000,
      maxTextBytes: 1048576,
      maxSourceUrlChars: 2048,
      maxSourceNoteChars: 2000,
      maxTags: 30,
      maxTagChars: 40,
      maxCollectionNameChars: 200,
      maxCollectionDescriptionChars: 5000,
      timeLimitMs: { min: 100, max: 30000 },
      memoryLimitKb: { min: 16384, max: 2097152 },
      maxTestCasesPerItem: 1000,
      maxTestDataBytes: 8388608,
      maxTestCaseNameChars: 200,
      maxDraftTextChars: 50000,
      maxInstructionChars: 2000,
      maxPreviousDraftBytes: 2097152,
      maxGeneratedTestCases: 30,
      maxStylePresets: 20,
      maxStyleNameChars: 60,
      maxStyleInstructionsChars: 2000,
      maxModelIdChars: 200,
      maxApiKeyChars: 1000,
      maxBundleNameChars: 200,
      maxBundleDescriptionChars: 5000,
    });
    expect(Object.keys(meta.limits)).toHaveLength(31);
    expect(meta.judge.languages).toEqual(JUDGE_LANGUAGES);
    expect(meta.judge.languages.map((l) => `${l.id} ${l.version}`)).toEqual([
      'c GCC 9.2.0',
      'cpp GCC 9.2.0',
      'csharp Mono 6.6.0.161',
      'go 1.13.5',
      'java OpenJDK 13.0.1',
      'javascript Node.js 12.14.0',
      'kotlin 1.3.70',
      'python 3.8.1',
      'ruby 2.7.0',
      'rust 1.40.0',
      'typescript 3.7.4',
    ]);
  });

  it('reports the public MCP URL when one is configured', async () => {
    start(optionsFromFlags(['mcp-url', 'instant']));
    expect((await api.meta()).mcp.url).toBe('https://library.example.org/mcp');
  });

  it('reflects scenario flags', async () => {
    start(optionsFromFlags(['no-ai', 'no-judge', 'mcp-token', 'empty', 'instant']));
    const meta = await api.meta();
    expect(meta.ai).toEqual({ enabled: false, provider: null, model: null });
    expect(meta.judge).toEqual({ enabled: false, engine: 'none', healthy: false, languages: [] });
    expect(meta.mcp.authRequired).toBe(true);
    expect((await api.items.list()).total).toBe(0);
    expect((await api.styles.list()).items).toEqual([]);

    start({ judge: 'down' });
    const down = (await api.meta()).judge;
    expect(down.enabled).toBe(true);
    expect(down.healthy).toBe(false);
    expect(down.languages.length).toBeGreaterThan(0);
  });

  it('counts the seed library with every enum key present', async () => {
    const stats = await api.stats();
    expect(stats.items.total).toBe(24);
    expect(stats.items.byType).toEqual({ problem: 16, reading: 8 });
    expect(stats.items.byStatus.todo + stats.items.byStatus.in_progress + stats.items.byStatus.done).toBe(24);
    expect(Object.keys(stats.items.byDifficulty).sort()).toEqual(['easy', 'hard', 'medium', 'none']);
    expect(stats.collections).toBe(8);
    expect(stats.submissions.total).toBeGreaterThan(10);
  });
});

describe('listing items', () => {
  it('paginates and reports the total before pagination', async () => {
    const page = await api.items.list({ limit: 5, offset: 20 });
    expect(page.total).toBe(24);
    expect(page.items).toHaveLength(4);
    expect((await failure(api.items.list({ limit: 500 }))).code).toBe('bad_request');
  });

  it('defaults to most recently updated first', async () => {
    const { items } = await api.items.list();
    const stamps = items.map((i) => i.updatedAt);
    expect(stamps).toEqual([...stamps].sort().reverse());
  });

  it('combines filters with AND, and repeats with OR', async () => {
    const readings = await api.items.list({ type: 'reading' });
    expect(readings.total).toBe(8);
    expect(readings.items.every((i) => i.testCaseCount === 0 && i.lastVerdict === null)).toBe(true);

    const open = await api.items.list({ type: 'problem', status: ['todo', 'in_progress'] });
    expect(open.items.every((i) => i.status !== 'done')).toBe(true);

    const ungraded = await api.items.list({ type: 'problem', difficulty: ['none'] });
    expect(ungraded.items.map((i) => i.id).sort()).toEqual(
      [seedIds.items.kthLargestStream, seedIds.items.trappingRainWater, seedIds.items.rateLimiter].sort(),
    );

    const both = await api.items.list({ tag: ['array', 'hash-map'] });
    expect(both.items.every((i) => i.tags.includes('array') && i.tags.includes('hash-map'))).toBe(true);
    expect(both.total).toBeGreaterThan(0);
    expect(both.total).toBeLessThan((await api.items.list({ tag: ['array'] })).total);

    const favorites = await api.items.list({ favorite: true });
    expect(favorites.items.every((i) => i.favorite)).toBe(true);
  });

  it('filters by collection, optionally with descendants, and by no collection', async () => {
    const direct = await api.items.list({ collectionId: seedIds.collections.interviewPrep });
    const recursive = await api.items.list({ collectionId: seedIds.collections.interviewPrep, recursive: true });
    expect(recursive.total).toBeGreaterThan(direct.total);

    const uncollected = await api.items.list({ uncollected: true });
    expect(uncollected.total).toBe(4);
    expect(uncollected.items.every((i) => i.collectionIds.length === 0)).toBe(true);
  });

  it('returns the collection order for sort=position and rejects it elsewhere', async () => {
    const id = seedIds.collections.weeklyPractice;
    const before = await api.items.list({ collectionId: id, sort: 'position' });
    const reversed = before.items.map((i) => i.id).reverse();
    await api.collections.setItems(id, reversed);
    const after = await api.items.list({ collectionId: id, sort: 'position' });
    expect(after.items.map((i) => i.id)).toEqual(reversed);

    expect((await failure(api.items.list({ sort: 'position' }))).status).toBe(400);
    expect((await failure(api.items.list({ collectionId: id, recursive: true, sort: 'position' }))).status).toBe(400);
    expect((await failure(api.items.list({ sort: 'relevance' }))).status).toBe(400);
  });

  it('searches title, summary, body and tags, ranking title hits first', async () => {
    const hits = await api.items.list({ q: 'hashing', sort: 'relevance' });
    expect(hits.items[0]?.id).toBe(seedIds.items.consistentHashing);
    const byTag = await api.items.list({ q: 'sliding-window' });
    expect(byTag.items.map((i) => i.id)).toContain(seedIds.items.longestSubstring);
    expect((await api.items.list({ q: 'zzzznotaword' })).total).toBe(0);
  });

  it('fetches specific items with a repeatable id filter', async () => {
    const { twoSum, lis, capTheorem } = seedIds.items;
    const some = await api.items.list({ id: [twoSum, capTheorem, '00000000-0000-4000-8000-000000000000'] });
    expect(some.total).toBe(2);
    expect(some.items.map((i) => i.id).sort()).toEqual([twoSum, capTheorem].sort());
    // Combined with the other filters by AND.
    expect((await api.items.list({ id: [twoSum, lis, capTheorem], type: 'reading' })).items.map((i) => i.id)).toEqual([capTheorem]);
  });

  it('puts the best match first by default and rejects out-of-range pages', async () => {
    const best = await api.items.list({ q: 'tree', sort: 'relevance' });
    const worst = await api.items.list({ q: 'tree', sort: 'relevance', order: 'asc' });
    expect(best.total).toBeGreaterThan(1);
    expect(best.items[0]?.id).toBe(worst.items[worst.items.length - 1]?.id);

    for (const params of [{ limit: 0 }, { limit: 201 }, { offset: -1 }]) {
      const err = await failure(api.items.list(params));
      expect(err.status).toBe(400);
      expect(err.code).toBe('bad_request');
    }
    expect((await api.items.list({ limit: 200 })).items.length).toBeGreaterThan(0);
  });

  it('links variants to their origin', async () => {
    const origin = await api.items.get(seedIds.items.twoSum);
    expect(origin.variantCount).toBe(2);
    const variants = await api.items.list({ variantOf: origin.id });
    expect(variants.items.map((i) => i.id).sort()).toEqual([seedIds.items.twoSumSorted, seedIds.items.countPairs].sort());

    await api.items.remove(origin.id);
    expect((await api.items.get(seedIds.items.twoSumSorted)).variantOf).toBeNull();
    expect((await failure(api.items.get(origin.id))).code).toBe('not_found');
  });
});

describe('creating and editing items', () => {
  it('applies defaults and saves test cases atomically', async () => {
    const item = await api.items.create({
      type: 'problem',
      title: '  Sum of Digits ',
      tags: ['Math', ' math ', 'Easy-Ones'],
      testCases: [{ name: 'Example 1', stdin: '12\n', expectedStdout: '3\n', isSample: true, origin: 'ai' }],
    });
    expect(item.title).toBe('Sum of Digits');
    expect(item.tags).toEqual(['easy-ones', 'math']);
    expect(item.revision).toBe(1);
    expect(item.status).toBe('todo');
    expect(item.rawInput).toBeNull();
    expect(item.source).toEqual({ url: null, note: null });
    expect(item.problem).toEqual({
      timeLimitMs: 2000,
      memoryLimitKb: 262144,
      compare: 'tokens',
      starterCode: {},
      referenceSolution: null,
    });
    expect(item.testCaseCount).toBe(1);
    const cases = await api.testCases.list(item.id);
    expect(cases.items[0]).toMatchObject({ origin: 'ai', isSample: true, verified: false, position: 0 });

    const reading = await api.items.create({ type: 'reading', title: 'A note' });
    expect(reading.problem).toBeNull();
  });

  it('validates input with per-field messages', async () => {
    const err = await failure(
      api.items.create({ type: 'problem', title: '', problem: { timeLimitMs: 5 }, tags: ['x'.repeat(41)] }),
    );
    expect(err.status).toBe(422);
    expect(err.code).toBe('validation_failed');
    expect(Object.keys(err.fields).sort()).toEqual(['problem.timeLimitMs', 'tags', 'title']);
    expect(err.fields['problem.timeLimitMs']).toBe('must be between 100 and 30000');
  });

  it('enforces the published limits with the server\'s field keys', async () => {
    const err = await failure(
      api.items.create({
        type: 'problem',
        title: 't'.repeat(201),
        summary: 's'.repeat(5001),
        body: 'b'.repeat(LIMITS.maxTextBytes + 1),
        tags: ['a/b'],
        source: { url: 'ftp://example.org/x', note: 'n'.repeat(2001) },
        problem: { memoryLimitKb: 1 },
        testCases: [{ name: 'x' } as never],
      }),
    );
    expect(err.status).toBe(422);
    expect(err.fields).toMatchObject({
      title: 'must be at most 200 characters',
      summary: 'must be at most 5000 characters',
      tags: 'tag "a/b" must not contain / or control characters',
      'source.url': 'must be an absolute http or https URL',
      'source.note': 'must be at most 2000 characters',
      'problem.memoryLimitKb': 'must be between 16384 and 2097152',
      'testCases.0.expectedStdout': 'is required',
    });
    expect(err.fields).toHaveProperty('body');

    const id = seedIds.items.twoSum;
    expect((await failure(api.items.update(id, { notes: 'n'.repeat(LIMITS.maxTextBytes + 1) }))).fields).toHaveProperty('notes');
    expect((await failure(api.items.update(id, { tags: ['bell\u0007'] }))).fields).toHaveProperty('tags');
    expect((await failure(api.items.update(id, { tags: Array.from({ length: 31 }, (_, i) => `t${i}`) }))).fields).toHaveProperty('tags');
    const tooMany = Array.from({ length: LIMITS.maxTestCasesPerItem + 1 }, () => ({ expectedStdout: '' }));
    expect((await failure(api.items.create({ type: 'problem', title: 'Many', testCases: tooMany }))).fields).toHaveProperty('testCases');
  });

  it('normalises line endings everywhere except test data', async () => {
    const item = await api.items.create({
      type: 'problem',
      title: 'CRLF',
      body: 'a\r\nb\rc',
      notes: 'n\r\n',
      problem: { referenceSolution: { language: 'python', source: 'print(1)\r\n' }, starterCode: { python: 'x\r\n' } },
      testCases: [{ name: 'n', stdin: '1\r\n', expectedStdout: '2\r\n' }],
    });
    expect(item.body).toBe('a\nb\nc');
    expect(item.notes).toBe('n\n');
    expect(item.problem?.referenceSolution?.source).toBe('print(1)\n');
    expect(item.problem?.starterCode.python).toBe('x\n');
    const [tc] = (await api.testCases.list(item.id)).items;
    expect(tc).toMatchObject({ stdin: '1\r\n', expectedStdout: '2\r\n' });
  });

  it('merges PATCH bodies and bumps the revision only for content', async () => {
    const id = seedIds.items.twoSum;
    const before = await api.items.get(id);

    const personal = await api.items.update(id, { status: 'todo', favorite: false, notes: 'x', collectionIds: [] });
    expect(personal.revision).toBe(before.revision);
    expect(personal.updatedAt).toBe(before.updatedAt);
    expect(personal.collectionIds).toEqual([]);

    // A request that leaves every content field as it was changes nothing either.
    const noop = await api.items.update(id, { title: before.title, tags: before.tags, problem: { timeLimitMs: before.problem!.timeLimitMs } });
    expect(noop.revision).toBe(before.revision);
    expect(noop.updatedAt).toBe(before.updatedAt);

    const content = await api.items.update(id, {
      problem: { timeLimitMs: 1000 },
      source: { note: 'from memory' },
      difficulty: null,
    });
    expect(content.revision).toBe(before.revision + 1);
    expect(content.updatedAt > before.updatedAt).toBe(true);
    expect(content.problem?.timeLimitMs).toBe(1000);
    expect(content.problem?.memoryLimitKb).toBe(before.problem?.memoryLimitKb);
    expect(content.problem?.starterCode).toEqual(before.problem?.starterCode);
    expect(content.source).toEqual({ url: null, note: 'from memory' });
    expect(content.difficulty).toBeNull();
    expect(content.title).toBe(before.title);
  });

  it('rejects a stale expectedRevision without writing', async () => {
    const id = seedIds.items.coinChange;
    const item = await api.items.get(id);
    server.externalEdit(id);

    const err = await failure(api.items.update(id, { title: 'Mine', expectedRevision: item.revision }));
    expect(err.status).toBe(409);
    expect(err.isRevisionConflict).toBe(true);
    expect(err.currentRevision).toBe(item.revision + 1);

    const current = await api.items.get(id);
    expect(current.title).toBe(`${item.title} (edited elsewhere)`);
    const saved = await api.items.update(id, { title: 'Mine', expectedRevision: current.revision });
    expect(saved.title).toBe('Mine');
    expect(saved.revision).toBe(current.revision + 1);
  });

  it('applies targeted text edits, all or nothing', async () => {
    const id = seedIds.items.twoSum;
    const before = await api.items.get(id);
    const edited = await api.items.edits(id, {
      field: 'body',
      expectedRevision: before.revision,
      edits: [{ oldText: '2 \\le n \\le 10^5', newText: '2 \\le n \\le 10^6' }],
    });
    expect(edited.body).toContain('10^6');
    expect(edited.revision).toBe(before.revision + 1);

    const err = await failure(
      api.items.edits(id, {
        field: 'body',
        edits: [
          { oldText: '10^6', newText: '10^7' },
          { oldText: 'no such text', newText: '' },
        ],
      }),
    );
    expect(err.status).toBe(422);
    expect(Object.keys(err.fields)).toEqual(['edits.1']);
    expect((await api.items.get(id)).body).toBe(edited.body);
  });

  it('applies bulk actions and ignores unknown ids', async () => {
    const ids = [seedIds.items.lis, seedIds.items.editDistance, 'missing'];
    expect(await api.items.bulk({ ids, action: 'addTags', tags: ['Revisit'] })).toEqual({ affected: 2 });
    expect((await api.items.get(seedIds.items.lis)).tags).toContain('revisit');
    await api.items.bulk({ ids, action: 'setStatus', status: 'done' });
    await api.items.bulk({ ids, action: 'addToCollection', collectionId: seedIds.collections.weeklyPractice });
    const item = await api.items.get(seedIds.items.editDistance);
    expect(item.status).toBe('done');
    expect(item.collectionIds).toContain(seedIds.collections.weeklyPractice);
    await api.items.bulk({ ids, action: 'delete' });
    expect((await api.items.list()).total).toBe(22);
  });
});

describe('test cases', () => {
  it('resets verified when the input or expected output is edited', async () => {
    const itemId = seedIds.items.twoSum;
    const [first, second] = (await api.testCases.list(itemId)).items;
    expect(first?.verified).toBe(true);

    const renamed = await api.testCases.update(first!.id, { name: 'Renamed' });
    expect(renamed.verified).toBe(true);
    const edited = await api.testCases.update(first!.id, { expectedStdout: '1 0\n' });
    expect(edited.verified).toBe(false);
    expect(second?.verified).toBe(true);
    // Sending the stored value back is not an edit.
    const same = await api.testCases.update(second!.id, { stdin: second!.stdin, expectedStdout: second!.expectedStdout });
    expect(same.verified).toBe(true);
    const kept = await api.testCases.update(second!.id, { stdin: `${second!.stdin}\n`, verified: true });
    expect(kept.verified).toBe(true);
  });

  it('moves updatedAt but never the revision', async () => {
    const itemId = seedIds.items.lis;
    const before = await api.items.get(itemId);
    const cases = (await api.testCases.list(itemId)).items;

    const added = await api.testCases.create(itemId, { name: 'extra', stdin: '1\n5\n', expectedStdout: '1\n' });
    await api.testCases.update(added.id, { expectedStdout: '2\n' });
    await api.testCases.reorder(itemId, [added.id, ...cases.map((c) => c.id)]);
    await api.testCases.bulk(itemId, { cases: [{ expectedStdout: '3\n' }] });
    await api.testCases.remove(added.id);

    const after = await api.items.get(itemId);
    expect(after.revision).toBe(before.revision);
    expect(after.updatedAt > before.updatedAt).toBe(true);
    expect(after.testCaseCount).toBe(before.testCaseCount + 1);
    // So an edit made against the revision read before all of that still goes through.
    expect((await api.items.update(itemId, { title: 'LIS, renamed', expectedRevision: before.revision })).revision).toBe(before.revision + 1);
  });

  it('checks expectedRevision on a bulk save and counts a stored solution as content', async () => {
    const itemId = seedIds.items.lis;
    const before = await api.items.get(itemId);
    const count = before.testCaseCount;
    const solution = { language: 'python', source: 'print(42)\r\n' };

    const stale = await failure(
      api.testCases.bulk(itemId, { cases: [{ expectedStdout: 'x' }], referenceSolution: solution, expectedRevision: before.revision + 5 }),
    );
    expect(stale.status).toBe(409);
    expect(stale.isRevisionConflict).toBe(true);
    expect(stale.currentRevision).toBe(before.revision);
    expect((await api.items.get(itemId)).testCaseCount).toBe(count);

    await api.testCases.bulk(itemId, { cases: [{ expectedStdout: 'x' }], referenceSolution: solution, expectedRevision: before.revision });
    const stored = await api.items.get(itemId);
    expect(stored.revision).toBe(before.revision + 1);
    expect(stored.problem?.referenceSolution).toEqual({ language: 'python', source: 'print(42)\n' });

    // Storing the same solution again is not a content change.
    await api.testCases.bulk(itemId, { cases: [], referenceSolution: { language: 'python', source: 'print(42)\n' } });
    expect((await api.items.get(itemId)).revision).toBe(before.revision + 1);
  });

  it('bounds the size of test data and the number of cases', async () => {
    const itemId = seedIds.items.lis;
    const big = 'x'.repeat(LIMITS.maxTestDataBytes + 1);
    expect((await failure(api.testCases.create(itemId, { stdin: big, expectedStdout: '' }))).fields).toHaveProperty('stdin');
    expect((await failure(api.testCases.create(itemId, { name: 'n'.repeat(201), expectedStdout: '' }))).fields).toHaveProperty('name');
    const many = Array.from({ length: LIMITS.maxTestCasesPerItem }, () => ({ expectedStdout: '' }));
    const err = await failure(api.testCases.bulk(itemId, { cases: many }));
    expect(err.status).toBe(422);
    expect((await failure(api.testCases.bulk(itemId, { cases: [{ name: 'x' } as never] }))).fields).toHaveProperty(['cases.0.expectedStdout']);
  });

  it('appends, replaces, reorders and deletes', async () => {
    const itemId = seedIds.items.lis;
    const before = await api.items.get(itemId);
    const cases = (await api.testCases.list(itemId)).items;

    const order = cases.map((c) => c.id).reverse();
    const reordered = await api.testCases.reorder(itemId, order);
    expect(reordered.items.map((c) => c.id)).toEqual(order);
    expect(reordered.items.map((c) => c.position)).toEqual(order.map((_, i) => i));
    expect((await failure(api.testCases.reorder(itemId, order.slice(1)))).status).toBe(422);

    await api.testCases.remove(order[0]!);
    const afterDelete = (await api.testCases.list(itemId)).items;
    expect(afterDelete.map((c) => c.position)).toEqual(afterDelete.map((_, i) => i));

    const replaced = await api.testCases.bulk(itemId, {
      cases: [{ stdin: '1\n1\n', expectedStdout: '1\n', origin: 'ai', verified: true }],
      replace: true,
      referenceSolution: { language: 'go', source: 'package main' },
    });
    expect(replaced.items).toHaveLength(1);
    const after = await api.items.get(itemId);
    expect(after.problem?.referenceSolution).toEqual({ language: 'go', source: 'package main' });
    expect(after.revision).toBeGreaterThan(before.revision);
  });

  it('are rejected for readings', async () => {
    const err = await failure(api.testCases.list(seedIds.items.capTheorem));
    expect(err.status).toBe(422);
    expect((await failure(api.testCases.create(seedIds.items.capTheorem, { expectedStdout: '' }))).status).toBe(422);
  });

  it('verifies against the reference solution and can adopt its output', async () => {
    const itemId = seedIds.items.mergeIntervals;
    const wrongId = seedIds.testCases.mergeIntervalsWrongExpected;

    const { results } = await api.testCases.verify(itemId, false);
    const mismatch = results.filter((r) => !r.matches);
    expect(mismatch.map((r) => r.testCaseId)).toEqual([wrongId]);
    expect(mismatch[0]).toMatchObject({ ok: true, verdict: 'executed', actualStdout: '2\n1 9\n10 12\n' });
    let cases = (await api.testCases.list(itemId)).items;
    expect(cases.find((c) => c.id === wrongId)?.verified).toBe(false);
    expect(cases.filter((c) => c.id !== wrongId).every((c) => c.verified)).toBe(true);

    const fixed = await api.testCases.verify(itemId, true);
    expect(fixed.results.find((r) => r.testCaseId === wrongId)?.matches).toBe(false);
    cases = (await api.testCases.list(itemId)).items;
    expect(cases.find((c) => c.id === wrongId)).toMatchObject({ verified: true, expectedStdout: '2\n1 9\n10 12\n' });
    expect((await api.testCases.verify(itemId, false)).results.every((r) => r.matches)).toBe(true);
  });

  it('cannot verify without a reference solution or a judge', async () => {
    expect((await failure(api.testCases.verify(seedIds.items.rateLimiter, false))).status).toBe(422);
    start({ judge: 'none' });
    expect((await failure(api.testCases.verify(seedIds.items.twoSum, false))).code).toBe('judge_unavailable');
    // An engine that cannot be reached is a 503 too, and nothing is changed.
    start({ judge: 'down' });
    const itemId = seedIds.items.mergeIntervals;
    const before = (await api.testCases.list(itemId)).items;
    const down = await failure(api.testCases.verify(itemId, true));
    expect(down.status).toBe(503);
    expect(down.code).toBe('judge_unavailable');
    expect((await api.testCases.list(itemId)).items).toEqual(before);
  });
});

describe('collections and tags', () => {
  it('lists roots first and counts direct members', async () => {
    const { items } = await api.collections.list();
    expect(items).toHaveLength(8);
    expect(items.slice(0, 3).every((c) => c.parentId === null)).toBe(true);
    expect(items.slice(0, 3).map((c) => c.position)).toEqual([0, 1, 2]);
    expect(items.find((c) => c.id === seedIds.collections.databases)?.itemCount).toBe(2);
  });

  it('refuses cycles and renumbers siblings on a move', async () => {
    const { interviewPrep, graphs, arraysAndHashing, dynamicProgramming } = seedIds.collections;
    const err = await failure(api.collections.update(interviewPrep, { parentId: graphs }));
    expect(err.status).toBe(409);
    expect(err.isRevisionConflict).toBe(false);

    const moved = await api.collections.update(graphs, { position: 0 });
    expect(moved.position).toBe(0);
    const siblings = (await api.collections.list()).items.filter((c) => c.parentId === interviewPrep);
    expect(siblings.map((c) => c.id)).toEqual([graphs, arraysAndHashing, dynamicProgramming]);
    expect(siblings.map((c) => c.position)).toEqual([0, 1, 2]);

    const toRoot = await api.collections.update(graphs, { parentId: null });
    expect(toRoot).toMatchObject({ parentId: null, position: 3 });
  });

  it('moves children up when a collection is deleted and keeps the items', async () => {
    await api.collections.remove(seedIds.collections.systemsReading);
    const { items } = await api.collections.list();
    const roots = items.filter((c) => c.parentId === null);
    expect(roots.map((c) => c.name)).toEqual(['Interview prep', 'Databases', 'Distributed systems', 'Weekly practice']);
    expect((await api.items.list()).total).toBe(24);
  });

  it('manages membership', async () => {
    const id = seedIds.collections.graphs;
    const appended = await api.collections.addItems(id, [seedIds.items.twoSum, seedIds.items.islands]);
    expect(appended.itemIds.filter((x) => x === seedIds.items.islands)).toHaveLength(1);
    expect(appended.itemIds[appended.itemIds.length - 1]).toBe(seedIds.items.twoSum);
    await api.collections.removeItem(id, seedIds.items.twoSum);
    expect((await api.items.get(seedIds.items.twoSum)).collectionIds).not.toContain(id);
    expect((await failure(api.collections.setItems(id, ['missing']))).status).toBe(422);
  });

  it('returns the full ordered membership of a collection', async () => {
    const id = seedIds.collections.dynamicProgramming;
    const listed = await api.items.list({ collectionId: id, sort: 'position', limit: 200 });
    const { itemIds } = await api.collections.itemIds(id);
    expect(itemIds).toEqual(listed.items.map((i) => i.id));
    const reversed = [...itemIds].reverse();
    expect((await api.collections.setItems(id, reversed)).itemIds).toEqual(reversed);
    expect((await api.collections.itemIds(id)).itemIds).toEqual(reversed);
    expect((await failure(api.collections.itemIds('00000000-0000-4000-8000-000000000000'))).status).toBe(404);
  });

  it('leaves revision and updatedAt alone when membership changes', async () => {
    const before = await api.items.get(seedIds.items.twoSum);
    await api.collections.addItems(seedIds.collections.graphs, [before.id]);
    await api.items.bulk({ ids: [before.id], action: 'removeFromCollection', collectionId: seedIds.collections.graphs });
    await api.items.bulk({ ids: [before.id], action: 'setFavorite', favorite: !before.favorite });
    const after = await api.items.get(before.id);
    expect(after.revision).toBe(before.revision);
    expect(after.updatedAt).toBe(before.updatedAt);
  });

  it('bounds collection names and descriptions', async () => {
    expect((await failure(api.collections.create({ name: 'n'.repeat(201) }))).fields).toHaveProperty('name');
    expect((await failure(api.collections.create({ name: 'ok', description: 'd'.repeat(5001) }))).fields).toHaveProperty('description');
    expect((await api.collections.create({ name: ' Two\r\nlines ' })).name).toBe('Two\nlines');
  });

  it('refuses tags with a slash or control character, and unknown tags', async () => {
    const slash = await failure(api.tags.rename('array', 'a/b'));
    expect(slash.status).toBe(422);
    expect(slash.fields).toEqual({ name: 'must not contain / or control characters' });
    expect((await failure(api.tags.rename('array', 't'.repeat(41)))).fields).toEqual({ name: 'must be 1-40 characters' });
    expect((await failure(api.tags.rename('no-such-tag', 'x'))).status).toBe(404);
    expect((await failure(api.tags.remove('no-such-tag'))).status).toBe(404);
    const bulk = await failure(api.items.bulk({ ids: [seedIds.items.twoSum], action: 'addTags', tags: ['x/y'] }));
    expect(bulk.fields).toEqual({ tags: 'tag "x/y" must not contain / or control characters' });
  });

  it('renames, merges and deletes tags', async () => {
    const before = (await api.tags.list()).items;
    expect(before.map((t) => t.name)).toEqual([...before.map((t) => t.name)].sort());
    const count = (name: string) => before.find((t) => t.name === name)?.count ?? 0;

    const renamed = await api.tags.rename('hash-map', 'Hashing');
    expect(renamed).toEqual({ name: 'hashing', count: count('hash-map') });

    // "stack" is only on Valid Parentheses, which also carries "string": merging must not double-count.
    const merged = await api.tags.rename('stack', 'string');
    expect(merged.count).toBe(count('string'));

    await api.tags.remove('dp');
    const after = (await api.tags.list()).items.map((t) => t.name);
    expect(after).not.toContain('dp');
    expect(after).not.toContain('stack');
    expect((await failure(api.tags.remove('dp'))).status).toBe(404);
  });
});

describe('submissions', () => {
  const lru = seedIds.items.lruCache;

  it('judges asynchronously to a failing verdict and moves the item to in_progress', async () => {
    expect((await api.items.get(lru)).status).toBe('todo');
    const queued = await api.submissions.create(lru, {
      language: 'python',
      source: 'print(1)  # MOCK:WA',
      mode: 'submit',
      stdin: null,
    });
    expect(queued).toMatchObject({ status: 'queued', verdict: null, finishedAt: null, timeMs: null, results: [] });
    expect((await api.items.get(lru)).status).toBe('in_progress');

    const { final, seen } = await judged(queued.id);
    const counts = seen.map((s) => s.results.length);
    expect(counts).toEqual([...counts].sort((a, b) => a - b));
    expect(final.totalCount).toBe(4);
    expect(final.results.map((r) => r.verdict)).toEqual(['accepted', 'wrong_answer', 'accepted', 'accepted']);
    expect(final.verdict).toBe('wrong_answer');
    expect(final.passedCount).toBe(3);
    expect(final.results[1]!.stdout).not.toBe(final.results[1]!.expectedStdout);
    expect(final.timeMs).toBe(Math.max(...final.results.map((r) => r.timeMs)));
    expect(final.finishedAt).not.toBeNull();

    const item = await api.items.get(lru);
    expect(item.lastVerdict).toBe('wrong_answer');
    expect(item.status).toBe('in_progress');
    const history = await api.submissions.list(lru);
    expect(history.items[0]?.id).toBe(queued.id);
    expect(history.items[0]).not.toHaveProperty('source');
    expect(history.items[0]).not.toHaveProperty('results');
  });

  it('marks the item done on an accepted submit, but not on a run', async () => {
    const run = await api.submissions.create(lru, { language: 'go', source: 'package main', mode: 'run', stdin: null });
    const ran = (await judged(run.id)).final;
    expect(ran.verdict).toBe('accepted');
    expect(ran.totalCount).toBe(1);
    expect((await api.items.get(lru)).status).toBe('in_progress');
    expect((await api.items.get(lru)).lastVerdict).toBe('compile_error');

    const submit = await api.submissions.create(lru, { language: 'go', source: 'package main', mode: 'submit', stdin: null });
    expect((await judged(submit.id)).final.verdict).toBe('accepted');
    const item = await api.items.get(lru);
    expect(item.status).toBe('done');
    expect(item.lastVerdict).toBe('accepted');
  });

  it('reports compile errors, crashes, limits and custom input', async () => {
    const go = async (source: string, stdin: string | null = null, mode: 'run' | 'submit' = 'submit') =>
      (await judged((await api.submissions.create(lru, { language: 'cpp', source, mode, stdin })).id)).final;

    const ce = await go('int main() { MOCK:CE }');
    expect(ce).toMatchObject({ verdict: 'compile_error', results: [], passedCount: 0 });
    expect(ce.compileOutput).toContain('error');

    const re = await go('// MOCK:RE');
    expect(re.verdict).toBe('runtime_error');
    expect(re.results[0]!.stderr).not.toBe('');

    const tle = await go('// MOCK:TLE');
    expect(tle.verdict).toBe('time_limit_exceeded');
    expect(tle.passedCount).toBe(tle.totalCount - 1);

    const ie = await go('// MOCK:IE');
    expect(ie.verdict).toBe('internal_error');
    expect(ie.error).not.toBeNull();

    const custom = await go('int main() {}', 'put 1 1\n', 'run');
    expect(custom.verdict).toBe('executed');
    expect(custom.results[0]).toMatchObject({ testCaseId: null, expectedStdout: null, stdin: 'put 1 1\n' });

    const starter = (await api.items.get(lru)).problem!.starterCode.cpp!;
    const untouched = await go(starter);
    expect(untouched.verdict).toBe('wrong_answer');
    expect(untouched.results.every((r) => r.stdout === '')).toBe(true);
  });

  it('validates the request', async () => {
    const body = { language: 'python', source: 'x', mode: 'submit' as const, stdin: null };
    expect((await failure(api.submissions.create(seedIds.items.capTheorem, body))).status).toBe(422);
    expect((await failure(api.submissions.create(lru, { ...body, language: 'cobol' }))).fields).toHaveProperty('language');
    const bigInput = 'x'.repeat(LIMITS.maxTestDataBytes + 1);
    expect((await failure(api.submissions.create(lru, { ...body, mode: 'run', stdin: bigInput }))).fields).toHaveProperty('stdin');
    expect((await failure(api.submissions.create(lru, { ...body, source: '' }))).fields).toHaveProperty('source');
    expect((await failure(api.submissions.create(lru, { ...body, source: 'x'.repeat(70000) }))).status).toBe(422);
    expect((await failure(api.submissions.create(lru, { ...body, stdin: '1' }))).fields).toHaveProperty('stdin');
    expect((await failure(api.submissions.create(seedIds.items.rateLimiter, body))).status).toBe(422);
  });

  it('is unavailable without a judge and fails internally when it is down', async () => {
    const body = { language: 'python', source: 'x', mode: 'submit' as const, stdin: null };
    start({ judge: 'none' });
    const err = await failure(api.submissions.create(lru, body));
    expect(err.status).toBe(503);
    expect(err.code).toBe('judge_unavailable');

    // A configured engine that cannot be reached still accepts the submission.
    start({ judge: 'down' });
    const queued = await api.submissions.create(lru, body);
    expect(queued.status).toBe('queued');
    const { final } = await judged(queued.id);
    expect(final.verdict).toBe('internal_error');
    expect(final.error).toMatch(/unreachable/);
    expect(final).toMatchObject({ passedCount: 0, totalCount: queued.totalCount, timeMs: null, memoryKb: null, results: [] });
  });

  it('fixes totalCount at creation and counts executed runs as passed', async () => {
    const total = (await api.items.get(lru)).testCaseCount;
    const submit = await api.submissions.create(lru, { language: 'python', source: 'print(1)', mode: 'submit', stdin: null });
    expect(submit).toMatchObject({ status: 'queued', passedCount: 0, totalCount: total });
    const { seen } = await judged(submit.id);
    expect(seen.every((s) => s.totalCount === total)).toBe(true);

    const custom = await api.submissions.create(lru, { language: 'python', source: 'print(1)', mode: 'run', stdin: 'get 1\n' });
    expect(custom.totalCount).toBe(1);
    expect((await judged(custom.id)).final).toMatchObject({ verdict: 'executed', passedCount: 1, totalCount: 1 });

    const broken = await api.submissions.create(lru, { language: 'cpp', source: '// MOCK:CE', mode: 'submit', stdin: null });
    const ce = (await judged(broken.id)).final;
    expect(ce).toMatchObject({ verdict: 'compile_error', passedCount: 0, totalCount: total, timeMs: null, memoryKb: null, results: [] });
    expect(ce.compileOutput).not.toBe('');
  });

  it('takes lastVerdict from the latest completed submit only', async () => {
    const before = (await api.items.get(lru)).lastVerdict;
    const pending = await api.submissions.create(lru, { language: 'python', source: '# MOCK:WA', mode: 'submit', stdin: null });
    // Still queued: the item keeps reporting the previous verdict.
    expect((await api.items.get(lru)).lastVerdict).toBe(before);
    await judged(pending.id);
    expect((await api.items.get(lru)).lastVerdict).toBe('wrong_answer');
    const run = await api.submissions.create(lru, { language: 'python', source: 'print(1)', mode: 'run', stdin: null });
    await judged(run.id);
    expect((await api.items.get(lru)).lastVerdict).toBe('wrong_answer');
  });

  it('seeds a history with failures to look at', async () => {
    const wa = await api.submissions.get(seedIds.submissions.longestSubstringWrongAnswer);
    expect(wa.verdict).toBe('wrong_answer');
    expect(wa.results.filter((r) => r.verdict === 'wrong_answer')).toHaveLength(2);
    expect((await api.submissions.get(seedIds.submissions.lruCacheCompileError)).compileOutput).toContain('error:');
    expect((await api.submissions.get(seedIds.submissions.networkDelayRuntimeError)).verdict).toBe('runtime_error');
    const runs = await api.submissions.list(seedIds.items.twoSum, { mode: 'run' });
    expect(runs.total).toBe(1);
  });
});

describe('AI drafting', () => {
  it('drafts a recognisable problem in the default style', async () => {
    const { draft, style } = await api.ai.draft({ text: 'two sum, array + target, return indices' });
    expect(style).toEqual({ id: seedIds.styles.leetcode, name: 'LeetCode style' });
    expect(draft).toMatchObject({ type: 'problem', title: 'Two Sum', difficulty: 'easy' });
    expect(draft.assumptions.length).toBeGreaterThanOrEqual(3);
    expect(draft.testCases.length).toBeGreaterThanOrEqual(2);
    expect(draft.testCases.every((c) => c.isSample)).toBe(true);
    // The default preset asks for Example blocks and for Python and Go only.
    expect(Object.keys(draft.problem!.starterCode).sort()).toEqual(['go', 'python']);
    expect(draft.body).toContain('**Example 1**');
    expect(draft.body.indexOf('## Constraints')).toBeGreaterThan(draft.body.indexOf('**Example 1**'));
  });

  it('resolves styleId: null for none, an id for that preset, 422 for an unknown id', async () => {
    const text = 'valid parentheses';
    const plain = await api.ai.draft({ text, styleId: null });
    expect(plain.style).toBeNull();
    expect(Object.keys(plain.draft.problem!.starterCode)).toHaveLength(5);
    expect(plain.draft.body).toContain('## Examples');

    const terse = await api.ai.draft({ text: 'two sum', styleId: seedIds.styles.terse });
    expect(terse.style?.name).toBe('Terse contest style');
    expect(Object.keys(terse.draft.problem!.starterCode).sort()).toEqual(['cpp', 'python']);
    expect(terse.draft.body).not.toContain('## Follow-up');

    const err = await failure(api.ai.draft({ text, styleId: 'nope' }));
    expect(err.status).toBe(422);
    expect(err.fields).toHaveProperty('styleId');

    await api.styles.remove(seedIds.styles.leetcode);
    expect((await api.ai.draft({ text })).style).toBeNull();
  });

  it('builds a generic problem or a reading from unrecognised text', async () => {
    const problem = (await api.ai.draft({ text: 'Given a list of temperatures, find the longest warm streak.', styleId: null })).draft;
    expect(problem.type).toBe('problem');
    expect(problem.title).toBe('Given a List of Temperatures');
    expect(problem.body).toContain('longest warm streak');
    expect(problem.testCases.length).toBeGreaterThanOrEqual(2);
    expect(problem.assumptions.length).toBeGreaterThanOrEqual(3);

    const prose =
      'Notes on how vector clocks work. Each process keeps a counter per process. Counters are merged element-wise when a message arrives.';
    const reading = (await api.ai.draft({ text: prose })).draft;
    expect(reading).toMatchObject({ type: 'reading', problem: null, testCases: [], difficulty: null });

    expect((await api.ai.draft({ text: prose, typeHint: 'problem' })).draft.type).toBe('problem');
    expect((await api.ai.draft({ text: 'two sum', typeHint: 'reading' })).draft.type).toBe('reading');
  });

  it('revises a previous draft according to the instruction', async () => {
    const first = (await api.ai.draft({ text: 'two sum', styleId: null })).draft;
    const harder = (await api.ai.draft({ text: 'two sum', previousDraft: first, instruction: 'make it harder', styleId: null })).draft;
    expect(harder.difficulty).toBe('medium');
    expect(harder.body).toContain('10^6');
    expect(harder.assumptions.length).toBe(first.assumptions.length + 1);

    const other = (await api.ai.draft({ text: 'two sum', previousDraft: first, instruction: 'mention overflow', styleId: null })).draft;
    expect(other.body).toContain('mention overflow');
    expect(other.title).toBe(first.title);
  });

  it('validates input and reports provider failures', async () => {
    expect((await failure(api.ai.draft({ text: '   ' }))).fields).toHaveProperty('text');
    expect((await failure(api.ai.draft({ text: 'x'.repeat(50001) }))).status).toBe(422);
    expect((await failure(api.ai.draft({ text: 'x', instruction: 'y'.repeat(2001) }))).fields).toHaveProperty('instruction');
    const twoSum = seedIds.items.twoSum;
    expect((await failure(api.ai.variant(twoSum, { instruction: 'y'.repeat(2001) }))).fields).toHaveProperty('instruction');
    expect((await failure(api.ai.testCases(twoSum, { instruction: 'y'.repeat(2001) }))).fields).toHaveProperty('instruction');
    const hugeDraft = { ...(await api.ai.draft({ text: 'two sum' })).draft, body: 'b'.repeat(LIMITS.maxPreviousDraftBytes) };
    expect((await failure(api.ai.draft({ text: 'x', instruction: 'shorter', previousDraft: hugeDraft }))).fields).toHaveProperty('previousDraft');
    const upstream = await failure(api.ai.draft({ text: 'anything MOCK:FAIL' }));
    expect(upstream.status).toBe(502);
    expect(upstream.code).toBe('upstream_error');
  });

  it('is unavailable when no provider is configured', async () => {
    start({ ai: false });
    for (const call of [
      api.ai.draft({ text: 'two sum' }),
      api.ai.variant(seedIds.items.twoSum, {}),
      api.ai.testCases(seedIds.items.twoSum, {}),
    ]) {
      const err = await failure(call);
      expect(err.status).toBe(503);
      expect(err.code).toBe('ai_unavailable');
    }
    // The request is validated first, so a bad one is a 422 even here.
    expect((await failure(api.ai.draft({ text: '' }))).status).toBe(422);
    expect((await failure(api.ai.testCases(seedIds.items.twoSum, { count: 99 }))).status).toBe(422);
  });

  it('can be cancelled', async () => {
    start({ speed: 'fast' });
    const controller = new AbortController();
    const pending = failure(api.ai.draft({ text: 'two sum' }, controller.signal));
    controller.abort();
    expect((await pending).code).toBe('aborted');
  });
});

describe('AI variants', () => {
  it('drafts every mode for a problem', async () => {
    const origin = await api.items.get(seedIds.items.coinChange);
    for (const mode of ['similar', 'easier', 'harder', 'twist'] as const) {
      const { draft, style } = await api.ai.variant(origin.id, { mode, instruction: 'keep it short' });
      expect(style?.id).toBe(seedIds.styles.leetcode);
      expect(draft.type).toBe('problem');
      expect(draft.title).not.toBe(origin.title);
      expect(draft.assumptions.length).toBeGreaterThanOrEqual(2);
      expect(draft.assumptions.join(' ')).toContain('keep it short');
    }
    const easier = (await api.ai.variant(origin.id, { mode: 'easier', styleId: null })).draft;
    expect(easier.difficulty).toBe('easy');
    const twist = (await api.ai.variant(origin.id, { mode: 'twist', styleId: null })).draft;
    expect(twist.body).toContain('## The twist');
    expect(twist.testCases).toEqual([]);
  });

  it('revises an earlier variant draft through previousDraft', async () => {
    const id = seedIds.items.twoSum;
    const first = await api.ai.variant(id, { mode: 'similar', styleId: null });
    const edited = { ...first.draft, title: 'My own title' };
    const revised = await api.ai.variant(id, {
      mode: 'similar',
      instruction: 'make it harder',
      previousDraft: edited,
      styleId: seedIds.styles.terse,
    });
    // The draft sent back is what gets revised, not a fresh variant.
    expect(revised.draft.title).toBe('My own title');
    expect(revised.draft.assumptions[0]).toMatch(/harder/i);
    expect(revised.style?.id).toBe(seedIds.styles.terse);
    // Without an instruction the draft is ignored and a new variant is written.
    expect((await api.ai.variant(id, { previousDraft: edited, styleId: null })).draft.title).not.toBe('My own title');
    expect((await failure(api.ai.variant(id, { instruction: 'x', previousDraft: { nope: true } as never }))).status).toBe(422);
  });

  it('only offers "similar" for a reading', async () => {
    const id = seedIds.items.capTheorem;
    const err = await failure(api.ai.variant(id, { mode: 'harder' }));
    expect(err.status).toBe(422);
    expect(err.fields).toHaveProperty('mode');
    const { draft } = await api.ai.variant(id, { mode: 'similar', instruction: 'as interview questions' });
    expect(draft).toMatchObject({ type: 'reading', problem: null, testCases: [] });
    expect(draft.body).toContain('as interview questions');
  });
});

describe('AI test cases', () => {
  it('verifies proposals by execution when a judge is available', async () => {
    const res = await api.ai.testCases(seedIds.items.twoSum, { count: 8 });
    expect(res.verification).toEqual({ attempted: true, engine: 'judge0', error: null });
    expect(res.referenceSolution.language).toBe('python');
    expect(res.cases).toHaveLength(8);
    expect(res.cases.every((c) => c.name !== '' && c.rationale !== '')).toBe(true);

    const mismatched = res.cases.filter((c) => c.predictionMatched === false);
    expect(mismatched).toHaveLength(1);
    expect(mismatched[0]!.verified).toBe(true);
    expect(mismatched[0]!.predictedStdout).not.toBe(mismatched[0]!.expectedStdout);

    const failed = res.cases.filter((c) => c.error !== null);
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({ verified: false, predictionMatched: null });
    expect(failed[0]!.expectedStdout).toBe(failed[0]!.predictedStdout);
    expect(res.cases.filter((c) => c.verified && c.predictionMatched)).toHaveLength(6);

    const small = await api.ai.testCases(seedIds.items.twoSum, { count: 3, language: 'go' });
    expect(small.referenceSolution.language).toBe('go');
    expect(small.cases.filter((c) => c.error !== null)).toHaveLength(0);
  });

  it('keeps predictions unverified without a judge', async () => {
    start({ judge: 'none' });
    const res = await api.ai.testCases(seedIds.items.twoSum, { count: 6 });
    expect(res.verification).toEqual({ attempted: false, engine: null, error: null });
    for (const c of res.cases) {
      expect(c).toMatchObject({ verified: false, predictionMatched: null, error: null });
      expect(c.expectedStdout).toBe(c.predictedStdout);
    }

    start({ judge: 'down' });
    const down = await api.ai.testCases(seedIds.items.twoSum, {});
    expect(down.verification.error).not.toBeNull();
    expect(down.cases.every((c) => !c.verified)).toBe(true);
  });

  it('rejects readings and bad counts', async () => {
    expect((await failure(api.ai.testCases(seedIds.items.bTrees, {}))).status).toBe(422);
    expect((await failure(api.ai.testCases(seedIds.items.twoSum, { count: 31 }))).fields).toEqual({ count: 'must be between 1 and 30' });
    expect((await api.ai.testCases(seedIds.items.twoSum, { count: 30 })).cases).toHaveLength(30);
  });

  it('still returns the proposal, unverified, when the engine cannot be reached', async () => {
    start({ judge: 'down' });
    const res = await api.ai.testCases(seedIds.items.twoSum, { count: 6 });
    expect(res.verification.attempted).toBe(true);
    expect(res.verification.error).toMatch(/unreachable/);
    expect(res.cases).toHaveLength(6);
    for (const c of res.cases) {
      expect(c).toMatchObject({ verified: false, predictionMatched: null });
      expect(c.expectedStdout).toBe(c.predictedStdout);
    }
  });
});

describe('style presets', () => {
  it('lists the default first, then by name', async () => {
    await api.styles.create({ name: 'academic', instructions: 'Formal tone.' });
    const { items } = await api.styles.list();
    expect(items.map((s) => s.name)).toEqual(['LeetCode style', 'academic', 'Terse contest style']);
    expect(items.map((s) => s.isDefault)).toEqual([true, false, false]);
  });

  it('keeps at most one default', async () => {
    const made = await api.styles.create({ name: 'Mine', instructions: 'Be brief.', isDefault: true });
    expect(made.isDefault).toBe(true);
    let items = (await api.styles.list()).items;
    expect(items.filter((s) => s.isDefault).map((s) => s.id)).toEqual([made.id]);

    await api.styles.update(seedIds.styles.terse, { isDefault: true });
    items = (await api.styles.list()).items;
    expect(items.filter((s) => s.isDefault).map((s) => s.id)).toEqual([seedIds.styles.terse]);

    await api.styles.update(seedIds.styles.terse, { isDefault: false });
    expect((await api.styles.list()).items.some((s) => s.isDefault)).toBe(false);

    await api.styles.update(made.id, { isDefault: true });
    await api.styles.remove(made.id);
    expect((await api.styles.list()).items.some((s) => s.isDefault)).toBe(false);
    expect((await failure(api.styles.remove(made.id))).status).toBe(404);
  });

  it('enforces the limits without truncating', async () => {
    const name = async (value: string) => failure(api.styles.create({ name: value, instructions: 'x' }));
    expect((await name('   ')).fields).toHaveProperty('name');
    expect((await name('n'.repeat(61))).fields).toHaveProperty('name');
    expect((await name('leetcode STYLE')).fields).toHaveProperty('name');
    expect((await name('bell\u0007')).fields).toHaveProperty('name');

    const tooLong = await failure(api.styles.create({ name: 'Long', instructions: 'i'.repeat(2001) }));
    expect(tooLong.status).toBe(422);
    expect(tooLong.fields).toHaveProperty('instructions');
    expect((await failure(api.styles.update(seedIds.styles.terse, { instructions: '' }))).status).toBe(422);

    // Lengths are counted in code points after trimming, and newlines and tabs are fine.
    const ok = await api.styles.create({ name: ` ${'😀'.repeat(60)} `, instructions: `  ${'é'.repeat(1999)}\n\t` });
    expect([...ok.name]).toHaveLength(60);
    expect([...ok.instructions]).toHaveLength(1999);
    const multi = await api.styles.create({ name: 'Multi', instructions: 'line one\n\tline two' });
    expect(multi.instructions).toBe('line one\n\tline two');

    // Carriage returns are normalised, not rejected; a name is a single line.
    const crlf = await api.styles.create({ name: 'Windows', instructions: 'one\r\ntwo\rthree' });
    expect(crlf.instructions).toBe('one\ntwo\nthree');
    expect((await name('two\nlines')).fields).toEqual({ name: 'must be a single line (no newline or tab)' });
    expect((await name('tab\there')).fields).toHaveProperty('name');
    expect((await failure(api.styles.update(crlf.id, { name: 'a\r\nb' }))).status).toBe(422);
  });

  it('refuses a 21st preset with a conflict', async () => {
    for (let i = 3; i <= 20; i++) await api.styles.create({ name: `Preset ${i}`, instructions: 'x' });
    const err = await failure(api.styles.create({ name: 'One too many', instructions: 'x' }));
    expect(err.status).toBe(409);
    expect(err.code).toBe('conflict');
    expect((await api.styles.list()).items).toHaveLength(20);
  });

  it('can start with none', async () => {
    start({ styles: 'none' });
    expect((await api.styles.list()).items).toEqual([]);
    expect((await api.ai.draft({ text: 'two sum' })).style).toBeNull();
  });
});

describe('AI settings', () => {
  it('never returns a key, only a hint and its source', async () => {
    const settings = await api.settings.getAi();
    expect(settings.activeProvider).toBe('anthropic');
    expect(settings.providers.anthropic).toEqual({
      model: 'claude-opus-5-5',
      baseUrl: null,
      modelSource: 'settings',
      baseUrlSource: null,
      apiKeySet: true,
      apiKeyHint: '…x7Qa',
      apiKeySource: 'settings',
      ready: true,
    });
    expect(settings.providers.openai_compatible).toMatchObject({
      model: null,
      modelSource: null,
      baseUrlSource: null,
      apiKeySet: false,
      apiKeyHint: null,
      ready: false,
    });
    expect(JSON.stringify(settings)).not.toContain('sk-ant');
  });

  it('says which values come from the environment', async () => {
    start(optionsFromFlags(['ai-env', 'instant']));
    const env = (await api.settings.getAi()).providers.anthropic;
    expect(env).toMatchObject({ modelSource: 'environment', baseUrlSource: 'environment', apiKeySource: 'environment', apiKeySet: true, ready: true });
    expect(env.model).toBe('claude-opus-5-5');
    expect(env.baseUrl).toMatch(/^https:/);
    expect((await api.meta()).ai.enabled).toBe(true);

    // A saved value takes precedence; clearing it falls back to the environment.
    let next = await api.settings.putAi({ providers: { anthropic: { model: 'claude-other', apiKey: 'sk-ant-saved-1234' } } });
    expect(next.providers.anthropic).toMatchObject({ model: 'claude-other', modelSource: 'settings', apiKeySource: 'settings', baseUrlSource: 'environment' });
    next = await api.settings.putAi({ providers: { anthropic: { model: null, apiKey: null } } });
    expect(next.providers.anthropic).toMatchObject({ model: 'claude-opus-5-5', modelSource: 'environment', apiKeySource: 'environment' });
  });

  it('treats an empty apiKey as omitted and bounds model and key lengths', async () => {
    const kept = await api.settings.putAi({ providers: { anthropic: { apiKey: '' } } });
    expect(kept.providers.anthropic).toMatchObject({ apiKeySet: true, apiKeyHint: '…x7Qa', apiKeySource: 'settings' });
    expect((await failure(api.settings.putAi({ providers: { anthropic: { model: 'm'.repeat(201) } } }))).status).toBe(422);
    expect((await failure(api.settings.putAi({ providers: { anthropic: { apiKey: 'k'.repeat(1001) } } }))).status).toBe(422);
    expect((await api.settings.getAi()).providers.anthropic.apiKeyHint).toBe('…x7Qa');
  });

  it('refuses to activate a provider that is not ready', async () => {
    const err = await failure(api.settings.putAi({ activeProvider: 'openai_compatible' }));
    expect(err.status).toBe(422);
    expect(err.fields).toHaveProperty('activeProvider');
    expect((await api.settings.getAi()).activeProvider).toBe('anthropic');

    const saved = await api.settings.putAi({
      activeProvider: 'openai_compatible',
      providers: { openai_compatible: { model: 'llama3.1', baseUrl: 'http://localhost:11434/v1' } },
    });
    expect(saved.providers.openai_compatible).toMatchObject({ ready: true, apiKeySet: false, model: 'llama3.1' });
    expect((await api.meta()).ai).toEqual({ enabled: true, provider: 'openai_compatible', model: 'llama3.1' });
  });

  it('replaces and deletes keys, and turns AI off', async () => {
    const replaced = await api.settings.putAi({ providers: { anthropic: { apiKey: 'sk-ant-new-key-ABCD' } } });
    expect(replaced.providers.anthropic.apiKeyHint).toBe('…ABCD');

    const untouched = await api.settings.putAi({ providers: { anthropic: { model: 'claude-sonnet-5' } } });
    expect(untouched.providers.anthropic).toMatchObject({ apiKeyHint: '…ABCD', model: 'claude-sonnet-5' });

    // Deleting the key of the active provider would leave it selected but not ready.
    expect((await failure(api.settings.putAi({ providers: { anthropic: { apiKey: null } } }))).status).toBe(422);

    const off = await api.settings.putAi({ activeProvider: null, providers: { anthropic: { apiKey: null } } });
    expect(off.activeProvider).toBeNull();
    expect(off.providers.anthropic).toMatchObject({ apiKeySet: false, apiKeySource: null, ready: false });
    expect((await api.meta()).ai).toEqual({ enabled: false, provider: null, model: null });
    expect((await failure(api.ai.draft({ text: 'two sum' }))).code).toBe('ai_unavailable');
  });

  it('tests a configuration without saving it', async () => {
    expect(await api.settings.testAi({ provider: 'anthropic' })).toMatchObject({ ok: true, model: 'claude-opus-5-5', error: null });
    const bad = await api.settings.testAi({ provider: 'anthropic', apiKey: 'sk-ant-bad-key' });
    expect(bad).toMatchObject({ ok: false, latencyMs: null });
    expect(bad.error).not.toContain('sk-ant-bad-key');
    expect((await api.settings.getAi()).providers.anthropic.apiKeyHint).toBe('…x7Qa');

    const local = await api.settings.testAi({ provider: 'openai_compatible', model: 'qwen', baseUrl: 'http://unreachable.lan:1234/v1' });
    expect(local.ok).toBe(false);
    expect(local.error).toContain('unreachable.lan');
    expect((await api.settings.testAi({ provider: 'openai_compatible' })).ok).toBe(false);
  });
});

describe('export and import', () => {
  it('round-trips the whole library as unchanged', async () => {
    const { blob, filename } = await api.bundle.export({ scope: 'all', includeSolutions: true, includeHiddenTests: true });
    expect(filename).toBe('codeathropy-library.codeathropy.zip');
    expect(blob.size).toBeGreaterThan(1000);

    const preview = await api.bundle.preview(new File([blob], filename!));
    expect(preview.bundle).toMatchObject({ name: 'Codeathropy library', formatVersion: 1 });
    expect(preview.counts).toEqual({ new: 0, changed: 0, unchanged: 24 });
    expect(preview.collections).toHaveLength(8);
    expect(preview.collections.every((c) => c.state === 'existing')).toBe(true);
    expect(preview.warnings).toEqual([]);
    expect(preview.items.find((i) => i.id === seedIds.items.twoSum)?.testCaseCount).toBe(6);
  });

  it('ignores what a partial export left out when comparing', async () => {
    const { blob } = await api.bundle.export({ scope: 'all', includeSolutions: false, includeHiddenTests: false });
    const preview = await api.bundle.preview(new File([blob], 'partial.zip'));
    expect(preview.counts).toEqual({ new: 0, changed: 0, unchanged: 24 });
    expect(preview.items.find((i) => i.id === seedIds.items.twoSum)?.testCaseCount).toBe(2);
  });

  it('exports a collection subtree or a selection', async () => {
    const subtree = await api.bundle.export({
      scope: 'collection',
      collectionId: seedIds.collections.systemsReading,
      includeSolutions: true,
      includeHiddenTests: true,
    });
    expect(subtree.filename).toBe('systems-reading.codeathropy.zip');
    const preview = await api.bundle.preview(new File([subtree.blob], 'a.zip'));
    expect(preview.collections.map((c) => c.name).sort()).toEqual(['Databases', 'Distributed systems', 'Systems reading']);
    expect(preview.items).toHaveLength(6);

    const picked = await api.bundle.export({
      scope: 'items',
      itemIds: [seedIds.items.twoSum, seedIds.items.lis],
      name: 'Two picks',
      includeSolutions: true,
      includeHiddenTests: true,
    });
    expect(picked.filename).toBe('two-picks.codeathropy.zip');
    const picks = await api.bundle.preview(new File([picked.blob], 'b.zip'));
    expect(picks.items).toHaveLength(2);
    expect(picks.collections).toEqual([]);

    expect((await failure(api.bundle.export({ scope: 'items', itemIds: [], includeSolutions: true, includeHiddenTests: true }))).status).toBe(422);
  });

  it('previews and applies each strategy for changed items', async () => {
    const bundle = await exportAll();
    const changedId = seedIds.items.coinChange;
    const deletedId = seedIds.items.lis;

    const arrange = async () => {
      start();
      await api.items.update(changedId, { title: 'Coin Change (local edit)', status: 'done', notes: 'mine' });
      await api.items.remove(deletedId);
      await api.collections.remove(seedIds.collections.graphs);
    };

    await arrange();
    const preview = await api.bundle.preview(bundle);
    expect(preview.counts).toEqual({ new: 1, changed: 1, unchanged: 22 });
    expect(preview.items.find((i) => i.id === changedId)).toMatchObject({ state: 'changed', changes: ['title'] });
    expect(preview.items.find((i) => i.id === deletedId)).toMatchObject({ state: 'new', changes: [] });
    expect(preview.items.filter((i) => i.state === 'unchanged').every((i) => i.changes.length === 0)).toBe(true);
    expect(preview.collections.find((c) => c.id === seedIds.collections.graphs)?.state).toBe('new');
    // A preview writes nothing.
    expect((await failure(api.items.get(deletedId))).status).toBe(404);

    const skip = await api.bundle.import(bundle, 'skip');
    expect(skip).toEqual({ created: 1, updated: 0, skipped: 1, duplicated: 0, unchanged: 22, collectionsCreated: 1, warnings: [] });
    expect((await api.items.get(changedId)).title).toBe('Coin Change (local edit)');
    const restored = await api.items.get(deletedId);
    expect(restored).toMatchObject({ status: 'todo', favorite: false, notes: '', revision: 1 });
    expect(restored.testCaseCount).toBe(6);
    expect(restored.collectionIds).toContain(seedIds.collections.dynamicProgramming);
    const graphs = await api.collections.get(seedIds.collections.graphs);
    expect(graphs).toMatchObject({ parentId: seedIds.collections.interviewPrep, itemCount: 2 });

    await arrange();
    const overwrite = await api.bundle.import(bundle, 'overwrite');
    expect(overwrite).toMatchObject({ created: 1, updated: 1, skipped: 0, duplicated: 0 });
    // Content comes from the bundle; personal state stays.
    expect(await api.items.get(changedId)).toMatchObject({ title: 'Coin Change', status: 'done', notes: 'mine' });
    expect((await api.bundle.preview(bundle)).counts).toEqual({ new: 0, changed: 0, unchanged: 24 });

    await arrange();
    const duplicate = await api.bundle.import(bundle, 'duplicate');
    expect(duplicate).toMatchObject({ created: 1, updated: 0, duplicated: 1 });
    expect((await api.items.list()).total).toBe(25);
    expect((await api.items.get(changedId)).title).toBe('Coin Change (local edit)');
    const copies = await api.items.list({ q: 'coin change', type: 'problem' });
    expect(copies.items.map((i) => i.title).sort()).toEqual(['Coin Change', 'Coin Change (local edit)']);
  });

  it('names every differing field of a changed item, in the documented order', async () => {
    const bundle = await exportAll();
    start();
    const id = seedIds.items.coinChange;
    const [first] = (await api.testCases.list(id)).items;
    await api.testCases.update(first!.id, { expectedStdout: 'changed\n' });
    await api.items.update(id, {
      tags: ['renamed-tag'],
      body: 'different',
      summary: 'different',
      difficulty: 'hard',
      source: { note: 'elsewhere' },
      problem: { timeLimitMs: 1234, compare: 'exact', starterCode: { ruby: 'puts 1' }, referenceSolution: { language: 'ruby', source: 'puts 2' } },
    });
    const preview = await api.bundle.preview(bundle);
    expect(preview.items.find((i) => i.id === id)?.changes).toEqual([
      'summary',
      'body',
      'difficulty',
      'tags',
      'source',
      'limits',
      'compare',
      'starterCode',
      'referenceSolution',
      'testCases',
    ]);
    expect(preview.counts.changed).toBe(1);
  });

  it('bounds the name, author and description of an export', async () => {
    const base = { scope: 'all' as const, includeSolutions: true, includeHiddenTests: true };
    expect((await failure(api.bundle.export({ ...base, name: 'n'.repeat(201) }))).fields).toHaveProperty('name');
    expect((await failure(api.bundle.export({ ...base, author: 'a'.repeat(201) }))).fields).toHaveProperty('author');
    expect((await failure(api.bundle.export({ ...base, description: 'd'.repeat(5001) }))).fields).toHaveProperty('description');
  });

  it('keeps local hidden tests and the solution when overwriting from a samples-only bundle', async () => {
    const { blob } = await api.bundle.export({
      scope: 'items',
      itemIds: [seedIds.items.twoSum],
      includeSolutions: false,
      includeHiddenTests: false,
    });
    await api.items.update(seedIds.items.twoSum, { summary: 'changed locally' });
    const result = await api.bundle.import(new File([blob], 'samples.zip'), 'overwrite');
    expect(result.updated).toBe(1);
    const item = await api.items.get(seedIds.items.twoSum);
    expect(item.testCaseCount).toBe(6);
    expect(item.problem?.referenceSolution).not.toBeNull();
    const cases = (await api.testCases.list(item.id)).items;
    expect(cases.map((c) => c.position)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(cases.slice(0, 2).every((c) => c.isSample)).toBe(true);
  });

  it('imports a hand-built bundle and reports per-item problems as warnings', async () => {
    const bytes = buildBundleZip({
      name: 'From a friend',
      author: 'Sam',
      items: [
        {
          id: '99999999-0000-4000-8000-000000000001',
          type: 'problem',
          title: 'FizzBuzz',
          summary: '',
          difficulty: 'easy',
          tags: ['Warm-Up'],
          source: { url: null, note: null },
          variantOf: '99999999-0000-4000-8000-00000000dead',
          body: 'Print the numbers.',
          problem: {
            timeLimitMs: 1000,
            memoryLimitKb: 65536,
            compare: 'exact',
            starterCode: { python: 'print()\n' },
            referenceSolution: null,
          },
          testCases: [{ name: 'One', stdin: '1\n', expectedStdout: '1\n', isSample: true }],
        },
      ],
      collections: [
        { id: '99999999-0000-4000-8000-0000000000c1', name: 'Warm-ups', description: '', parentId: null, position: 0, itemIds: ['99999999-0000-4000-8000-000000000001'] },
      ],
    });
    const preview = await api.bundle.preview(zipFile(bytes));
    expect(preview.bundle).toMatchObject({ name: 'From a friend', author: 'Sam' });
    expect(preview.counts).toEqual({ new: 1, changed: 0, unchanged: 0 });
    expect(preview.collections).toEqual([
      { id: '99999999-0000-4000-8000-0000000000c1', name: 'Warm-ups', state: 'new', itemCount: 1 },
    ]);

    const result = await api.bundle.import(zipFile(bytes), 'skip');
    expect(result).toMatchObject({ created: 1, collectionsCreated: 1 });
    const item = await api.items.get('99999999-0000-4000-8000-000000000001');
    expect(item).toMatchObject({ tags: ['warm-up'], variantOf: null, collectionIds: ['99999999-0000-4000-8000-0000000000c1'] });
    expect(item.problem).toMatchObject({ compare: 'exact', timeLimitMs: 1000 });
    expect((await api.bundle.preview(zipFile(bytes))).counts.unchanged).toBe(1);
  });

  it('rejects files that are not bundles', async () => {
    const notZip = await failure(api.bundle.preview(new File(['hello'], 'notes.txt')));
    expect(notZip.status).toBe(422);
    expect(notZip.code).toBe('validation_failed');

    const future = buildBundleZip({ name: 'Future', formatVersion: 2, items: [] });
    const err = await failure(api.bundle.import(zipFile(future), 'skip'));
    expect(err.status).toBe(422);
    expect(err.message).toMatch(/newer/);
  });
});

describe('routing', () => {
  it('answers unknown routes with not_found', async () => {
    const res = await server.fetch('/api/v1/nope');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: { code: 'not_found', message: 'no such endpoint' } });
    expect((await server.fetch('/api/v1/items', { method: 'POST', body: '{oops' })).status).toBe(400);
  });

  it('answers an unsupported method on a known path with a JSON 405', async () => {
    const res = await server.fetch('/api/v1/meta', { method: 'PUT' });
    expect(res.status).toBe(405);
    expect(await res.json()).toEqual({ error: { code: 'bad_request', message: 'method PUT is not allowed for this path' } });
    expect((await server.fetch(`/api/v1/items/${seedIds.items.twoSum}`, { method: 'PUT', body: '{}' })).status).toBe(405);
  });

  it('refuses state-changing requests under the forbidden scenario', async () => {
    start(optionsFromFlags(['forbidden', 'instant']));
    expect((await api.items.list()).total).toBeGreaterThan(0);
    const err = await failure(api.items.update(seedIds.items.twoSum, { favorite: true }));
    expect(err.status).toBe(403);
    expect(err.code).toBe('forbidden');
    expect(err.message).toMatch(/CODEATHROPY_ALLOWED_ORIGINS/);
    expect((await failure(api.collections.create({ name: 'x' }))).code).toBe('forbidden');
  });

  it('keeps externalEdit a content change', async () => {
    const before = await api.items.get(seedIds.items.twoSum);
    server.externalEdit(before.id);
    const after = await api.items.get(before.id);
    expect(after.revision).toBe(before.revision + 1);
    expect((await failure(api.items.update(before.id, { title: 'mine', expectedRevision: before.revision }))).isRevisionConflict).toBe(true);
  });
});
