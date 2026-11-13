import { describe, expect, it } from 'vitest';
import type { Item, ItemDraft, LargeCaseReport, Limits } from '../api/types';
import {
  addFormLanguage,
  changedFields,
  checkedState,
  checkRequestFromForm,
  discardableCases,
  draftFromForm,
  effectiveHarness,
  emptyForm,
  formLanguages,
  formFromDraft,
  formFromItem,
  inputFromForm,
  mergeForms,
  normalizeTags,
  patchFromForm,
  patchTouchesContent,
  removeFormLanguage,
  upgradeForm,
  byteLength,
  charCount,
  formErrorsFromFields,
  revisionProblem,
  tagProblem,
  validateForm,
  withCheck,
  restoreCases,
  withoutCases,
  type FormTestCase,
  type CheckedDraft,
} from './itemForm';

const draft: ItemDraft = {
  type: 'problem',
  title: 'Two Sum',
  summary: 'Find two indices.',
  body: '## Problem',
  difficulty: 'easy',
  tags: ['Hash-Map', 'array'],
  problem: {
    interface: 'program',
    timeLimitMs: 1000,
    memoryLimitKb: 131072,
    compare: 'exact',
    starterCode: { python: 'pass', go: '   ' },
    harness: {},
    referenceSolution: { language: 'python', source: 'print(2)' },
  },
  testCases: [{ name: 'Example 1', stdin: '1\n', expectedStdout: '2\n', isSample: true, verified: true }],
  assumptions: ['Assumed 0-based indices.'],
};

const runner = { prefix: 'import json\n', suffix: 'print(Solution().solve())\n' };

/** The same draft as a "solution only" problem: a stub and a runner for Python, and a stub alone for Go. */
const functionDraft: ItemDraft = {
  ...draft,
  problem: { ...draft.problem!, interface: 'function', starterCode: { python: 'class Solution:\n    pass', go: 'func solve() {}' }, harness: { python: runner } },
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
  solutionCount: 0,
  lastVerdict: null,
  revision: 4,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  body: '## Problem',
  notes: 'private',
  rawInput: null,
  source: { url: null, note: 'interview' },
  problem: {
    interface: 'program',
    timeLimitMs: 2000,
    memoryLimitKb: 262144,
    compare: 'tokens',
    starterCode: { python: 'pass' },
    harness: {},
    referenceSolution: { language: 'python', source: 'print(1)' },
  },
};

const functionItem: Item = { ...item, problem: { ...item.problem!, interface: 'function', starterCode: { python: 'class Solution:\n    pass' }, harness: { python: runner } } };

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
    expect(form.testCases[0]).toMatchObject({ name: 'Example 1', origin: 'ai', isSample: true, verified: true });
  });

  it('takes the interface, the runner and the reference solution of the draft', () => {
    expect(formFromDraft(draft)).toMatchObject({ interface: 'program', harness: {}, referenceSolution: { language: 'python', source: 'print(2)' } });
    expect(formFromDraft(functionDraft)).toMatchObject({ interface: 'function', harness: { python: runner } });
  });

  it('marks the large test case the generation added', () => {
    const big: ItemDraft = { ...draft, testCases: [...draft.testCases, { name: 'Large', stdin: '9\n', expectedStdout: '1\n', isSample: false, verified: true }] };
    const report: LargeCaseReport = { status: 'added', error: null, index: 1, name: 'Large', inputBytes: 2, timeMs: 5, generator: null };
    expect(formFromDraft(big, {}, report).testCases.map((t) => t.large === true)).toEqual([false, true]);
    expect(formFromDraft(big, {}, { ...report, status: 'failed', index: null }).testCases.some((t) => t.large)).toBe(false);
    expect(formFromDraft(big).testCases.some((t) => t.large)).toBe(false);
  });

  it('uses the problem defaults for a reading draft', () => {
    const form = formFromDraft({ ...draft, type: 'reading', problem: null, testCases: [] });
    expect(form).toMatchObject({ type: 'reading', timeLimitMs: 2000, memoryLimitKb: 262144, compare: 'tokens', interface: 'program', starterCode: {}, harness: {}, testCases: [], referenceSolution: null });
  });
});

