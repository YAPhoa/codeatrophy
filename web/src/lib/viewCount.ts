import { typeInBar, type LibraryFilters } from './filters';

// The count beside a library view's title. While the list keeps an earlier
// page on screen (it dims it and waits for the next), that page's total may
// belong to another view, and the title has already changed.

/**
 * What a library view is, as its title and scope name it: the collection
 * (with or without nested ones), Favorites, Uncollected, Problems or
 * Readings. The search and the filter bar narrow a view; they are not part
 * of it.
 */
export function libraryView(f: LibraryFilters, collectionId: string | null): string {
  return JSON.stringify([
    collectionId,
    collectionId != null && f.recursive,
    f.favorite,
    collectionId == null && f.uncollected,
    typeInBar(f, collectionId) ? null : f.type,
  ]);
}

export interface TitleCountState {
  /** The total of the page on screen, or `null` when none has loaded. */
  total: number | null;
  /** Whether that page is one kept from an earlier query, or none has loaded yet. */
  waiting: boolean;
  /** Whether the page on screen was loaded for this same view (`libraryView`). */
  sameView: boolean;
  /** How many filter bar filters are set (`barFilterCount`). */
  barFilters: number;
  /** The view's count from counts already loaded, or `null` (`unfilteredTotal`). */
  viewTotal: number | null;
}

/**
 * The count the title shows, or `null` for none. The page's own total once
 * it is in. Until then, the view's count where one is known and no bar
 * filter narrows it, so a new title comes with its own number; otherwise the
 * earlier total only if it was this view's (a search refined it), and
 * nothing rather than another view's number.
 */
export function titleCount({ total, waiting, sameView, barFilters, viewTotal }: TitleCountState): number | null {
  if (!waiting) return total;
  if (barFilters === 0 && viewTotal !== null) return viewTotal;
  return sameView ? total : null;
}
