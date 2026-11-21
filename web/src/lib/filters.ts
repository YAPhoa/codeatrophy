// The library's filter state lives in the URL so that views can be
// bookmarked and the back button works. This module converts between the URL,
// the in-memory filter object and the API's query parameters. The view
// itself is the path (libraryPaths.ts); the filters carry what it fixes (the
// type of Problems and Readings, Favorites) so the rules below read one object.

import type { Difficulty, ItemListParams, ItemSort, ItemStatus, ItemType, SortOrder } from '../api/types';
import type { LibraryRoute } from './libraryPaths';

export interface LibraryFilters {
  q: string;
  type: ItemType | null;
  status: ItemStatus[];
  difficulty: (Difficulty | 'none')[];
  tags: string[];
  /** The Favorites view. */
  favorite: boolean;
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
  recursive: false,
  sort: null,
  order: null,
};

const TYPES: readonly string[] = ['problem', 'reading'];
const STATUSES: readonly string[] = ['todo', 'in_progress', 'done'];
const DIFFS: readonly string[] = ['easy', 'medium', 'hard', 'none'];
const SORTS: readonly string[] = ['updated', 'created', 'title', 'difficulty', 'position', 'relevance'];

const uniq = <T,>(list: T[]): T[] => Array.from(new Set(list));

/**
 * The filters of the library view at `view`'s path. The path fixes the type
 * of Problems and Readings and makes Favorites; the URL's `type` counts only
 * where the filter bar picks it (Favorites, a collection), and a `favorite`
 * in it never does.
 */
export function parseFilters(sp: URLSearchParams, view: LibraryRoute['view'] = 'all'): LibraryFilters {
  const type = view === 'problem' || view === 'reading' ? view : view === 'favorite' || view === 'collection' ? sp.get('type') : null;
  const sort = sp.get('sort');
  const order = sp.get('order');
  return {
    q: sp.get('q') ?? '',
    type: type && TYPES.includes(type) ? (type as ItemType) : null,
    status: uniq(sp.getAll('status').filter((s) => STATUSES.includes(s))) as ItemStatus[],
    difficulty: uniq(sp.getAll('difficulty').filter((d) => DIFFS.includes(d))) as (Difficulty | 'none')[],
    tags: uniq(sp.getAll('tag').map((t) => t.trim().toLowerCase()).filter(Boolean)),
    favorite: view === 'favorite',
    recursive: sp.get('recursive') === 'true',
    sort: sort && SORTS.includes(sort) ? (sort as ItemSort) : null,
    order: order === 'asc' || order === 'desc' ? order : null,
  };
}

/**
 * Serialise filters for the URL, leaving out everything that is at its
 * default and what the path already says (the view, and the type where the
 * filter bar does not pick it).
 */
export function filtersToSearch(f: LibraryFilters, collectionId: string | null): URLSearchParams {
  const sp = new URLSearchParams();
  if (f.q.trim()) sp.set('q', f.q.trim());
  if (f.type && typeInBar(f, collectionId)) sp.set('type', f.type);
  for (const s of f.status) sp.append('status', s);
  for (const d of f.difficulty) sp.append('difficulty', d);
  for (const t of f.tags) sp.append('tag', t);
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

/** A direction of a sort as words for a sentence: "newest first", "A to Z". */
export function directionText(sort: ItemSort, order: SortOrder): string | null {
  const label = sortDirections(sort)?.find((d) => d.order === order)?.label;
  return label ? label.replace(' → ', ' to ').replace(/^[A-Z](?=[a-z])/, (c) => c.toLowerCase()) : null;
}

/** The columns whose names in the list's head sort it. */
export type SortColumn = 'title' | 'difficulty' | 'updated';

/**
 * The filters after a click on a column's name: the list sorts by it in its
 * natural direction, then the other way, then goes back to the view's own
 * order (by update, by relevance while searching, or a collection's own).
 */
export function nextColumnSort(f: LibraryFilters, collectionId: string | null, column: SortColumn): LibraryFilters {
  const sort = effectiveSort(f, collectionId);
  const order = f.order ?? defaultOrder(sort);
  if (sort !== column) return { ...f, sort: column, order: null };
  if (order === defaultOrder(column)) return { ...f, sort: column, order: order === 'asc' ? 'desc' : 'asc' };
  return { ...f, sort: null, order: null };
}

/**
 * What a library view lists, as its filter box names it: a Problems or
 * Readings view, or items anywhere else (all items, Favorites, a
 * collection), whatever the type filter says there.
 */
export function viewNoun(f: LibraryFilters, collectionId: string | null): 'problems' | 'readings' | 'items' {
  if (collectionId || f.favorite) return 'items';
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
    (f.favorite ? 1 : 0)
  );
}

