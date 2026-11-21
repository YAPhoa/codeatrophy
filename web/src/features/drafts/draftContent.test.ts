import { describe, expect, it } from 'vitest';
import type { DraftResponse, ItemDraft } from '../../api/types';
import { checkedState, emptyForm } from '../../lib/itemForm';
import { contentFromGeneration, emptyContent, hasNewGeneration, readContent, titleOf, type DraftContent } from './draftContent';

const itemDraft = (over: Partial<ItemDraft> = {}): ItemDraft => ({
  type: 'problem',
  title: 'Two Sum',
  summary: 'Find two indices.',
  body: 'Given nums and target…',
  difficulty: 'easy',
  tags: ['array'],
  problem: null,
  testCases: [{ name: 'Example 1', stdin: '1\n', expectedStdout: '2\n', isSample: true, verified: false, generator: null }],
  assumptions: ['Exactly one answer.'],
  ...over,
});

const generation = (over: Partial<ItemDraft> = {}): DraftResponse => ({
  draft: itemDraft(over),
  style: { id: 's1', name: 'LeetCode style' },
  check: null,
  usage: { logId: 'log-1', model: 'm', durationMs: 10, inputTokens: 1, outputTokens: 2, reasoningTokens: null, cacheReadTokens: null, cacheWriteTokens: null },
});

describe('contentFromGeneration', () => {
  it('files a first generation under the inherited collections and those the capture began in, once each', () => {
    const started: DraftContent = { ...emptyContent(), collectionIds: ['c-capture', 'c-both'] };
    const content = contentFromGeneration(started, generation({ tags: ['dp', 'Array'] }), { tags: ['array', 'graph'], collectionIds: ['c-both', 'c-original'] });
    expect([...content.form!.collectionIds].sort()).toEqual(['c-both', 'c-capture', 'c-original']);
    // The original's tags and the generated ones, normalised.
    expect(content.form!.tags).toEqual(['array', 'dp', 'graph']);
    expect(content).toMatchObject({ aiDrafted: true, assumptions: ['Exactly one answer.'], appliedStyle: { id: 's1', name: 'LeetCode style' }, styleChoice: 's1' });
    expect(content.form!.title).toBe('Two Sum');
    expect(content.checked).toBe(checkedState(content.form!));
  });

  it('keeps where a revised form is filed and where it came from, which the model does not produce', () => {
    const form = { ...emptyForm(), title: 'Mine', collectionIds: ['c1'], sourceUrl: 'https://example.org/p', sourceNote: 'from a book', tags: ['mine'] };
    const previous: DraftContent = { ...emptyContent(), form, aiDrafted: true, collectionIds: ['c-capture'] };
    const revised = contentFromGeneration(previous, generation({ title: 'Two Sum II', tags: ['array'] }), { collectionIds: ['c-original'], tags: ['inherited'] });
    expect(revised.form).toMatchObject({ title: 'Two Sum II', collectionIds: ['c1'], sourceUrl: 'https://example.org/p', sourceNote: 'from a book' });
    // The model's tags replace the form's; what was inherited applied to the first generation only.
    expect(revised.form!.tags).toEqual(['array']);
    expect(revised.collectionIds).toEqual(['c-capture']);
  });

  it('records no style for a generation made without one', () => {
    const content = contentFromGeneration({ ...emptyContent(), styleChoice: 's1' }, { ...generation(), style: null });
    expect(content).toMatchObject({ appliedStyle: null, styleChoice: null });
  });
});

describe('hasNewGeneration', () => {
  const draft = { generation: generation(), generationSeq: 2, basedOn: 1 };

  it('is true only for a generation the content was not built from', () => {
    expect(hasNewGeneration(draft)).toBe(true);
    expect(hasNewGeneration({ ...draft, basedOn: 2 })).toBe(false);
    expect(hasNewGeneration({ ...draft, generation: null })).toBe(false);
  });
});

describe('readContent', () => {
  it('starts empty from no content, or content that is not an object', () => {
    for (const content of [null, undefined, 'text', 7]) expect(readContent({ content: content as never }), String(content)).toEqual(emptyContent());
  });

  it('fills in what an older document left out, and upgrades its form', () => {
    // A form kept before `verified` and the problem fields existed.
    const oldCase = { key: 'k1', name: 'a', stdin: '', expectedStdout: '', isSample: true, origin: 'manual' };
    const oldForm = { type: 'reading', title: 'Old', testCases: [oldCase] } as unknown as DraftContent['form'];
    const content = readContent({ content: { form: oldForm, aiDrafted: true, styleChoice: null } });
    expect(content).toMatchObject({ v: 1, assumptions: [], aiDrafted: true, appliedStyle: null, styleChoice: null });
    expect(content.form).toMatchObject({ ...emptyForm('reading'), title: 'Old', testCases: [{ ...oldCase, verified: false }] });
    // Assumptions of the wrong shape are dropped.
    expect(readContent({ content: { assumptions: 'one' } }).assumptions).toEqual([]);
  });
});

describe('titleOf', () => {
  it('is the form’s title, or none for a blank one', () => {
    expect(titleOf({ ...emptyContent(), form: { ...emptyForm(), title: '  Two Sum ' } })).toBe('Two Sum');
    expect(titleOf({ ...emptyContent(), form: { ...emptyForm(), title: '  ' } })).toBeNull();
    expect(titleOf(emptyContent())).toBeNull();
  });
});
