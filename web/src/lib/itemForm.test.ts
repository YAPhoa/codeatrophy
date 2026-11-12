import { describe, expect, it } from 'vitest';
import type { Item, ItemDraft, Limits } from '../api/types';
import {
  changedFields,
  draftFromForm,
  emptyForm,
  formFromDraft,
  formFromItem,
  inputFromForm,
  mergeForms,
  normalizeTags,
  patchFromForm,
  patchTouchesContent,
  byteLength,
  charCount,
  formErrorsFromFields,
  revisionProblem,
  tagProblem,
  validateForm,
} from './itemForm';

const draft: ItemDraft = {
  type: 'problem',
  title: 'Two Sum',
  summary: 'Find two indices.',
  body: '## Problem',
  difficulty: 'easy',
  tags: ['Hash-Map', 'array'],
  problem: { timeLimitMs: 1000, memoryLimitKb: 131072, compare: 'exact', starterCode: { python: 'pass', go: '   ' } },
  testCases: [{ name: 'Example 1', stdin: '1\n', expectedStdout: '2\n', isSample: true }],
  assumptions: ['Assumed 0-based indices.'],
};

const item: Item = {
  id: 'i1',
  type: 'problem',
  title: 'Two Sum',
  summary: 'Find two indices.',
  difficulty: 'easy',
  tags: ['array', 'hash-map'],
  status: 'todo',
  favorite: false,
  collectionIds: ['c1', 'c2'],
  variantOf: null,
  variantCount: 0,
  testCaseCount: 1,
  lastVerdict: null,
  revision: 4,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  body: '## Problem',
  notes: 'private',
  rawInput: null,
  source: { url: null, note: 'interview' },
  problem: { timeLimitMs: 2000, memoryLimitKb: 262144, compare: 'tokens', starterCode: { python: 'pass' }, referenceSolution: { language: 'python', source: 'print(1)' } },
};

describe('normalizeTags', () => {
  it('lower-cases, trims, de-duplicates and sorts, as the server does', () => {
    expect(normalizeTags([' DP ', 'array', 'dp', ''])).toEqual(['array', 'dp']);
  });
});

describe('formFromDraft', () => {
  it('maps a draft onto the form and marks its test cases as AI-made', () => {
    const form = formFromDraft(draft, { collectionIds: ['c9'], tags: ['practice'] });
    expect(form).toMatchObject({ type: 'problem', title: 'Two Sum', difficulty: 'easy', timeLimitMs: 1000, memoryLimitKb: 131072, compare: 'exact', collectionIds: ['c9'] });
    expect(form.tags).toEqual(['array', 'hash-map', 'practice']);
    expect(form.testCases).toHaveLength(1);
    expect(form.testCases[0]).toMatchObject({ name: 'Example 1', origin: 'ai', isSample: true });
  });

  it('uses the problem defaults for a reading draft', () => {
    const form = formFromDraft({ ...draft, type: 'reading', problem: null, testCases: [] });
    expect(form).toMatchObject({ type: 'reading', timeLimitMs: 2000, memoryLimitKb: 262144, compare: 'tokens', starterCode: {}, testCases: [] });
  });
});

describe('draftFromForm', () => {
  it('round-trips the content of a draft, carrying user edits', () => {
    const form = { ...formFromDraft(draft), title: 'Two Sum (edited)' };
    const back = draftFromForm(form, draft.assumptions);
    expect(back.title).toBe('Two Sum (edited)');
    expect(back.testCases).toEqual(draft.testCases);
    expect(back.assumptions).toEqual(draft.assumptions);
    expect(back.problem).toEqual({ timeLimitMs: 1000, memoryLimitKb: 131072, compare: 'exact', starterCode: { python: 'pass', go: '   ' } });
  });

  it('has no problem part or test cases for a reading', () => {
    const back = draftFromForm({ ...formFromDraft(draft), type: 'reading' }, []);
    expect(back.problem).toBeNull();
    expect(back.testCases).toEqual([]);
  });
});

