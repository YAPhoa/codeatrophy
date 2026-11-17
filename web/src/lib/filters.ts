// The library's filter state lives in the URL so that views can be
// bookmarked and the back button works. This module converts between the URL,
// the in-memory filter object and the API's query parameters.

import type { Difficulty, ItemListParams, ItemSort, ItemStatus, ItemType, SortOrder } from '../api/types';

export interface LibraryFilters {
  q: string;
  type: ItemType | null;
  status: ItemStatus[];
  difficulty: (Difficulty | 'none')[];
  tags: string[];
  favorite: boolean;
  uncollected: boolean;
  /** In a collection view: also show items of nested collections. */
  recursive: boolean;
  /** `null` means "the default for this view". */
  sort: ItemSort | null;
  order: SortOrder | null;
}

export const EMPTY_FILTERS: LibraryFilters = {
  q: '',
  type: null,
  status: [],
  difficulty: [],
  tags: [],
  favorite: false,
  uncollected: false,
  recursive: false,
  sort: null,
  order: null,
};

const TYPES: readonly string[] = ['problem', 'reading'];
const STATUSES: readonly string[] = ['todo', 'in_progress', 'done'];
const DIFFS: readonly string[] = ['easy', 'medium', 'hard', 'none'];
const SORTS: readonly string[] = ['updated', 'created', 'title', 'difficulty', 'position', 'relevance'];

const uniq = <T,>(list: T[]): T[] => Array.from(new Set(list));

export function parseFilters(sp: URLSearchParams): LibraryFilters {
  const type = sp.get('type');
  const sort = sp.get('sort');
  const order = sp.get('order');
  return {
    q: sp.get('q') ?? '',
    type: type && TYPES.includes(type) ? (type as ItemType) : null,
    status: uniq(sp.getAll('status').filter((s) => STATUSES.includes(s))) as ItemStatus[],
    difficulty: uniq(sp.getAll('difficulty').filter((d) => DIFFS.includes(d))) as (Difficulty | 'none')[],
    tags: uniq(sp.getAll('tag').map((t) => t.trim().toLowerCase()).filter(Boolean)),
    favorite: sp.get('favorite') === 'true',
    uncollected: sp.get('uncollected') === 'true',
    recursive: sp.get('recursive') === 'true',
    sort: sort && SORTS.includes(sort) ? (sort as ItemSort) : null,
    order: order === 'asc' || order === 'desc' ? order : null,
  };
}

/** Serialise filters for the URL, leaving out everything that is at its default. */
export function filtersToSearch(f: LibraryFilters): URLSearchParams {
  const sp = new URLSearchParams();
  if (f.q.trim()) sp.set('q', f.q.trim());
  if (f.type) sp.set('type', f.type);
  for (const s of f.status) sp.append('status', s);
  for (const d of f.difficulty) sp.append('difficulty', d);
  for (const t of f.tags) sp.append('tag', t);
  if (f.favorite) sp.set('favorite', 'true');
  if (f.uncollected) sp.set('uncollected', 'true');
  if (f.recursive) sp.set('recursive', 'true');
  if (f.sort) sp.set('sort', f.sort);
  if (f.order) sp.set('order', f.order);
  return sp;
}

export function defaultOrder(sort: ItemSort): SortOrder {
  return sort === 'updated' || sort === 'created' ? 'desc' : 'asc';
}

/**
 * The two directions of a sort, named for what they mean for its field, the
 * default first; `null` for sorts that have no direction (a collection's own
 * order, relevance). Items without a difficulty come last either way.
 */
export function sortDirections(sort: ItemSort): { order: SortOrder; label: string }[] | null {
  switch (sort) {
    case 'updated':
    case 'created':
      return [
        { order: 'desc', label: 'Newest first' },
        { order: 'asc', label: 'Oldest first' },
      ];
    case 'title':
      return [
        { order: 'asc', label: 'A → Z' },
        { order: 'desc', label: 'Z → A' },
      ];
    case 'difficulty':
      return [
        { order: 'asc', label: 'Easiest first' },
        { order: 'desc', label: 'Hardest first' },
      ];
    case 'position':
    case 'relevance':
      return null;
  }
}

/**
 * What a library view lists, as its filter box names it: a Problems or
 * Readings view, or items anywhere else (all items, Favorites, Uncollected,
 * a collection), whatever the type filter says there.
 */
export function viewNoun(f: LibraryFilters, collectionId: string | null): 'problems' | 'readings' | 'items' {
  if (collectionId || f.favorite || f.uncollected) return 'items';
  return f.type === 'problem' ? 'problems' : f.type === 'reading' ? 'readings' : 'items';
}

/**
 * The sort actually used for a view. `relevance` needs a search query and
 * `position` needs a single (non-recursive) collection; when a remembered
 * choice is no longer valid the view falls back to its default.
 */
export function effectiveSort(f: LibraryFilters, collectionId: string | null): ItemSort {
  const hasQuery = f.q.trim() !== '';
  const canPosition = collectionId != null && !f.recursive;
  if (f.sort === 'relevance') return hasQuery ? 'relevance' : canPosition ? 'position' : 'updated';
  if (f.sort === 'position') return canPosition ? 'position' : 'updated';
  if (f.sort) return f.sort;
  if (hasQuery) return 'relevance';
  return canPosition ? 'position' : 'updated';
}

export function toListParams(f: LibraryFilters, collectionId: string | null): ItemListParams {
  const sort = effectiveSort(f, collectionId);
  const params: ItemListParams = { sort };
  if (f.order && f.order !== defaultOrder(sort)) params.order = f.order;
  if (f.q.trim()) params.q = f.q.trim();
  if (f.type) params.type = f.type;
  if (f.status.length) params.status = f.status;
  if (f.difficulty.length) params.difficulty = f.difficulty;
  if (f.tags.length) params.tag = f.tags;
  if (f.favorite) params.favorite = true;
  if (collectionId) {
    params.collectionId = collectionId;
    if (f.recursive) params.recursive = true;
  } else if (f.uncollected) {
    params.uncollected = true;
  }
  return params;
}

/** Number of narrowing filters in effect (sort and the collection itself do not count). */
export function activeFilterCount(f: LibraryFilters): number {
  return (
    (f.q.trim() ? 1 : 0) +
    (f.type ? 1 : 0) +
    (f.status.length ? 1 : 0) +
    (f.difficulty.length ? 1 : 0) +
    (f.tags.length ? 1 : 0) +
    (f.favorite ? 1 : 0) +
    (f.uncollected ? 1 : 0)
  );
}

/**
 * Filters set in the library's filter bar. The type, Favorites and
 * Uncollected are views picked in the sidebar, so the bar neither counts nor
 * clears them.
 */
export function barFilterCount(f: LibraryFilters): number {
  return (f.q.trim() ? 1 : 0) + (f.status.length ? 1 : 0) + (f.difficulty.length ? 1 : 0) + (f.tags.length ? 1 : 0);
}

export function clearBarFilters(f: LibraryFilters): LibraryFilters {
  return { ...f, q: '', status: [], difficulty: [], tags: [] };
}

/** Manual ordering only makes sense when the list is the whole collection in its own order. */
export function canReorder(f: LibraryFilters, collectionId: string | null): boolean {
  return (
    collectionId != null &&
    effectiveSort(f, collectionId) === 'position' &&
    (f.order ?? 'asc') === 'asc' &&
    activeFilterCount(f) === 0
  );
}

export function toggleIn<T>(list: readonly T[], value: T): T[] {
  return list.includes(value) ? list.filter((v) => v !== value) : [...list, value];
}
