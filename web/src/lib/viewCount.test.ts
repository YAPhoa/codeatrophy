import { describe, expect, it } from 'vitest';
import { parseFilters } from './filters';
import { libraryView, titleCount, type TitleCountState } from './viewCount';

const view = (qs: string, collectionId: string | null = null) => libraryView(parseFilters(new URLSearchParams(qs)), collectionId);

describe('libraryView', () => {
  it('tells apart what the sidebar picks: the type, Favorites, Uncollected, a collection and its nested ones', () => {
    const views = [view(''), view('type=problem'), view('type=reading'), view('favorite=true'), view('uncollected=true'), view('', 'c1'), view('', 'c2'), view('recursive=true', 'c1')];
    expect(new Set(views).size).toBe(views.length);
  });

  it('leaves out the search, the filter bar and the sort', () => {
    expect(view('type=problem&q=graph&status=done&difficulty=easy&tag=dp&sort=title&order=asc')).toBe(view('type=problem'));
    // The type is in the bar in a collection and in Favorites.
    expect(view('type=reading', 'c1')).toBe(view('', 'c1'));
    expect(view('favorite=true&type=problem')).toBe(view('favorite=true'));
  });

  it('ignores what does not apply to the view', () => {
    expect(view('recursive=true')).toBe(view(''));
    expect(view('uncollected=true', 'c1')).toBe(view('', 'c1'));
  });
});

describe('titleCount', () => {
  const base: TitleCountState = { total: 12, waiting: false, sameView: true, barFilters: 0, viewTotal: 30 };

  it('is the page\'s own total once it is in', () => {
    expect(titleCount(base)).toBe(12);
    expect(titleCount({ ...base, sameView: false, viewTotal: null })).toBe(12);
    expect(titleCount({ ...base, total: null })).toBeNull();
  });

  it('is the view\'s known count while waiting with no bar filter, on a first load too', () => {
    expect(titleCount({ ...base, waiting: true, sameView: false })).toBe(30);
    expect(titleCount({ ...base, waiting: true })).toBe(30);
    expect(titleCount({ ...base, waiting: true, total: null, sameView: false })).toBe(30);
  });

  it('keeps the earlier total while a search or bar filter refines the same view', () => {
    expect(titleCount({ ...base, waiting: true, barFilters: 1 })).toBe(12);
    expect(titleCount({ ...base, waiting: true, viewTotal: null })).toBe(12);
  });

  it('shows nothing rather than another view\'s total', () => {
    expect(titleCount({ ...base, waiting: true, sameView: false, viewTotal: null })).toBeNull();
    expect(titleCount({ ...base, waiting: true, sameView: false, barFilters: 2 })).toBeNull();
    expect(titleCount({ ...base, waiting: true, total: null, viewTotal: null })).toBeNull();
  });
});
