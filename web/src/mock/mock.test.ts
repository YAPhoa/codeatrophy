import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError, setTransport } from '../api/client';
import type { Submission } from '../api/types';
import type { MockOptions, MockServer } from './index';
import { DEFAULT_PREFERENCES, envProviderId, JUDGE_LANGUAGES, LIMITS, REFERENCE_SOLUTION_NAME } from './db';
import { assemble, functionKit, KIT_LANGUAGES } from './harness';
import { buildBundleZip, createMockServer, optionsFromFlags, parseBundleZip, seedIds } from './index';
import { TLE_GRACE_MS } from './judge';
import { MERGE_K_LISTS_JAVA, MERGE_K_LISTS_REFERENCE } from './seed/mergeKLists';
import { readZip } from './zip';

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

const zipFile = (bytes: Uint8Array<ArrayBuffer>, name = 'bundle.codeatrophy.zip') =>
  new File([bytes], name, { type: 'application/zip' });

async function exportAll(): Promise<File> {
  const { blob, filename } = await api.bundle.export({ scope: 'all', includeSolutions: true, includeHiddenTests: true });
  return new File([blob], filename ?? 'export.zip');
}

beforeEach(() => {
  start();
});

afterEach(() => {
  vi.useRealTimers();
  setTransport(() => Promise.reject(new Error('no transport')));
});

describe('meta and stats', () => {
  it('reports capabilities for the default scenario', async () => {
    const meta = await api.meta();
    expect(meta.ai).toEqual({ enabled: true, providerId: meta.ai.providerId, providerName: 'Personal key', kind: 'anthropic', model: 'claude-opus-5-5' });
    expect(meta.ai.providerId).toBe((await api.settings.getAi()).defaultProviderId);
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
      maxImportEntries: 1000000,
      maxImportCollections: 10000,
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
      maxSolutionsPerItem: 50,
      maxSolutionNameChars: 100,
      maxSolutionNotesChars: 5000,
      maxDraftTextChars: 50000,
      maxInstructionChars: 2000,
      maxPreviousDraftBytes: 2097152,
      maxGeneratedTestCases: 30,
      maxLargeInputBytes: 1048576,
      maxStylePresets: 20,
      maxStyleNameChars: 60,
      maxStyleInstructionsChars: 2000,
      maxModelIdChars: 200,
      maxApiKeyChars: 1000,
      maxAiProviders: 20,
      maxAiProviderNameChars: 60,
      minAiTimeoutSeconds: 10,
      maxAiTimeoutSeconds: 300,
      maxBundleNameChars: 200,
      maxBundleDescriptionChars: 5000,
    });
    expect(Object.keys(meta.limits)).toHaveLength(40);
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
    expect(meta.ai).toEqual({ enabled: false, providerId: null, providerName: null, kind: null, model: null });
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
    expect(stats.items.total).toBe(25);
    expect(stats.items.byType).toEqual({ problem: 17, reading: 8 });
    expect(stats.items.byStatus.todo + stats.items.byStatus.in_progress + stats.items.byStatus.done).toBe(25);
    expect(Object.keys(stats.items.byDifficulty).sort()).toEqual(['easy', 'hard', 'medium', 'none']);
    expect(stats.collections).toBe(8);
    expect(stats.submissions.total).toBeGreaterThan(10);
  });

  it('counts only submit-mode submissions as accepted', async () => {
    const before = (await api.stats()).submissions;
    const source = 'print("ok")';
    const run = await api.submissions.create(seedIds.items.twoSum, { language: 'python', source, mode: 'run', stdin: null });
    expect((await judged(run.id)).final.verdict).toBe('accepted');
    expect((await api.stats()).submissions).toEqual({ total: before.total + 1, accepted: before.accepted });

    const submit = await api.submissions.create(seedIds.items.twoSum, { language: 'python', source, mode: 'submit', stdin: null });
    expect((await judged(submit.id)).final.verdict).toBe('accepted');
    expect((await api.stats()).submissions).toEqual({ total: before.total + 2, accepted: before.accepted + 1 });
  });
});

describe('listing items', () => {
  it('paginates and reports the total before pagination', async () => {
    const page = await api.items.list({ limit: 5, offset: 20 });
    expect(page.total).toBe(25);
    expect(page.items).toHaveLength(5);
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
      interface: 'program',
      timeLimitMs: 2000,
      memoryLimitKb: 262144,
      compare: 'tokens',
      starterCode: {},
      harness: {},
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
    expect((await api.items.list()).total).toBe(23);
  });
});

