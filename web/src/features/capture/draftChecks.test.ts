import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setTransport } from '../../api/client';
import type { ItemDraft } from '../../api/types';
import { checkedState, formFromDraft, type CheckedDraft } from '../../lib/itemForm';
import { readJson, writeJson } from '../../lib/storage';
import { createMockServer } from '../../mock';
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

function memoryStorage(): Storage {
  const data = new Map<string, string>();
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
  } as unknown as Storage;
}

async function settled(key: string): Promise<void> {
  for (let i = 0; i < 100 && getDraftCheck(key).running; i++) await new Promise((r) => setTimeout(r, 5));
}

describe('a draft check with its page closed', () => {
  beforeEach(() => {
    Object.defineProperty(globalThis, 'localStorage', { value: memoryStorage(), configurable: true });
    setTransport(createMockServer({ speed: 'instant' }).fetch);
  });
  afterEach(() => {
    Reflect.deleteProperty(globalThis, 'localStorage');
    setTransport(() => Promise.reject(new Error('no transport')));
  });

  it('writes its answer into the stored draft', async () => {
    const form = formFromDraft(draft);
    writeJson('capture:test', { form, check: null } satisfies CheckedDraft);
    startDraftCheck('capture:test', form);
    expect(getDraftCheck('capture:test')).toMatchObject({ running: true, total: 2 });
    await settled('capture:test');
    const stored = readJson<CheckedDraft | null>('capture:test', null)!;
    expect(stored.form!.testCases.map((t) => t.verified)).toEqual([true, false]);
    expect(stored.check).toMatchObject({ attempted: true, passed: 1, total: 2 });
    expect(stored.checked).toBe(checkedState(stored.form!));
    expect(getDraftCheck('capture:test')).toMatchObject({ running: false, outdated: false, error: null });
  });

  it('leaves a draft that changed meanwhile alone, and says so', async () => {
    const form = formFromDraft(draft);
    startDraftCheck('capture:test', form);
    const edited = { ...form, testCases: form.testCases.slice(0, 1) };
    writeJson('capture:test', { form: edited } satisfies CheckedDraft);
    await settled('capture:test');
    expect(readJson<CheckedDraft | null>('capture:test', null)).toEqual({ form: edited });
    expect(getDraftCheck('capture:test').outdated).toBe(true);
  });

  it('can be cancelled', async () => {
    const form = formFromDraft(draft);
    writeJson('capture:test', { form } satisfies CheckedDraft);
    startDraftCheck('capture:test', form);
    cancelDraftCheck('capture:test');
    await new Promise((r) => setTimeout(r, 20));
    expect(getDraftCheck('capture:test')).toMatchObject({ running: false, error: null, outdated: false });
    expect(readJson<CheckedDraft | null>('capture:test', null)!.form!.testCases.map((t) => t.verified)).toEqual([false, true]);
  });
});