describe('inputFromForm', () => {
  it('builds the create body with rawInput, origins and cleaned starter code', () => {
    const input = inputFromForm({ ...formFromDraft(draft), sourceUrl: ' https://example.com ', title: '  Two Sum ' }, { rawInput: 'two sum thing' });
    expect(input).toMatchObject({ type: 'problem', title: 'Two Sum', rawInput: 'two sum thing', variantOf: null, source: { url: 'https://example.com', note: null } });
    expect(input.problem?.starterCode).toEqual({ python: 'pass' });
    expect(input.testCases).toEqual([{ name: 'Example 1', stdin: '1\n', expectedStdout: '2\n', isSample: true, origin: 'ai' }]);
  });

  it('sends no problem part or test cases for a reading', () => {
    const input = inputFromForm({ ...formFromDraft(draft), type: 'reading' }, { variantOf: 'orig' });
    expect(input.problem).toBeUndefined();
    expect(input.testCases).toBeUndefined();
    expect(input.variantOf).toBe('orig');
  });
});

describe('patchFromForm', () => {
  it('is empty when nothing changed', () => {
    expect(patchFromForm(item, formFromItem(item))).toEqual({});
  });

  it('contains only the fields that differ', () => {
    const form = { ...formFromItem(item), title: 'Two Sum II', tags: ['array', 'hash-map', 'New'], timeLimitMs: 3000, sourceUrl: 'https://x.test' };
    expect(patchFromForm(item, form)).toEqual({
      title: 'Two Sum II',
      tags: ['array', 'hash-map', 'new'],
      source: { url: 'https://x.test' },
      problem: { timeLimitMs: 3000 },
    });
  });

  it('never includes the reference solution, which is edited elsewhere', () => {
    const patch = patchFromForm(item, { ...formFromItem(item), compare: 'exact' });
    expect(patch.problem).toEqual({ compare: 'exact' });
  });

  it('treats collection order as irrelevant but membership as a change', () => {
    expect(patchFromForm(item, { ...formFromItem(item), collectionIds: ['c2', 'c1'] })).toEqual({});
    expect(patchFromForm(item, { ...formFromItem(item), collectionIds: ['c1'] })).toEqual({ collectionIds: ['c1'] });
  });

  it('clears nullable fields with null', () => {
    expect(patchFromForm(item, { ...formFromItem(item), difficulty: null, sourceNote: '  ' })).toEqual({ difficulty: null, source: { note: null } });
  });

  it('knows whether a patch touches revisioned content', () => {
    expect(patchTouchesContent({ collectionIds: ['c1'] })).toBe(false);
    expect(patchTouchesContent({ collectionIds: ['c1'], title: 'x' })).toBe(true);
  });
});

describe('mergeForms', () => {
  const base = formFromItem(item);

  it('adopts their changes and keeps mine when different fields changed', () => {
    const mine = { ...base, title: 'Mine' };
    const theirs = { ...base, body: 'their body', tags: ['array', 'hash-map', 'two-pointers'] };
    const res = mergeForms(base, mine, theirs);
    expect(res.merged).toMatchObject({ title: 'Mine', body: 'their body', tags: ['array', 'hash-map', 'two-pointers'] });
    expect(res.theirs.sort()).toEqual(['body', 'tags']);
    expect(res.mine).toEqual(['title']);
    expect(res.overlapping).toEqual([]);
  });

  it('flags a field changed on both sides and keeps my value', () => {
    const res = mergeForms(base, { ...base, title: 'Mine', body: 'my body' }, { ...base, title: 'Theirs' });
    expect(res.overlapping).toEqual(['title']);
    expect(res.merged.title).toBe('Mine');
    expect(res.merged.body).toBe('my body');
    expect(res.mine).toEqual(['body']);
  });

  it('does not flag the same change made on both sides', () => {
    const res = mergeForms(base, { ...base, difficulty: 'hard' }, { ...base, difficulty: 'hard' });
    expect(res.overlapping).toEqual([]);
    expect(res.merged.difficulty).toBe('hard');
  });

  it('reports no differences for cosmetic variations', () => {
    expect(changedFields(base, { ...base, title: ' Two Sum ', tags: ['HASH-MAP', 'array'], collectionIds: ['c2', 'c1'] })).toEqual([]);
  });
});

const limits: Limits = {
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
};

