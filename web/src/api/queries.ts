// TanStack Query bindings: query keys, read hooks, and the cache updates that
// keep lists and detail views consistent after a mutation.

import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type InfiniteData,
  type QueryClient,
} from '@tanstack/react-query';
import { api } from './client';
import type { Item, ItemListParams, ItemStatus, ItemSummary, Limits, Page } from './types';

export const PAGE_SIZE = 50;

export const qk = {
  meta: ['meta'] as const,
  stats: ['stats'] as const,
  collections: ['collections'] as const,
  tags: ['tags'] as const,
  aiSettings: ['settings', 'ai'] as const,
  styles: ['styles'] as const,
  items: ['items'] as const,
  /** Prefix of every cached item list, whatever its shape. */
  itemLists: ['items', 'list'] as const,
  itemPages: (params: ItemListParams) => ['items', 'list', 'pages', params] as const,
  itemQuery: (params: ItemListParams) => ['items', 'list', 'query', params] as const,
  item: (id: string) => ['items', 'detail', id] as const,
  testCases: (itemId: string) => ['testcases', itemId] as const,
  submissions: (itemId: string) => ['submissions', 'list', itemId] as const,
  submission: (id: string) => ['submissions', 'detail', id] as const,
};

export function useMeta() {
  return useQuery({
    queryKey: qk.meta,
    queryFn: ({ signal }) => api.meta(signal),
    staleTime: 20_000,
    // Judge health is probed by the server and can change without any action here.
    refetchInterval: 60_000,
  });
}

export function useStats() {
  return useQuery({ queryKey: qk.stats, queryFn: ({ signal }) => api.stats(signal), staleTime: 10_000 });
}

export function useCollections() {
  return useQuery({
    queryKey: qk.collections,
    queryFn: ({ signal }) => api.collections.list(signal),
    select: (data) => data.items,
    staleTime: 10_000,
  });
}

export function useTags() {
  return useQuery({
    queryKey: qk.tags,
    queryFn: ({ signal }) => api.tags.list(signal),
    select: (data) => data.items,
    staleTime: 10_000,
  });
}

/** Paged item list for the library ("load more"). */
export function useItemPages(params: ItemListParams, enabled = true) {
  return useInfiniteQuery({
    queryKey: qk.itemPages(params),
    queryFn: ({ pageParam, signal }) => api.items.list({ ...params, limit: PAGE_SIZE, offset: pageParam }, signal),
    initialPageParam: 0,
    getNextPageParam: (last, pages) => {
      const loaded = pages.reduce((n, p) => n + p.items.length, 0);
      return loaded < last.total && last.items.length > 0 ? loaded : undefined;
    },
    enabled,
    placeholderData: (prev) => prev,
  });
}

/** A single bounded item query (variants of an item, palette search, …). */
export function useItemQuery(params: ItemListParams, enabled = true) {
  return useQuery({
    queryKey: qk.itemQuery(params),
    queryFn: ({ signal }) => api.items.list(params, signal),
    enabled,
    placeholderData: (prev) => prev,
  });
}

export function useItem(id: string | undefined) {
  return useQuery({
    queryKey: qk.item(id ?? ''),
    queryFn: ({ signal }) => api.items.get(id ?? '', signal),
    enabled: !!id,
  });
}

export function useTestCases(itemId: string, enabled = true) {
  return useQuery({
    queryKey: qk.testCases(itemId),
    queryFn: ({ signal }) => api.testCases.list(itemId, signal),
    select: (data) => data.items,
    enabled,
  });
}

export function useSubmissionList(itemId: string, enabled = true) {
  return useQuery({
    queryKey: qk.submissions(itemId),
    queryFn: ({ signal }) => api.submissions.list(itemId, { limit: 50 }, signal),
    enabled,
  });
}

export function useStyles(enabled = true) {
  return useQuery({
    queryKey: qk.styles,
    queryFn: ({ signal }) => api.styles.list(signal),
    select: (data) => data.items,
    staleTime: 10_000,
    enabled,
  });
}

export function useAiSettings() {
  return useQuery({ queryKey: qk.aiSettings, queryFn: ({ signal }) => api.settings.getAi(signal) });
}

/** The limits published by `GET /meta`, or `undefined` until it has loaded (the app shell waits for it). */
export function useLimits(): Limits | undefined {
  return useMeta().data?.limits;
}

/** Refresh everything derived from the set of items: lists, counts, collections and tags. */
export function invalidateLibrary(qc: QueryClient): Promise<unknown> {
  return Promise.all([
    qc.invalidateQueries({ queryKey: qk.items }),
    qc.invalidateQueries({ queryKey: qk.collections }),
    qc.invalidateQueries({ queryKey: qk.tags }),
    qc.invalidateQueries({ queryKey: qk.stats }),
  ]);
}

// The shapes an item list is cached in: paged, single page, or a plain array.
type ListData = InfiniteData<Page<ItemSummary>> | Page<ItemSummary> | ItemSummary[] | undefined;

function patchLists(qc: QueryClient, id: string, change: Partial<ItemSummary>): void {
  const one = (it: ItemSummary): ItemSummary => (it.id === id ? { ...it, ...change } : it);
  const apply = (page: Page<ItemSummary>): Page<ItemSummary> => ({ ...page, items: page.items.map(one) });
  const update = (data: ListData): ListData => {
    if (!data) return data;
    if (Array.isArray(data)) return data.map(one);
    return 'pages' in data ? { ...data, pages: data.pages.map(apply) } : apply(data);
  };
  qc.setQueriesData<ListData>({ queryKey: qk.itemLists }, update);
  qc.setQueryData<Item>(qk.item(id), (item) => (item ? { ...item, ...change } : item));
}

/** Put a freshly returned item into the cache and refresh the lists that may show it. */
export function storeItem(qc: QueryClient, item: Item): void {
  qc.setQueryData(qk.item(item.id), item);
  void qc.invalidateQueries({ queryKey: qk.itemLists });
  void qc.invalidateQueries({ queryKey: qk.tags });
  void qc.invalidateQueries({ queryKey: qk.stats });
  void qc.invalidateQueries({ queryKey: qk.collections });
}

/**
 * Change an item's personal state (status, favorite) from anywhere. The
 * change shows immediately and is rolled back if the server rejects it.
 * Personal state does not affect the item's revision, so no
 * `expectedRevision` is sent.
 */
export function useQuickUpdate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, change }: { id: string; change: { status?: ItemStatus; favorite?: boolean } }) =>
      api.items.update(id, change),
    onMutate: async ({ id, change }) => {
      await qc.cancelQueries({ queryKey: qk.items });
      const snapshot = qc.getQueriesData<unknown>({ queryKey: qk.items });
      patchLists(qc, id, change);
      return { snapshot };
    },
    onError: (_err, _vars, ctx) => {
      for (const [key, data] of ctx?.snapshot ?? []) qc.setQueryData(key, data);
    },
    onSuccess: (item) => {
      qc.setQueryData(qk.item(item.id), item);
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: qk.itemLists });
      void qc.invalidateQueries({ queryKey: qk.stats });
    },
  });
}
