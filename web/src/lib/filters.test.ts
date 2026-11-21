import { describe, expect, it } from 'vitest';
import { EMPTY_FILTERS, activeFilterCount, barFilterCount, canReorder, clearBarFilters, defaultOrder, directionText, effectiveSort, filtersToSearch, nextColumnSort, parseFilters, sortApplies, sortChange, sortDirections, sortScope, toListParams, toggleIn, typeInBar, viewNoun, withRememberedSort, type LibraryFilters } from './filters';

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

describe('the remembered sort', () => {
  const title = { sort: 'title', order: null } as const;

  it('is one for each of the sidebar\'s views and one per collection', () => {
    const scope = (qs: string, collectionId: string | null = null) => sortScope(parse(qs), collectionId);
    expect([scope(''), scope('type=problem'), scope('type=reading'), scope('favorite=true'), scope('uncollected=true')]).toEqual(['view:all', 'view:problem', 'view:reading', 'view:favorite', 'view:uncollected']);
    expect(scope('', 'c1')).toBe('collection:c1');
    expect(scope('', 'c2')).toBe('collection:c2');
    // The search, the filter bar and its type (in Favorites, in a collection) narrow the view and keep its sort.
    expect(scope('type=problem&q=x&status=done&tag=dp&sort=title')).toBe('view:problem');
    expect(scope('favorite=true&type=problem')).toBe('view:favorite');
    expect(scope('type=reading&recursive=true', 'c1')).toBe('collection:c1');
    // As the title names the view.
    expect(scope('uncollected=true&favorite=true&type=problem')).toBe('view:uncollected');
  });

  it('never applies relevance, and a collection\'s own order only there without its nested ones', () => {
    expect(sortApplies('relevance', parse(''), null)).toBe(false);
    expect(sortApplies('position', parse(''), null)).toBe(false);
    expect(sortApplies('position', parse('recursive=true'), 'c1')).toBe(false);
    expect(sortApplies('position', parse(''), 'c1')).toBe(true);
    expect(sortApplies('title', parse('recursive=true'), 'c1')).toBe(true);
  });

  it('stands in for a URL that names no sort, outside a search', () => {
    expect(withRememberedSort(parse('type=reading'), null, { sort: 'title', order: 'desc' })).toMatchObject({ sort: 'title', order: 'desc' });
    // The URL wins, its order alone too.
    expect(withRememberedSort(parse('sort=difficulty'), null, title)).toMatchObject({ sort: 'difficulty', order: null });
    expect(withRememberedSort(parse('order=asc'), null, title)).toMatchObject({ sort: null, order: 'asc' });
    // A search sorts by relevance.
    expect(effectiveSort(withRememberedSort(parse('q=graph'), null, title), null)).toBe('relevance');
    // One that cannot apply leaves the view's default.
    expect(effectiveSort(withRememberedSort(parse('recursive=true'), 'c1', { sort: 'position', order: null }), 'c1')).toBe('updated');
    expect(withRememberedSort(parse(''), null, null)).toEqual(EMPTY_FILTERS);
  });

  /** A change made on the filters shown with `remembered`, from a URL of `qs`. */
  const change = (qs: string, remembered: { sort: 'title' | 'updated'; order: 'asc' | 'desc' | null } | null, edit: (f: LibraryFilters) => LibraryFilters, collectionId: string | null = null) => {
    const url = parse(qs);
    const shown = withRememberedSort(url, collectionId, remembered);
    return sortChange(shown, edit(shown), url, collectionId, remembered);
  };

  it('stays out of the URL when another filter changes, and does not follow a search', () => {
    expect(change('', title, (f) => ({ ...f, status: ['done'] }))).toEqual({ url: { ...EMPTY_FILTERS, status: ['done'] }, remember: undefined });
    const searched = change('', title, (f) => ({ ...f, q: 'graph' }));
    expect(searched.url).toMatchObject({ q: 'graph', sort: null, order: null });
    expect(searched.remember).toBeUndefined();
    // A sort the URL names stays there.
    expect(change('sort=difficulty', title, (f) => ({ ...f, q: 'graph' })).url).toMatchObject({ sort: 'difficulty' });
  });

  it('is what a column\'s name chooses, and forgotten on the way back to the default', () => {
    const first = change('', null, (f) => nextColumnSort(f, null, 'title'));
    expect(first).toEqual({ url: { ...EMPTY_FILTERS, sort: 'title' }, remember: title });
    // From the remembered sort, with a URL that names none.
    expect(change('', title, (f) => nextColumnSort(f, null, 'title'))).toEqual({ url: { ...EMPTY_FILTERS, sort: 'title', order: 'desc' }, remember: { sort: 'title', order: 'desc' } });
    expect(change('', { sort: 'title', order: 'desc' }, (f) => nextColumnSort(f, null, 'title'))).toEqual({ url: EMPTY_FILTERS, remember: null });
    // Another column from the remembered one: Updated is the default.
    expect(change('', title, (f) => nextColumnSort(f, null, 'updated'))).toEqual({ url: EMPTY_FILTERS, remember: null });
    expect(change('', null, (f) => nextColumnSort(f, null, 'updated')).remember).toEqual({ sort: 'updated', order: 'asc' });
  });

  it('forgets a pick of the view\'s default from the menu, and leaves it out of the URL', () => {
    expect(change('', title, (f) => ({ ...f, sort: 'updated', order: null }))).toEqual({ url: EMPTY_FILTERS, remember: null });
    expect(change('', title, (f) => ({ ...f, sort: 'position', order: null }), 'c1')).toEqual({ url: EMPTY_FILTERS, remember: null });
    expect(change('recursive=true', title, (f) => ({ ...f, sort: 'updated', order: null }), 'c1').remember).toBeNull();
    // Its other direction is a choice.
    expect(change('', null, (f) => ({ ...f, sort: 'updated', order: 'asc' })).remember).toEqual({ sort: 'updated', order: 'asc' });
  });

  it('leaves the URL as a search starts on it, when the URL names the remembered sort', () => {
    // Clicked this visit: in the URL and remembered.
    expect(change('sort=title', title, (f) => ({ ...f, q: 'graph' })).url).toMatchObject({ q: 'graph', sort: null, order: null });
    expect(change('sort=title&order=asc', title, (f) => ({ ...f, q: 'graph' })).url).toMatchObject({ sort: null, order: null });
    expect(change('sort=title&order=desc', { sort: 'title', order: 'desc' }, (f) => ({ ...f, q: 'graph' })).url).toMatchObject({ sort: null, order: null });
    // Another sort than the remembered one (a shared link) stays.
    expect(change('sort=title&order=desc', title, (f) => ({ ...f, q: 'graph' })).url).toMatchObject({ sort: 'title', order: 'desc' });
    expect(change('sort=title', null, (f) => ({ ...f, q: 'graph' })).url).toMatchObject({ sort: 'title' });
    // Only as the search starts: one chosen during it, or another filter, keeps it.
    expect(change('q=graph&sort=title', title, (f) => ({ ...f, q: 'graphs' })).url).toMatchObject({ sort: 'title' });
    expect(change('sort=title', title, (f) => ({ ...f, status: ['done'] })).url).toMatchObject({ sort: 'title' });
    // Cleared, the search leaves no sort in the URL, and the remembered one applies again.
    const cleared = change('q=graph', title, (f) => ({ ...f, q: '' }));
    expect(cleared.url).toMatchObject({ q: '', sort: null, order: null });
    expect(effectiveSort(withRememberedSort(cleared.url, null, title), null)).toBe('title');
  });

  it('is not changed by a sort chosen while searching, which stays in the URL', () => {
    expect(change('q=graph', title, (f) => ({ ...f, sort: 'title', order: null }))).toEqual({ url: { ...EMPTY_FILTERS, q: 'graph', sort: 'title' }, remember: undefined });
  });
});