describe('validateForm', () => {
  const ok = { ...emptyForm(), title: 'ok' };

  it('requires a title within the published limit', () => {
    expect(validateForm(emptyForm(), limits).title).toBeDefined();
    expect(validateForm({ ...ok, title: 'x'.repeat(201) }, limits).title).toBeDefined();
    expect(validateForm(ok, limits)).toEqual({});
    // The bound is the server's, not a constant of the client.
    expect(validateForm({ ...ok, title: 'x'.repeat(201) }, { ...limits, maxTitleChars: 300 })).toEqual({});
  });

  it('counts characters as code points, the way the server does', () => {
    expect(charCount('a😀b')).toBe(3);
    expect(validateForm({ ...ok, title: '😀'.repeat(200) }, limits)).toEqual({});
    expect(byteLength('é😀')).toBe(6);
  });

  it('checks time and memory limits for problems only', () => {
    const bad = { ...emptyForm('problem'), title: 'ok', timeLimitMs: 50, memoryLimitKb: 1024 };
    expect(Object.keys(validateForm(bad, limits)).sort()).toEqual(['memoryLimitKb', 'timeLimitMs']);
    expect(validateForm({ ...bad, type: 'reading' }, limits)).toEqual({});
    expect(validateForm({ ...bad, timeLimitMs: NaN, memoryLimitKb: 262144 }, limits).timeLimitMs).toBeDefined();
  });

  it('checks the tag rules', () => {
    expect(validateForm({ ...ok, tags: Array.from({ length: 31 }, (_, i) => `t${i}`) }, limits).tags).toBeDefined();
    expect(validateForm({ ...ok, tags: ['x'.repeat(41)] }, limits).tags).toBeDefined();
    expect(validateForm({ ...ok, tags: ['a/b'] }, limits).tags).toMatch(/“\/”/);
    expect(tagProblem('tab\there', limits)).toMatch(/control/);
    expect(tagProblem('dp', limits)).toBeNull();
  });

  it('checks summary, text size and the source link', () => {
    expect(validateForm({ ...ok, summary: 's'.repeat(5001) }, limits).summary).toBeDefined();
    expect(validateForm({ ...ok, body: 'b'.repeat(1048577) }, limits).body).toBeDefined();
    expect(validateForm({ ...ok, sourceUrl: 'ftp://example.org/x' }, limits).sourceUrl).toMatch(/http/);
    expect(validateForm({ ...ok, sourceUrl: `https://example.org/${'x'.repeat(2048)}` }, limits).sourceUrl).toBeDefined();
    expect(validateForm({ ...ok, sourceUrl: ' https://example.org/a ' }, limits)).toEqual({});
  });

  it('checks the size of initial test cases', () => {
    const big = { key: 'k', name: 'big', stdin: 'x'.repeat(8388609), expectedStdout: '', isSample: false, origin: 'manual' as const };
    expect(validateForm({ ...emptyForm('problem'), title: 'ok', testCases: [big] }, limits).testCases).toBeDefined();
  });

  it('checks the source note and test-case names', () => {
    expect(validateForm({ ...ok, sourceNote: 'n'.repeat(2001) }, limits).sourceNote).toBeDefined();
    const named = { key: 'k', name: 'n'.repeat(201), stdin: '', expectedStdout: '', isSample: false, origin: 'manual' as const };
    expect(validateForm({ ...emptyForm('problem'), title: 'ok', testCases: [named] }, limits).testCases).toMatch(/name/);
  });

  it('refuses to send an oversized draft for revision', () => {
    expect(revisionProblem(draft, limits)).toBeNull();
    expect(revisionProblem({ ...draft, body: 'x'.repeat(2097152) }, limits)).toMatch(/revision/);
    expect(revisionProblem({ ...draft, body: 'x'.repeat(2097152) }, undefined)).toBeNull();
  });

  it('leaves the bounds to the server when they are not known yet', () => {
    expect(validateForm({ ...ok, title: 'x'.repeat(5000), tags: ['x'.repeat(500)] }, undefined)).toEqual({});
    expect(validateForm(emptyForm(), undefined).title).toBeDefined();
  });
});

describe('formErrorsFromFields', () => {
  it('maps the server field names onto the form', () => {
    const { errors, rest } = formErrorsFromFields({
      title: 'is required',
      'problem.timeLimitMs': 'must be between 100 and 30000',
      'source.url': 'must be an absolute http or https URL',
      'testCases.0.expectedStdout': 'is required',
      tags: 'tag "a/b" must not contain / or control characters',
      notes: 'must be at most 1048576 bytes',
    });
    expect(errors.title).toBe('This is required.');
    expect(errors.timeLimitMs).toBe('This must be between 100 and 30000.');
    expect(errors.sourceUrl).toMatch(/absolute http/);
    expect(errors.testCases).toBe('Case 1, expectedStdout: is required.');
    expect(errors.tags).toMatch(/^tag "a\/b"/);
    expect(rest).toEqual(['notes: must be at most 1048576 bytes']);
  });
});