describe('draftFromForm', () => {
  it('round-trips the content of a draft, carrying user edits', () => {
    const form = { ...formFromDraft(draft), title: 'Two Sum (edited)' };
    const back = draftFromForm(form, draft.assumptions);
    expect(back.title).toBe('Two Sum (edited)');
    expect(back.testCases).toEqual(draft.testCases);
    expect(back.assumptions).toEqual(draft.assumptions);
    expect(back.problem).toEqual(draft.problem);
  });

  it('sends the interface, the runner and the reference solution back for a revision', () => {
    const back = draftFromForm(formFromDraft(functionDraft), []);
    expect(back.problem).toMatchObject({ interface: 'function', harness: { python: runner }, referenceSolution: { language: 'python', source: 'print(2)' } });
    // Switched to a full program in the form, the runner is not part of the draft any more.
    expect(draftFromForm({ ...formFromDraft(functionDraft), interface: 'program' }, []).problem).toMatchObject({ interface: 'program', harness: {} });
  });

  it('leaves the large test case, and any test data too large to show a model, out of a revision', () => {
    const form = formFromDraft(draft);
    const cases = [
      ...form.testCases,
      { ...form.testCases[0]!, key: 'big', name: 'Generated', stdin: '7\n', large: true },
      { ...form.testCases[0]!, key: 'pasted', name: 'Pasted', stdin: '1 '.repeat(40_000) },
      { ...form.testCases[0]!, key: 'output', name: 'Long output', expectedStdout: '0\n'.repeat(20_000) },
    ];
    expect(draftFromForm({ ...form, testCases: cases }, []).testCases.map((t) => t.name)).toEqual(['Example 1']);
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
    expect(input.testCases).toEqual([{ name: 'Example 1', stdin: '1\n', expectedStdout: '2\n', isSample: true, origin: 'ai', verified: true }]);
  });

  it('saves the reference solution of a draft with the item', () => {
    expect(inputFromForm(formFromDraft(draft)).problem).toMatchObject({ interface: 'program', harness: {}, referenceSolution: { language: 'python', source: 'print(2)' } });
    expect(inputFromForm({ ...formFromDraft(draft), referenceSolution: null }).problem?.referenceSolution).toBeNull();
  });

  it('saves a runner only for a "solution only" problem', () => {
    const form = formFromDraft(functionDraft);
    expect(inputFromForm(form).problem).toMatchObject({ interface: 'function', harness: { python: runner } });
    // Switching to a full program keeps the runner in the form, and saves none.
    const switched = { ...form, interface: 'program' as const };
    expect(switched.harness).toEqual({ python: runner });
    expect(inputFromForm(switched).problem).toMatchObject({ interface: 'program', harness: {} });
    expect(inputFromForm({ ...switched, interface: 'function' }).problem?.harness).toEqual({ python: runner });
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

  it('sends a changed runner, and an empty one with a switch to a full program', () => {
    expect(patchFromForm(functionItem, formFromItem(functionItem))).toEqual({});
    const edited = { ...formFromItem(functionItem), harness: { python: { ...runner, suffix: 'print(1)\n' } } };
    expect(patchFromForm(functionItem, edited)).toEqual({ problem: { harness: { python: { prefix: runner.prefix, suffix: 'print(1)\n' } } } });
    expect(patchFromForm(functionItem, { ...formFromItem(functionItem), interface: 'program' })).toEqual({ problem: { interface: 'program', harness: {} } });
    expect(patchFromForm(item, { ...formFromItem(item), interface: 'function' })).toEqual({ problem: { interface: 'function' } });
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

  it('compares the runner as it would be saved', () => {
    const form = formFromItem(functionItem);
    expect(changedFields(form, { ...form, harness: { ...form.harness, go: { prefix: ' ', suffix: '' } } })).toEqual([]);
    expect(changedFields(form, { ...form, interface: 'program' }).sort()).toEqual(['harness', 'interface']);
  });

  it('reports no differences for cosmetic variations', () => {
    expect(changedFields(base, { ...base, title: ' Two Sum ', tags: ['HASH-MAP', 'array'], collectionIds: ['c2', 'c1'] })).toEqual([]);
  });
});

const limits: Limits = {
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
  maxBundleNameChars: 200,
  maxBundleDescriptionChars: 5000,
  maxSolutionsPerItem: 50,
  maxSolutionNameChars: 100,
  maxSolutionNotesChars: 5000,
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
    const big = { key: 'k', name: 'big', stdin: 'x'.repeat(8388609), expectedStdout: '', isSample: false, origin: 'manual' as const, verified: false };
    expect(validateForm({ ...emptyForm('problem'), title: 'ok', testCases: [big] }, limits).testCases).toBeDefined();
  });

  it('checks the source note and test-case names', () => {
    expect(validateForm({ ...ok, sourceNote: 'n'.repeat(2001) }, limits).sourceNote).toBeDefined();
    const named = { key: 'k', name: 'n'.repeat(201), stdin: '', expectedStdout: '', isSample: false, origin: 'manual' as const, verified: false };
    expect(validateForm({ ...emptyForm('problem'), title: 'ok', testCases: [named] }, limits).testCases).toMatch(/name/);
  });

  it('checks the size of starter and runner code', () => {
    const form = { ...emptyForm('problem'), title: 'ok', interface: 'function' as const, harness: { python: { prefix: 'x'.repeat(65537), suffix: '' } } };
    expect(validateForm(form, limits).code).toBeDefined();
    // A runner that will not be saved is not checked.
    expect(validateForm({ ...form, interface: 'program' }, limits)).toEqual({});
    expect(validateForm({ ...emptyForm('problem'), title: 'ok', starterCode: { go: 'x'.repeat(65537) } }, limits).code).toBeDefined();
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
      'problem.harness': 'must be empty for a program problem',
    });
    expect(errors.code).toBe('harness: must be empty for a program problem.');
    expect(errors.title).toBe('This is required.');
    expect(errors.timeLimitMs).toBe('This must be between 100 and 30000.');
    expect(errors.sourceUrl).toMatch(/absolute http/);
    expect(errors.testCases).toBe('Case 1, expectedStdout: is required.');
    expect(errors.tags).toMatch(/^tag "a\/b"/);
    expect(rest).toEqual(['notes: must be at most 1048576 bytes']);
  });
});

