import { describe, expect, it } from 'vitest';
import { withFakeLocalStorage } from '../test/fakeStorage';
import type { Tag } from '../api/types';
import { DEFAULT_TAG_ORDER, getHideEmptyTags, nextTagOrder, setHideEmptyTags, sortTags, tagDirectionText, type TagOrder } from './tagList';

const tags: Tag[] = [
  { name: 'graph', count: 2 },
  { name: 'array', count: 7 },
  { name: 'trie', count: 0 },
  { name: 'dp', count: 2 },
  { name: 'backtracking', count: 0 },
];
const names = (order: TagOrder) => sortTags(tags, order).map((t) => t.name);

describe('sorting tags', () => {
  it('goes by name, or by count with ties by name from A to Z', () => {
    expect(names(DEFAULT_TAG_ORDER)).toEqual(['array', 'backtracking', 'dp', 'graph', 'trie']);
    expect(names({ sort: 'name', order: 'desc' })).toEqual(['trie', 'graph', 'dp', 'backtracking', 'array']);
    expect(names({ sort: 'items', order: 'desc' })).toEqual(['array', 'dp', 'graph', 'backtracking', 'trie']);
    expect(names({ sort: 'items', order: 'asc' })).toEqual(['backtracking', 'trie', 'dp', 'graph', 'array']);
  });

  it('cycles a column: its natural direction, the other way, then back to the default', () => {
    const items1 = nextTagOrder(DEFAULT_TAG_ORDER, 'items');
    expect(items1).toEqual({ sort: 'items', order: 'desc' });
    const items2 = nextTagOrder(items1, 'items');
    expect(items2).toEqual({ sort: 'items', order: 'asc' });
    expect(nextTagOrder(items2, 'items')).toEqual(DEFAULT_TAG_ORDER);
    // The name is the default: A to Z and Z to A in turn.
    const name1 = nextTagOrder(DEFAULT_TAG_ORDER, 'name');
    expect(name1).toEqual({ sort: 'name', order: 'desc' });
    expect(nextTagOrder(name1, 'name')).toEqual(DEFAULT_TAG_ORDER);
    expect(nextTagOrder(items2, 'name')).toEqual(DEFAULT_TAG_ORDER);
  });

  it('names each direction', () => {
    expect(tagDirectionText('name', 'asc')).toBe('A to Z');
    expect(tagDirectionText('items', 'desc')).toBe('most first');
    expect(tagDirectionText('items', 'asc')).toBe('fewest first');
  });
});

describe('hiding empty tags', () => {
  withFakeLocalStorage();

  it('is on unless turned off in this browser', () => {
    expect(getHideEmptyTags()).toBe(true);
    setHideEmptyTags(false);
    expect(getHideEmptyTags()).toBe(false);
    setHideEmptyTags(true);
    expect(getHideEmptyTags()).toBe(true);
  });
});
