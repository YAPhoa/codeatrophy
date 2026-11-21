import { QueryClient, type InfiniteData } from '@tanstack/react-query';
import { afterEach, describe, expect, it } from 'vitest';
import { patchItemsNow, qk, storeLinks } from './queries';
import type { Item, ItemFacets, ItemLinks, ItemSummary, LinkedItem, Page } from './types';

const summary = (id: string, over: Partial<ItemSummary> = {}): ItemSummary => ({
  id,
  type: 'problem',
  title: `Item ${id}`,
  summary: '',
  difficulty: null,
  tags: [],
  status: 'todo',
  favorite: false,
  collectionIds: [],
  variantOf: null,
  variantCount: 0,
  linkCount: 0,
  testCaseCount: 0,
  solutionCount: 0,
  lastVerdict: null,
  revision: 1,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  ...over,
});

let qc: QueryClient;

/** A cache holding the item `a` in every shape a list is kept in, next to `b` and `c`, and the detail of `a`. */
function seed() {
  qc = new QueryClient();
  const keys = {
    page: qk.itemPage({}, 50, 0),
    infinite: qk.itemQuery({ type: 'problem' }),
    array: [...qk.itemLists, 'related', 'a'],
    facets: qk.itemFacets({}),
    detail: qk.item('a'),
  };
  const data = {
    page: { items: [summary('a'), summary('b')], total: 2 } satisfies Page<ItemSummary>,
    infinite: { pages: [{ items: [summary('c')], total: 2 }, { items: [summary('a')], total: 2 }], pageParams: [0, 50] } satisfies InfiniteData<Page<ItemSummary>>,
    array: [summary('b'), summary('a')],
    facets: { byType: { problem: 2, reading: 0 }, byStatus: { todo: 2, in_progress: 0, done: 0 }, byDifficulty: { easy: 0, medium: 0, hard: 0, none: 2 }, byTag: {} } satisfies ItemFacets,
    detail: { ...summary('a'), body: 'b', notes: '', rawInput: null, source: { url: null, note: null }, problem: null, variantOrigin: null } as Item,
  };
  for (const name of Object.keys(keys) as (keyof typeof keys)[]) qc.setQueryData(keys[name], data[name]);
  const original = structuredClone(data);
  const read = () => Object.fromEntries(Object.entries(keys).map(([name, key]) => [name, qc.getQueryData(key)])) as typeof data;
  return { original, read };
}

afterEach(() => qc.clear());

describe('patchItemsNow', () => {
  it('shows the change in every cached shape of a list and in the item, leaving other items alone', async () => {
    const { original, read } = seed();
    await patchItemsNow(qc, ['a'], { status: 'done', favorite: true });
    const now = read();
    const a = (s: ItemSummary) => (s.id === 'a' ? { ...s, status: 'done', favorite: true } : s);
    expect(now.page).toEqual({ ...original.page, items: original.page.items.map(a) });
    expect(now.infinite).toEqual({ ...original.infinite, pages: original.infinite.pages.map((p) => ({ ...p, items: p.items.map(a) })) });
    expect(now.array).toEqual(original.array.map(a));
    expect(now.detail).toMatchObject({ status: 'done', favorite: true, body: 'b' });
    // The filter menus' counts share the prefix, and are left for the refresh.
    expect(now.facets).toEqual(original.facets);
  });

  it('patches several items at once', async () => {
    const { read } = seed();
    await patchItemsNow(qc, ['a', 'b', 'c'], { status: 'in_progress' });
    const now = read();
    expect([...now.page.items, ...now.infinite.pages.flatMap((p) => p.items), ...now.array].every((s) => s.status === 'in_progress')).toBe(true);
  });

  it('puts back exactly what was cached when the server rejects the change', async () => {
    const { original, read } = seed();
    const restore = await patchItemsNow(qc, ['a', 'b'], { favorite: true });
    expect(read().page.items.every((s) => s.favorite)).toBe(true);
    restore();
    expect(read()).toEqual(original);
  });
});

describe('storeLinks', () => {
  const linked = (id: string): LinkedItem => ({ id, available: true, title: `Item ${id}`, type: 'problem', status: 'todo', difficulty: null, linkedAt: null });

  it('stores the links of the item, shows its count at once, and fetches the other end again', async () => {
    const { read } = seed();
    qc.setQueryData<ItemLinks>(qk.links('b'), { links: [] });
    qc.setQueryData(qk.item('b'), { ...summary('b'), body: '', notes: '', rawInput: null, source: { url: null, note: null }, problem: null, variantOrigin: null } as Item);
    storeLinks(qc, 'a', 'b', [linked('b'), linked('c')]);
    expect(qc.getQueryData(qk.links('a'))).toEqual({ links: [linked('b'), linked('c')] });
    const now = read();
    expect(now.detail.linkCount).toBe(2);
    expect(now.page.items.map((i) => i.linkCount)).toEqual([2, 0]);
    expect(now.array.map((i) => i.linkCount)).toEqual([0, 2]);
    // The other item's count is not known here: it is fetched again, as are the lists.
    expect(qc.getQueryState(qk.links('b'))?.isInvalidated).toBe(true);
    expect(qc.getQueryState(qk.item('b'))?.isInvalidated).toBe(true);
    expect(qc.getQueryState(qk.itemPage({}, 50, 0))?.isInvalidated).toBe(true);
    expect(qc.getQueryState(qk.item('a'))?.isInvalidated).toBe(false);
  });

  it('keeps the links apart from the lists, so a list refresh leaves them be', () => {
    expect(qk.links('a').slice(0, qk.itemLists.length)).not.toEqual([...qk.itemLists]);
    expect(qk.links('a').slice(0, qk.items.length)).toEqual([...qk.items]);
  });
});
