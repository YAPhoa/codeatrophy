// TanStack Query bindings: query keys, read hooks, and the cache updates that
// keep lists and detail views consistent after a mutation.

import {
  keepPreviousData,
  queryOptions,
  useMutation,
  useQuery,
  useQueryClient,
  type InfiniteData,
  type QueryClient,
} from '@tanstack/react-query';
import { api } from './client';
import type { AiJob, AiLogFilters, DraftSummary, Item, ItemLinks, ItemListParams, ItemType, ItemStatus, ItemSummary, LinkedItem, Limits, List, Page, Preferences, PreferencesUpdate, WorkingCopy } from './types';

export const qk = {
  meta: ['meta'] as const,
  stats: ['stats'] as const,
  collections: ['collections'] as const,
  tags: ['tags'] as const,
  aiSettings: ['settings', 'ai'] as const,
  /** Prefix of everything cached from the AI activity log. */
  aiLog: ['settings', 'ai-log'] as const,
  aiLogPage: (filters: AiLogFilters, limit: number, offset: number) => ['settings', 'ai-log', 'page', filters, limit, offset] as const,
  aiLogEntry: (id: string) => ['settings', 'ai-log', 'entry', id] as const,
  styles: ['styles'] as const,
  systemPrompt: ['settings', 'system-prompt'] as const,
  testCasePrompt: ['settings', 'testcase-prompt'] as const,
  items: ['items'] as const,
  /** Prefix of every cached item list, whatever its shape, and of the counts of the filter menus. */
  itemLists: ['items', 'list'] as const,
  itemFacets: (params: ItemListParams) => ['items', 'list', 'facets', params] as const,
  itemPage: (params: ItemListParams, limit: number, offset: number) => ['items', 'list', 'page', params, limit, offset] as const,
  itemQuery: (params: ItemListParams) => ['items', 'list', 'query', params] as const,
  item: (id: string) => ['items', 'detail', id] as const,
  /** The items linked to an item. Under `items`, so whatever refreshes the library (a delete) refreshes them too. */
  links: (id: string) => ['items', 'links', id] as const,
  testCases: (itemId: string) => ['testcases', itemId] as const,
  solutions: (itemId: string) => ['solutions', itemId] as const,
  /** A problem's working copies. Outside `items`, so refreshing the library never refetches them under an open editor. */
  workspace: (itemId: string) => ['workspace', itemId] as const,
  preferences: ['settings', 'preferences'] as const,
  submissions: (itemId: string) => ['submissions', 'list', itemId] as const,
  submission: (id: string) => ['submissions', 'detail', id] as const,
  /** The jobs whose outcome has not been collected: what the sidebar's AI jobs list. */
  aiJobs: ['ai-jobs', 'list'] as const,
  /** Prefix of every cached job lookup, the list included. */
  aiJobsAll: ['ai-jobs'] as const,
  drafts: ['drafts', 'list'] as const,
  draft: (id: string) => ['drafts', 'detail', id] as const,
  /** Prefix of everything cached about drafts. */
  draftsAll: ['drafts'] as const,
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

/**
 * The filter menus' counts for a view. Kept under the lists' key, so whatever
 * refreshes the lists refreshes them too; the counts before stay shown while
 * new ones load.
 */
export function useItemFacets(params: ItemListParams) {
  const { sort: _sort, order: _order, limit: _limit, offset: _offset, ...filters } = params;
  return useQuery({
    queryKey: qk.itemFacets(filters),
    queryFn: ({ signal }) => api.items.facets(filters, signal),
    placeholderData: (prev) => prev,
    staleTime: 10_000,
  });
}

/** One page of the library; the page before stays shown while the next loads. */
export function useItemPage(params: ItemListParams, limit: number, offset: number) {
  return useQuery({
    queryKey: qk.itemPage(params, limit, offset),
    queryFn: ({ signal }) => api.items.list({ ...params, limit, offset }, signal),
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

/** How an item is loaded: shared by `useItem` and `prefetchItem`, so the two cannot drift apart. */
export function itemQuery(id: string) {
  return queryOptions({
    queryKey: qk.item(id),
    queryFn: ({ signal }) => api.items.get(id, signal),
  });
}

export function useItem(id: string | undefined) {
  return useQuery({ ...itemQuery(id ?? ''), enabled: !!id });
}

/**
 * Load what an item's page opens with, ahead of opening it (the pointer
 * rests on its row): the item, and a problem's test cases and working
 * copies. A copy younger
 * than this is kept, so resting on the same row again asks for nothing.
 */
const PREFETCH_FRESH_MS = 30_000;

export function prefetchItem(qc: QueryClient, id: string, type: ItemType): void {
  void qc.prefetchQuery({ ...itemQuery(id), staleTime: PREFETCH_FRESH_MS });
  if (type === 'problem') {
    void qc.prefetchQuery({ ...testCasesQuery(id), staleTime: PREFETCH_FRESH_MS });
    void qc.prefetchQuery({ ...workspaceQuery(id), staleTime: PREFETCH_FRESH_MS });
  }
}

/**
 * How a problem's working copies are loaded: shared by `useWorkspace` and
 * `prefetchItem`. The editor reads them once, as it opens, and keeps this
 * copy up to date with its own saves (`setWorkingCopy`); it never refetches
 * them under an open editor.
 */
export function workspaceQuery(itemId: string) {
  return queryOptions({
    queryKey: qk.workspace(itemId),
    queryFn: ({ signal }) => api.workspace.list(itemId, signal),
    staleTime: PREFETCH_FRESH_MS,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
}

export function useWorkspace(itemId: string, enabled = true) {
  return useQuery({ ...workspaceQuery(itemId), enabled });
}

/** How often a submission still being judged is read again. */
export const SUBMISSION_POLL_MS = 700;

/**
 * How a submission is loaded: shared by the drawer's latest run and a past
 * submission's details. Once judged it never changes, so it is never read
 * again on its own; each caller says when to poll.
 */
export function submissionQuery(id: string) {
  return queryOptions({
    queryKey: qk.submission(id),
    queryFn: ({ signal }) => api.submissions.get(id, signal),
    refetchOnWindowFocus: false,
    staleTime: Infinity,
  });
}

/**
 * Record a save of the editor in the cached working copies: `copy` written,
 * or a language's copy `removed`. A read under way may have been answered
 * before the save, so it is made again rather than let it put back what the
 * save replaced.
 */
export function setWorkingCopy(qc: QueryClient, itemId: string, change: { copy: WorkingCopy } | { removed: string }): void {
  const key = qk.workspace(itemId);
  qc.setQueryData<List<WorkingCopy>>(key, (prev) => {
    if (!prev) return prev;
    const language = 'copy' in change ? change.copy.language : change.removed;
    const others = prev.items.filter((w) => w.language !== language);
    return { items: 'copy' in change ? [change.copy, ...others] : others };
  });
  if (qc.getQueryState(key)?.fetchStatus === 'fetching') void qc.refetchQueries({ queryKey: key });
}

/** How a problem's test cases are loaded: shared by `useTestCases` and `prefetchItem`. */
export function testCasesQuery(itemId: string) {
  return queryOptions({
    queryKey: qk.testCases(itemId),
    queryFn: ({ signal }) => api.testCases.list(itemId, signal),
  });
}

export function useTestCases(itemId: string, enabled = true) {
  return useQuery({ ...testCasesQuery(itemId), select: (data) => data.items, enabled });
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
  largeTestCase: false,
  largeTestCaseCount: 3,
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

/**
 * How many large test cases to ask for when they are asked for: the
 * preference, within the server's bound.
 */
export function useLargeTestCaseCount(): number {
  const count = usePreferences().largeTestCaseCount;
  const max = useLimits()?.maxLargeTestCases ?? Infinity;
  return Math.min(max, Math.max(1, count));
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

/** A problem's submission history: submits only, since only the latest run is kept. */
export function useSubmissionList(itemId: string, enabled = true) {
  return useQuery({
    queryKey: qk.submissions(itemId),
    queryFn: ({ signal }) => api.submissions.list(itemId, { mode: 'submit', limit: 50 }, signal),
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

export function useSystemPrompt() {
  return useQuery({ queryKey: qk.systemPrompt, queryFn: ({ signal }) => api.settings.systemPrompt(signal) });
}

export function useTestCasePrompt() {
  return useQuery({ queryKey: qk.testCasePrompt, queryFn: ({ signal }) => api.settings.testCasePrompt(signal) });
}

/** The AI settings; `enabled: false` waits (the shell keeps them loaded while AI is on). */
export function useAiSettings(enabled = true) {
  return useQuery({ queryKey: qk.aiSettings, queryFn: ({ signal }) => api.settings.getAi(signal), enabled });
}

/** A numbered page of the AI activity log, newest first; the page before stays shown while the next loads. */
export function useAiLog(filters: AiLogFilters, limit: number, offset: number) {
  return useQuery({
    queryKey: qk.aiLogPage(filters, limit, offset),
    queryFn: ({ signal }) => api.settings.log({ ...filters, limit, offset }, signal),
    placeholderData: keepPreviousData,
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
    if ('pages' in data) return { ...data, pages: data.pages.map(apply) };
    // The filter menus' counts share the prefix; they refresh on invalidation.
    return 'items' in data ? apply(data) : data;
  };
  qc.setQueriesData<ListData>({ queryKey: qk.itemLists }, update);
  qc.setQueryData<Item>(qk.item(id), (item) => (item ? { ...item, ...change } : item));
}

/**
 * Show a change to items' personal state (status, favorite) at once, before
 * the server has it (`useQuickUpdate` does so for one); returns what to
 * restore if the server rejects it.
 */
export async function patchItemsNow(qc: QueryClient, ids: readonly string[], change: Partial<ItemSummary>): Promise<() => void> {
  await qc.cancelQueries({ queryKey: qk.items });
  const snapshot = qc.getQueriesData<unknown>({ queryKey: qk.items });
  for (const id of ids) patchLists(qc, id, change);
  return () => {
    for (const [key, data] of snapshot) qc.setQueryData(key, data);
  };
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
    onMutate: async ({ id, change }) => ({ restore: await patchItemsNow(qc, [id], change) }),
    onError: (_err, _vars, ctx) => ctx?.restore(),
    onSuccess: (item) => {
      qc.setQueryData(qk.item(item.id), item);
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: qk.itemLists });
      void qc.invalidateQueries({ queryKey: qk.stats });
    },
  });
}

/** The items linked to an item: live ones first, then those no longer in the library. */
export function useItemLinks(id: string, enabled = true) {
  return useQuery({
    queryKey: qk.links(id),
    queryFn: ({ signal }) => api.items.links.list(id, signal),
    select: (data) => data.links,
    enabled,
  });
}

/**
 * Keep the cache in step with a link between `id` and `otherId` made or
 * removed: `links` is what `id` is linked to now. Its count shows at once;
 * the other item's links and count, and the lists, are fetched again.
 * Neither item's revision moves.
 */
export function storeLinks(qc: QueryClient, id: string, otherId: string, links: LinkedItem[]): void {
  qc.setQueryData<ItemLinks>(qk.links(id), { links });
  patchLists(qc, id, { linkCount: links.length });
  void qc.invalidateQueries({ queryKey: qk.links(otherId) });
  void qc.invalidateQueries({ queryKey: qk.item(otherId) });
  void qc.invalidateQueries({ queryKey: qk.itemLists });
}

/** Link another item to `id`. */
export function useLinkItem(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (otherId: string) => api.items.links.add(id, otherId),
    onSuccess: (data, otherId) => storeLinks(qc, id, otherId, data.links),
  });
}

/**
 * Remove the link between `id` and another item. The row goes at once and
 * comes back if the server refuses.
 */
export function useUnlinkItem(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (otherId: string) => api.items.links.remove(id, otherId),
    onMutate: async (otherId) => {
      await qc.cancelQueries({ queryKey: qk.links(id) });
      const previous = qc.getQueryData<ItemLinks>(qk.links(id));
      if (previous) qc.setQueryData<ItemLinks>(qk.links(id), { links: previous.links.filter((l) => l.id !== otherId) });
      return { previous };
    },
    onError: (_err, _otherId, ctx) => {
      if (ctx?.previous) qc.setQueryData(qk.links(id), ctx.previous);
    },
    onSuccess: (_data, otherId) => {
      const now = qc.getQueryData<ItemLinks>(qk.links(id));
      if (now) storeLinks(qc, id, otherId, now.links);
      else {
        void qc.invalidateQueries({ queryKey: qk.links(id) });
        void qc.invalidateQueries({ queryKey: qk.item(id) });
        void qc.invalidateQueries({ queryKey: qk.links(otherId) });
        void qc.invalidateQueries({ queryKey: qk.item(otherId) });
        void qc.invalidateQueries({ queryKey: qk.itemLists });
      }
    },
  });
}

/** Whether a job is still waiting or running. */
export const isActiveJob = (job: Pick<AiJob, 'status'>): boolean => job.status === 'queued' || job.status === 'running';

/**
 * The AI jobs whose outcome has not been collected, newest first. Polled every
 * two seconds while one is active; otherwise every few seconds while `watching`
 * (the AI jobs list is open), and else only when asked.
 */
export function useAiJobs(watching = false) {
  return useQuery({
    queryKey: qk.aiJobs,
    queryFn: ({ signal }) => api.ai.jobs({ limit: 50 }, signal),
    select: (data) => data.items,
    refetchInterval: (query) => (query.state.data?.items.some(isActiveJob) ? 2000 : watching ? 5000 : false),
  });
}

/** The drafts, most recently changed first; polled while one of them is being drafted. */
export function useDrafts() {
  return useQuery({
    queryKey: qk.drafts,
    queryFn: ({ signal }) => api.drafts.list({}, signal),
    select: (data) => data.items,
    refetchInterval: (query) => (query.state.data?.items.some((d: DraftSummary) => d.state === 'drafting') ? 2000 : false),
  });
}

/** Something started or ended a generation: the AI jobs and the drafts look again. */
export function invalidateJobs(qc: QueryClient): Promise<unknown> {
  return Promise.all([qc.invalidateQueries({ queryKey: qk.aiJobsAll }), qc.invalidateQueries({ queryKey: qk.drafts })]);
}