describe('languages of a form', () => {
  const form = formFromDraft(functionDraft);

  it('lists the languages with a stub or a runner, and only those with starter code for a full program', () => {
    const withRunnerOnly = { ...form, harness: { ...form.harness, java: runner } };
    expect(formLanguages(withRunnerOnly).sort()).toEqual(['go', 'java', 'python']);
    expect(formLanguages({ ...withRunnerOnly, interface: 'program' }).sort()).toEqual(['go', 'python']);
  });

  it('adds a language with its runner, and removes the two together', () => {
    const added = addFormLanguage(form, 'java');
    expect(added.starterCode.java).toBe('');
    expect(added.harness.java).toEqual({ prefix: '', suffix: '' });
    // A full program has no runner to add.
    expect(addFormLanguage({ ...form, interface: 'program' as const }, 'java').harness).toEqual({ python: runner });
    const removed = removeFormLanguage(form, 'python');
    expect(removed.starterCode).toEqual({ go: 'func solve() {}' });
    expect(removed.harness).toEqual({});
  });

  it('saves a runner only for the languages that have any code in theirs', () => {
    expect(effectiveHarness(addFormLanguage(form, 'java'))).toEqual({ python: runner });
    expect(effectiveHarness({ interface: 'program', harness: { python: runner } })).toEqual({});
  });
});

describe('checkedState', () => {
  const form = formFromDraft(functionDraft);

  it('changes with what the check was run on, and with nothing else', () => {
    const state = checkedState(form);
    expect(checkedState({ ...form, title: 'Another title', body: 'Another statement', tags: ['x'] })).toBe(state);
    expect(checkedState({ ...form, testCases: form.testCases.map((t) => ({ ...t, name: 'Renamed', isSample: false })) })).toBe(state);
    expect(checkedState({ ...form, testCases: form.testCases.map((t) => ({ ...t, expectedStdout: '3\n' })) })).not.toBe(state);
    expect(checkedState({ ...form, harness: { python: { ...runner, suffix: '' } } })).not.toBe(state);
    expect(checkedState({ ...form, interface: 'program' })).not.toBe(state);
    expect(checkedState({ ...form, referenceSolution: null })).not.toBe(state);
  });
});

describe('upgradeForm', () => {
  it('fills in what a form stored by an earlier version lacks', () => {
    const { interface: _interface, harness: _harness, referenceSolution: _reference, ...old } = formFromDraft(draft);
    const stored = { ...old, testCases: old.testCases.map(({ verified: _verified, ...t }) => t) } as unknown as Parameters<typeof upgradeForm>[0];
    const form = upgradeForm(stored);
    expect(form).toMatchObject({ interface: 'program', harness: {}, referenceSolution: null, title: 'Two Sum' });
    expect(form.testCases[0]).toMatchObject({ name: 'Example 1', verified: false });
  });

  it('leaves a current form as it is', () => {
    const form = formFromDraft(functionDraft);
    expect(upgradeForm(form)).toEqual(form);
  });
});

