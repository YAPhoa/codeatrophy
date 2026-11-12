import { describe, expect, it } from 'vitest';
import { EMPTY_FILTERS, activeFilterCount, canReorder, effectiveSort, filtersToSearch, parseFilters, toListParams, toggleIn } from './filters';

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

  it('toggles membership', () => {
    expect(toggleIn(['a', 'b'], 'a')).toEqual(['b']);
    expect(toggleIn(['a'], 'b')).toEqual(['a', 'b']);
  });
});
