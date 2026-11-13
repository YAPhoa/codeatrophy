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
import type { AiLogFilters, Item, ItemListParams, ItemStatus, ItemSummary, Limits, Page, Preferences, PreferencesUpdate } from './types';

export const PAGE_SIZE = 50;

export const qk = {
  meta: ['meta'] as const,
  stats: ['stats'] as const,
  collections: ['collections'] as const,
  tags: ['tags'] as const,
  aiSettings: ['settings', 'ai'] as const,
  /** Prefix of everything cached from the AI activity log. */
  aiLog: ['settings', 'ai-log'] as const,
  aiLogPages: (filters: AiLogFilters) => ['settings', 'ai-log', 'pages', filters] as const,
  aiLogEntry: (id: string) => ['settings', 'ai-log', 'entry', id] as const,
  styles: ['styles'] as const,
  items: ['items'] as const,
  /** Prefix of every cached item list, whatever its shape. */
  itemLists: ['items', 'list'] as const,
  itemPages: (params: ItemListParams) => ['items', 'list', 'pages', params] as const,
  itemQuery: (params: ItemListParams) => ['items', 'list', 'query', params] as const,
  item: (id: string) => ['items', 'detail', id] as const,
  testCases: (itemId: string) => ['testcases', itemId] as const,
  solutions: (itemId: string) => ['solutions', itemId] as const,
  preferences: ['settings', 'preferences'] as const,
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

export function useSolutions(itemId: string, enabled = true) {
  return useQuery({
    queryKey: qk.solutions(itemId),
    queryFn: ({ signal }) => api.solutions.list(itemId, signal),
    select: (data) => data.items,
    enabled,
  });
}

/** What the server uses until the user changes something (docs/api.md, "Preferences"). */
export const DEFAULT_PREFERENCES: Preferences = {
  hideTestCases: true,
  generatedTestCases: 8,
  editor: { autocomplete: true, closeBrackets: true, matchBrackets: true, lineWrapping: false, tabSize: 4, fontSize: 14 },
};

/**
 * The user's preferences. Until they have loaded (and if they cannot be
 * loaded) the defaults apply, so nothing waits on them.
 */
export function usePreferences(): Preferences {
  const query = useQuery({ queryKey: qk.preferences, queryFn: ({ signal }) => api.preferences.get(signal), staleTime: 60_000, select: withDefaults });
  return query.data ?? DEFAULT_PREFERENCES;
}

/** A server that does not know a preference yet leaves it out; its default then applies. */
const withDefaults = (saved: Preferences): Preferences => ({ ...DEFAULT_PREFERENCES, ...saved });

/** Change preferences. The change applies at once and is rolled back if the server rejects it. */
export function useUpdatePreferences() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (change: PreferencesUpdate) => api.preferences.put(change),
    onMutate: async (change) => {
      await qc.cancelQueries({ queryKey: qk.preferences });
      const previous = qc.getQueryData<Preferences>(qk.preferences);
      const base = previous ?? DEFAULT_PREFERENCES;
      qc.setQueryData<Preferences>(qk.preferences, { ...base, ...change, editor: { ...base.editor, ...change.editor } });
      return { previous };
    },
    onError: (_err, _change, ctx) => {
      qc.setQueryData(qk.preferences, ctx?.previous);
    },
    onSuccess: (saved) => {
      qc.setQueryData(qk.preferences, saved);
    },
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

/** The AI activity log, newest first, loaded a batch at a time as the user reaches the end. */
export function useAiLog(filters: AiLogFilters) {
  return useInfiniteQuery({
    queryKey: qk.aiLogPages(filters),
    queryFn: ({ pageParam, signal }) => api.settings.log({ ...filters, limit: PAGE_SIZE, before: pageParam ?? undefined }, signal),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.next ?? undefined,
  });
}

/**
 * One entry of the log with its raw request and response. It is fetched when
 * the entry is opened and dropped as soon as nothing shows it any more: the
 * texts are large, and the list can be long.
 */
export function useAiLogEntry(id: string) {
  return useQuery({ queryKey: qk.aiLogEntry(id), queryFn: ({ signal }) => api.settings.logEntry(id, signal), retry: false, gcTime: 0 });
}

/** The limits published by `GET /meta`, or `undefined` until it has loaded (the app shell waits for it). */
export function useLimits(): Limits | undefined {
  return useMeta().data?.limits;
}

/** Refresh the AI providers and what `GET /meta` says about the one in use. */
export function invalidateAi(qc: QueryClient): Promise<unknown> {
  return Promise.all([qc.invalidateQueries({ queryKey: qk.aiSettings }), qc.invalidateQueries({ queryKey: qk.meta })]);
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