/**
 * Whether the filter bar picks the type in this view: in a collection and in
 * Favorites. Elsewhere the sidebar does (Problems, Readings).
 */
export function typeInBar(f: LibraryFilters, collectionId: string | null): boolean {
  return collectionId != null || f.favorite;
}

/**
 * Filters set in the library's filter bar. Favorites is a view picked in
 * the sidebar, and so is the type where the bar does not
 * offer it (typeInBar), so the bar neither counts nor clears them.
 */
export function barFilterCount(f: LibraryFilters, collectionId: string | null): number {
  return (
    (f.q.trim() ? 1 : 0) +
    (typeInBar(f, collectionId) && f.type ? 1 : 0) +
    (f.status.length ? 1 : 0) +
    (f.difficulty.length ? 1 : 0) +
    (f.tags.length ? 1 : 0)
  );
}

export function clearBarFilters(f: LibraryFilters, collectionId: string | null): LibraryFilters {
  return { ...f, q: '', type: typeInBar(f, collectionId) ? null : f.type, status: [], difficulty: [], tags: [] };
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

// ---- The remembered sort ----
// A sort chosen outside a search is remembered in the browser (sortStore.ts):
// one for each of the sidebar's views, one for each collection. The URL still
// wins: the remembered sort only stands in for a URL that names none.

/** A sort as remembered: `order` is `null` for the sort's natural direction. */
export interface RememberedSort {
  sort: ItemSort;
  order: SortOrder | null;
}

/**
 * Which remembered sort a view uses, from its path: one for each view of the
 * sidebar (`view:all`, `view:problem`, `view:reading`, `view:favorite`) and
 * one for each collection, with or without its nested ones. The query
 * string, a type picked in the filter bar included, narrows the view and
 * keeps its sort.
 */
export function sortScope(route: LibraryRoute): string {
  return route.collectionId ? `collection:${route.collectionId}` : `view:${route.view}`;
}

/** Whether a remembered sort can apply to a view: never relevance, and a collection's own order only in that collection without its nested ones. */
export function sortApplies(sort: ItemSort, f: LibraryFilters, collectionId: string | null): boolean {
  if (sort === 'relevance') return false;
  if (sort === 'position') return collectionId != null && !f.recursive;
  return true;
}

/**
 * The filters a view is shown with: the URL's, with the remembered sort in
 * place of the default when the URL names no sort or order, no search is
 * typed (a search sorts by relevance), and the sort can apply here.
 */
export function withRememberedSort(f: LibraryFilters, collectionId: string | null, remembered: RememberedSort | null): LibraryFilters {
  if (!remembered || f.sort || f.order || f.q.trim() || !sortApplies(remembered.sort, f, collectionId)) return f;
  return { ...f, sort: remembered.sort, order: remembered.order };
}

/** Whether the URL names the remembered sort, in either spelling of its natural direction. */
function sameSort(url: LibraryFilters, remembered: RememberedSort | null): boolean {
  if (!remembered || !url.sort) return false;
  return url.sort === remembered.sort && (url.order ?? defaultOrder(url.sort)) === (remembered.order ?? defaultOrder(remembered.sort));
}

/**
 * What a change made on screen (`next`, from the `shown` filters) puts in
 * the URL, whose own filters are `url`, and in the remembered sort:
 * `undefined` leaves it as it is, `null` forgets it.
 *
 * A change that keeps the sort keeps the URL's own, so a remembered sort is
 * not written into the URL, and does not follow a search. A search that
 * starts on the remembered sort also takes it out of the URL, where a click
 * put it this visit, so it sorts by relevance as on any later visit; a sort
 * the URL names otherwise (a shared link) stays. A sort chosen outside a
 * search goes into the URL as before and is remembered; the view's default
 * is left out of the URL and forgets the remembered one. One chosen while
 * searching is only in the URL.
 */
export function sortChange(
  shown: LibraryFilters,
  next: LibraryFilters,
  url: LibraryFilters,
  collectionId: string | null,
  remembered: RememberedSort | null,
): { url: LibraryFilters; remember: RememberedSort | null | undefined } {
  if (next.sort === shown.sort && next.order === shown.order) {
    const searchStarts = !shown.q.trim() && next.q.trim() !== '';
    const keep = !(searchStarts && sameSort(url, remembered));
    return { url: { ...next, sort: keep ? url.sort : null, order: keep ? url.order : null }, remember: undefined };
  }
  if (next.q.trim()) return { url: next, remember: undefined };
  const sort = effectiveSort(next, collectionId);
  const order = next.order ?? defaultOrder(sort);
  const byDefault = sort === effectiveSort({ ...next, sort: null }, collectionId) && order === defaultOrder(sort);
  if (byDefault) return { url: { ...next, sort: null, order: null }, remember: null };
  return { url: next, remember: { sort, order: order === defaultOrder(sort) ? null : order } };
}
