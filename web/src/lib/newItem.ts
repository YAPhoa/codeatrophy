import { useLocation } from 'react-router';
import { parseFilters } from './filters';
import { libraryRouteAt } from './libraryPaths';

/**
 * Where "New item" leads from a location: the capture page, preset with what
 * the library is showing there — the collection being viewed and the type it
 * is filtered to (Problems, Readings, or the filter bar's type) — so the new
 * item starts out where the user was looking.
 */
export function newItemHref(pathname: string, search: string): string {
  const route = libraryRouteAt(pathname);
  if (!route) return '/new';
  const preset = new URLSearchParams();
  if (route.collectionId) preset.set('collection', route.collectionId);
  const { type } = parseFilters(new URLSearchParams(search), route.view);
  if (type) preset.set('type', type);
  const qs = preset.toString();
  return qs ? `/new?${qs}` : '/new';
}

export function useNewItemHref(): string {
  const { pathname, search } = useLocation();
  return newItemHref(pathname, search);
}
