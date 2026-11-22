import { describe, expect, it } from 'vitest';
import { ApiError } from '../../api/client';
import type { Draft, DraftPatch, DraftResponse } from '../../api/types';
import type { DraftContent } from './draftContent';
import { DraftSaver } from './draftSaver';

const generation: DraftResponse = {
  draft: {
    type: 'problem',
    title: 'Two Sum',
    summary: 'Find two indices.',
    body: 'Given nums and target…',
    difficulty: 'easy',
    tags: ['array'],
    problem: null,
    testCases: [{ name: 'Example 1', stdin: '1\n', expectedStdout: '2\n', isSample: true, verified: false, generator: null }],
    assumptions: [],
  },
  style: null,
  check: null,
  usage: { logId: 'log-1', model: 'm', durationMs: 10, inputTokens: 1, outputTokens: 2, reasoningTokens: null, cacheReadTokens: null, cacheWriteTokens: null },
};

/** A draft whose first generation has arrived and has not been taken in. */
const ready = (): Draft => ({
  id: 'd1',
  kind: 'capture',
  variantOf: null,
  title: 'Two Sum',
  state: 'ready',
  revision: 3,
  edited: false,
  request: null,
  job: null,
  error: null,
  generation,
  generationSeq: 1,
  content: null,
  basedOn: 0,
  createdAt: '2026-11-22T09:00:00Z',
  updatedAt: '2026-11-22T09:00:00Z',
});

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const down = new ApiError(0, 'network', 'The Codeatrophy server is not reachable.');

/** A saver over an in-memory server that answers as `PATCH /drafts/{id}` does, and the record of what it did. */
function setup(initial: Draft = ready()) {
  const state = { server: initial };
  const patches: DraftPatch[] = [];
  /** Failures for the next updates, in order. */
  const failures: unknown[] = [];
  const seen = { collected: 0, refetches: 0, reloads: 0, errors: [] as unknown[] };
  const copy = () => structuredClone(state.server);
  const saver: DraftSaver = new DraftSaver(
    {
      get: async () => copy(),
      update: async (patch) => {
        patches.push(patch);
        const failure = failures.shift();
        if (failure) throw failure;
        const s = state.server;
        if (patch.expectedRevision !== undefined && patch.expectedRevision !== s.revision) throw new ApiError(409, 'conflict', 'changed', { revision: s.revision });
        if (patch.basedOn !== undefined && patch.basedOn > s.generationSeq) throw new ApiError(422, 'validation_failed', 'basedOn', { basedOn: 'too large' });
        state.server = {
          ...s,
          revision: s.revision + 1,
          ...(patch.content !== undefined ? { content: patch.content } : {}),
          ...(patch.basedOn !== undefined ? { basedOn: patch.basedOn } : {}),
          ...(patch.edited !== undefined ? { edited: patch.edited } : {}),
        };
        return copy();
      },
    },
    {
      // As the page does: what goes into the cache comes back to the saver, after a render.
      took: (draft) => void flush().then(() => saver.received(draft)),
      reloaded: () => void seen.reloads++,
      saveError: (e) => void (e !== null && seen.errors.push(e)),
      collected: () => void seen.collected++,
      refetch: () => {
        seen.refetches++;
        void flush().then(() => saver.received(copy()));
      },
    },
    10_000,
  );
  /** A change of the form's title, as the user makes it. */
  const retitle = (title: string) => saver.update((c: DraftContent) => ({ ...c, form: { ...c.form!, title } }));
  /** The content the server holds. */
  const stored = () => state.server.content as unknown as DraftContent | null;
  /** Something changes the draft elsewhere. */
  const elsewhere = (title: string) => {
    state.server = { ...state.server, revision: state.server.revision + 1, content: { ...stored()!, form: { ...stored()!.form!, title } } as unknown as Record<string, unknown> };
  };
  return { state, saver, patches, failures, seen, retitle, stored, elsewhere, copy };
}

