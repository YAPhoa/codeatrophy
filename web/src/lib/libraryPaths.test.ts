import { describe, expect, it } from 'vitest';
import { legacyLibraryPath, libraryRouteAt } from './libraryPaths';

describe('libraryRouteAt', () => {
  it('names the view of each library path', () => {
    expect(libraryRouteAt('/')).toEqual({ view: 'all', collectionId: null });
    expect(libraryRouteAt('/problems')).toEqual({ view: 'problem', collectionId: null });
    expect(libraryRouteAt('/readings/')).toEqual({ view: 'reading', collectionId: null });
    expect(libraryRouteAt('/favorites')).toEqual({ view: 'favorite', collectionId: null });
    expect(libraryRouteAt('/collections/c1')).toEqual({ view: 'collection', collectionId: 'c1' });
  });

  it('is null away from the library', () => {
    expect(libraryRouteAt('/items/i1')).toBeNull();
    expect(libraryRouteAt('/tags')).toBeNull();
    expect(libraryRouteAt('/problems/x')).toBeNull();
    expect(libraryRouteAt('/collections')).toBeNull();
  });
});

describe('legacyLibraryPath', () => {
  it('leads the old addresses of the views to their paths, with every other parameter', () => {
    expect(legacyLibraryPath('?type=problem')).toBe('/problems');
    expect(legacyLibraryPath('?type=reading&q=raft&status=done&sort=title&page=2')).toBe('/readings?q=raft&status=done&sort=title&page=2');
    expect(legacyLibraryPath('?favorite=true&tag=dp')).toBe('/favorites?tag=dp');
  });

  it('keeps a type with Favorites, as its filter bar\'s', () => {
    expect(legacyLibraryPath('?type=reading&favorite=true&q=x')).toBe('/favorites?type=reading&q=x');
  });

  it('drops Uncollected, which is no longer a view', () => {
    expect(legacyLibraryPath('?uncollected=true')).toBe('/');
    expect(legacyLibraryPath('?uncollected=true&q=x')).toBe('/?q=x');
    expect(legacyLibraryPath('?uncollected=true&type=problem')).toBe('/problems');
    expect(legacyLibraryPath('?uncollected=true&favorite=true')).toBe('/favorites');
  });

  it('leaves an address that names no old view', () => {
    expect(legacyLibraryPath('')).toBeNull();
    expect(legacyLibraryPath('?q=x&status=done&sort=title')).toBeNull();
    expect(legacyLibraryPath('?type=video')).toBeNull();
    expect(legacyLibraryPath('?favorite=false')).toBeNull();
  });
});
