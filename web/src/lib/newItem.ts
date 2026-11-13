import { matchPath, useLocation } from 'react-router';
import { parseFilters } from './filters';

/**
 * Where "New item" leads from a location: the capture page, preset with what
 * the library is showing there — the collection being viewed and the type it
 * is filtered to — so the new item starts out where the user was looking.
 */
export function newItemHref(pathname: string, search: string): string {
  const collection = matchPath('/collections/:id', pathname)?.params.id;
  if (pathname !== '/' && !collection) return '/new';
  const preset = new URLSearchParams();
  if (collection) preset.set('collection', collection);
  const { type } = parseFilters(new URLSearchParams(search));
  if (type) preset.set('type', type);
  const qs = preset.toString();
  return qs ? `/new?${qs}` : '/new';
}

export function useNewItemHref(): string {
  const { pathname, search } = useLocation();
  return newItemHref(pathname, search);
}