describe('problem interface', () => {
  const lists = seedIds.items.mergeKLists;
  const runner = { prefix: 'import json\n', suffix: 'print(solve())\n' };

  it('seeds a "solution only" problem with a stub and a harness per language', async () => {
    const item = await api.items.get(lists);
    expect(item.problem!.interface).toBe('function');
    expect(Object.keys(item.problem!.harness).sort()).toEqual(['java', 'python']);
    expect(Object.keys(item.problem!.starterCode).sort()).toEqual(['java', 'python']);
    expect(item.problem!.starterCode.python).toContain('def mergeKLists(self, lists: list[ListNode | None]) -> ListNode | None:');
    // The solver's part defines no ListNode and reads no input: the harness does.
    expect(item.problem!.harness.python!.prefix).toContain('class ListNode:');
    expect(item.problem!.harness.python!.suffix).toContain('sys.stdin');
    // Saved solutions hold the solution part only.
    expect(item.problem!.referenceSolution).toMatchObject({ language: 'python', source: MERGE_K_LISTS_REFERENCE });
    expect(MERGE_K_LISTS_REFERENCE).not.toContain('class ListNode:');
    // Test cases follow the convention: one JSON value per argument, one JSON value out.
    for (const c of (await api.testCases.list(lists)).items) {
      expect(() => JSON.parse(c.stdin)).not.toThrow();
      expect(() => JSON.parse(c.expectedStdout)).not.toThrow();
    }
    // Every other seed problem is a full program without a harness.
    expect((await api.items.get(seedIds.items.twoSum)).problem).toMatchObject({ interface: 'program', harness: {} });
  });

  it('saves a harness with a function problem, and none with a program', async () => {
    const made = await api.items.create({ type: 'problem', title: 'F', problem: { interface: 'function', starterCode: { python: 'def solve():\r\n    pass' }, harness: { python: runner } } });
    expect(made.problem).toMatchObject({ interface: 'function', starterCode: { python: 'def solve():\n    pass' }, harness: { python: runner } });
    // It may be saved with no entries at all.
    expect((await api.items.create({ type: 'problem', title: 'G', problem: { interface: 'function' } })).problem).toMatchObject({ interface: 'function', harness: {} });

    const refused = await failure(api.items.create({ type: 'problem', title: 'P', problem: { harness: { python: runner } } }));
    expect(refused.status).toBe(422);
    expect(refused.fields).toHaveProperty(['problem.harness']);
  });

  it('validates the interface and the shape of the harness', async () => {
    const bad: [Record<string, unknown>, string][] = [
      [{ interface: 'class' }, 'problem.interface'],
      [{ interface: 'function', harness: { klingon: runner } }, 'problem.harness'],
      [{ interface: 'function', harness: { python: { prefix: 'x' } } }, 'problem.harness'],
      [{ interface: 'function', harness: [] }, 'problem.harness'],
      [{ interface: 'function', harness: { python: { prefix: 'x'.repeat(LIMITS.maxSourceBytes + 1), suffix: '' } } }, 'problem.harness.python'],
    ];
    for (const [problem, field] of bad) {
      const err = await failure(api.items.create({ type: 'problem', title: 'X', problem: problem as never }));
      expect(err.status, field).toBe(422);
      expect(err.fields, field).toHaveProperty([field]);
    }
    // Either part may be empty.
    const item = await api.items.create({ type: 'problem', title: 'X', problem: { interface: 'function', harness: { go: { prefix: '', suffix: 'func main() {}' } } } });
    expect(item.problem!.harness).toEqual({ go: { prefix: '', suffix: 'func main() {}' } });
  });

  it('changes the interface later, only together with a harness that fits it', async () => {
    const before = await api.items.get(lists);
    // A program keeps no harness: the change is refused while one is stored.
    const refused = await failure(api.items.update(lists, { problem: { interface: 'program' } }));
    expect(refused.status).toBe(422);
    expect(refused.fields).toHaveProperty(['problem.harness']);
    expect(await api.items.get(lists)).toEqual(before);

    const program = await api.items.update(lists, { problem: { interface: 'program', harness: {} } });
    expect(program.problem).toMatchObject({ interface: 'program', harness: {} });
    expect(program.revision).toBe(before.revision + 1);
    // Starter code and saved solutions are left as they were.
    expect(program.problem!.starterCode).toEqual(before.problem!.starterCode);
    expect(program.solutionCount).toBe(before.solutionCount);

    const back = await api.items.update(lists, { problem: { interface: 'function', harness: { python: runner } } });
    expect(back.problem).toMatchObject({ interface: 'function', harness: { python: runner } });
    // The harness is replaced as a whole, like starter code.
    expect((await api.items.update(lists, { problem: { harness: { java: runner } } })).problem!.harness).toEqual({ java: runner });
    // A harness on a program is refused in a patch too.
    expect((await failure(api.items.update(seedIds.items.twoSum, { problem: { harness: { python: runner } } }))).status).toBe(422);
  });

  it('assembles the program from the prefix, the source and the suffix, each on a new line', () => {
    expect(assemble({ prefix: 'a\nb', suffix: 'z' }, 'x\ny')).toEqual({ program: 'a\nb\nx\ny\nz', lineOffset: 2 });
    expect(assemble({ prefix: 'a\n', suffix: 'z\n' }, 'x\n')).toEqual({ program: 'a\nx\nz\n', lineOffset: 1 });
    expect(assemble({ prefix: '', suffix: 'z' }, 'x')).toEqual({ program: 'x\nz', lineOffset: 0 });
    expect(assemble(undefined, 'x')).toEqual({ program: 'x', lineOffset: 0 });
  });

  it('writes a stub and a runner for a signature in each language it knows', () => {
    const kit = functionKit({ name: 'twoSum', params: [{ name: 'nums', type: 'int[]' }, { name: 'target', type: 'int' }], returns: 'int[]' });
    expect(Object.keys(kit.starterCode)).toEqual([...KIT_LANGUAGES]);
    expect(Object.keys(kit.harness)).toEqual([...KIT_LANGUAGES]);
    expect(kit.starterCode.python).toBe('class Solution:\n    def twoSum(self, nums: list[int], target: int) -> list[int]:\n        ');
    expect(kit.starterCode.java).toContain('public int[] twoSum(int[] nums, int target) {');
    expect(kit.starterCode.go).toContain('func twoSum(nums []int, target int) []int {');
    expect(kit.starterCode.javascript).toContain('function twoSum(nums, target) {');
    for (const language of KIT_LANGUAGES) {
      // The runner calls the solution, and nothing in the stub does its work.
      expect(kit.harness[language]!.suffix, language).toMatch(/twoSum[.(]/);
      expect(kit.starterCode[language], language).not.toMatch(/stdin|readLine|readFileSync|os\.Stdin/);
    }
    expect(Object.keys(functionKit({ name: 'f', params: [], returns: 'bool' }, ['python', 'rust']).harness)).toEqual(['python']);
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
    // The write lands on the solution that is the reference, in place.
    expect(stored.problem?.referenceSolution).toEqual({ id: before.problem!.referenceSolution!.id, language: 'python', source: 'print(42)\n' });
    expect(stored.solutionCount).toBe(before.solutionCount);

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
    expect(after.problem?.referenceSolution).toMatchObject({ language: 'go', source: 'package main' });
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

  it('clears verified on cases the reference solution no longer confirms', async () => {
    const itemId = seedIds.items.twoSum;
    const reference = seedIds.solutions.twoSumHashMap;
    expect((await api.testCases.list(itemId)).items.every((c) => c.verified)).toBe(true);

    // The reference now times out on the last case.
    await api.solutions.update(reference, { source: 'while True: pass  # MOCK:TLE' });
    // Changing the reference solution does not reset the marks by itself.
    expect((await api.testCases.list(itemId)).items.every((c) => c.verified)).toBe(true);

    const { results } = await api.testCases.verify(itemId, false);
    const last = results[results.length - 1]!;
    expect(last).toMatchObject({ ok: false, matches: false, verdict: 'time_limit_exceeded' });
    const cases = (await api.testCases.list(itemId)).items;
    expect(cases.map((c) => c.verified)).toEqual([true, true, true, true, true, false]);

    // A wrong output clears the mark as well.
    await api.solutions.update(reference, { source: 'print(0)  # MOCK:WA' });
    const wrong = await api.testCases.verify(itemId, false);
    expect(wrong.results.map((r) => r.matches)).toEqual([true, false, true, true, false, true]);
    expect((await api.testCases.list(itemId)).items.map((c) => c.verified)).toEqual([true, false, true, true, false, true]);
  });

  it('runs another solution as a check that changes nothing', async () => {
    const itemId = seedIds.items.mergeIntervals;
    const wrongId = seedIds.testCases.mergeIntervalsWrongExpected;
    const other = await api.solutions.create(itemId, { name: 'Second opinion', language: 'python', source: 'print(1)' });
    const before = await api.items.get(itemId);
    const casesBefore = (await api.testCases.list(itemId)).items;
    expect(casesBefore.find((c) => c.id === wrongId)?.verified).toBe(false);

    const { results } = await api.testCases.verify(itemId, false, other.id);
    expect(results).toHaveLength(casesBefore.length);
    expect(results.filter((r) => !r.matches).map((r) => r.testCaseId)).toEqual([wrongId]);
    // No verified mark is set or cleared, and the item is not touched.
    expect((await api.testCases.list(itemId)).items).toEqual(casesBefore);
    expect(await api.items.get(itemId)).toEqual(before);

    // Only the reference solution can replace expected outputs.
    const refused = await failure(api.testCases.verify(itemId, true, other.id));
    expect(refused.status).toBe(422);
    expect(refused.fields).toHaveProperty('updateExpected');
    expect((await api.testCases.list(itemId)).items).toEqual(casesBefore);

    // Naming the reference solution explicitly is the same as naming none.
    const reference = before.problem!.referenceSolution!.id!;
    await api.testCases.verify(itemId, true, reference);
    expect((await api.testCases.list(itemId)).items.find((c) => c.id === wrongId)).toMatchObject({ verified: true, expectedStdout: '2\n1 9\n10 12\n' });
  });

  it('reports how a chosen solution fails, and rejects a solution of another item', async () => {
    const itemId = seedIds.items.twoSum;
    // The seed brute force is too slow for the last case.
    const slow = await api.testCases.verify(itemId, false, seedIds.solutions.twoSumBruteForce);
    expect(slow.results.map((r) => r.ok)).toEqual([true, true, true, true, true, false]);
    expect(slow.results[5]).toMatchObject({ verdict: 'time_limit_exceeded', matches: false, actualStdout: '' });
    expect((await api.testCases.list(itemId)).items.every((c) => c.verified)).toBe(true);

    const broken = await api.solutions.create(itemId, { name: 'Does not build', language: 'cpp', source: 'int main() { MOCK:CE }' });
    const built = await api.testCases.verify(itemId, false, broken.id);
    expect(built.results.every((r) => !r.ok && r.verdict === 'compile_error' && r.stderr !== '')).toBe(true);

    const foreign = await failure(api.testCases.verify(itemId, false, seedIds.solutions.coinChangeTable));
    expect(foreign.status).toBe(422);
    expect(foreign.fields).toHaveProperty('solutionId');
    expect((await failure(api.testCases.verify(itemId, false, 'no-such-solution'))).status).toBe(422);
  });
});

describe('running a "solution only" problem', () => {
  const lists = seedIds.items.mergeKLists;

  it('runs a submission inside the harness and reports where its lines start', async () => {
    const item = await api.items.get(lists);
    const queued = await api.submissions.create(lists, { language: 'python', source: MERGE_K_LISTS_REFERENCE, mode: 'submit', stdin: null });
    // What is stored is what was submitted; the offset is the length of the prefix.
    expect(queued.source).toBe(MERGE_K_LISTS_REFERENCE);
    expect(queued.lineOffset).toBe(item.problem!.harness.python!.prefix.split('\n').length - 1);
    expect(queued.lineOffset).toBeGreaterThan(0);
    const { final } = await judged(queued.id);
    expect(final).toMatchObject({ verdict: 'accepted', passedCount: 7, totalCount: 7, lineOffset: queued.lineOffset });
    expect((await api.submissions.list(lists)).items[0]!.lineOffset).toBe(queued.lineOffset);

    // A program has nothing before the source.
    const plain = await api.submissions.create(seedIds.items.twoSum, { language: 'python', source: 'print(1)', mode: 'run', stdin: null });
    expect(plain.lineOffset).toBe(0);
  });

  it('fails the stub submitted as it is', async () => {
    const stub = (await api.items.get(lists)).problem!.starterCode.python!;
    const { final } = await judged((await api.submissions.create(lists, { language: 'python', source: stub, mode: 'run', stdin: null })).id);
    expect(final.verdict).toBe('wrong_answer');
    expect(final.passedCount).toBe(0);
    expect(final.results.every((r) => r.stdout === '')).toBe(true);
  });

  it('only runs the languages that have a harness', async () => {
    const java = await api.submissions.create(lists, { language: 'java', source: MERGE_K_LISTS_JAVA, mode: 'run', stdin: null });
    expect((await judged(java.id)).final.verdict).toBe('accepted');
    // Offered by the judge, but this problem has no harness for it.
    const err = await failure(api.submissions.create(lists, { language: 'go', source: 'package main', mode: 'run', stdin: null }));
    expect(err.status).toBe(422);
    expect(err.fields).toEqual({ language: 'has no harness on this problem' });
    // With no entries at all nothing can be run.
    await api.items.update(lists, { problem: { harness: {} } });
    expect((await failure(api.submissions.create(lists, { language: 'python', source: 'x', mode: 'run', stdin: null }))).status).toBe(422);
  });

  it('judges the assembled program: a harness that does not build fails every submission', async () => {
    const item = await api.items.get(lists);
    const python = item.problem!.harness.python!;
    await api.items.update(lists, { problem: { harness: { python: { ...python, suffix: `${python.suffix}\n# MOCK:CE` } } } });
    const { final } = await judged((await api.submissions.create(lists, { language: 'python', source: MERGE_K_LISTS_REFERENCE, mode: 'submit', stdin: null })).id);
    expect(final.verdict).toBe('compile_error');
    expect(final.compileOutput).not.toBe('');
  });

  it('verifies saved solutions through the harness of their language', async () => {
    const all = (await api.solutions.list(lists)).items;
    const reference = await api.testCases.verify(lists, false);
    expect(reference.results).toHaveLength(7);
    expect(reference.results.every((r) => r.ok && r.matches)).toBe(true);
    const java = all.find((s) => s.language === 'java')!;
    expect((await api.testCases.verify(lists, false, java.id)).results.every((r) => r.ok && r.matches)).toBe(true);

    // The stub saved as a solution prints nothing.
    const stub = await api.solutions.create(lists, { name: 'Untouched stub', language: 'python', source: (await api.items.get(lists)).problem!.starterCode.python! });
    expect((await api.testCases.verify(lists, false, stub.id)).results.every((r) => r.ok && !r.matches && r.actualStdout === '')).toBe(true);

    // A solution in a language without a harness cannot be run.
    const go = await api.solutions.create(lists, { name: 'Go', language: 'go', source: 'func mergeKLists() {}' });
    const err = await failure(api.testCases.verify(lists, false, go.id));
    expect(err.status).toBe(422);
    expect(err.fields).toHaveProperty('solutionId');
  });
});

describe('solutions', () => {
  const twoSum = seedIds.items.twoSum;

  it('lists the reference solution first, then oldest first', async () => {
    const { items } = await api.solutions.list(twoSum);
    expect(items.map((s) => s.id)).toEqual([seedIds.solutions.twoSumHashMap, seedIds.solutions.twoSumBruteForce, seedIds.solutions.twoSumCpp]);
    expect(items.map((s) => s.isReference)).toEqual([true, false, false]);
    expect(Object.keys(items[0]!).sort()).toEqual(['createdAt', 'id', 'isReference', 'itemId', 'language', 'name', 'notes', 'source', 'updatedAt']);
    expect(items[0]).toMatchObject({ itemId: twoSum, name: 'Hash map, one pass', language: 'python' });

    // Marking another one moves it to the front; the rest keep their age order.
    await api.solutions.update(seedIds.solutions.twoSumCpp, { isReference: true });
    expect((await api.solutions.list(twoSum)).items.map((s) => s.id)).toEqual([
      seedIds.solutions.twoSumCpp,
      seedIds.solutions.twoSumHashMap,
      seedIds.solutions.twoSumBruteForce,
    ]);
  });

  it('reports the reference solution on the item, with its id, and counts solutions', async () => {
    const item = await api.items.get(twoSum);
    const [reference] = (await api.solutions.list(twoSum)).items;
    expect(item.solutionCount).toBe(3);
    expect(item.problem?.referenceSolution).toEqual({ id: reference!.id, language: reference!.language, source: reference!.source });

    const listed = await api.items.list({ id: [twoSum, seedIds.items.rateLimiter, seedIds.items.capTheorem] });
    const count = (id: string) => listed.items.find((i) => i.id === id)?.solutionCount;
    expect(count(twoSum)).toBe(3);
    expect(count(seedIds.items.rateLimiter)).toBe(0);
    expect(count(seedIds.items.capTheorem)).toBe(0);
    expect((await api.items.get(seedIds.items.rateLimiter)).problem?.referenceSolution).toBeNull();
  });

  it('creates with defaults, trims the name and normalises line endings', async () => {
    const created = await api.solutions.create(twoSum, { name: '  Sorting first  ', language: 'ruby', source: 'puts 1\r\nputs 2\r\n' });
    expect(created).toMatchObject({ itemId: twoSum, name: 'Sorting first', language: 'ruby', source: 'puts 1\nputs 2\n', notes: '', isReference: false });
    expect(created.createdAt).toBe(created.updatedAt);
    const { items } = await api.solutions.list(twoSum);
    expect(items[items.length - 1]?.id).toBe(created.id);
    expect((await api.items.get(twoSum)).solutionCount).toBe(4);
  });

  it('validates input with per-field messages', async () => {
    const missing = await failure(api.solutions.create(twoSum, {} as never));
    expect(missing.status).toBe(422);
    expect(Object.keys(missing.fields).sort()).toEqual(['language', 'name', 'source']);

    const base = { name: 'x', language: 'python', source: 'print(1)' };
    const field = async (patch: Record<string, unknown>) => Object.keys((await failure(api.solutions.create(twoSum, { ...base, ...patch } as never))).fields);
    expect(await field({ name: '   ' })).toEqual(['name']);
    expect(await field({ name: 'n'.repeat(LIMITS.maxSolutionNameChars + 1) })).toEqual(['name']);
    expect(await field({ name: 'two\nlines' })).toEqual(['name']);
    expect(await field({ language: 'brainfuck' })).toEqual(['language']);
    expect(await field({ source: '  \n' })).toEqual(['source']);
    expect(await field({ source: 'x'.repeat(LIMITS.maxSourceBytes + 1) })).toEqual(['source']);
    expect(await field({ notes: 'n'.repeat(LIMITS.maxSolutionNotesChars + 1) })).toEqual(['notes']);
    expect(await field({ isReference: 'yes' })).toEqual(['isReference']);
    // At the limits, and whether or not a judge offers the language, it is accepted.
    start({ judge: 'none' });
    const ok = await api.solutions.create(twoSum, {
      name: 'n'.repeat(LIMITS.maxSolutionNameChars),
      language: 'kotlin',
      source: 'fun main() {}',
      notes: 'n'.repeat(LIMITS.maxSolutionNotesChars),
    });
    expect(ok.language).toBe('kotlin');

    const patch = await failure(api.solutions.update(ok.id, { name: '', source: '' }));
    expect(Object.keys(patch.fields).sort()).toEqual(['name', 'source']);
    expect((await api.solutions.list(twoSum)).items.find((s) => s.id === ok.id)?.source).toBe('fun main() {}');
  });

  it('is rejected for a reading and unknown ids', async () => {
    const reading = seedIds.items.capTheorem;
    expect((await failure(api.solutions.list(reading))).status).toBe(422);
    expect((await failure(api.solutions.create(reading, { name: 'x', language: 'python', source: 'x' }))).status).toBe(422);
    expect((await failure(api.solutions.list('no-such-item'))).status).toBe(404);
    expect((await failure(api.solutions.update('no-such-solution', { name: 'x' }))).status).toBe(404);
    expect((await failure(api.solutions.remove('no-such-solution'))).status).toBe(404);
  });

  it('keeps at most one reference solution per item', async () => {
    const created = await api.solutions.create(twoSum, { name: 'New reference', language: 'go', source: 'package main', isReference: true });
    expect(created.isReference).toBe(true);
    let list = (await api.solutions.list(twoSum)).items;
    expect(list.filter((s) => s.isReference).map((s) => s.id)).toEqual([created.id]);
    expect((await api.items.get(twoSum)).problem?.referenceSolution).toEqual({ id: created.id, language: 'go', source: 'package main' });

    await api.solutions.update(seedIds.solutions.twoSumBruteForce, { isReference: true });
    list = (await api.solutions.list(twoSum)).items;
    expect(list.filter((s) => s.isReference).map((s) => s.id)).toEqual([seedIds.solutions.twoSumBruteForce]);
    // Another item's reference is not affected.
    expect((await api.items.get(seedIds.items.coinChange)).problem?.referenceSolution?.id).toBe(seedIds.solutions.coinChangeTable);
  });

  it('raises the revision only when what the item reports as its reference changes', async () => {
    const start = await api.items.get(twoSum);
    const revision = async () => (await api.items.get(twoSum)).revision;
    const reference = seedIds.solutions.twoSumHashMap;
    const other = seedIds.solutions.twoSumBruteForce;

    // Other saved solutions, and the reference's name and notes, are outside the revision.
    const added = await api.solutions.create(twoSum, { name: 'Scratch', language: 'python', source: 'print(1)' });
    await api.solutions.update(other, { name: 'Brute force, renamed', source: 'print(2)', language: 'ruby', notes: 'changed' });
    await api.solutions.update(reference, { name: 'Renamed reference', notes: 'new notes' });
    await api.solutions.remove(added.id);
    expect(await revision()).toBe(start.revision);
    // They still count as a modification of the item.
    expect((await api.items.get(twoSum)).updatedAt > start.updatedAt).toBe(true);

    // The reference's language or source is item content.
    await api.solutions.update(reference, { source: 'print(3)' });
    expect(await revision()).toBe(start.revision + 1);
    await api.solutions.update(reference, { language: 'ruby' });
    expect(await revision()).toBe(start.revision + 2);
    // So is which solution it is: switching, unmarking, marking, creating as reference, deleting it.
    await api.solutions.update(other, { isReference: true });
    expect(await revision()).toBe(start.revision + 3);
    await api.solutions.update(other, { isReference: false });
    expect(await revision()).toBe(start.revision + 4);
    expect((await api.items.get(twoSum)).problem?.referenceSolution).toBeNull();
    await api.solutions.update(other, { isReference: true });
    expect(await revision()).toBe(start.revision + 5);
    const fresh = await api.solutions.create(twoSum, { name: 'Fresh', language: 'python', source: 'print(4)', isReference: true });
    expect(await revision()).toBe(start.revision + 6);
    await api.solutions.remove(fresh.id);
    expect(await revision()).toBe(start.revision + 7);
    expect((await api.items.get(twoSum)).problem?.referenceSolution).toBeNull();

    // A request that leaves every field as it was changes nothing, not even a timestamp.
    const before = await api.items.get(twoSum);
    const [first] = (await api.solutions.list(twoSum)).items;
    const same = await api.solutions.update(first!.id, { name: first!.name, source: first!.source, isReference: first!.isReference });
    expect(same).toEqual(first);
    expect(await api.items.get(twoSum)).toEqual(before);
  });

  it('does not reset verified marks when the reference changes', async () => {
    await api.solutions.update(seedIds.solutions.twoSumHashMap, { source: 'print(5)' });
    await api.solutions.update(seedIds.solutions.twoSumCpp, { isReference: true });
    expect((await api.testCases.list(twoSum)).items.every((c) => c.verified)).toBe(true);
  });

  it('checks expectedRevision on writes', async () => {
    const item = await api.items.get(twoSum);
    const reference = seedIds.solutions.twoSumHashMap;

    const staleCreate = await failure(
      api.solutions.create(twoSum, { name: 'x', language: 'python', source: 'x', isReference: true, expectedRevision: item.revision + 3 }),
    );
    expect(staleCreate.status).toBe(409);
    expect(staleCreate.isRevisionConflict).toBe(true);
    expect(staleCreate.currentRevision).toBe(item.revision);
    const stalePatch = await failure(api.solutions.update(reference, { source: 'print(6)', expectedRevision: item.revision - 1 }));
    expect(stalePatch.isRevisionConflict).toBe(true);
    // Nothing was written.
    expect(await api.items.get(twoSum)).toEqual(item);
    expect((await api.solutions.list(twoSum)).items).toHaveLength(3);

    const saved = await api.solutions.update(reference, { source: 'print(6)', expectedRevision: item.revision });
    expect(saved.source).toBe('print(6)');
    expect((await api.items.get(twoSum)).revision).toBe(item.revision + 1);
    // The revision the caller read is now stale for the next reference change.
    expect((await failure(api.solutions.update(seedIds.solutions.twoSumCpp, { isReference: true, expectedRevision: item.revision }))).status).toBe(409);
    await api.solutions.update(seedIds.solutions.twoSumCpp, { isReference: true, expectedRevision: item.revision + 1 });
    expect((await api.items.get(twoSum)).revision).toBe(item.revision + 2);
  });

  it('refuses one more than the limit with a conflict', async () => {
    const itemId = seedIds.items.rateLimiter;
    for (let i = 0; i < LIMITS.maxSolutionsPerItem; i++) {
      await api.solutions.create(itemId, { name: `Attempt ${i + 1}`, language: 'python', source: `print(${i})` });
    }
    const err = await failure(api.solutions.create(itemId, { name: 'One too many', language: 'python', source: 'print()' }));
    expect(err.status).toBe(409);
    expect(err.code).toBe('conflict');
    expect(err.isRevisionConflict).toBe(false);
    // Writing a reference solution to an item that has none would need a new one, too.
    const viaItem = await failure(api.items.update(itemId, { problem: { referenceSolution: { language: 'python', source: 'print()' } } }));
    expect(viaItem.status).toBe(409);
    expect((await api.items.get(itemId)).solutionCount).toBe(LIMITS.maxSolutionsPerItem);
  });

  it('writes problem.referenceSolution through to the saved solution', async () => {
    // Updates the reference solution in place; an id in the written value is ignored.
    const before = await api.items.get(twoSum);
    const patched = await api.items.update(twoSum, {
      problem: { referenceSolution: { id: seedIds.solutions.twoSumCpp, language: 'go', source: 'package main\r\n' } },
    });
    expect(patched.problem?.referenceSolution).toEqual({ id: seedIds.solutions.twoSumHashMap, language: 'go', source: 'package main\n' });
    expect(patched.revision).toBe(before.revision + 1);
    expect(patched.solutionCount).toBe(3);
    const [reference] = (await api.solutions.list(twoSum)).items;
    expect(reference).toMatchObject({ id: seedIds.solutions.twoSumHashMap, name: 'Hash map, one pass', language: 'go', source: 'package main\n', isReference: true });

    // Writing the same value again is not a change.
    expect((await api.items.update(twoSum, { problem: { referenceSolution: { language: 'go', source: 'package main\n' } } })).revision).toBe(before.revision + 1);

    // null only removes the mark; the solution stays saved.
    const cleared = await api.items.update(twoSum, { problem: { referenceSolution: null } });
    expect(cleared.problem?.referenceSolution).toBeNull();
    expect(cleared.solutionCount).toBe(3);
    expect(cleared.revision).toBe(before.revision + 2);
    expect((await api.solutions.list(twoSum)).items.some((s) => s.isReference)).toBe(false);

    // With no reference, a write creates one under the standard name.
    const again = await api.items.update(twoSum, { problem: { referenceSolution: { language: 'python', source: 'print(7)' } } });
    expect(again.solutionCount).toBe(4);
    const created = (await api.solutions.list(twoSum)).items[0]!;
    expect(created).toMatchObject({ name: REFERENCE_SOLUTION_NAME, language: 'python', source: 'print(7)', notes: '', isReference: true });
    expect(again.problem?.referenceSolution?.id).toBe(created.id);
  });

  it('saves a reference solution given at creation or through a bulk test-case save', async () => {
    const made = await api.items.create({
      type: 'problem',
      title: 'With a solution',
      problem: { referenceSolution: { language: 'python', source: 'print(8)' } },
    });
    expect(made.solutionCount).toBe(1);
    expect(made.revision).toBe(1);
    const [only] = (await api.solutions.list(made.id)).items;
    expect(only).toMatchObject({ name: REFERENCE_SOLUTION_NAME, isReference: true, source: 'print(8)' });
    expect(made.problem?.referenceSolution).toEqual({ id: only!.id, language: 'python', source: 'print(8)' });

    const bare = await api.items.create({ type: 'problem', title: 'Without one' });
    expect(bare.solutionCount).toBe(0);
    await api.testCases.bulk(bare.id, { cases: [{ expectedStdout: '1\n' }], referenceSolution: { language: 'cpp', source: 'int main() {}' } });
    const after = await api.items.get(bare.id);
    expect(after.solutionCount).toBe(1);
    expect(after.revision).toBe(2);
    expect((await api.solutions.list(bare.id)).items[0]).toMatchObject({ name: REFERENCE_SOLUTION_NAME, language: 'cpp', isReference: true });
  });

  it('deletes a solution, and all of them with their item', async () => {
    await api.solutions.remove(seedIds.solutions.twoSumBruteForce);
    expect((await api.solutions.list(twoSum)).items.map((s) => s.id)).toEqual([seedIds.solutions.twoSumHashMap, seedIds.solutions.twoSumCpp]);
    expect((await failure(api.solutions.remove(seedIds.solutions.twoSumBruteForce))).status).toBe(404);

    // Deleting the reference solution leaves the item without one.
    await api.solutions.remove(seedIds.solutions.twoSumHashMap);
    const item = await api.items.get(twoSum);
    expect(item.problem?.referenceSolution).toBeNull();
    expect(item.solutionCount).toBe(1);

    await api.items.remove(twoSum);
    expect(server.db.solutions.some((s) => s.itemId === twoSum)).toBe(false);
    expect((await failure(api.solutions.update(seedIds.solutions.twoSumCpp, { name: 'x' }))).status).toBe(404);
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
    expect((await api.items.list()).total).toBe(25);
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

  it('can report more than one result between two polls', async () => {
    vi.useFakeTimers();
    const queued = await api.submissions.create(seedIds.items.twoSum, { language: 'python', source: 'print(1)', mode: 'submit', stdin: null });
    expect(queued.totalCount).toBe(6);
    // Step the judge one timer at a time and watch the stored submission, so that no state is missed.
    const stored = server.db.submissions.find((s) => s.id === queued.id)!;
    const lengths = [stored.results.length];
    for (let i = 0; i < 50 && stored.status !== 'completed'; i++) {
      vi.advanceTimersToNextTimer();
      lengths.push(stored.results.length);
    }
    expect(stored.status).toBe('completed');
    const jumps = lengths.slice(1).map((n, i) => n - lengths[i]!);
    expect(lengths[0]).toBe(0);
    expect(lengths[lengths.length - 1]).toBe(6);
    expect(jumps.every((j) => j >= 0 && j <= 2)).toBe(true);
    // Some results arrived together.
    expect(jumps).toContain(2);
    expect(stored.passedCount).toBe(6);
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
    // The reported time is when the engine stopped the program: later than the limit.
    const limit = (await api.items.get(lru)).problem!.timeLimitMs;
    expect(tle.results[tle.results.length - 1]!.timeMs).toBe(limit + TLE_GRACE_MS);
    expect(tle.timeMs).toBeGreaterThan(limit);

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
    const plain = await api.ai.draft({ text, styleId: null, interfaceHint: 'program' });
    expect(plain.style).toBeNull();
    expect(Object.keys(plain.draft.problem!.starterCode)).toHaveLength(5);
    expect(plain.draft.body).toContain('## Examples');

    const terse = await api.ai.draft({ text: 'two sum', styleId: seedIds.styles.terse, interfaceHint: 'program' });
    expect(terse.style?.name).toBe('Terse contest style');
    expect(Object.keys(terse.draft.problem!.starterCode).sort()).toEqual(['cpp', 'python']);
    expect(terse.draft.body).not.toContain('## Follow-up');

    const err = await failure(api.ai.draft({ text, styleId: 'nope' }));
    expect(err.status).toBe(422);
    expect(err.fields).toHaveProperty('styleId');

    await api.styles.remove(seedIds.styles.leetcode);
    expect((await api.ai.draft({ text })).style).toBeNull();
  });

  it('chooses the interface itself: a function for one routine, a program when input and output are the task', async () => {
    const algorithm = await api.ai.draft({ text: 'two sum, array + target, return indices', styleId: null });
    expect(algorithm.draft.problem!.interface).toBe('function');
    expect(Object.keys(algorithm.draft.problem!.harness)).toEqual([...KIT_LANGUAGES]);
    expect(Object.keys(algorithm.draft.problem!.starterCode)).toEqual([...KIT_LANGUAGES]);
    expect(algorithm.draft.problem!.starterCode.python).toBe('class Solution:\n    def twoSum(self, nums: list[int], target: int) -> list[int]:\n        ');
    // One JSON value per argument in, one JSON value out.
    expect(algorithm.draft.testCases[0]).toMatchObject({ stdin: '[2,7,11,15]\n9\n', expectedStdout: '[0,1]\n' });
    // The reference solution is the solution part, in a language that has a harness.
    expect(algorithm.draft.problem!.referenceSolution).toMatchObject({ language: 'python' });
    expect(algorithm.draft.problem!.referenceSolution!.source).toMatch(/^class Solution:/);
    expect(algorithm.draft.problem!.referenceSolution!.source).not.toContain('stdin');

    for (const text of ['Design an LRU cache with get and put', 'Parse a log file and print the busiest hour', 'simulate a bank queue; the input format is one event per line']) {
      const { draft } = await api.ai.draft({ text, styleId: null });
      expect(draft.problem, text).toMatchObject({ interface: 'program', harness: {} });
      expect(draft.problem!.referenceSolution!.source, text).toContain('sys.stdin');
    }
    const generic = (await api.ai.draft({ text: 'Given a list of temperatures, find the longest warm streak.', styleId: null })).draft;
    expect(generic.problem!.interface).toBe('function');
    expect(generic.problem!.starterCode.python).toContain('def solve(self, nums: list[int]) -> int:');
  });

  it('follows interfaceHint when it gives one', async () => {
    const program = (await api.ai.draft({ text: 'two sum', interfaceHint: 'program', styleId: null })).draft;
    expect(program.problem).toMatchObject({ interface: 'program', harness: {} });
    expect(program.testCases[0]!.stdin).toBe('4\n2 7 11 15\n9\n');
    // Written up only as a program in the mock: drafted from the text instead.
    const fn = (await api.ai.draft({ text: 'Design an LRU cache with get and put', interfaceHint: 'function', styleId: null })).draft;
    expect(fn.problem!.interface).toBe('function');
    expect(Object.keys(fn.problem!.harness).length).toBeGreaterThan(0);
    // It says nothing for a reading.
    expect((await api.ai.draft({ text: 'two sum', typeHint: 'reading', interfaceHint: 'function' })).draft.problem).toBeNull();
    const err = await failure(api.ai.draft({ text: 'two sum', interfaceHint: 'class' as never }));
    expect(err.status).toBe(422);
    expect(err.fields).toHaveProperty('interfaceHint');
  });

  it('keeps a stub and its runner together when a style narrows the languages', async () => {
    // The default preset asks for Python and Go only.
    const { draft } = await api.ai.draft({ text: 'valid parentheses' });
    expect(draft.problem!.interface).toBe('function');
    expect(Object.keys(draft.problem!.starterCode).sort()).toEqual(['go', 'python']);
    expect(Object.keys(draft.problem!.harness).sort()).toEqual(['go', 'python']);
    // The terse one asks for C++ and Python; there is no C++ runner, so Python it is.
    const terse = (await api.ai.draft({ text: 'valid parentheses', styleId: seedIds.styles.terse })).draft;
    expect(Object.keys(terse.problem!.starterCode)).toEqual(['python']);
    expect(Object.keys(terse.problem!.harness)).toEqual(['python']);
  });

  it('checks the reference solution against the draft\'s test cases', async () => {
    const good = await api.ai.draft({ text: 'two sum', styleId: null });
    expect(good.check).toEqual({ attempted: true, engine: 'judge0', passed: 2, total: 2, error: null, runners: KIT_LANGUAGES.map((language) => ({ language, status: 'ok', error: null })).sort((a, b) => a.language.localeCompare(b.language)), largeCase: null });
    expect(good.draft.testCases.every((c) => c.verified)).toBe(true);

    // The mock can be asked for an example its own solution disagrees with.
    const bad = await api.ai.draft({ text: 'two sum MOCK:MISMATCH', styleId: null });
    expect(bad.check).toMatchObject({ attempted: true, passed: 1, total: 2 });
    expect(bad.check!.error).toMatch(/^Example 2: expected \[1,2\], but the reference solution printed /);
    expect(bad.draft.testCases.map((c) => c.verified)).toEqual([true, false]);

    expect((await api.ai.draft({ text: 'Notes on how vector clocks work. Each process keeps a counter per process.' })).check).toBeNull();

    start({ judge: 'none' });
    const none = await api.ai.draft({ text: 'two sum', styleId: null });
    expect(none.check).toEqual({ attempted: false, engine: null, passed: 0, total: 2, error: null, runners: [], largeCase: null });
    expect(none.draft.testCases.some((c) => c.verified)).toBe(false);
    expect(none.draft.problem!.referenceSolution).not.toBeNull();

    // An engine that cannot be reached is reported in the check, not as a failed request.
    start({ judge: 'down' });
    const down = await api.ai.draft({ text: 'two sum', styleId: null });
    expect(down.check).toMatchObject({ passed: 0, total: 2 });
    expect(down.check!.error).toMatch(/unreachable/);
    expect(down.draft.testCases.some((c) => c.verified)).toBe(false);
  });

  it('proves every runner of a "solution only" draft, not only the reference solution\'s', async () => {
    // The default preset keeps Python and Go; the mock can be asked to leave Go's runner broken.
    const { draft, check } = await api.ai.draft({ text: 'two sum MOCK:RUNNER' });
    expect(check).toMatchObject({ attempted: true, passed: 2, total: 2, error: null });
    expect(check!.runners).toEqual([
      { language: 'go', status: 'failed', error: expect.stringMatching(/^the go starter code did not compile inside its harness: /) },
      { language: 'python', status: 'ok', error: null },
    ]);
    // Saved as it is, the problem cannot be solved in Go until the runner is fixed.
    const item = await api.items.create({ type: 'problem', title: draft.title, problem: draft.problem!, testCases: draft.testCases.map((c) => ({ ...c, origin: 'ai' as const })) });
    const go = await judged((await api.submissions.create(item.id, { language: 'go', source: 'func twoSum() {}', mode: 'run', stdin: null })).id);
    expect(go.final.verdict).toBe('compile_error');
    // A revision does not break it twice.
    const revised = await api.ai.draft({ text: 'two sum MOCK:RUNNER', previousDraft: draft, instruction: 'shorter' });
    expect(revised.draft.problem!.harness.go).toEqual(draft.problem!.harness.go);

    // A runner without starter code is not tried, and neither is one the engine has no language for.
    const first = (await api.ai.draft({ text: 'two sum', styleId: null })).draft;
    const partial = { ...first, problem: { ...first.problem!, starterCode: { ...first.problem!.starterCode, java: '' } } };
    const skipped = await api.ai.draft({ text: 'two sum', previousDraft: partial, instruction: 'shorter', styleId: null });
    expect(skipped.check!.runners.find((r) => r.language === 'java')).toEqual({ language: 'java', status: 'skipped', error: null });
    expect(skipped.check!.runners.filter((r) => r.status === 'ok').map((r) => r.language)).toEqual(['go', 'javascript', 'python']);

    // A program has none, and nothing is tried without an engine or when it cannot be reached.
    expect((await api.ai.draft({ text: 'two sum', interfaceHint: 'program', styleId: null })).check!.runners).toEqual([]);
    start({ judge: 'down' });
    expect((await api.ai.draft({ text: 'two sum', styleId: null })).check!.runners.every((r) => r.status === 'skipped')).toBe(true);
    start({ judge: 'none' });
    expect((await api.ai.draft({ text: 'two sum', styleId: null })).check!.runners).toEqual([]);
  });

  it('reports what each generation cost, and counts it towards the default provider', async () => {
    const before = (await api.settings.getAi()).providers[0]!;
    const { usage, draft } = await api.ai.draft({ text: 'two sum', styleId: null });
    expect(usage.model).toBe('claude-opus-5-5');
    expect(usage.inputTokens).toBeGreaterThan(1800);
    expect(usage.outputTokens).toBe(Math.ceil(JSON.stringify(draft).length / 4));
    expect(usage.durationMs).toBeGreaterThan(0);

    const variant = await api.ai.variant(seedIds.items.coinChange, { styleId: null });
    const tests = await api.ai.testCases(seedIds.items.twoSum, { count: 3 });
    expect(variant.usage.model).toBe('claude-opus-5-5');
    expect(tests.usage.outputTokens).toBeGreaterThan(0);
    // A failed request is counted too, with no tokens.
    await failure(api.ai.draft({ text: 'anything MOCK:FAIL' }));

    const [after, ...others] = (await api.settings.getAi()).providers;
    const spent = [usage, variant.usage, tests.usage];
    for (const period of ['last30Days', 'allTime'] as const) {
      expect(after!.usage[period]).toEqual({
        requests: before.usage[period].requests + 4,
        failed: before.usage[period].failed + 1,
        inputTokens: before.usage[period].inputTokens + spent.reduce((sum, u) => sum + u.inputTokens!, 0),
        outputTokens: before.usage[period].outputTokens + spent.reduce((sum, u) => sum + u.outputTokens!, 0),
      });
    }
    expect(Date.parse(after!.usage.lastUsedAt!)).toBeGreaterThan(Date.parse(before.usage.lastUsedAt!));
    // The other providers were not involved.
    expect(others.map((p) => p.usage.allTime.requests)).toEqual([9, 0]);
  });

  it('keeps the interface, the harness and the reference solution through a revision, and checks again', async () => {
    const first = (await api.ai.draft({ text: 'two sum', styleId: null })).draft;
    const edited = { ...first, problem: { ...first.problem!, harness: { python: first.problem!.harness.python! }, starterCode: { python: '# mine' } } };
    const revised = await api.ai.draft({ text: 'two sum', previousDraft: edited, instruction: 'make it harder', interfaceHint: 'function', styleId: null });
    expect(revised.draft.problem).toMatchObject({ interface: 'function', harness: edited.problem.harness, starterCode: { python: '# mine' }, referenceSolution: first.problem!.referenceSolution });
    expect(revised.check).toMatchObject({ attempted: true, passed: 2, total: 2 });
    expect(revised.draft.testCases.every((c) => c.verified)).toBe(true);

    // Without the runner of the solution's language there is nothing to run it with.
    const noRunner = { ...first, problem: { ...first.problem!, harness: { go: first.problem!.harness.go! } } };
    const unrun = await api.ai.draft({ text: 'two sum', previousDraft: noRunner, instruction: 'shorter', styleId: null });
    expect(unrun.check).toMatchObject({ passed: 0, total: 2 });
    expect(unrun.check!.error).toMatch(/no harness/);
    // A draft that went back as a program carries no harness.
    const asProgram = { ...first, problem: { ...first.problem!, interface: 'program' as const, harness: {} } };
    expect((await api.ai.draft({ text: 'two sum', previousDraft: asProgram, instruction: 'shorter', styleId: null })).draft.problem).toMatchObject({ interface: 'program', harness: {} });
  });

  it('saves a reviewed draft with its harness, its reference solution and the verified marks', async () => {
    const { draft } = await api.ai.draft({ text: 'two sum', styleId: null });
    const item = await api.items.create({
      type: 'problem',
      title: draft.title,
      body: draft.body,
      problem: draft.problem!,
      testCases: draft.testCases.map((c) => ({ ...c, origin: 'ai' as const })),
    });
    expect(item.problem).toMatchObject({ interface: 'function', harness: draft.problem!.harness });
    expect(item.problem!.referenceSolution).toMatchObject(draft.problem!.referenceSolution!);
    expect(item.solutionCount).toBe(1);
    expect((await api.testCases.list(item.id)).items.map((c) => c.verified)).toEqual([true, true]);
    // The saved reference solution passes when it is run, and the stub does not.
    expect((await api.testCases.verify(item.id, false)).results.every((r) => r.ok && r.matches)).toBe(true);
    const stub = await judged((await api.submissions.create(item.id, { language: 'python', source: draft.problem!.starterCode.python!, mode: 'submit', stdin: null })).id);
    expect(stub.final.verdict).toBe('wrong_answer');
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

  it('keeps the original\'s interface, with its stubs, runners and a checked reference solution', async () => {
    const lists = seedIds.items.mergeKLists;
    const origin = await api.items.get(lists);
    const { draft, check } = await api.ai.variant(lists, { mode: 'similar', styleId: null });
    expect(draft.problem).toMatchObject({ interface: 'function', harness: origin.problem!.harness, starterCode: origin.problem!.starterCode });
    expect(draft.problem!.referenceSolution).toEqual({ language: 'python', source: MERGE_K_LISTS_REFERENCE });
    expect(check).toMatchObject({ attempted: true, engine: 'judge0', passed: 3, total: 3, error: null });
    expect(check!.runners).toEqual([
      { language: 'java', status: 'ok', error: null },
      { language: 'python', status: 'ok', error: null },
    ]);
    expect(draft.testCases.every((c) => c.verified)).toBe(true);

    const program = await api.ai.variant(seedIds.items.coinChange, { mode: 'easier', styleId: null });
    expect(program.draft.problem).toMatchObject({ interface: 'program', harness: {} });
    expect(program.check).toMatchObject({ attempted: true, error: null });
    // A twist has no examples, so there is nothing to check.
    expect((await api.ai.variant(lists, { mode: 'twist', styleId: null })).check).toMatchObject({ attempted: false, total: 0 });
    expect((await api.ai.variant(seedIds.items.capTheorem, {})).check).toBeNull();
  });

  it('takes the other interface when interfaceHint asks for it', async () => {
    const lists = seedIds.items.mergeKLists;
    const { draft, check } = await api.ai.variant(lists, { interfaceHint: 'program', styleId: null });
    expect(draft.problem).toMatchObject({ interface: 'program', harness: {}, referenceSolution: null });
    expect(check).toMatchObject({ attempted: false });
    expect((await api.ai.variant(lists, { interfaceHint: 'function', styleId: null })).draft.problem!.interface).toBe('function');
    expect((await api.ai.variant(seedIds.items.coinChange, { interfaceHint: 'function', styleId: null })).draft.problem).toMatchObject({ interface: 'function', harness: {} });

    const err = await failure(api.ai.variant(lists, { interfaceHint: 'auto' as never }));
    expect(err.status).toBe(422);
    expect(err.fields).toHaveProperty('interfaceHint');
    expect((await failure(api.ai.variant(seedIds.items.capTheorem, { interfaceHint: 'function' }))).status).toBe(422);
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

  it('writes only the solution part for a "solution only" problem, in a language that has a harness', async () => {
    const lists = seedIds.items.mergeKLists;
    const python = await api.ai.testCases(lists, { count: 4 });
    expect(python.referenceSolution).toEqual({ language: 'python', source: MERGE_K_LISTS_REFERENCE });
    expect(python.cases.every((c) => c.stdin.startsWith('['))).toBe(true);
    const java = await api.ai.testCases(lists, { count: 4, language: 'java' });
    expect(java.referenceSolution).toEqual({ language: 'java', source: MERGE_K_LISTS_JAVA });

    const err = await failure(api.ai.testCases(lists, { language: 'go' }));
    expect(err.status).toBe(422);
    expect(err.fields).toEqual({ language: 'has no harness on this problem' });
    // The same language is fine for a full program.
    expect((await api.ai.testCases(seedIds.items.twoSum, { count: 2, language: 'go' })).referenceSolution.language).toBe('go');
  });

  it('leaves out proposals that repeat an input, and says how many', async () => {
    const plain = await api.ai.testCases(seedIds.items.twoSum, { count: 6 });
    expect(plain.duplicatesDropped).toBe(0);
    expect(plain.cases).toHaveLength(6);
    // The mock can be asked for two repeats.
    const repeated = await api.ai.testCases(seedIds.items.twoSum, { count: 6, instruction: 'stress the limits MOCK:REPEAT' });
    expect(repeated.duplicatesDropped).toBe(2);
    expect(repeated.cases).toHaveLength(4);
    expect((await api.ai.testCases(seedIds.items.twoSum, { count: 1, instruction: 'MOCK:REPEAT' })).cases).toHaveLength(1);
    // All of them can be repeats: the answer is still a proposal, with nothing in it.
    const none = await api.ai.testCases(seedIds.items.twoSum, { count: 8, instruction: 'MOCK:REPEAT-ALL' });
    expect(none).toMatchObject({ cases: [], duplicatesDropped: 8 });
    expect(none.usage.logId).not.toBeNull();
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

describe('choosing the provider of a request', () => {
  const providers = async () => {
    const { providers: list } = await api.settings.getAi();
    const named = (name: string) => list.find((p) => p.name === name)!;
    return { personal: named('Personal key'), ollama: named('Local Ollama'), gateway: named('Work gateway') };
  };
  const latestLog = async () => (await api.settings.log({ limit: 1 })).items[0]!;
  const requestsOf = async (id: string) => (await api.settings.getAi()).providers.find((p) => p.id === id)!.usage.allTime.requests;

  it('uses the named provider for a draft, a variant and test cases, and leaves the default alone', async () => {
    const { personal, ollama, gateway } = await providers();
    const before = { personal: await requestsOf(personal.id), ollama: await requestsOf(ollama.id), gateway: await requestsOf(gateway.id) };

    const drafted = await api.ai.draft({ text: 'two sum, array + target, return indices', providerId: ollama.id });
    expect(drafted.usage.model).toBe('qwen2.5-coder:14b');
    expect(await latestLog()).toMatchObject({ operation: 'draft', providerId: ollama.id, providerName: 'Local Ollama', model: 'qwen2.5-coder:14b' });

    const variant = await api.ai.variant(seedIds.items.twoSum, { mode: 'harder', providerId: gateway.id });
    expect(variant.usage.model).toBe('llama3.1:70b');
    expect(await latestLog()).toMatchObject({ operation: 'variant', providerId: gateway.id, model: 'llama3.1:70b' });

    const cases = await api.ai.testCases(seedIds.items.twoSum, { count: 3, providerId: ollama.id });
    expect(cases.usage.model).toBe('qwen2.5-coder:14b');
    expect(await latestLog()).toMatchObject({ operation: 'testcases', providerId: ollama.id });

    expect(await requestsOf(ollama.id)).toBe(before.ollama + 2);
    expect(await requestsOf(gateway.id)).toBe(before.gateway + 1);
    expect(await requestsOf(personal.id)).toBe(before.personal);
    expect((await api.settings.getAi()).defaultProviderId).toBe(personal.id);
    expect((await api.meta()).ai.providerId).toBe(personal.id);

    // Without one, or with `null`, the default answers.
    expect((await api.ai.draft({ text: 'two sum', providerId: null })).usage.model).toBe('claude-opus-5-5');
    expect((await api.ai.testCases(seedIds.items.twoSum, { count: 2 })).usage.model).toBe('claude-opus-5-5');
    expect(await requestsOf(personal.id)).toBe(before.personal + 2);
  });

  it('logs a failed request against the named provider', async () => {
    const { ollama } = await providers();
    const before = await requestsOf(ollama.id);
    expect((await failure(api.ai.draft({ text: 'MOCK:FAIL', providerId: ollama.id }))).code).toBe('upstream_error');
    expect(await latestLog()).toMatchObject({ providerId: ollama.id, status: 'failed' });
    expect(await requestsOf(ollama.id)).toBe(before + 1);
  });

  it('turns down an unknown or unready provider without generating anything', async () => {
    const notReady = await api.settings.createProvider({ name: 'Bare', kind: 'openai_compatible' });
    const logged = (await api.settings.log()).total;
    const requests = [
      () => api.ai.draft({ text: 'two sum', providerId: 'nope' }),
      () => api.ai.draft({ text: 'two sum', providerId: notReady.id }),
      () => api.ai.variant(seedIds.items.twoSum, { providerId: 'nope' }),
      () => api.ai.variant(seedIds.items.twoSum, { providerId: notReady.id }),
      () => api.ai.testCases(seedIds.items.twoSum, { providerId: 'nope' }),
      () => api.ai.testCases(seedIds.items.twoSum, { providerId: notReady.id }),
      () => api.ai.draft({ text: 'two sum', providerId: 42 as never }),
    ];
    for (const request of requests) {
      const err = await failure(request());
      expect(err.status).toBe(422);
      expect(Object.keys(err.fields)).toEqual(['providerId']);
    }
    expect((await api.settings.log()).total).toBe(logged);
  });

  it('works with a named provider when there is no default, environment providers included', async () => {
    const { ollama } = await providers();
    await api.settings.putAi({ defaultProviderId: null });
    expect((await failure(api.ai.draft({ text: 'two sum' }))).code).toBe('ai_unavailable');
    expect((await api.ai.draft({ text: 'two sum', providerId: ollama.id })).usage.model).toBe('qwen2.5-coder:14b');

    start(optionsFromFlags(['ai-env', 'no-ai', 'instant']));
    expect((await api.ai.testCases(seedIds.items.twoSum, { count: 2, providerId: 'env-anthropic' })).usage.model).toBe('claude-opus-5-5');
    expect(await latestLog()).toMatchObject({ providerId: 'env-anthropic' });
    expect((await api.settings.getAi()).defaultProviderId).toBeNull();
  });
});

describe('checking a problem that is not saved', () => {
  const problem = { interface: 'program' as const, compare: 'tokens' as const, timeLimitMs: 2000, referenceSolution: { language: 'python', source: 'print(1)' } };
  const cases = [
    { name: 'One', stdin: '1\n', expectedStdout: '1\n' },
    { name: 'Two', stdin: '2\n', expectedStdout: '2\n' },
    { name: 'Three', stdin: '3\n', expectedStdout: '3\n' },
    { name: 'Four', stdin: '4\n', expectedStdout: '4\n' },
  ];
  const passed = { outcome: 'passed', error: null };

  it('runs the reference solution on every case and stores nothing', async () => {
    const before = (await api.items.list()).total;
    const res = await api.items.check({ problem, testCases: cases });
    expect(res).toEqual({ check: { attempted: true, engine: 'judge0', passed: 4, total: 4, error: null, runners: [], largeCase: null }, cases: [passed, passed, passed, passed] });
    expect((await api.items.list()).total).toBe(before);
  });

  it('tells a wrong case from one the solution failed on, and names the first', async () => {
    const marked = cases.map((c, i) => (i === 1 ? { ...c, expectedStdout: '2 MOCK:WA\n' } : i === 2 ? { ...c, stdin: '3 MOCK:RE\n' } : c));
    const res = await api.items.check({ problem, testCases: marked });
    expect(res.cases.map((c) => c.outcome)).toEqual(['passed', 'wrong', 'failed', 'passed']);
    expect(res.cases[1]!.error).toBeNull();
    expect(res.cases[2]!.error).toMatch(/crashed/);
    expect(res.check).toMatchObject({ attempted: true, passed: 2, total: 4 });
    expect(res.check.error).toMatch(/^Two: expected 2 MOCK:WA, but the reference solution printed /);
  });

  it('reports what stopped the check, and the cases it did not get to', async () => {
    const slow = await api.items.check({ problem: { ...problem, referenceSolution: { language: 'python', source: 'print(1)  # MOCK:TIMEOUT' } }, testCases: cases });
    expect(slow.cases.map((c) => c.outcome)).toEqual(['passed', 'passed', 'not_run', 'not_run']);
    expect(slow.check).toMatchObject({ passed: 2, error: 'the check ran out of time after 2 of 4 test cases' });
    const broken = await api.items.check({ problem: { ...problem, referenceSolution: { language: 'python', source: 'print( # MOCK:CE' } }, testCases: cases });
    expect(broken.check).toMatchObject({ attempted: true, passed: 0, error: 'the reference solution did not compile' });
    expect(broken.cases.every((c) => c.outcome === 'failed')).toBe(true);
    const none = await api.items.check({ problem: { ...problem, referenceSolution: null }, testCases: cases });
    expect(none.check).toMatchObject({ attempted: false, error: null });
    expect(none.cases.every((c) => c.outcome === 'not_run')).toBe(true);
    start({ judge: 'none' });
    expect((await api.items.check({ problem, testCases: cases })).check).toMatchObject({ attempted: false, engine: null });
    start({ judge: 'down' });
    const down = await api.items.check({ problem, testCases: cases });
    expect(down.check.error).toMatch(/unreachable/);
    expect(down.cases.every((c) => c.outcome === 'not_run')).toBe(true);
  });

  it('validates the problem and the test cases as for a new item, and ignores the rest', async () => {
    expect((await failure(api.items.check({ testCases: cases } as never))).fields).toEqual({ problem: 'is required' });
    expect((await failure(api.items.check({ type: 'reading', problem, testCases: cases } as never))).fields).toEqual({ type: 'must be problem' });
    expect((await failure(api.items.check({ problem: { ...problem, timeLimitMs: 5 }, testCases: cases }))).fields).toHaveProperty(['problem.timeLimitMs']);
    expect((await failure(api.items.check({ problem, testCases: [{ stdin: '1' } as never] }))).fields).toEqual({ 'testCases.0.expectedStdout': 'is required' });
    expect((await failure(api.items.check({ problem: { ...problem, harness: { python: { prefix: 'a', suffix: 'b' } } }, testCases: cases }))).fields).toHaveProperty(['problem.harness']);
    const whole = { type: 'problem', title: 'Anything', tags: ['x'], problem, testCases: cases };
    expect((await api.items.check(whole as never)).check.passed).toBe(4);
  });
});

describe('large test case', () => {
  const large = (text: string) => text.length > 100_000;

  it('is built only when asked for, appended to a draft and counted in its check', async () => {
    const plain = await api.ai.draft({ text: 'two sum', interfaceHint: 'program' });
    expect(plain.check!.largeCase).toBeNull();
    expect(plain.draft.testCases.some((c) => large(c.stdin))).toBe(false);

    const res = await api.ai.draft({ text: 'two sum', interfaceHint: 'program', largeTestCase: true });
    const cases = res.draft.testCases;
    const report = res.check!.largeCase!;
    expect(report).toMatchObject({ status: 'added', error: null, index: cases.length - 1 });
    expect(report.generator).toMatchObject({ language: 'python' });
    expect(report.generator!.source).toContain('random.seed(');
    const added = cases[cases.length - 1]!;
    expect(added).toMatchObject({ name: report.name, isSample: false, verified: true });
    // A few hundred kilobytes, within the bound, as the report says.
    expect(report.inputBytes).toBe(new TextEncoder().encode(added.stdin).length);
    expect(report.inputBytes).toBeGreaterThan(200_000);
    expect(report.inputBytes).toBeLessThanOrEqual(LIMITS.maxLargeInputBytes);
    expect(report.timeMs).toBeGreaterThan(0);
    expect(report.timeMs).toBeLessThan(res.draft.problem!.timeLimitMs);
    expect(res.check).toMatchObject({ passed: cases.length, total: cases.length });
    // The model did not write it, so it does not count towards the tokens.
    expect(res.usage.outputTokens).toBeLessThan(plain.usage.outputTokens! * 2);
    // The same input every time.
    const again = await api.ai.draft({ text: 'two sum', interfaceHint: 'program', largeTestCase: true });
    expect(again.draft.testCases.at(-1)!.stdin).toBe(added.stdin);
  });

  it('takes the problem\'s input convention, and is ignored for a reading', async () => {
    const fn = await api.ai.draft({ text: 'two sum', interfaceHint: 'function', largeTestCase: true });
    expect(fn.draft.testCases.at(-1)!.stdin).toMatch(/^\[-?\d+,/);
    const reading = await api.ai.draft({ text: 'notes on consistent hashing', typeHint: 'reading', largeTestCase: true });
    expect(reading.check).toBeNull();
    expect(reading.draft.testCases).toEqual([]);
  });

  it('reports a failed or skipped large case, and adds nothing', async () => {
    const failed = await api.ai.draft({ text: 'two sum MOCK:LARGE-FAIL', interfaceHint: 'program', largeTestCase: true });
    expect(failed.check!.largeCase).toMatchObject({ status: 'failed', index: null, inputBytes: null, timeMs: null });
    expect(failed.check!.largeCase!.error).toMatch(/generator crashed/);
    expect(failed.check!.passed).toBe(failed.check!.total);
    expect(failed.draft.testCases.some((c) => large(c.stdin))).toBe(false);

    const skipped = await api.ai.draft({ text: 'two sum MOCK:LARGE-SKIP', interfaceHint: 'program', largeTestCase: true });
    expect(skipped.check!.largeCase).toMatchObject({ status: 'skipped', index: null });
    expect(skipped.check!.largeCase!.error).toMatch(/ran out of time/);

    start({ judge: 'none' });
    const noJudge = await api.ai.draft({ text: 'two sum', interfaceHint: 'program', largeTestCase: true });
    expect(noJudge.check!.largeCase).toMatchObject({ status: 'skipped', error: 'there is no judge engine' });
    start({ judge: 'down' });
    expect((await api.ai.draft({ text: 'two sum', largeTestCase: true })).check!.largeCase).toMatchObject({ status: 'skipped', error: 'the judge engine could not be reached' });
  });

  it('is asked for on a variant and its revision too', async () => {
    const res = await api.ai.variant(seedIds.items.twoSum, { mode: 'harder', largeTestCase: true });
    expect(res.check!.largeCase!.status).toBe('added');
    expect(large(res.draft.testCases.at(-1)!.stdin)).toBe(true);
    const revised = await api.ai.variant(seedIds.items.twoSum, { mode: 'harder', instruction: 'shorter', previousDraft: res.draft, largeTestCase: false });
    expect(revised.check!.largeCase).toBeNull();
  });

  it('is proposed after the counted cases, without a prediction', async () => {
    const res = await api.ai.testCases(seedIds.items.twoSum, { count: 4, largeTestCase: true });
    expect(res.cases).toHaveLength(5);
    expect(res.largeCase).toMatchObject({ status: 'added', index: 4 });
    expect(res.cases[4]).toMatchObject({ name: res.largeCase!.name, isSample: false, verified: true, predictedStdout: null, predictionMatched: null, error: null });
    expect(large(res.cases[4]!.stdin)).toBe(true);
    expect((await api.ai.testCases(seedIds.items.twoSum, { count: 4 })).largeCase).toBeNull();

    const failed = await api.ai.testCases(seedIds.items.twoSum, { count: 2, largeTestCase: true, instruction: 'MOCK:LARGE-FAIL' });
    expect(failed.largeCase!.status).toBe('failed');
    expect(failed.cases).toHaveLength(2);
    start({ judge: 'none' });
    expect((await api.ai.testCases(seedIds.items.twoSum, { count: 2, largeTestCase: true })).largeCase!.status).toBe('skipped');
  });

  it('is saved like any case, never sent to the model, and cut to 64 KiB in results', async () => {
    const res = await api.ai.testCases(seedIds.items.twoSum, { count: 1, largeTestCase: true });
    const big = res.cases[1]!;
    await api.testCases.bulk(seedIds.items.twoSum, { cases: [{ name: big.name, stdin: big.stdin, expectedStdout: big.expectedStdout, origin: 'ai', verified: true }] });
    // The next generation lists the stored case by its name and size only.
    const next = await api.ai.testCases(seedIds.items.twoSum, { count: 1 });
    const entry = await api.settings.logEntry(next.usage.logId!);
    const prompt = JSON.stringify(entry.request);
    expect(prompt).toContain(big.name);
    expect(prompt).not.toContain(big.stdin.slice(0, 2000));
    expect(prompt.length).toBeLessThan(50_000);

    const { id } = await api.submissions.create(seedIds.items.twoSum, { language: 'python', source: 'print(1)', mode: 'submit', stdin: null });
    const { final } = await judged(id);
    const result = final.results.find((r) => r.name === big.name)!;
    expect(new TextEncoder().encode(result.stdin).length).toBe(64 * 1024);
    expect(big.stdin.startsWith(result.stdin)).toBe(true);
  });

  it('rejects a flag that is not a boolean', async () => {
    expect((await failure(api.ai.draft({ text: 'two sum', largeTestCase: 'yes' as never }))).fields).toEqual({ largeTestCase: 'must be a boolean' });
    expect((await failure(api.ai.variant(seedIds.items.twoSum, { largeTestCase: 1 as never }))).fields).toEqual({ largeTestCase: 'must be a boolean' });
    // Null counts as absent.
    expect((await api.ai.testCases(seedIds.items.twoSum, { count: 1, largeTestCase: null as never })).largeCase).toBeNull();
  });
});

describe('AI activity log', () => {
  /** Every entry, newest first, through the cursors. */
  const all = async (filters: Parameters<typeof api.settings.log>[0] = {}) => {
    const items = [];
    let before: string | undefined;
    for (;;) {
      const page = await api.settings.log({ ...filters, limit: 100, before });
      items.push(...page.items);
      if (page.next === null) return { items, total: page.total };
      before = page.next;
    }
  };

  it('lists the requests newest first, a batch at a time', async () => {
    const first = await api.settings.log();
    expect(first.items).toHaveLength(50);
    expect(first.total).toBe(246);
    expect(first.next).not.toBeNull();
    expect(first.items[0]).toMatchObject({ operation: 'draft', title: 'Merge k Sorted Lists', providerName: 'Personal key', model: 'claude-opus-5-5', status: 'ok', durationMs: 48200 });
    expect(first.items[0]).not.toHaveProperty('request');
    expect(first.items[0]).not.toHaveProperty('response');

    const { items, total } = await all();
    expect(items).toHaveLength(total);
    expect(new Set(items.map((e) => e.id)).size).toBe(total);
    const times = items.map((e) => Date.parse(e.createdAt));
    expect(times).toEqual([...times].sort((a, b) => b - a));
    expect((await api.settings.log({ limit: 200 })).items).toHaveLength(200);
    expect((await failure(api.settings.log({ limit: 201 }))).status).toBe(400);
    expect((await failure(api.settings.log({ before: 'yesterday' }))).status).toBe(400);
  });

  it('keeps a cursor valid while new requests arrive', async () => {
    const first = await api.settings.log({ limit: 10 });
    await api.ai.draft({ text: 'two sum', styleId: null });
    const second = await api.settings.log({ limit: 10, before: first.next! });
    // Nothing repeats and nothing is skipped: the new entry belongs before the first batch.
    const again = await api.settings.log({ limit: 21 });
    expect(again.items.map((e) => e.id)).toEqual([again.items[0]!.id, ...first.items.map((e) => e.id), ...second.items.map((e) => e.id)]);
    expect(again.total).toBe(first.total + 1);
  });

  it('filters by provider, kind of request and outcome on the server', async () => {
    const [personal, ollama] = (await api.settings.getAi()).providers;
    const local = await all({ providerId: ollama!.id });
    expect(local.total).toBe(9);
    expect(local.items.every((e) => e.providerName === 'Local Ollama' && e.kind === 'openai_compatible')).toBe(true);
    const failed = await all({ status: 'failed' });
    expect(failed.total).toBeGreaterThan(5);
    expect(failed.items.every((e) => e.status === 'failed' && e.error !== null && e.usage.inputTokens === null)).toBe(true);
    const tests = await all({ operation: 'test', providerId: personal!.id, status: 'ok' });
    expect(tests.total).toBeGreaterThan(0);
    expect(tests.items.every((e) => e.operation === 'test' && e.title === null && e.itemId === null)).toBe(true);
    expect((await api.settings.log({ status: 'cancelled' })).total).toBeGreaterThan(0);
    expect((await api.settings.log({ providerId: 'nobody' })).total).toBe(0);
    expect((await failure(api.settings.log({ operation: 'poem' as never }))).status).toBe(400);
  });

  it('gives what was sent and what came back for one entry', async () => {
    const { items } = await api.settings.log({ limit: 10 });
    const draft = await api.settings.logEntry(items[0]!.id);
    expect(draft).toMatchObject({ ...items[0]!, truncated: false });
    expect(draft.request).toMatchObject({ schema: 'item_draft', maxOutputTokens: 64000, messages: [{ role: 'user' }] });
    expect(JSON.parse(draft.response!)).toMatchObject({ title: 'Merge k Sorted Lists' });
    // Reasoning and cache figures where the provider reported them.
    expect(items[1]!.usage).toEqual({ inputTokens: 3900, outputTokens: 1650, reasoningTokens: 420, cacheReadTokens: 3100, cacheWriteTokens: 0 });
    // A failed and a cancelled request brought nothing back; one was cut off.
    const details = await Promise.all(items.slice(0, 6).map((e) => api.settings.logEntry(e.id)));
    expect(details.map((d) => d.status)).toEqual(['ok', 'ok', 'failed', 'cancelled', 'ok', 'ok']);
    expect(details[2]!.response).toBeNull();
    expect(details[3]).toMatchObject({ response: null, error: null });
    expect(details[4]!.truncated).toBe(true);
    expect(JSON.stringify(details)).not.toMatch(/sk-ant|x-api-key|authorization/i);
    expect((await failure(api.settings.logEntry('nope'))).status).toBe(404);
  });

  it('writes an entry for every request to a provider, with the id the generation reports', async () => {
    const before = (await api.settings.log()).total;
    const { usage, draft } = await api.ai.draft({ text: 'two sum, array + target', styleId: null });
    expect(usage).toMatchObject({ reasoningTokens: null, cacheReadTokens: 0, cacheWriteTokens: 0 });
    const entry = await api.settings.logEntry(usage.logId!);
    expect(entry).toMatchObject({ operation: 'draft', itemId: null, title: 'Two Sum', status: 'ok', model: usage.model, durationMs: usage.durationMs });
    expect(entry.usage).toMatchObject({ inputTokens: usage.inputTokens, outputTokens: usage.outputTokens });
    expect((entry.request as { messages: { content: string }[] }).messages[0]!.content).toContain('two sum, array + target');
    expect(JSON.parse(entry.response!)).toMatchObject({ title: draft.title });

    const twoSum = seedIds.items.twoSum;
    const tests = await api.ai.testCases(twoSum, { count: 2 });
    expect(await api.settings.logEntry(tests.usage.logId!)).toMatchObject({ operation: 'testcases', itemId: twoSum, title: 'Two Sum' });
    const variant = await api.ai.variant(twoSum, { styleId: null });
    expect(await api.settings.logEntry(variant.usage.logId!)).toMatchObject({ operation: 'variant', itemId: twoSum, title: 'Two Sum' });
    await failure(api.ai.variant(twoSum, { instruction: 'MOCK:FAIL' }));
    const personal = (await api.settings.getAi()).providers[0]!;
    await api.settings.testAi({ providerId: personal.id });
    // Settings that are not saved belong to no provider, and are not logged.
    await api.settings.testAi({ kind: 'anthropic', apiKey: 'sk-ant-typed' });

    const log = await api.settings.log({ limit: 5 });
    expect(log.total).toBe(before + 5);
    expect(log.items.map((e) => [e.operation, e.status])).toEqual([['test', 'ok'], ['variant', 'failed'], ['variant', 'ok'], ['testcases', 'ok'], ['draft', 'ok']]);
    expect(log.items[1]).toMatchObject({ error: expect.stringMatching(/overloaded/), usage: { inputTokens: null, outputTokens: null } });

    // An entry outlives its item and its provider; a service that reports reasoning has it counted.
    const ollama = (await api.settings.getAi()).providers[1]!;
    await api.settings.putAi({ defaultProviderId: ollama.id });
    const viaOllama = await api.ai.draft({ text: 'two sum', styleId: null });
    expect(viaOllama.usage).toMatchObject({ model: 'qwen2.5-coder:14b', cacheReadTokens: null, cacheWriteTokens: null });
    expect(viaOllama.usage.reasoningTokens).toBeGreaterThan(0);
    await api.settings.removeProvider(ollama.id);
    await api.items.remove(twoSum);
    expect((await api.settings.log({ providerId: ollama.id })).total).toBe(10);
    expect((await api.settings.logEntry(tests.usage.logId!)).title).toBe('Two Sum');
  });

  it('clears the older part or everything, and leaves the providers\' totals alone', async () => {
    const usage = (await api.settings.getAi()).providers.map((p) => p.usage);
    const before = (await api.settings.log()).total;
    const recent = (await all()).items.filter((e) => Date.parse(e.createdAt) >= Date.now() - 30 * 86400_000);
    expect(recent.length).toBeGreaterThan(5);
    expect(recent.length).toBeLessThan(before);

    await api.settings.clearLog(new Date(Date.now() - 30 * 86400_000).toISOString());
    const kept = await all();
    expect(kept.items.map((e) => e.id)).toEqual(recent.map((e) => e.id));
    expect((await failure(api.settings.clearLog('long ago'))).status).toBe(400);

    await api.settings.clearLog();
    expect(await api.settings.log()).toEqual({ items: [], next: null, total: 0 });
    expect((await failure(api.settings.logEntry(recent[0]!.id))).status).toBe(404);
    expect((await api.settings.getAi()).providers.map((p) => p.usage)).toEqual(usage);
  });

  it('is empty without a seeded library or a provider', async () => {
    start({ library: 'empty' });
    expect((await api.settings.log()).total).toBe(0);
    start({ ai: false });
    expect((await api.settings.log()).total).toBe(0);
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
  /** The saved provider the default scenario starts with. */
  const seeded = async () => (await api.settings.getAi()).providers[0]!;
  const local = { name: 'Ollama', kind: 'openai_compatible', model: 'llama3.1:8b', baseUrl: 'http://localhost:11434/v1' } as const;

  it('never returns a key, only a hint', async () => {
    const settings = await api.settings.getAi();
    expect(settings.providers.map((p) => p.name)).toEqual(['Personal key', 'Local Ollama', 'Work gateway']);
    const provider = settings.providers[0]!;
    expect(settings.defaultProviderId).toBe(provider.id);
    expect(provider).toEqual({
      id: provider.id,
      name: 'Personal key',
      kind: 'anthropic',
      model: 'claude-opus-5-5',
      baseUrl: null,
      apiKeySet: true,
      apiKeyHint: '…x7Qa',
      source: 'settings',
      isDefault: true,
      ready: true,
      usage: {
        last30Days: { requests: 14, failed: 1, inputTokens: 61200, outputTokens: 48100 },
        allTime: { requests: 52, failed: 3, inputTokens: 233000, outputTokens: 171500 },
        lastUsedAt: provider.usage.lastUsedAt,
      },
      createdAt: provider.createdAt,
      updatedAt: provider.updatedAt,
    });
    expect(provider.createdAt).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
    expect(settings.kinds).toEqual({
      anthropic: { defaultModel: 'claude-opus-5-5', defaultBaseUrl: 'https://api.anthropic.com', keyRequired: true },
      gemini: { defaultModel: null, defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta', keyRequired: true },
      openai_compatible: { defaultModel: null, defaultBaseUrl: 'https://api.openai.com/v1', keyRequired: false },
    });
    expect(JSON.stringify(settings)).not.toContain('sk-ant');
  });

  it('keeps what was spent through each provider, starting from nothing', async () => {
    const [personal, ollama, gateway] = (await api.settings.getAi()).providers;
    expect(personal!.usage.lastUsedAt).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
    // Used, but not in the last 30 days.
    expect(ollama!.usage).toMatchObject({ last30Days: { requests: 0 }, allTime: { requests: 9, failed: 2 } });
    const unused = { requests: 0, failed: 0, inputTokens: 0, outputTokens: 0 };
    expect(gateway!.usage).toEqual({ last30Days: unused, allTime: unused, lastUsedAt: null });
    const made = await api.settings.createProvider(local);
    expect(made.usage).toEqual({ last30Days: unused, allTime: unused, lastUsedAt: null });

    // The generation step of a saved provider's connection test is a request; a failed one is counted as such.
    expect((await api.settings.testAi({ providerId: made.id })).ok).toBe(true);
    expect((await api.settings.testAi({ providerId: made.id, model: 'no-such-model' })).ok).toBe(false);
    const tested = (await api.settings.getAi()).providers.find((p) => p.id === made.id)!;
    expect(tested.usage.allTime).toEqual({ requests: 2, failed: 1, inputTokens: 14, outputTokens: 5 });
    expect(tested.usage.last30Days).toEqual(tested.usage.allTime);
    expect(tested.usage.lastUsedAt).not.toBeNull();
    // The counts stay with the entry when its settings change.
    expect((await api.settings.updateProvider(made.id, { model: 'gemma3:12b' })).usage.allTime.requests).toBe(2);

    // A test of settings that are not saved is nobody's request, and neither is one that never reaches the service.
    await api.settings.testAi({ kind: 'anthropic', apiKey: 'sk-ant-typed' });
    await api.settings.updateProvider(personal!.id, { apiKey: null });
    expect((await api.settings.testAi({ providerId: personal!.id })).ok).toBe(false);
    expect((await api.settings.getAi()).providers.find((p) => p.id === personal!.id)!.usage.allTime.requests).toBe(52);
  });

  it('starts with no providers when AI is not configured', async () => {
    start({ ai: false });
    expect(await api.settings.getAi()).toMatchObject({ defaultProviderId: null, providers: [] });
  });

  it('lists the default first, then saved providers by name, then environment providers', async () => {
    start(optionsFromFlags(['ai-env', 'instant']));
    const zed = await api.settings.createProvider({ name: 'zed', kind: 'anthropic', apiKey: 'sk-ant-zed-0001' });
    await api.settings.createProvider({ name: 'Alpha', kind: 'anthropic' });
    await api.settings.createProvider({ name: 'beta', kind: 'openai_compatible' });
    expect((await api.settings.getAi()).providers.map((p) => p.name)).toEqual(['Anthropic (environment)', 'Alpha', 'beta', 'zed']);
    const next = await api.settings.putAi({ defaultProviderId: zed.id });
    expect(next.providers.map((p) => p.name)).toEqual(['zed', 'Alpha', 'beta', 'Anthropic (environment)']);
    expect(next.providers.map((p) => p.isDefault)).toEqual([true, false, false, false]);
  });

  it('supplies a read-only provider from the environment', async () => {
    start(optionsFromFlags(['ai-env', 'instant']));
    const settings = await api.settings.getAi();
    expect(settings.defaultProviderId).toBe('env-anthropic');
    expect(settings.providers).toHaveLength(1);
    const env = settings.providers[0]!;
    expect(env).toMatchObject({ id: 'env-anthropic', kind: 'anthropic', source: 'environment', isDefault: true, ready: true, apiKeySet: true, createdAt: null, updatedAt: null });
    expect(env.baseUrl).toMatch(/^https:/);
    expect(await api.meta()).toMatchObject({ ai: { enabled: true, providerId: 'env-anthropic', kind: 'anthropic', model: 'claude-opus-5-5' } });
    // The other kinds have fixed ids of their own.
    expect([envProviderId('gemini'), envProviderId('openai_compatible')]).toEqual(['env-gemini', 'env-openai-compatible']);

    // It can be tested and chosen, but not changed or deleted.
    expect((await api.settings.testAi({ providerId: 'env-anthropic' })).ok).toBe(true);
    expect(await failure(api.settings.updateProvider('env-anthropic', { name: 'Mine' }))).toMatchObject({ status: 409, code: 'conflict' });
    expect(await failure(api.settings.removeProvider('env-anthropic'))).toMatchObject({ status: 409, code: 'conflict' });
    await api.settings.putAi({ defaultProviderId: null });
    expect((await api.settings.putAi({ defaultProviderId: 'env-anthropic' })).defaultProviderId).toBe('env-anthropic');

    // Its name is not reserved: only saved providers have to differ from each other.
    expect((await api.settings.createProvider({ name: env.name, kind: 'anthropic' })).source).toBe('settings');

    // Without CODEATROPHY_AI_PROVIDER it is there but not in use.
    start(optionsFromFlags(['ai-env', 'no-ai', 'instant']));
    expect(await api.settings.getAi()).toMatchObject({ defaultProviderId: null, providers: [{ id: 'env-anthropic', isDefault: false, ready: true }] });
    expect((await api.meta()).ai.enabled).toBe(false);
  });

  it('creates a provider without making it the default', async () => {
    const before = await seeded();
    const made = await api.settings.createProvider({ ...local, name: '  Ollama  ' });
    expect(made).toMatchObject({ name: 'Ollama', kind: 'openai_compatible', model: 'llama3.1:8b', baseUrl: local.baseUrl, apiKeySet: false, source: 'settings', isDefault: false, ready: true });
    expect((await api.settings.getAi()).defaultProviderId).toBe(before.id);

    // Nothing but a name and a kind is needed, so a key can be stored before a model is chosen.
    const bare = await api.settings.createProvider({ name: 'Work', kind: 'openai_compatible', apiKey: 'sk-work-0000ABCD' });
    expect(bare).toMatchObject({ model: null, baseUrl: null, apiKeySet: true, apiKeyHint: '…ABCD', ready: false });
    expect(JSON.stringify(bare)).not.toContain('sk-work');
  });

  it('validates a provider with per-field messages', async () => {
    const before = await seeded();
    expect((await failure(api.settings.createProvider({ kind: 'anthropic' } as never))).fields).toEqual({ name: 'is required' });
    expect((await failure(api.settings.createProvider({ name: '   ', kind: 'anthropic' }))).fields).toEqual({ name: 'is required' });
    expect((await failure(api.settings.createProvider({ name: 'x' } as never))).fields).toEqual({ kind: 'is required' });
    expect((await failure(api.settings.createProvider({ name: 'x', kind: 'mistral' as never }))).fields).toHaveProperty('kind');
    expect((await failure(api.settings.createProvider({ name: 'n'.repeat(LIMITS.maxAiProviderNameChars + 1), kind: 'anthropic' }))).fields).toHaveProperty('name');
    expect((await api.settings.createProvider({ name: 'é'.repeat(LIMITS.maxAiProviderNameChars), kind: 'anthropic' })).name).toHaveLength(LIMITS.maxAiProviderNameChars);
    expect((await failure(api.settings.createProvider({ name: 'two\tparts', kind: 'anthropic' }))).fields.name).toMatch(/single line/);
    expect((await failure(api.settings.createProvider({ name: 'PERSONAL KEY', kind: 'anthropic' }))).fields).toEqual({ name: 'is already used by another provider' });

    const many = await failure(
      api.settings.createProvider({ name: 'x', kind: 'anthropic', model: 'm'.repeat(LIMITS.maxModelIdChars + 1), baseUrl: 'localhost:11434', apiKey: 'k'.repeat(LIMITS.maxApiKeyChars + 1) }),
    );
    expect(many.status).toBe(422);
    expect(Object.keys(many.fields).sort()).toEqual(['apiKey', 'baseUrl', 'model']);

    expect((await failure(api.settings.updateProvider(before.id, { name: '' }))).fields).toEqual({ name: 'is required' });
    expect((await failure(api.settings.updateProvider(before.id, { model: 'a\nb' }))).fields.model).toMatch(/single line/);
    expect((await failure(api.settings.updateProvider(before.id, { kind: 'openai_compatible' } as never))).fields).toEqual({ kind: 'cannot be changed after creation' });
    expect(await failure(api.settings.updateProvider('nope', { name: 'x' }))).toMatchObject({ status: 404, code: 'not_found' });
    expect(await failure(api.settings.removeProvider('nope'))).toMatchObject({ status: 404, code: 'not_found' });
    // Nothing of a rejected update is applied; keeping its own name is not a clash.
    expect(await seeded()).toEqual(before);
    expect((await api.settings.updateProvider(before.id, { name: 'personal KEY' })).name).toBe('personal KEY');
  });

  it('refuses a 21st saved provider with a conflict', async () => {
    start(optionsFromFlags(['ai-env', 'instant']));
    for (let i = 0; i < LIMITS.maxAiProviders; i++) await api.settings.createProvider({ name: `Provider ${i}`, kind: 'anthropic' });
    const err = await failure(api.settings.createProvider({ name: 'One too many', kind: 'anthropic' }));
    expect(err).toMatchObject({ status: 409, code: 'conflict' });
    // The environment's provider is not counted.
    expect((await api.settings.getAi()).providers).toHaveLength(LIMITS.maxAiProviders + 1);
  });

  it('merges an update, and replaces and deletes keys', async () => {
    const { id } = await seeded();
    const replaced = await api.settings.updateProvider(id, { apiKey: 'sk-ant-new-key-ABCD' });
    expect(replaced.apiKeyHint).toBe('…ABCD');

    const untouched = await api.settings.updateProvider(id, { name: 'Work key', model: 'claude-sonnet-5-5' });
    expect(untouched).toMatchObject({ name: 'Work key', model: 'claude-sonnet-5-5', apiKeyHint: '…ABCD', isDefault: true });
    expect((await api.meta()).ai).toEqual({ enabled: true, providerId: id, providerName: 'Work key', kind: 'anthropic', model: 'claude-sonnet-5-5' });

    // An empty key is treated like an omitted one.
    expect((await api.settings.updateProvider(id, { apiKey: '' })).apiKeyHint).toBe('…ABCD');
    expect((await failure(api.settings.updateProvider(id, { apiKey: 'k'.repeat(LIMITS.maxApiKeyChars + 1) }))).fields).toHaveProperty('apiKey');

    // Clearing the model falls back to the kind's default.
    expect((await api.settings.updateProvider(id, { model: null })).model).toBeNull();
    expect((await api.meta()).ai.model).toBe('claude-opus-5-5');
  });

  it('keeps a default that is no longer ready selected, with AI off', async () => {
    const { id } = await seeded();
    const keyless = await api.settings.updateProvider(id, { apiKey: null });
    expect(keyless).toMatchObject({ apiKeySet: false, apiKeyHint: null, ready: false, isDefault: true });
    expect((await api.settings.getAi()).defaultProviderId).toBe(id);
    expect((await api.meta()).ai).toEqual({ enabled: false, providerId: null, providerName: null, kind: null, model: null });
    expect((await failure(api.ai.draft({ text: 'two sum' }))).code).toBe('ai_unavailable');

    await api.settings.updateProvider(id, { apiKey: 'sk-ant-back-0000WXYZ' });
    expect((await api.meta()).ai.enabled).toBe(true);
  });

  it('chooses the default, and turns AI off without deleting anything', async () => {
    const first = await seeded();
    const notReady = await api.settings.createProvider({ name: 'OpenAI', kind: 'openai_compatible' });
    let err = await failure(api.settings.putAi({ defaultProviderId: notReady.id }));
    expect(err.status).toBe(422);
    expect(err.fields.defaultProviderId).toMatch(/a model and an API key/);
    expect((await failure(api.settings.putAi({ defaultProviderId: 'nope' }))).fields).toHaveProperty('defaultProviderId');
    // Leaving it out keeps it: the update is a merge.
    expect((await api.settings.putAi({})).defaultProviderId).toBe(first.id);
    expect((await api.settings.putAi({ timeoutSeconds: 60 })).defaultProviderId).toBe(first.id);
    expect((await api.settings.getAi()).defaultProviderId).toBe(first.id);

    const ollama = await api.settings.createProvider(local);
    const chosen = await api.settings.putAi({ defaultProviderId: ollama.id });
    expect(chosen.defaultProviderId).toBe(ollama.id);
    expect(chosen.providers.filter((p) => p.isDefault).map((p) => p.id)).toEqual([ollama.id]);
    expect((await api.meta()).ai).toEqual({ enabled: true, providerId: ollama.id, providerName: 'Ollama', kind: 'openai_compatible', model: 'llama3.1:8b' });

    const off = await api.settings.putAi({ defaultProviderId: null });
    expect(off.defaultProviderId).toBeNull();
    expect(off.providers).toHaveLength(5);
    expect(off.providers.every((p) => !p.isDefault)).toBe(true);
    expect((await api.meta()).ai.enabled).toBe(false);
    expect((await failure(api.ai.draft({ text: 'two sum' }))).code).toBe('ai_unavailable');

    err = await failure(api.settings.putAi({ defaultProviderId: notReady.id }));
    expect(err.status).toBe(422);
  });

  it('keeps a request timeout, with the environment\'s value until one is saved', async () => {
    const first = await seeded();
    expect(await api.settings.getAi()).toMatchObject({ timeoutSeconds: 300, defaultTimeoutSeconds: 300 });

    // A merge update: the timeout alone leaves the default provider where it was, and the other way round.
    expect(await api.settings.putAi({ timeoutSeconds: 120 })).toMatchObject({ timeoutSeconds: 120, defaultTimeoutSeconds: 300, defaultProviderId: first.id });
    const ollama = await api.settings.createProvider(local);
    expect(await api.settings.putAi({ defaultProviderId: ollama.id })).toMatchObject({ timeoutSeconds: 120, defaultProviderId: ollama.id });
    expect((await api.settings.getAi()).timeoutSeconds).toBe(120);

    // Both at once.
    expect(await api.settings.putAi({ defaultProviderId: first.id, timeoutSeconds: 10 })).toMatchObject({ timeoutSeconds: 10, defaultProviderId: first.id });

    // `null` removes the saved value.
    expect(await api.settings.putAi({ timeoutSeconds: null })).toMatchObject({ timeoutSeconds: 300, defaultTimeoutSeconds: 300 });
  });

  it('rejects a request timeout outside the limits or not a whole number, and changes nothing', async () => {
    const first = await seeded();
    await api.settings.putAi({ timeoutSeconds: 90 });
    const { minAiTimeoutSeconds: min, maxAiTimeoutSeconds: max } = (await api.meta()).limits;
    expect([min, max]).toEqual([10, 300]);
    expect(await api.settings.putAi({ timeoutSeconds: max })).toMatchObject({ timeoutSeconds: max });
    await api.settings.putAi({ timeoutSeconds: 90 });

    for (const bad of [min - 1, max + 1, 0, -30, 60.5, '60', true]) {
      const err = await failure(api.settings.putAi({ timeoutSeconds: bad as never }));
      expect(err.status).toBe(422);
      expect(Object.keys(err.fields)).toEqual(['timeoutSeconds']);
    }
    expect((await failure(api.settings.putAi({ timeoutSeconds: 301 }))).fields.timeoutSeconds).toBe('must be between 10 and 300');

    // One bad field rejects the whole update.
    const ollama = await api.settings.createProvider(local);
    const err = await failure(api.settings.putAi({ defaultProviderId: ollama.id, timeoutSeconds: 5 }));
    expect(Object.keys(err.fields)).toEqual(['timeoutSeconds']);
    expect(Object.keys((await failure(api.settings.putAi({ defaultProviderId: 'nope', timeoutSeconds: 60 }))).fields)).toEqual(['defaultProviderId']);
    expect(await api.settings.getAi()).toMatchObject({ timeoutSeconds: 90, defaultProviderId: first.id });
  });

  it('leaves no default when the default is deleted', async () => {
    const first = await seeded();
    const other = await api.settings.createProvider(local);
    await api.settings.removeProvider(other.id);
    expect((await api.settings.getAi()).defaultProviderId).toBe(first.id);

    await api.settings.removeProvider(first.id);
    const left = await api.settings.getAi();
    expect(left.defaultProviderId).toBeNull();
    expect(left.providers.map((p) => p.name)).toEqual(['Local Ollama', 'Work gateway']);
    expect((await api.meta()).ai.enabled).toBe(false);
  });

  it('drops a saved key when the base URL moves to another origin', async () => {
    const { id } = await seeded();
    // Same origin, different path: the key stays.
    let next = await api.settings.updateProvider(id, { baseUrl: 'https://api.anthropic.com/v1' });
    expect(next).toMatchObject({ apiKeySet: true, apiKeyHint: '…x7Qa' });

    // Another origin without a key in the same request: the key is gone.
    next = await api.settings.updateProvider(id, { baseUrl: 'https://gateway.example.org/anthropic' });
    expect(next).toMatchObject({ baseUrl: 'https://gateway.example.org/anthropic', apiKeySet: false, apiKeyHint: null, ready: false });

    // With the key for the new server in the same request, it is kept.
    await api.settings.updateProvider(id, { apiKey: 'sk-gw-key-WXYZ' });
    next = await api.settings.updateProvider(id, { baseUrl: 'https://other.example.org/anthropic', apiKey: 'sk-other-key-1234' });
    expect(next).toMatchObject({ apiKeyHint: '…1234', ready: true });

    // Clearing the base URL falls back to the default one, which is another origin again.
    next = await api.settings.updateProvider(id, { baseUrl: null });
    expect(next).toMatchObject({ baseUrl: null, apiKeySet: false });
  });

  it('needs a key for the default OpenAI endpoint, but not for another one', async () => {
    const made = await api.settings.createProvider({ name: 'OpenAI', kind: 'openai_compatible', model: 'gpt-4.1' });
    expect(made).toMatchObject({ baseUrl: null, apiKeySet: false, ready: false });
    const err = await failure(api.settings.putAi({ defaultProviderId: made.id }));
    expect(err.fields.defaultProviderId).toMatch(/API key/);
    expect(await api.settings.testAi({ providerId: made.id })).toMatchObject({ ok: false, models: null });

    expect((await api.settings.updateProvider(made.id, { apiKey: 'sk-openai-9876' })).ready).toBe(true);

    const moved = await api.settings.updateProvider(made.id, { baseUrl: 'http://localhost:1234/v1', model: 'llama3.1:8b' });
    expect(moved).toMatchObject({ apiKeySet: false, ready: true });
    expect((await api.settings.testAi({ providerId: made.id })).ok).toBe(true);
  });

  it('needs a key and a model for Google Gemini, on its own server or a gateway', async () => {
    const made = await api.settings.createProvider({ name: 'Gemini', kind: 'gemini' });
    expect(made).toMatchObject({ kind: 'gemini', model: null, baseUrl: null, apiKeySet: false, ready: false });
    expect((await failure(api.settings.putAi({ defaultProviderId: made.id }))).fields.defaultProviderId).toMatch(/a model and an API key$/);
    expect((await api.settings.updateProvider(made.id, { model: 'gemini-3.5-flash' })).ready).toBe(false);
    expect((await api.settings.updateProvider(made.id, { apiKey: 'AIza-mock-0000Gm1n' })).ready).toBe(true);
    // A gateway does not make the key optional.
    const proxied = await api.settings.updateProvider(made.id, { baseUrl: 'https://gateway.example.org/google' });
    expect(proxied).toMatchObject({ apiKeySet: false, ready: false });
    expect((await failure(api.settings.putAi({ defaultProviderId: made.id }))).fields.defaultProviderId).toMatch(/needs an API key$/);
  });

  it('lists only the text models of Google Gemini, by bare id, and generates through it', async () => {
    // Without a key nothing is asked of the service.
    expect(await api.settings.listModels({ kind: 'gemini' })).toEqual({ models: null, error: 'No API key is set for this provider.' });
    expect(await api.settings.testAi({ kind: 'gemini', model: 'gemini-3.5-flash' })).toMatchObject({ ok: false, models: null, error: expect.stringMatching(/key/i) });

    const { models } = await api.settings.listModels({ kind: 'gemini', apiKey: 'AIza-typed' });
    expect(models).toContain('gemini-3.5-flash');
    expect(models).toEqual([...new Set(models)].sort());
    expect(models!.every((m) => /^gem(ini|ma)-/.test(m))).toBe(true);
    expect(models!.some((m) => /embedding|tts|image|imagen|veo/.test(m))).toBe(false);
    expect((await api.settings.listModels({ kind: 'gemini', baseUrl: 'https://gateway.example.org/google', apiKey: 'AIza-typed' })).models).toEqual(models);

    // With no default model, a test without one only fetches the list.
    expect(await api.settings.testAi({ kind: 'gemini', apiKey: 'AIza-typed' })).toMatchObject({ ok: true, model: null, models });
    expect(await api.settings.testAi({ kind: 'gemini', apiKey: 'AIza-typed', model: 'gemini-3.5-flash' })).toMatchObject({ ok: true, model: 'gemini-3.5-flash' });
    expect((await api.settings.testAi({ kind: 'gemini', apiKey: 'AIza-typed', model: 'models/gemini-3.5-flash' })).error).toMatch(/does not know the model/);
    const bad = await api.settings.listModels({ kind: 'gemini', apiKey: 'AIza-bad-key' });
    expect(bad).toMatchObject({ models: null, error: expect.stringMatching(/rejected the API key/) });
    expect(bad.error).not.toContain('AIza-bad-key');

    // Made the default, it is the one in use, and what it spends is counted towards it.
    const gemini = await api.settings.createProvider({ name: 'Gemini', kind: 'gemini', model: 'gemini-3.5-flash', apiKey: 'AIza-mock-0000Gm1n' });
    expect(gemini).toMatchObject({ ready: true, apiKeyHint: '…Gm1n' });
    await api.settings.putAi({ defaultProviderId: gemini.id });
    expect((await api.meta()).ai).toEqual({ enabled: true, providerId: gemini.id, providerName: 'Gemini', kind: 'gemini', model: 'gemini-3.5-flash' });
    const { usage } = await api.ai.draft({ text: 'two sum' });
    expect(usage).toMatchObject({ model: 'gemini-3.5-flash', cacheReadTokens: 0, cacheWriteTokens: null });
    expect(usage.reasoningTokens).toBeGreaterThan(0);
    expect((await api.settings.getAi()).providers.find((p) => p.id === gemini.id)!.usage.allTime.requests).toBe(1);
  });

  it('tests a configuration without saving it, and lists the service\'s models', async () => {
    const { id } = await seeded();
    const works = await api.settings.testAi({ providerId: id });
    expect(works).toEqual({ ok: true, model: 'claude-opus-5-5', latencyMs: works.latencyMs, error: null, models: ['claude-haiku-5-5', 'claude-opus-5-5', 'claude-sonnet-5-5'], modelsError: null });
    expect(works.latencyMs).toBeGreaterThan(0);

    const bad = await api.settings.testAi({ providerId: id, apiKey: 'sk-ant-bad-key' });
    expect(bad).toMatchObject({ ok: false, latencyMs: null, models: null });
    expect(bad.error).not.toContain('sk-ant-bad-key');
    expect(bad.modelsError).not.toBeNull();

    const unreachable = await api.settings.testAi({ kind: 'openai_compatible', model: 'qwen', baseUrl: 'http://unreachable.lan:1234/v1' });
    expect(unreachable).toMatchObject({ ok: false, models: null });
    expect(unreachable.error).toContain('unreachable.lan');

    // An override applies to this test only; a model the service does not have fails it, with the list to pick from.
    const unknown = await api.settings.testAi({ providerId: id, model: 'claude-nonesuch' });
    expect(unknown).toMatchObject({ ok: false, model: 'claude-nonesuch', latencyMs: null });
    expect(unknown.error).toContain('claude-nonesuch');
    expect(unknown.models).toContain('claude-sonnet-5-5');
    expect(await seeded()).toMatchObject({ model: 'claude-opus-5-5', apiKeyHint: '…x7Qa', baseUrl: null });
  });

  it('tests a configuration that has not been saved, by kind', async () => {
    // Without a model, fetching the list is the whole test.
    const listed = await api.settings.testAi({ kind: 'openai_compatible', apiKey: 'sk-openai-typed' });
    expect(listed).toMatchObject({ ok: true, model: null, latencyMs: null, error: null, modelsError: null });
    expect(listed.models).toContain('gpt-4.1');
    expect(listed.models).toEqual([...new Set(listed.models)].sort());

    // A local endpoint needs no key at all, and offers other models.
    const ollama = await api.settings.testAi({ kind: 'openai_compatible', baseUrl: 'http://localhost:11434/v1' });
    expect(ollama.ok).toBe(true);
    expect(ollama.models).toContain('llama3.1:8b');
    expect(ollama.models).not.toContain('gpt-4.1');
    expect(await api.settings.testAi({ kind: 'openai_compatible', baseUrl: 'http://localhost:11434/v1', model: 'llama3.1:8b' })).toMatchObject({ ok: true, model: 'llama3.1:8b' });

    // A required key that is missing rules out any request.
    expect(await api.settings.testAi({ kind: 'anthropic' })).toMatchObject({ ok: false, model: null, models: null });
    expect((await api.settings.testAi({ kind: 'openai_compatible', model: 'gpt-4.1' })).error).toMatch(/key/i);
    expect((await api.settings.testAi({ kind: 'anthropic', apiKey: 'sk-ant-typed' })).ok).toBe(true);
    expect((await api.settings.getAi()).providers).toHaveLength(3);
  });

  it('does not fail a configured model because the service lists none', async () => {
    const baseUrl = 'http://no-models.lan:8000/v1';
    const typed = await api.settings.testAi({ kind: 'openai_compatible', baseUrl, model: 'my-finetune' });
    expect(typed).toMatchObject({ ok: true, model: 'my-finetune', models: null });
    expect(typed.modelsError).toContain('no-models.lan:8000');

    // Without a model there is nothing left that could succeed.
    const nothing = await api.settings.testAi({ kind: 'openai_compatible', baseUrl });
    expect(nothing).toMatchObject({ ok: false, model: null, models: null });
    expect(nothing.error).not.toBeNull();
    expect(nothing.modelsError).not.toBeNull();
  });

  it('lists the models without a generation request, steered as a test is', async () => {
    const { id } = await seeded();
    const before = { log: (await api.settings.log({ limit: 1 })).total, usage: (await seeded()).usage };

    expect(await api.settings.listModels({ providerId: id })).toEqual({ models: ['claude-haiku-5-5', 'claude-opus-5-5', 'claude-sonnet-5-5'], error: null });
    // A model in the body is ignored, even one the service does not have.
    expect((await api.settings.listModels({ providerId: id, model: 'claude-nonesuch' } as never)).error).toBeNull();
    expect((await api.settings.listModels({ kind: 'openai_compatible', baseUrl: 'http://localhost:11434/v1' })).models).toContain('llama3.1:8b');

    const bad = await api.settings.listModels({ providerId: id, apiKey: 'sk-ant-bad-key' });
    expect(bad).toMatchObject({ models: null, error: expect.stringMatching(/rejected the API key/) });
    expect(bad.error).not.toContain('sk-ant-bad-key');
    expect((await api.settings.listModels({ kind: 'openai_compatible', baseUrl: 'http://unreachable.lan:1234/v1' })).error).toContain('unreachable.lan');
    expect((await api.settings.listModels({ kind: 'openai_compatible', baseUrl: 'http://no-models.lan:8000/v1' })).error).toContain('does not list its models');
    // A missing required key is reported in the body, as is the saved key kept from another origin.
    expect(await api.settings.listModels({ kind: 'anthropic' })).toEqual({ models: null, error: 'No API key is set for this provider.' });
    expect((await api.settings.listModels({ providerId: id, baseUrl: 'https://gateway.example.org/anthropic' })).error).toMatch(/saved key/);

    expect((await failure(api.settings.listModels({}))).status).toBe(422);
    expect((await failure(api.settings.listModels({ providerId: id, kind: 'anthropic' }))).status).toBe(422);
    expect((await failure(api.settings.listModels({ providerId: id, baseUrl: 'localhost:11434' }))).fields).toEqual({ baseUrl: 'must be an http(s) URL' });

    // Nothing was logged, counted or saved.
    expect((await api.settings.log({ limit: 1 })).total).toBe(before.log);
    expect(await seeded()).toMatchObject({ usage: before.usage, baseUrl: null, apiKeyHint: '…x7Qa' });
  });

  it('requires exactly one of providerId and kind for a test', async () => {
    const { id } = await seeded();
    expect((await failure(api.settings.testAi({}))).status).toBe(422);
    expect((await failure(api.settings.testAi({ providerId: id, kind: 'anthropic' }))).status).toBe(422);
    expect((await failure(api.settings.testAi({ providerId: 'nope' }))).fields).toHaveProperty('providerId');
    expect((await failure(api.settings.testAi({ kind: 'mistral' as never }))).fields).toHaveProperty('kind');
    expect((await failure(api.settings.testAi({ providerId: id, baseUrl: 'localhost:11434' }))).fields).toEqual({ baseUrl: 'must be an http(s) URL' });
  });

  it('tests another base URL only with a key typed into the same request', async () => {
    const { id } = await seeded();
    // The saved key is not sent to a server it was not saved for.
    const elsewhere = await api.settings.testAi({ providerId: id, baseUrl: 'https://gateway.example.org/anthropic' });
    expect(elsewhere).toMatchObject({ ok: false, models: null });
    expect(elsewhere.error).toMatch(/key/i);
    expect(elsewhere.error).not.toContain('x7Qa');
    expect((await api.settings.testAi({ providerId: id, baseUrl: 'https://gateway.example.org/anthropic', apiKey: 'sk-gw-typed' })).ok).toBe(true);
    // The same origin under another path still uses the saved key.
    expect((await api.settings.testAi({ providerId: id, baseUrl: 'https://api.anthropic.com/v2' })).ok).toBe(true);
    // Nothing was saved by any of this.
    expect(await seeded()).toMatchObject({ baseUrl: null, apiKeyHint: '…x7Qa' });
  });
});

describe('preferences', () => {
  it('returns every key with the documented defaults', async () => {
    const prefs = await api.preferences.get();
    expect(prefs).toEqual({
      hideTestCases: true,
      generatedTestCases: 8,
      largeTestCase: false,
      editor: { autocomplete: true, closeBrackets: true, matchBrackets: true, lineWrapping: false, tabSize: 4, fontSize: 14 },
    });
    expect(prefs).toEqual(DEFAULT_PREFERENCES);
  });

  it('merges an update at any depth and returns the whole document', async () => {
    let prefs = await api.preferences.put({ hideTestCases: false });
    expect(prefs).toEqual({ ...DEFAULT_PREFERENCES, hideTestCases: false });
    prefs = await api.preferences.put({ editor: { fontSize: 18, lineWrapping: true } });
    expect(prefs).toEqual({ ...DEFAULT_PREFERENCES, hideTestCases: false, editor: { ...DEFAULT_PREFERENCES.editor, fontSize: 18, lineWrapping: true } });
    prefs = await api.preferences.put({ generatedTestCases: 12 });
    expect(prefs.generatedTestCases).toBe(12);
    prefs = await api.preferences.put({ largeTestCase: true });
    expect(prefs.largeTestCase).toBe(true);
    prefs = await api.preferences.put({ editor: { tabSize: 2 }, hideTestCases: true });
    expect(prefs.editor).toEqual({ ...DEFAULT_PREFERENCES.editor, fontSize: 18, lineWrapping: true, tabSize: 2 });
    expect(await api.preferences.put({})).toEqual(prefs);
    expect(await api.preferences.get()).toEqual(prefs);
    // The defaults themselves were not modified by any of this.
    start();
    expect(await api.preferences.get()).toEqual(DEFAULT_PREFERENCES);
  });

  it('rejects an unknown key or an out-of-range value and saves nothing', async () => {
    const bad: [Record<string, unknown>, string][] = [
      [{ hideTestCases: 'yes' }, 'hideTestCases'],
      [{ generatedTestCases: 0 }, 'generatedTestCases'],
      [{ generatedTestCases: LIMITS.maxGeneratedTestCases + 1 }, 'generatedTestCases'],
      [{ generatedTestCases: 2.5 }, 'generatedTestCases'],
      [{ largeTestCase: 1 }, 'largeTestCase'],
      [{ theme: 'dark' }, 'theme'],
      [{ editor: { minimap: true } }, 'editor.minimap'],
      [{ editor: { tabSize: 3 } }, 'editor.tabSize'],
      [{ editor: { fontSize: 9 } }, 'editor.fontSize'],
      [{ editor: { fontSize: 25 } }, 'editor.fontSize'],
      [{ editor: { fontSize: 13.5 } }, 'editor.fontSize'],
      [{ editor: { autocomplete: null } }, 'editor.autocomplete'],
      [{ editor: 'none' }, 'editor'],
    ];
    for (const [body, field] of bad) {
      const err = await failure(api.preferences.put(body as never));
      expect(err.status, field).toBe(422);
      expect(Object.keys(err.fields), field).toEqual([field]);
    }
    // One bad value rejects the whole update, valid parts included.
    const mixed = await failure(api.preferences.put({ hideTestCases: false, editor: { fontSize: 20, tabSize: 5 as never } }));
    expect(mixed.status).toBe(422);
    expect(await api.preferences.get()).toEqual(DEFAULT_PREFERENCES);
    // The bounds themselves are accepted.
    expect((await api.preferences.put({ editor: { fontSize: 10 } })).editor.fontSize).toBe(10);
    expect((await api.preferences.put({ editor: { fontSize: 24, tabSize: 8 } })).editor).toMatchObject({ fontSize: 24, tabSize: 8 });
    expect((await api.preferences.put({ generatedTestCases: 1 })).generatedTestCases).toBe(1);
    expect((await api.preferences.put({ generatedTestCases: LIMITS.maxGeneratedTestCases })).generatedTestCases).toBe(30);
  });

  it('can start with test cases shown', async () => {
    start(optionsFromFlags(['show-tests', 'instant']));
    expect(await api.preferences.get()).toEqual({ ...DEFAULT_PREFERENCES, hideTestCases: false });
  });
});

describe('export and import', () => {
  it('round-trips the whole library as unchanged', async () => {
    const { blob, filename } = await api.bundle.export({ scope: 'all', includeSolutions: true, includeHiddenTests: true });
    expect(filename).toBe('codeatrophy-library.codeatrophy.zip');
    expect(blob.size).toBeGreaterThan(1000);

    const preview = await api.bundle.preview(new File([blob], filename!));
    expect(preview.bundle).toMatchObject({ name: 'Codeatrophy library', formatVersion: 1 });
    expect(preview.counts).toEqual({ new: 0, changed: 0, unchanged: 25 });
    expect(preview.collections).toHaveLength(8);
    expect(preview.collections.every((c) => c.state === 'existing')).toBe(true);
    expect(preview.warnings).toEqual([]);
    expect(preview.items.find((i) => i.id === seedIds.items.twoSum)?.testCaseCount).toBe(6);
  });

  it('ignores what a partial export left out when comparing', async () => {
    const { blob } = await api.bundle.export({ scope: 'all', includeSolutions: false, includeHiddenTests: false });
    const preview = await api.bundle.preview(new File([blob], 'partial.zip'));
    expect(preview.counts).toEqual({ new: 0, changed: 0, unchanged: 25 });
    expect(preview.items.find((i) => i.id === seedIds.items.twoSum)?.testCaseCount).toBe(2);
  });

  it('exports a collection subtree or a selection', async () => {
    const subtree = await api.bundle.export({
      scope: 'collection',
      collectionId: seedIds.collections.systemsReading,
      includeSolutions: true,
      includeHiddenTests: true,
    });
    expect(subtree.filename).toBe('systems-reading.codeatrophy.zip');
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
    expect(picked.filename).toBe('two-picks.codeatrophy.zip');
    const picks = await api.bundle.preview(new File([picked.blob], 'b.zip'));
    expect(picks.items).toHaveLength(2);
    expect(picks.collections).toEqual([]);

    expect((await failure(api.bundle.export({ scope: 'items', itemIds: [], includeSolutions: true, includeHiddenTests: true }))).status).toBe(422);
    // A collection or item that does not exist is a validation error, not a 404.
    const noCollection = await failure(api.bundle.export({ scope: 'collection', collectionId: 'nope', includeSolutions: true, includeHiddenTests: true }));
    expect(noCollection.status).toBe(422);
    expect(noCollection.fields).toHaveProperty('collectionId');
    const noItem = await failure(
      api.bundle.export({ scope: 'items', itemIds: [seedIds.items.twoSum, 'nope'], includeSolutions: true, includeHiddenTests: true }),
    );
    expect(noItem.status).toBe(422);
  });

  it('writes solutions as files, and says what the export includes', async () => {
    const twoSum = seedIds.items.twoSum;
    const full = await api.bundle.export({ scope: 'items', itemIds: [twoSum, seedIds.items.rateLimiter], includeSolutions: true, includeHiddenTests: true });
    const bytes = new Uint8Array(await full.blob.arrayBuffer());
    const entries = new Map((await readZip(bytes)).map((e) => [e.path, new TextDecoder().decode(e.data)]));
    const manifest = JSON.parse(entries.get('bundle.json')!) as { includes: unknown; items: { id: string; path: string }[] };
    expect(manifest.includes).toEqual({ solutions: true, hiddenTests: true });

    const dir = manifest.items.find((i) => i.id === twoSum)!.path;
    const index = JSON.parse(entries.get(`${dir}/solutions/solutions.json`)!) as { solutions: Record<string, unknown>[] };
    expect(index.solutions.map((x) => [x.name, x.language, x.file, x.reference])).toEqual([
      ['Hash map, one pass', 'python', '01-hash-map-one-pass.py', true],
      ['Brute force', 'python', '02-brute-force.py', false],
      ['Hash map, one pass (C++)', 'cpp', '03-hash-map-one-pass-c.cpp', false],
    ]);
    expect(index.solutions[0]!.notes).toContain('O(n)');
    const stored = (await api.solutions.list(twoSum)).items;
    expect(entries.get(`${dir}/solutions/03-hash-map-one-pass-c.cpp`)).toBe(stored[2]!.source);
    // The reference solution is no longer part of item.json.
    expect(entries.get(`${dir}/item.json`)).not.toContain('referenceSolution');
    // A problem without solutions still says so, which is different from "not exported".
    const bare = manifest.items.find((i) => i.id === seedIds.items.rateLimiter)!.path;
    expect(JSON.parse(entries.get(`${bare}/solutions/solutions.json`)!)).toEqual({ solutions: [] });

    const parsed = await parseBundleZip(bytes);
    expect(parsed.includes).toEqual({ solutions: true, hiddenTests: true });
    expect(parsed.items.find((i) => i.id === twoSum)?.solutions).toHaveLength(3);
    expect(parsed.items.find((i) => i.id === seedIds.items.rateLimiter)?.solutions).toEqual([]);

    const partial = await api.bundle.export({ scope: 'items', itemIds: [twoSum], includeSolutions: false, includeHiddenTests: false });
    const partialBytes = new Uint8Array(await partial.blob.arrayBuffer());
    const paths = (await readZip(partialBytes)).map((e) => e.path);
    expect(paths.some((path) => path.includes('/solutions/'))).toBe(false);
    const sparse = await parseBundleZip(partialBytes);
    expect(sparse.includes).toEqual({ solutions: false, hiddenTests: false });
    expect(sparse.items[0]?.solutions).toBeUndefined();
    expect(sparse.items[0]?.testCases).toHaveLength(2);
  });

  it('compares solutions only when the bundle carries them', async () => {
    const twoSum = seedIds.items.twoSum;
    const full = await exportAll();
    const partial = await api.bundle.export({ scope: 'all', includeSolutions: false, includeHiddenTests: true });
    const without = new File([partial.blob], 'without-solutions.zip');
    const changesOf = async (file: File) => (await api.bundle.preview(file)).items.find((i) => i.id === twoSum);

    // Notes, names, order of the reference mark and membership of the list all count.
    await api.solutions.update(seedIds.solutions.twoSumBruteForce, { notes: 'Rewritten notes.' });
    expect(await changesOf(full)).toMatchObject({ state: 'changed', changes: ['solutions'] });
    expect(await changesOf(without)).toMatchObject({ state: 'unchanged', changes: [] });

    await api.solutions.update(seedIds.solutions.twoSumBruteForce, { notes: (await parseBundleZip(new Uint8Array(await full.arrayBuffer()))).items.find((i) => i.id === twoSum)!.solutions![1]!.notes });
    expect(await changesOf(full)).toMatchObject({ state: 'unchanged' });
    await api.solutions.update(seedIds.solutions.twoSumCpp, { isReference: true });
    expect((await changesOf(full))?.changes).toEqual(['solutions']);
    await api.solutions.remove(seedIds.solutions.twoSumCpp);
    expect((await changesOf(full))?.changes).toEqual(['solutions']);
    expect((await changesOf(without))?.state).toBe('unchanged');
  });

  it('replaces solutions on overwrite, and copies them to a duplicate', async () => {
    const twoSum = seedIds.items.twoSum;
    const bundle = await exportAll();
    const original = (await api.solutions.list(twoSum)).items;

    await api.solutions.remove(seedIds.solutions.twoSumCpp);
    await api.solutions.update(seedIds.solutions.twoSumHashMap, { source: 'print("local edit")' });
    const mine = await api.solutions.create(twoSum, { name: 'Local only', language: 'go', source: 'package main', isReference: true });
    const before = await api.items.get(twoSum);

    const result = await api.bundle.import(bundle, 'overwrite');
    expect(result).toMatchObject({ updated: 1, created: 0, duplicated: 0 });
    const restored = (await api.solutions.list(twoSum)).items;
    const content = (list: typeof restored) => list.map((x) => [x.name, x.language, x.source, x.notes, x.isReference]);
    expect(content(restored)).toEqual(content(original));
    expect(restored.some((x) => x.id === mine.id)).toBe(false);
    const after = await api.items.get(twoSum);
    expect(after.solutionCount).toBe(3);
    expect(after.problem?.referenceSolution).toMatchObject({ language: 'python', source: original[0]!.source });
    expect(after.revision).toBeGreaterThan(before.revision);
    expect((await api.bundle.preview(bundle)).counts.changed).toBe(0);

    // A duplicate is a separate item with its own copies.
    await api.solutions.update(restored[1]!.id, { name: 'Renamed locally' });
    const duplicated = await api.bundle.import(bundle, 'duplicate');
    expect(duplicated.duplicated).toBe(1);
    const copies = (await api.items.list({ q: 'Two Sum', limit: 50 })).items.filter((i) => i.title === after.title && i.id !== twoSum);
    expect(copies).toHaveLength(1);
    const copied = (await api.solutions.list(copies[0]!.id)).items;
    expect(content(copied)).toEqual(content(original));
    expect(copied.every((x) => x.itemId === copies[0]!.id && !restored.some((r) => r.id === x.id))).toBe(true);
    expect(copies[0]!.solutionCount).toBe(3);
    expect((await api.solutions.list(twoSum)).items[1]?.name).toBe('Renamed locally');
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
    expect(preview.counts).toEqual({ new: 1, changed: 1, unchanged: 23 });
    expect(preview.items.find((i) => i.id === changedId)).toMatchObject({ state: 'changed', changes: ['title'] });
    expect(preview.items.find((i) => i.id === deletedId)).toMatchObject({ state: 'new', changes: [] });
    expect(preview.items.filter((i) => i.state === 'unchanged').every((i) => i.changes.length === 0)).toBe(true);
    expect(preview.collections.find((c) => c.id === seedIds.collections.graphs)?.state).toBe('new');
    // A preview writes nothing.
    expect((await failure(api.items.get(deletedId))).status).toBe(404);

    const skip = await api.bundle.import(bundle, 'skip');
    expect(skip).toEqual({ created: 1, updated: 0, skipped: 1, duplicated: 0, unchanged: 23, collectionsCreated: 1, warnings: [] });
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
    expect((await api.bundle.preview(bundle)).counts).toEqual({ new: 0, changed: 0, unchanged: 25 });

    await arrange();
    const duplicate = await api.bundle.import(bundle, 'duplicate');
    expect(duplicate).toMatchObject({ created: 1, updated: 0, duplicated: 1 });
    expect((await api.items.list()).total).toBe(26);
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
      'solutions',
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
    // The bundle carried no solutions, so the local ones are all still there.
    expect(item.solutionCount).toBe(3);
    expect((await api.solutions.list(item.id)).items.map((x) => x.id)).toEqual([
      seedIds.solutions.twoSumHashMap,
      seedIds.solutions.twoSumBruteForce,
      seedIds.solutions.twoSumCpp,
    ]);
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
          },
          solutions: [
            { name: 'Loop', language: 'python', source: 'print(1)\r\n', notes: 'Straightforward.', isReference: true },
            { name: 'In Go', language: 'go', source: 'package main\n', notes: '', isReference: false },
          ],
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
    expect(item.solutionCount).toBe(2);
    const solutions = (await api.solutions.list(item.id)).items;
    expect(solutions.map((s) => [s.name, s.language, s.isReference])).toEqual([
      ['Loop', 'python', true],
      ['In Go', 'go', false],
    ]);
    expect(solutions[0]).toMatchObject({ source: 'print(1)\n', notes: 'Straightforward.' });
    expect(item.problem?.referenceSolution).toEqual({ id: solutions[0]!.id, language: 'python', source: 'print(1)\n' });
    expect((await api.bundle.preview(zipFile(bytes))).counts.unchanged).toBe(1);
  });

  it('skips broken solutions in a bundle with a warning each', async () => {
    const bytes = buildBundleZip({
      name: 'Odd solutions',
      items: [
        {
          id: '99999999-0000-4000-8000-000000000002',
          type: 'problem',
          title: 'Echo',
          summary: '',
          difficulty: null,
          tags: [],
          source: { url: null, note: null },
          variantOf: null,
          body: 'Print the input.',
          problem: { timeLimitMs: 1000, memoryLimitKb: 65536, compare: 'tokens', starterCode: {} },
          solutions: [
            { name: 'First', language: 'python', source: 'print(input())', notes: '', isReference: true },
            { name: 'Second reference', language: 'python', source: 'print(input())', notes: '', isReference: true },
            { name: 'Unknown language', language: 'brainfuck', source: ',.', notes: '', isReference: false },
            { name: 'Empty', language: 'go', source: '   ', notes: '', isReference: false },
          ],
          testCases: [],
        },
      ],
    });
    const preview = await api.bundle.preview(zipFile(bytes));
    expect(preview.items[0]).toMatchObject({ state: 'new' });
    expect(preview.warnings.filter((w) => w.includes('solutions/solutions.json'))).toHaveLength(3);
    expect(preview.warnings.some((w) => /more than one reference solution/.test(w))).toBe(true);
    expect(preview.warnings.some((w) => /unknown language/.test(w))).toBe(true);

    await api.bundle.import(zipFile(bytes), 'skip');
    const saved = (await api.solutions.list('99999999-0000-4000-8000-000000000002')).items;
    expect(saved.map((x) => [x.name, x.isReference])).toEqual([
      ['First', true],
      ['Second reference', false],
    ]);
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

  it('refuses state-changing requests from another origin under forbidden-writes', async () => {
    start(optionsFromFlags(['forbidden-writes', 'instant']));
    expect((await api.items.list()).total).toBeGreaterThan(0);
    const err = await failure(api.items.update(seedIds.items.twoSum, { favorite: true }));
    expect(err.status).toBe(403);
    expect(err.code).toBe('forbidden');
    expect(err.message).toMatch(/CODEATROPHY_ALLOWED_ORIGINS/);
    expect((await failure(api.collections.create({ name: 'x' }))).code).toBe('forbidden');
  });

  it('refuses every request, reads included, for a host that is not accepted', async () => {
    start(optionsFromFlags(['forbidden', 'instant']));
    const meta = await failure(api.meta());
    expect(meta.status).toBe(403);
    expect(meta.code).toBe('forbidden');
    expect(meta.message).toMatch(/CODEATROPHY_PUBLIC_URL/);
    expect(meta.message).toMatch(/CODEATROPHY_ALLOWED_HOSTS/);
    expect((await failure(api.items.list())).code).toBe('forbidden');
    expect((await failure(api.preferences.get())).code).toBe('forbidden');
    expect((await failure(api.items.update(seedIds.items.twoSum, { favorite: true }))).code).toBe('forbidden');
  });

  it('keeps externalEdit a content change', async () => {
    const before = await api.items.get(seedIds.items.twoSum);
    server.externalEdit(before.id);
    const after = await api.items.get(before.id);
    expect(after.revision).toBe(before.revision + 1);
    expect((await failure(api.items.update(before.id, { title: 'mine', expectedRevision: before.revision }))).isRevisionConflict).toBe(true);
  });
});
