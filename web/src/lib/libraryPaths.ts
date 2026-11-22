import { matchPath } from 'react-router';

// The library's views each have a path: All items `/`, `/problems`,
// `/readings`, `/favorites`, and each collection `/collections/:id`. The path
// says what the view is; the query string only narrows it (search, the
// filter bar, sort, page). The type is in the query string only where the
// filter bar picks it, in Favorites and in a collection (`typeInBar`).

/** A view of the sidebar. */
export type SidebarView = 'all' | 'problem' | 'reading' | 'favorite';

/** A library view as its path names it: a view of the sidebar, or a collection. */
export type LibraryRoute = { view: SidebarView; collectionId: null } | { view: 'collection'; collectionId: string };

export const VIEW_PATHS: Record<SidebarView, string> = {
  all: '/',
  problem: '/problems',
  reading: '/readings',
  favorite: '/favorites',
};

const VIEWS = Object.entries(VIEW_PATHS) as [SidebarView, string][];

/** The library view at a path, or `null` for a page that is not the library. */
export function libraryRouteAt(pathname: string): LibraryRoute | null {
  for (const [view, path] of VIEWS) if (matchPath(path, pathname)) return { view, collectionId: null };
  const id = matchPath('/collections/:id', pathname)?.params.id;
  return id ? { view: 'collection', collectionId: id } : null;
}

/**
 * Where an address of the library from before its views had paths leads:
 * `/?type=problem` to `/problems`, `/?type=reading` to `/readings`,
 * `/?favorite=true` to `/favorites` (a type with it stays, as the filter
 * bar's, as Favorites showed it), every other parameter kept; `null` for an
 * address that is already right. Uncollected is no longer a view: its
 * parameter is dropped, leaving All items or whichever view the rest names.
 */
export function legacyLibraryPath(search: string): string | null {
  const sp = new URLSearchParams(search);
  const type = sp.get('type');
  const favorite = sp.get('favorite') === 'true';
  const typed = type === 'problem' || type === 'reading' ? type : null;
  if (!favorite && !typed && !sp.has('uncollected')) return null;
  sp.delete('favorite');
  sp.delete('uncollected');
  let path = '/';
  if (favorite) path = VIEW_PATHS.favorite;
  else if (typed) {
    path = VIEW_PATHS[typed];
    sp.delete('type');
  }
  const qs = sp.toString();
  return qs ? `${path}?${qs}` : path;
}

/**
 * The pages of one item whose Back arrow leads to the library view looked at
 * last (`libraryHref` in features/item): the solve workspace or the reader,
 * and a problem's other tabs.
 */
const ITEM_PAGES = ['/items/:id', '/items/:id/tests', '/items/:id/tests/generate', '/items/:id/solutions'];

/** Whether `pathname` is a page of one item whose Back leads to the library. */
export function isItemPage(pathname: string): boolean {
  return ITEM_PAGES.some((path) => matchPath(path, pathname) !== null);
}

/**
 * The view an item page's Back leads to, from the address stored as the
 * library's last (`null` when none is: All items). Only its path counts, as
 * the old addresses lead to theirs; `null` on any page that is not an item's,
 * or when the address is not a view.
 */
export function backViewAt(pathname: string, last: string | null): LibraryRoute | null {
  if (!isItemPage(pathname)) return null;
  let url: URL;
  try {
    url = new URL(last || '/', 'http://library.invalid');
  } catch {
    return libraryRouteAt('/');
  }
  const moved = url.pathname === '/' ? legacyLibraryPath(url.search) : null;
  return libraryRouteAt(moved ? new URL(moved, url).pathname : url.pathname);
}