describe('DraftSaver', () => {
  it('takes a generation in at once, saving the form built from it with basedOn', async () => {
    const t = setup();
    t.saver.received(t.copy());
    await flush();
    expect(t.saver.content?.form?.title).toBe('Two Sum');
    expect(t.patches).toEqual([expect.objectContaining({ basedOn: 1, edited: false, title: 'Two Sum', expectedRevision: 3 })]);
    expect(t.state.server).toMatchObject({ basedOn: 1, edited: false, revision: 4 });
    expect(t.seen.collected).toBe(1);
  });

  it('after taking a generation in failed, saves edits with basedOn instead of taking it in again over them', async () => {
    const t = setup();
    t.failures.push(down);
    t.saver.received(t.copy());
    await flush();
    expect(t.seen.errors).toEqual([down]);
    expect(t.state.server.basedOn).toBe(0);
    expect(t.saver.content?.form?.title).toBe('Two Sum');

    t.retitle('Mine');
    await t.saver.flush();
    await flush();
    await flush();
    expect(t.patches.at(-1)).toMatchObject({ basedOn: 1, edited: true, title: 'Mine', expectedRevision: 3 });
    expect(t.state.server).toMatchObject({ basedOn: 1, edited: true });
    expect(t.stored()?.form?.title).toBe('Mine');
    // The answer, back from the cache, leaves the edit as it is, and the generation is collected.
    expect(t.saver.content?.form?.title).toBe('Mine');
    expect(t.patches).toHaveLength(2);
    expect(t.seen.collected).toBe(1);

    // And a later edit is an ordinary save.
    t.retitle('Mine, again');
    await t.saver.flush();
    expect(t.patches.at(-1)).not.toHaveProperty('basedOn');
  });

  it('does not take a generation in again over an edit of it while its save is not through', async () => {
    const t = setup();
    t.failures.push(down);
    t.saver.received(t.copy());
    await flush();
    t.retitle('Mine');
    t.failures.push(down);
    await t.saver.flush();
    // A refetch, on focus say, brings the same copy back.
    t.saver.received(t.copy());
    await flush();
    expect(t.saver.content?.form?.title).toBe('Mine');
    expect(t.patches).toHaveLength(2);
    // Closing the tab sends the edit with what it was built from.
    expect(t.saver.parting()).toMatchObject({ basedOn: 1, edited: true, title: 'Mine' });
  });

  it('tries taking a generation in again on the next read while nothing has been edited since', async () => {
    const t = setup();
    t.failures.push(down);
    t.saver.received(t.copy());
    await flush();
    t.saver.received(t.copy());
    await flush();
    expect(t.patches).toHaveLength(2);
    expect(t.patches[1]).toMatchObject({ basedOn: 1, edited: false });
    expect(t.state.server.basedOn).toBe(1);
    expect(t.seen.collected).toBe(1);
  });

  it('takes a generation in from the copy read again when the draft changed before it could be', async () => {
    const t = setup();
    const read = t.copy();
    t.state.server = { ...t.state.server, revision: 4 };
    t.saver.received(read);
    await flush();
    await flush();
    await flush();
    expect(t.seen.refetches).toBe(1);
    expect(t.patches).toHaveLength(2);
    expect(t.patches[1]).toMatchObject({ basedOn: 1, edited: false, expectedRevision: 4 });
    expect(t.state.server.basedOn).toBe(1);
  });

  it('drops what it built from a generation when the draft is reloaded', async () => {
    const t = setup();
    t.failures.push(down);
    t.saver.received(t.copy());
    await flush();
    // The generation is taken in elsewhere, and edited there.
    t.state.server = { ...t.state.server, basedOn: 1, edited: true, revision: 4, content: { form: { ...t.saver.content!.form!, title: 'Theirs' } } };
    t.retitle('Mine');
    await t.saver.flush();
    expect(t.seen.reloads).toBe(1);
    expect(t.saver.content?.form?.title).toBe('Theirs');
    t.retitle('Mine after all');
    await t.saver.flush();
    expect(t.patches.at(-1)).not.toHaveProperty('basedOn');
  });

  it('says when settling reloaded the draft, because it changed elsewhere', async () => {
    const t = setup();
    t.saver.received(t.copy());
    await flush();
    t.retitle('Mine');
    expect(await t.saver.settle()).toEqual({ revision: 5, reloaded: false });

    t.retitle('Mine, again');
    t.elsewhere('Theirs');
    const settled = await t.saver.settle();
    expect(settled.reloaded).toBe(true);
    expect(settled.revision).toBe(6);
    expect(t.saver.content?.form?.title).toBe('Theirs');
    expect(t.saver.dirty).toBe(false);
    // With nothing unsaved, settling again changes nothing.
    expect(await t.saver.settle()).toEqual({ revision: 6, reloaded: false });
  });
});
