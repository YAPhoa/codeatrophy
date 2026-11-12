import { describe, expect, it } from 'vitest';
import type { Collection } from '../api/types';
import { buildTree, descendantIds, findNode, flattenTree, moveIndex, pathTo, placeAfter, siblingsOf } from './tree';

const c = (id: string, parentId: string | null, position: number, name = id): Collection => ({
  id,
  name,
  description: '',
  parentId,
  position,
  itemCount: 0,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
});

const sample = [c('a', null, 1), c('b', null, 0), c('a1', 'a', 1), c('a0', 'a', 0), c('a0x', 'a0', 0)];

describe('buildTree', () => {
  it('nests by parentId and orders siblings by position', () => {
    const tree = buildTree(sample);
    expect(tree.map((n) => n.collection.id)).toEqual(['b', 'a']);
    expect(tree[1]?.children.map((n) => n.collection.id)).toEqual(['a0', 'a1']);
    expect(flattenTree(tree).map((n) => `${n.depth}:${n.collection.id}`)).toEqual(['0:b', '0:a', '1:a0', '2:a0x', '1:a1']);
  });

  it('treats a collection with a missing parent as a root', () => {
    const tree = buildTree([c('x', 'gone', 0)]);
    expect(tree.map((n) => n.collection.id)).toEqual(['x']);
  });

  it('does not loop on a cycle', () => {
    const tree = buildTree([c('p', 'q', 0), c('q', 'p', 0)]);
    const ids = flattenTree(tree).map((n) => n.collection.id).sort();
    expect(ids).toEqual(['p', 'q']);
  });
});

describe('navigation helpers', () => {
  const tree = buildTree(sample);

  it('finds nodes and descendants', () => {
    expect(findNode(tree, 'a0x')?.depth).toBe(2);
    expect(findNode(tree, 'nope')).toBeNull();
    expect(descendantIds(tree, 'a').sort()).toEqual(['a0', 'a0x', 'a1']);
    expect(descendantIds(tree, 'b')).toEqual([]);
  });

  it('builds the path from the root', () => {
    expect(pathTo(sample, 'a0x').map((x) => x.id)).toEqual(['a', 'a0', 'a0x']);
    expect(pathTo(sample, 'missing')).toEqual([]);
    expect(pathTo([c('p', 'q', 0), c('q', 'p', 0)], 'p').map((x) => x.id)).toEqual(['q', 'p']);
  });

  it('lists siblings in order', () => {
    expect(siblingsOf(sample, 'a1').map((x) => x.id)).toEqual(['a0', 'a1']);
    expect(siblingsOf(sample, 'a').map((x) => x.id)).toEqual(['b', 'a']);
  });
});

describe('moveIndex', () => {
  it('moves an element and clamps the target', () => {
    expect(moveIndex(['a', 'b', 'c', 'd'], 0, 2)).toEqual(['b', 'c', 'a', 'd']);
    expect(moveIndex(['a', 'b', 'c'], 2, 0)).toEqual(['c', 'a', 'b']);
    expect(moveIndex(['a', 'b', 'c'], 1, 99)).toEqual(['a', 'c', 'b']);
    expect(moveIndex(['a', 'b', 'c'], 5, 0)).toEqual(['a', 'b', 'c']);
  });

  it('does not mutate its input', () => {
    const list = ['a', 'b'];
    moveIndex(list, 0, 1);
    expect(list).toEqual(['a', 'b']);
  });
});

describe('placeAfter', () => {
  const ids = ['a', 'b', 'c', 'd'];

  it('moves an id directly after another, or to the front', () => {
    expect(placeAfter(ids, 'a', 'c')).toEqual(['b', 'c', 'a', 'd']);
    expect(placeAfter(ids, 'd', 'a')).toEqual(['a', 'd', 'b', 'c']);
    expect(placeAfter(ids, 'c', null)).toEqual(['c', 'a', 'b', 'd']);
    expect(placeAfter(ids, 'b', 'a')).toEqual(ids);
  });

  it('applies a move seen in one page to a longer full list', () => {
    // The page shows a, b, c; the collection also holds x and y further down.
    expect(placeAfter(['a', 'b', 'c', 'x', 'y'], 'a', 'c')).toEqual(['b', 'c', 'a', 'x', 'y']);
  });

  it('changes nothing when either id is no longer a member', () => {
    expect(placeAfter(ids, 'zz', 'a')).toEqual(ids);
    expect(placeAfter(ids, 'a', 'zz')).toEqual(ids);
    expect(placeAfter(ids, 'a', 'a')).toEqual(ids);
  });
});
