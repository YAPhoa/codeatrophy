import { describe, expect, it } from 'vitest';
import { ApiError } from '../api/client';
import type { WorkingCopy } from '../api/types';
import { WorkspaceSaver } from './workspaceSaver';

interface Call {
  method: 'PUT' | 'DELETE';
  language: string;
  source?: string;
  keepalive?: boolean;
  resolve: () => void;
  reject: (error: unknown) => void;
}

/** A saver whose requests wait until the test answers them, and the record of what it did. */
function setup() {
  const calls: Call[] = [];
  const stored = new Map<string, string>();
  /** The base each stored edit was written with. */
  const bases = new Map<string, string | null | undefined>();
  let written = 0;
  const saved: WorkingCopy[] = [];
  const removed: string[] = [];
  const saver = new WorkspaceSaver(
    {
      put: (language, source, keepalive) =>
        new Promise<WorkingCopy>((resolve, reject) => {
          calls.push({ method: 'PUT', language, source, keepalive, resolve: () => resolve({ language, source, updatedAt: `t${++written}` }), reject });
        }),
      remove: (language) =>
        new Promise<void>((resolve, reject) => {
          calls.push({ method: 'DELETE', language, resolve, reject });
        }),
    },
    {
      write: (language, source, base) => {
        stored.set(language, source);
        bases.set(language, base);
      },
      clear: (language) => {
        stored.delete(language);
        bases.delete(language);
      },
    },
    { saved: (copy) => void saved.push(copy), removed: (language) => void removed.push(language) },
  );
  /** Calls not answered yet. */
  const open = () => calls.filter((c) => !(c as { done?: boolean }).done);
  const answer = async (i: number, outcome: 'ok' | unknown = 'ok') => {
    const call = calls[i]!;
    (call as { done?: boolean }).done = true;
    if (outcome === 'ok') call.resolve();
    else call.reject(outcome);
    await flush();
  };
  return { saver, calls, stored, bases, saved, removed, open, answer };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const down = new ApiError(0, 'network', 'The Codeatrophy server is not reachable.');
const shown = (calls: Call[]) => calls.map((c) => (c.method === 'PUT' ? `PUT ${c.language} ${c.source}` : `DELETE ${c.language}`));

describe('WorkspaceSaver', () => {
  it('keeps an edit here until its save succeeds', async () => {
    const t = setup();
    t.saver.edit('python', 'a');
    expect(t.stored.get('python')).toBe('a');
    void t.saver.send('python');
    expect(shown(t.calls)).toEqual(['PUT python a']);
    expect(t.stored.get('python')).toBe('a');
    await t.answer(0);
    expect(t.stored.has('python')).toBe(false);
    expect(t.saved).toEqual([{ language: 'python', source: 'a', updatedAt: 't1' }]);
    expect(t.saver.unsent('python')).toBe(false);
  });

  it('has at most one request in flight per language, and sends only the latest edit next, in order', async () => {
    const t = setup();
    t.saver.edit('python', 'v1');
    const first = t.saver.send('python');
    t.saver.edit('python', 'v2');
    void t.saver.send('python');
    t.saver.edit('python', 'v3');
    void t.saver.send('python');
    // v2 and v3 wait behind v1; nothing else is in flight.
    expect(shown(t.open())).toEqual(['PUT python v1']);
    await t.answer(0);
    // v1 landed, but v3 is still waiting here.
    expect(t.stored.get('python')).toBe('v3');
    expect(shown(t.open())).toEqual(['PUT python v3']);
    await t.answer(1);
    await first;
    expect(shown(t.calls)).toEqual(['PUT python v1', 'PUT python v3']);
    expect(t.stored.has('python')).toBe(false);
  });

  it('runs the languages side by side, each in its own order', async () => {
    const t = setup();
    t.saver.edit('python', 'p1');
    void t.saver.send('python');
    t.saver.edit('cpp', 'c1');
    void t.saver.send('cpp');
    expect(shown(t.open())).toEqual(['PUT python p1', 'PUT cpp c1']);
    await t.answer(1);
    await t.answer(0);
    expect(t.stored.size).toBe(0);
  });

  it('waits for an edit made during a request until it is asked to send it', async () => {
    const t = setup();
    t.saver.edit('python', 'v1');
    void t.saver.send('python');
    t.saver.edit('python', 'v2');
    await t.answer(0);
    // Typing goes on: v2 is kept here, and goes on the next send.
    expect(t.open()).toEqual([]);
    expect(t.stored.get('python')).toBe('v2');
    void t.saver.send('python');
    expect(shown(t.open())).toEqual(['PUT python v2']);
  });

  it('does not send code the server already holds', async () => {
    const t = setup();
    t.saver.seed([{ language: 'python', source: 'same', updatedAt: 'then' }]);
    t.saver.edit('python', 'same');
    await t.saver.send('python');
    expect(t.calls).toEqual([]);
    expect(t.stored.size).toBe(0);
    // Edited and edited back while a save was under way.
    t.saver.edit('python', 'other');
    void t.saver.send('python');
    t.saver.edit('python', 'same');
    void t.saver.send('python');
    await t.answer(0);
    expect(shown(t.calls)).toEqual(['PUT python other', 'PUT python same']);
  });

  it('keeps a failed edit here, says so, and sends it on the next attempt', async () => {
    const t = setup();
    const changes: boolean[] = [];
    t.saver.subscribe(() => changes.push(t.saver.failing));
    t.saver.edit('python', 'v1');
    void t.saver.send('python');
    await t.answer(0, down);
    expect(t.saver.failing).toBe(true);
    expect(t.saver.error).toBe(down);
    expect(t.stored.get('python')).toBe('v1');
    t.saver.edit('python', 'v2');
    void t.saver.sendAll();
    expect(shown(t.open())).toEqual(['PUT python v2']);
    await t.answer(1);
    expect(t.saver.failing).toBe(false);
    expect(t.stored.size).toBe(0);
    expect(changes).toEqual([true, false]);
  });

  it('sends every language with something waiting, one after the other, in the order asked', async () => {
    const t = setup();
    t.saver.edit('python', 'p');
    t.saver.edit('cpp', 'c');
    t.saver.edit('go', 'g');
    const all = t.saver.sendAll(['go', 'python']);
    expect(shown(t.open())).toEqual(['PUT go g']);
    await t.answer(0);
    expect(shown(t.open())).toEqual(['PUT python p']);
    await t.answer(1);
    expect(shown(t.open())).toEqual(['PUT cpp c']);
    await t.answer(2);
    await all;
  });

  it('deletes on a reset after the save under way, and keeps the starter here until then', async () => {
    const t = setup();
    t.saver.edit('python', 'mine');
    void t.saver.send('python');
    t.saver.reset('python', '# starter');
    expect(t.stored.get('python')).toBe('# starter');
    void t.saver.send('python');
    expect(shown(t.open())).toEqual(['PUT python mine']);
    await t.answer(0);
    expect(shown(t.open())).toEqual(['DELETE python']);
    await t.answer(1);
    expect(t.removed).toEqual(['python']);
    expect(t.stored.size).toBe(0);
    // And an edit after the reset comes after the delete.
    t.saver.edit('python', 'again');
    void t.saver.send('python');
    expect(shown(t.open())).toEqual(['PUT python again']);
  });

  it('writes the starter code when a reset cannot delete', async () => {
    const t = setup();
    t.saver.seed([{ language: 'python', source: 'mine', updatedAt: 'then' }]);
    t.saver.reset('python', '# starter');
    void t.saver.send('python');
    await t.answer(0, down);
    expect(t.saver.failing).toBe(true);
    expect(t.stored.get('python')).toBe('# starter');
    void t.saver.send('python');
    expect(shown(t.open())).toEqual(['PUT python # starter']);
  });

  it('sends a last save as one that outlives the page, and never beside one under way', async () => {
    const t = setup();
    t.saver.edit('python', 'v1');
    void t.saver.send('python', { keepalive: true });
    expect(t.calls[0]!.keepalive).toBe(true);
    t.saver.edit('python', 'v2');
    void t.saver.send('python', { keepalive: true });
    // v2 is kept here for the next opening rather than raced against v1.
    expect(t.open()).toHaveLength(1);
    expect(t.stored.get('python')).toBe('v2');
  });

  it('forgets the edits of an item that is gone', async () => {
    const t = setup();
    t.saver.edit('python', 'v1');
    void t.saver.send('python');
    await t.answer(0, new ApiError(404, 'not_found', 'item not found'));
    expect(t.saver.failing).toBe(false);
    expect(t.stored.size).toBe(0);
    expect(t.saver.unsent('python')).toBe(false);
  });

  it('keeps what it knows of a language with a save waiting when the server is read again', async () => {
    const t = setup();
    t.saver.edit('python', 'mine');
    t.saver.seed([{ language: 'python', source: 'mine', updatedAt: 'then' }]);
    void t.saver.send('python');
    // Seeding did not take "mine" as already saved: it is sent.
    expect(shown(t.open())).toEqual(['PUT python mine']);
    t.saver.seed([]);
    await t.answer(0);
    t.saver.edit('python', 'mine');
    await t.saver.send('python');
    expect(t.calls).toHaveLength(1);
  });

  it('keeps each edit with the time of the server copy it is based on, moved on by every save that lands', async () => {
    const t = setup();
    // Not read from the server: not known.
    t.saver.edit('go', 'g');
    expect(t.bases.get('go')).toBeUndefined();
    t.saver.seed([{ language: 'python', source: 'server', updatedAt: 'then' }]);
    t.saver.edit('python', 'v1');
    expect(t.bases.get('python')).toBe('then');
    t.saver.edit('cpp', 'c');
    expect(t.bases.get('cpp')).toBeNull();
    void t.saver.send('python');
    t.saver.edit('python', 'v2');
    expect(t.bases.get('python')).toBe('then');
    await t.answer(0);
    // v1 landed: v2, still waiting, is now based on it.
    expect([t.stored.get('python'), t.bases.get('python')]).toEqual(['v2', 't1']);
    t.saver.edit('python', 'v3');
    expect(t.bases.get('python')).toBe('t1');
  });

  it('bases a reset, and what follows a delete, on the copy as it then is', async () => {
    const t = setup();
    t.saver.seed([{ language: 'python', source: 'mine', updatedAt: 'then' }]);
    t.saver.reset('python', '# starter');
    expect(t.bases.get('python')).toBe('then');
    void t.saver.send('python');
    t.saver.edit('python', 'after');
    await t.answer(0);
    expect([t.stored.get('python'), t.bases.get('python')]).toEqual(['after', null]);
  });

  it('sends a reset\'s delete even where no copy is known', async () => {
    const t = setup();
    t.saver.seed([]);
    t.saver.reset('python', '');
    void t.saver.send('python');
    expect(shown(t.open())).toEqual(['DELETE python']);
  });
});
