import { describe, expect, it } from 'vitest';
import { withFakeLocalStorage } from '../test/fakeStorage';
import { getPageSize, pageList, pageSizes, parsePage, setPageSize, withPage } from './paging';

describe('pageList', () => {
  it('shows the ends, the current page and its neighbours, with gaps between', () => {
    expect(pageList(5, 12)).toEqual([1, 'gap', 4, 5, 6, 'gap', 12]);
    expect(pageList(6, 12)).toEqual([1, 'gap', 5, 6, 7, 'gap', 12]);
  });

  it('keeps five numbers together near either end', () => {
    expect(pageList(1, 12)).toEqual([1, 2, 3, 4, 5, 'gap', 12]);
    expect(pageList(4, 12)).toEqual([1, 2, 3, 4, 5, 'gap', 12]);
    expect(pageList(12, 12)).toEqual([1, 'gap', 8, 9, 10, 11, 12]);
  });

  it('never leaves out a single page behind a gap', () => {
    expect(pageList(3, 6)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(pageList(5, 7)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it('lists every page of a short list', () => {
    expect(pageList(1, 1)).toEqual([1]);
    expect(pageList(2, 3)).toEqual([1, 2, 3]);
  });
});

describe('the page in the URL', () => {
  it('is a whole number from 2, and the first page otherwise', () => {
    expect(parsePage(new URLSearchParams('page=3'))).toBe(3);
    for (const bad of ['', 'page=1', 'page=0', 'page=-2', 'page=2.5', 'page=x']) expect(parsePage(new URLSearchParams(bad))).toBe(1);
  });

  it('is left out for the first page', () => {
    expect(withPage(new URLSearchParams('q=a&page=4'), 1).toString()).toBe('q=a');
    expect(withPage(new URLSearchParams('q=a'), 2).toString()).toBe('q=a&page=2');
  });
});

describe('the page sizes offered', () => {
  it('are those the server allows as a limit', () => {
    expect(pageSizes(200)).toEqual([25, 50, 100, 200]);
    expect(pageSizes(100)).toEqual([25, 50, 100]);
    expect(pageSizes(60)).toEqual([25, 50]);
    expect(pageSizes(undefined)).toEqual([25, 50, 100, 200]);
  });
});

describe('page size', () => {
  withFakeLocalStorage();

  it('defaults to 50, and is kept when it is one of the sizes offered', () => {
    expect(getPageSize()).toBe(50);
    setPageSize(100);
    expect(getPageSize()).toBe(100);
    localStorage.setItem('codeatrophy:libraryPageSize', '37');
    expect(getPageSize()).toBe(50);
  });
});
