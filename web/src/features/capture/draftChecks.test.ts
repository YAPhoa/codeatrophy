import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { api, setTransport } from '../../api/client';
import type { ItemDraft } from '../../api/types';
import { checkedState, formFromDraft, type ItemFormState } from '../../lib/itemForm';
import { createMockServer } from '../../mock';
import { readContent } from '../drafts/draftContent';
import { cancelDraftCheck, getDraftCheck, startDraftCheck } from './draftChecks';

const draft: ItemDraft = {
  type: 'problem',
  title: 'Echo',
  summary: '',
  body: '',
  difficulty: null,
  tags: [],
  problem: { interface: 'program', timeLimitMs: 1000, memoryLimitKb: 65536, compare: 'tokens', starterCode: {}, harness: {}, referenceSolution: { language: 'python', source: 'print(input())' } },
  testCases: [
    { name: 'One', stdin: '1\n', expectedStdout: '1\n', isSample: true, verified: false },
    { name: 'Two', stdin: '2\n', expectedStdout: '2 MOCK:WA\n', isSample: false, verified: true },
  ],
  assumptions: [],
};

async function settled(key: string): Promise<void> {
  for (let i = 0; i < 100 && getDraftCheck(key).running; i++) await new Promise((r) => setTimeout(r, 5));
}

/** A draft on the server holding this form. */
async function stored(form: ItemFormState): Promise<string> {
  return (await api.drafts.create({ kind: 'capture', content: { v: 1, form, check: null } })).id;
}

const contentOf = async (id: string) => readContent(await api.drafts.get(id));

describe('a draft check with its page closed', () => {
  beforeEach(() => {
    setTransport(createMockServer({ speed: 'instant' }).fetch);
  });
  afterEach(() => {
    setTransport(() => Promise.reject(new Error('no transport')));
  });

  it('writes its answer into the draft on the server', async () => {
    const form = formFromDraft(draft);
    const id = await stored(form);
    startDraftCheck(id, form);
    expect(getDraftCheck(id)).toMatchObject({ running: true, total: 2 });
    await settled(id);
    const content = await contentOf(id);
    expect(content.form!.testCases.map((t) => t.verified)).toEqual([true, false]);
    expect(content.check).toMatchObject({ attempted: true, passed: 1, total: 2 });
    expect(content.checked).toBe(checkedState(content.form!));
    expect(getDraftCheck(id)).toMatchObject({ running: false, outdated: false, error: null });
  });

  it('leaves a draft that changed meanwhile alone, and says so', async () => {
    const form = formFromDraft(draft);
    const id = await stored(form);
    startDraftCheck(id, form);
    const edited = { ...form, testCases: form.testCases.slice(0, 1) };
    await api.drafts.update(id, { content: { v: 1, form: edited } });
    await settled(id);
    expect((await contentOf(id)).form!.testCases).toHaveLength(1);
    expect((await contentOf(id)).check).toBeUndefined();
    expect(getDraftCheck(id).outdated).toBe(true);
  });

  it('can be cancelled', async () => {
    const form = formFromDraft(draft);
    const id = await stored(form);
    startDraftCheck(id, form);
    cancelDraftCheck(id);
    await new Promise((r) => setTimeout(r, 20));
    expect(getDraftCheck(id)).toMatchObject({ running: false, error: null, outdated: false });
    expect((await contentOf(id)).form!.testCases.map((t) => t.verified)).toEqual([false, true]);
  });
});
