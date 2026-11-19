import { describe, expect, it } from 'vitest';
import { EMPTY_FILTERS, activeFilterCount, barFilterCount, canReorder, clearBarFilters, defaultOrder, directionText, effectiveSort, filtersToSearch, nextColumnSort, parseFilters, sortDirections, toListParams, toggleIn, typeInBar, viewNoun } from './filters';

const parse = (qs: string) => parseFilters(new URLSearchParams(qs));

describe('parseFilters / filtersToSearch', () => {
  it('round-trips a full filter set through the URL', () => {
    const qs = 'q=two+sum&type=problem&status=todo&status=done&difficulty=easy&difficulty=none&tag=dp&tag=graph&favorite=true&sort=title&order=desc';
    const f = parse(qs);
    expect(f).toMatchObject({ q: 'two sum', type: 'problem', status: ['todo', 'done'], difficulty: ['easy', 'none'], tags: ['dp', 'graph'], favorite: true, sort: 'title', order: 'desc' });
    expect(filtersToSearch(f).toString()).toBe(qs);
  });

  it('drops unknown values instead of passing them to the API', () => {
    const f = parse('type=video&status=todo&status=bogus&difficulty=extreme&sort=random&order=sideways&favorite=yes');
    expect(f).toEqual({ ...EMPTY_FILTERS, status: ['todo'] });
  });

  it('serialises the empty state to an empty query string', () => {
    expect(filtersToSearch(EMPTY_FILTERS).toString()).toBe('');
  });

  it('normalises and de-duplicates tags', () => {
    expect(parse('tag=DP&tag=dp&tag=+Graph+').tags).toEqual(['dp', 'graph']);
  });
});

describe('effectiveSort', () => {
  it('defaults to relevance while searching, position in a collection, otherwise updated', () => {
    expect(effectiveSort(parse('q=x'), null)).toBe('relevance');
    expect(effectiveSort(parse('q=x'), 'c1')).toBe('relevance');
    expect(effectiveSort(parse(''), 'c1')).toBe('position');
    expect(effectiveSort(parse(''), null)).toBe('updated');
  });

  it('falls back when a chosen sort is not valid for the view', () => {
    // `relevance` needs a query; `position` needs a single, non-recursive collection.
    expect(effectiveSort(parse('sort=relevance'), null)).toBe('updated');
    expect(effectiveSort(parse('sort=position'), null)).toBe('updated');
    expect(effectiveSort(parse('sort=position&recursive=true'), 'c1')).toBe('updated');
    expect(effectiveSort(parse('recursive=true'), 'c1')).toBe('updated');
    expect(effectiveSort(parse('sort=position'), 'c1')).toBe('position');
  });

  it('respects an explicit valid choice', () => {
    expect(effectiveSort(parse('q=x&sort=title'), 'c1')).toBe('title');
  });
});

describe('toListParams', () => {
  it('never sends sort=position without a non-recursive collectionId', () => {
    expect(toListParams(parse('sort=position'), null)).toEqual({ sort: 'updated' });
    expect(toListParams(parse('sort=position&recursive=true'), 'c1')).toEqual({ sort: 'updated', collectionId: 'c1', recursive: true });
  });

  it('never sends sort=relevance without q', () => {
    expect(toListParams(parse('sort=relevance'), null).sort).toBe('updated');
    expect(toListParams(parse('q=heap'), null)).toEqual({ sort: 'relevance', q: 'heap' });
  });

  it('omits the order when it is the default for the sort', () => {
    expect(toListParams(parse('sort=updated&order=desc'), null).order).toBeUndefined();
    expect(toListParams(parse('sort=updated&order=asc'), null).order).toBe('asc');
    expect(toListParams(parse('sort=title&order=asc'), null).order).toBeUndefined();
    expect(toListParams(parse('sort=title&order=desc'), null).order).toBe('desc');
  });

  it('ignores "uncollected" inside a collection view', () => {
    expect(toListParams(parse('uncollected=true'), 'c1')).toEqual({ sort: 'position', collectionId: 'c1' });
    expect(toListParams(parse('uncollected=true'), null)).toEqual({ sort: 'updated', uncollected: true });
  });

  it('passes multi-value filters through', () => {
    expect(toListParams(parse('status=todo&status=done&tag=a&tag=b&difficulty=none&favorite=true&type=reading'), null)).toEqual({
      sort: 'updated',
      status: ['todo', 'done'],
      tag: ['a', 'b'],
      difficulty: ['none'],
      favorite: true,
      type: 'reading',
    });
  });
});

describe('canReorder', () => {
  it('is only possible for a whole collection in its own order', () => {
    expect(canReorder(parse(''), 'c1')).toBe(true);
    expect(canReorder(parse(''), null)).toBe(false);
    expect(canReorder(parse('q=x'), 'c1')).toBe(false);
    expect(canReorder(parse('status=todo'), 'c1')).toBe(false);
    expect(canReorder(parse('sort=title'), 'c1')).toBe(false);
    expect(canReorder(parse('recursive=true'), 'c1')).toBe(false);
    expect(canReorder(parse('order=desc'), 'c1')).toBe(false);
  });
});

