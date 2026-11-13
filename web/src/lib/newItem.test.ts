import { describe, expect, it } from 'vitest';
import { newItemHref } from './newItem';

describe('newItemHref', () => {
  it('presets the type the library is filtered to', () => {
    expect(newItemHref('/', '?type=problem')).toBe('/new?type=problem');
    expect(newItemHref('/', '?type=reading&status=todo&q=graphs')).toBe('/new?type=reading');
  });

  it('presets the collection being viewed, with its type filter', () => {
    expect(newItemHref('/collections/c1', '')).toBe('/new?collection=c1');
    expect(newItemHref('/collections/c1', '?type=reading')).toBe('/new?collection=c1&type=reading');
  });

  it('presets nothing from an unfiltered library or an unknown type', () => {
    expect(newItemHref('/', '')).toBe('/new');
    expect(newItemHref('/', '?favorite=true')).toBe('/new');
    expect(newItemHref('/', '?type=video')).toBe('/new');
  });

  it('ignores the query string of pages that are not the library', () => {
    expect(newItemHref('/items/i1', '?type=reading')).toBe('/new');
    expect(newItemHref('/settings', '')).toBe('/new');
  });
});