describe('checking a draft again', () => {
  const report: LargeCaseReport = { status: 'added', error: null, index: 1, name: 'Large', inputBytes: 9, timeMs: 5, generator: null };
  const twoCases: ItemDraft = { ...draft, testCases: [...draft.testCases, { name: 'Large', stdin: '9\n', expectedStdout: '1\n', isSample: false, verified: true }] };
  const form = formFromDraft(twoCases, {}, report);
  const answer = {
    check: { attempted: true, engine: 'judge0', passed: 1, total: 2, error: 'Example 1: expected 2', runners: [], largeCase: null },
    cases: [
      { outcome: 'wrong' as const, error: null },
      { outcome: 'passed' as const, error: null },
    ],
  };

  it('sends the problem and the test cases as they would be saved', () => {
    const body = checkRequestFromForm(form);
    expect(body.problem).toMatchObject({ interface: 'program', compare: 'exact', referenceSolution: { language: 'python', source: 'print(2)' } });
    expect(body.testCases.map((t) => t.stdin)).toEqual(['1\n', '9\n']);
    expect(body.testCases[1]).not.toHaveProperty('large');
  });

  it('marks each case from the answer and keeps the report of the large case', () => {
    const session = { form, check: { ...answer.check, passed: 2, error: null, largeCase: report }, checked: checkedState(form), other: 'kept' };
    const next = withCheck(session, checkedState(form), answer)!;
    expect(next.form!.testCases.map((t) => t.verified)).toEqual([false, true]);
    expect(next.form!.testCases.map((t) => t.outcome?.outcome)).toEqual(['wrong', 'passed']);
    expect(next.check).toEqual({ ...answer.check, largeCase: report });
    expect(next.checked).toBe(checkedState(next.form!));
    expect(next.other).toBe('kept');
  });

  it('drops an answer for a form that has changed since', () => {
    const sent = checkedState(form);
    const edited = { ...form, testCases: form.testCases.map((t, i) => (i === 0 ? { ...t, expectedStdout: '3\n' } : t)) };
    expect(withCheck({ form: edited }, sent, answer)).toBeNull();
    expect(withCheck({ form: null }, sent, answer)).toBeNull();
    // A change the check does not depend on is fine.
    expect(withCheck({ form: { ...form, title: 'Renamed' } }, sent, answer)).not.toBeNull();
  });

  it('offers to discard the cases that ran and were wrong or failed, but only when some passed', () => {
    const outcomes = (...list: ('passed' | 'wrong' | 'failed' | 'not_run')[]) => ({
      testCases: list.map((outcome, i) => ({ ...form.testCases[0]!, key: `k${i}`, outcome: { outcome, error: null } })),
    });
    expect(discardableCases(outcomes('passed', 'wrong', 'failed', 'not_run'))).toEqual(['k1', 'k2']);
    expect(discardableCases(outcomes('wrong', 'failed'))).toEqual([]);
    expect(discardableCases(outcomes('wrong', 'not_run'))).toEqual([]);
    expect(discardableCases(outcomes('passed', 'passed'))).toEqual([]);
    expect(discardableCases(form)).toEqual([]);
  });

  it('drops cases and brings a check that still holds along', () => {
    const checked = withCheck<CheckedDraft>({ form, check: null }, checkedState(form), answer)!;
    const wrong = checked.form!.testCases[0]!.key;
    const next = withoutCases(checked, [wrong]);
    expect(next.form!.testCases).toHaveLength(1);
    expect(next.check).toMatchObject({ passed: 1, total: 1, error: null });
    expect(next.checked).toBe(checkedState(next.form!));
    // A check the form has moved on from is left as it is.
    const edited = { ...checked, form: { ...checked.form!, compare: 'tokens' as const } };
    expect(withoutCases(edited, [wrong]).check).toEqual(checked.check);
  });
});

describe('restoreCases', () => {
  const tc = (key: string): FormTestCase => ({ key, name: key, stdin: '', expectedStdout: '', isSample: false, origin: 'manual', verified: false });
  const before = [tc('a'), tc('b'), tc('c'), tc('d')];

  it('puts removed cases back where they were', () => {
    const form = { testCases: [before[0]!, before[2]!] };
    expect(restoreCases(form, before, ['b', 'd']).testCases.map((t) => t.key)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('copes with a list that changed since: nothing twice, and a lost position means the end', () => {
    expect(restoreCases({ testCases: [before[1]!] }, before, ['b', 'd']).testCases.map((t) => t.key)).toEqual(['b', 'd']);
    expect(restoreCases({ testCases: [] as FormTestCase[] }, before, ['c']).testCases.map((t) => t.key)).toEqual(['c']);
  });
});