describe('helpers', () => {
  it('counts narrowing filters, not sort', () => {
    expect(activeFilterCount(parse('sort=title&order=desc&recursive=true'))).toBe(0);
    expect(activeFilterCount(parse('q=a&type=problem&status=todo&status=done&tag=x&favorite=true'))).toBe(5);
  });

  it('leaves the sidebar view out of the filter bar', () => {
    const f = parse('q=a&type=problem&status=todo&difficulty=easy&tag=x&uncollected=true&sort=title');
    expect(barFilterCount(f, null)).toBe(4);
    expect(barFilterCount(parse('type=reading&uncollected=true'), null)).toBe(0);
    expect(barFilterCount(parse('favorite=true'), null)).toBe(0);
    const cleared = clearBarFilters(f, null);
    expect(barFilterCount(cleared, null)).toBe(0);
    expect(cleared).toMatchObject({ type: 'problem', uncollected: true, sort: 'title' });
  });

  it('counts and clears the type as a bar filter in Favorites', () => {
    const f = parse('type=reading&status=todo&favorite=true');
    expect(typeInBar(f, null)).toBe(true);
    expect(typeInBar(parse('type=reading'), null)).toBe(false);
    expect(barFilterCount(f, null)).toBe(2);
    expect(clearBarFilters(f, null)).toMatchObject({ type: null, status: [], favorite: true });
  });

  it('counts and clears the type as a bar filter in a collection', () => {
    const f = parse('q=a&type=reading&status=todo&recursive=true&sort=title');
    expect(barFilterCount(f, 'c1')).toBe(3);
    expect(barFilterCount(parse('type=problem'), 'c1')).toBe(1);
    const cleared = clearBarFilters(f, 'c1');
    expect(barFilterCount(cleared, 'c1')).toBe(0);
    expect(cleared).toMatchObject({ type: null, recursive: true, sort: 'title' });
  });

  it('toggles membership', () => {
    expect(toggleIn(['a', 'b'], 'a')).toEqual(['b']);
    expect(toggleIn(['a'], 'b')).toEqual(['a', 'b']);
  });
});

describe('sortDirections', () => {
  it('names the directions for the field, the default first', () => {
    for (const sort of ['updated', 'created'] as const) {
      expect(sortDirections(sort)).toEqual([
        { order: 'desc', label: 'Newest first' },
        { order: 'asc', label: 'Oldest first' },
      ]);
      expect(sortDirections(sort)![0]!.order).toBe(defaultOrder(sort));
    }
    expect(sortDirections('title')).toEqual([
      { order: 'asc', label: 'A → Z' },
      { order: 'desc', label: 'Z → A' },
    ]);
    // Ascending difficulty is easy before hard.
    expect(sortDirections('difficulty')).toEqual([
      { order: 'asc', label: 'Easiest first' },
      { order: 'desc', label: 'Hardest first' },
    ]);
  });

  it('has none for manual order and relevance', () => {
    expect(sortDirections('position')).toBeNull();
    expect(sortDirections('relevance')).toBeNull();
  });
});

describe('nextColumnSort', () => {
  const cycle = (f: typeof EMPTY_FILTERS, collectionId: string | null, column: 'title' | 'difficulty' | 'updated') => {
    const seen: string[] = [];
    let cur = f;
    for (let i = 0; i < 3; i++) {
      cur = nextColumnSort(cur, collectionId, column);
      seen.push(`${cur.sort ?? '-'}/${cur.order ?? '-'}`);
    }
    return seen;
  };

  it('sorts by the column in its natural direction, then the other way, then back to the view\'s own order', () => {
    expect(cycle(EMPTY_FILTERS, null, 'title')).toEqual(['title/-', 'title/desc', '-/-']);
    expect(cycle(EMPTY_FILTERS, null, 'difficulty')).toEqual(['difficulty/-', 'difficulty/desc', '-/-']);
    expect(cycle(EMPTY_FILTERS, 'c1', 'title')).toEqual(['title/-', 'title/desc', '-/-']);
  });

  it('on the column a view sorts by anyway, reverses it first', () => {
    expect(cycle(EMPTY_FILTERS, null, 'updated')).toEqual(['updated/asc', '-/-', 'updated/asc']);
    // While searching the view sorts by relevance, so Updated starts at newest first.
    expect(cycle({ ...EMPTY_FILTERS, q: 'x' }, null, 'updated')).toEqual(['updated/-', 'updated/asc', '-/-']);
  });

  it('keeps the filters', () => {
    expect(nextColumnSort({ ...EMPTY_FILTERS, tags: ['a'] }, null, 'title').tags).toEqual(['a']);
  });
});

describe('directionText', () => {
  it('words a direction for a sentence', () => {
    expect(directionText('title', 'asc')).toBe('A to Z');
    expect(directionText('difficulty', 'desc')).toBe('hardest first');
    expect(directionText('updated', 'desc')).toBe('newest first');
    expect(directionText('position', 'asc')).toBeNull();
  });
});

describe('viewNoun', () => {
  it('names problems and readings only in their own views', () => {
    expect(viewNoun(parse('type=problem'), null)).toBe('problems');
    expect(viewNoun(parse('type=reading'), null)).toBe('readings');
    expect(viewNoun(parse(''), null)).toBe('items');
    expect(viewNoun(parse('favorite=true'), null)).toBe('items');
    expect(viewNoun(parse('uncollected=true&type=problem'), null)).toBe('items');
    expect(viewNoun(parse('type=reading'), 'c1')).toBe('items');
  });
});
