import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installLocalStorage, removeLocalStorage } from '../test/fakeStorage';
import { SORT_TTL_MS, readRememberedSort, rememberSort, touchRememberedSort } from './sortStore';

const KEY = 'codeatrophy:librarySort';
const DAY = 24 * 60 * 60 * 1000;
const stored = (storage: Storage) => JSON.parse(storage.getItem(KEY) ?? 'null') as unknown;

describe('the remembered library sort', () => {
  let storage: Storage;
  beforeEach(() => {
    storage = installLocalStorage();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-01T12:00:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
    removeLocalStorage();
  });

  it('is kept per scope, with the time it was last used', () => {
    rememberSort('view:all', { sort: 'title', order: null });
    rememberSort('collection:c1', { sort: 'difficulty', order: 'desc' });
    expect(readRememberedSort('view:all')).toEqual({ sort: 'title', order: null });
    expect(readRememberedSort('collection:c1')).toEqual({ sort: 'difficulty', order: 'desc' });
    expect(readRememberedSort('collection:c2')).toBeNull();
    expect(stored(storage)).toEqual({
      'view:all': { sort: 'title', order: null, at: Date.now() },
      'collection:c1': { sort: 'difficulty', order: 'desc', at: Date.now() },
    });
  });

  it('is forgotten, and the key goes with the last one', () => {
    rememberSort('view:all', { sort: 'title', order: null });
    rememberSort('view:all', null);
    expect(readRememberedSort('view:all')).toBeNull();
    expect(storage.getItem(KEY)).toBeNull();
  });

  it('lasts 30 days from the last visit, each visit starting them again', () => {
    rememberSort('view:all', { sort: 'title', order: null });
    vi.advanceTimersByTime(20 * DAY);
    touchRememberedSort('view:all');
    vi.advanceTimersByTime(20 * DAY);
    expect(readRememberedSort('view:all')).toEqual({ sort: 'title', order: null });
    vi.advanceTimersByTime(SORT_TTL_MS - 20 * DAY + 1);
    expect(readRememberedSort('view:all')).toBeNull();
    // Expired, it is dropped at the next visit rather than refreshed.
    touchRememberedSort('view:all');
    expect(storage.getItem(KEY)).toBeNull();
  });

  it('drops the expired entries of other scopes whenever it writes', () => {
    rememberSort('collection:old', { sort: 'title', order: null });
    rememberSort('collection:kept', { sort: 'title', order: 'desc' });
    vi.advanceTimersByTime(10 * DAY);
    touchRememberedSort('collection:kept');
    vi.advanceTimersByTime(25 * DAY);
    rememberSort('view:all', { sort: 'created', order: null });
    expect(Object.keys(stored(storage) as object).sort()).toEqual(['collection:kept', 'view:all']);
    vi.advanceTimersByTime(10 * DAY);
    touchRememberedSort('collection:other');
    expect(Object.keys(stored(storage) as object)).toEqual(['view:all']);
  });

  it('ignores and drops what it cannot read', () => {
    storage.setItem(KEY, '{not json');
    expect(readRememberedSort('view:all')).toBeNull();
    touchRememberedSort('view:all');
    expect(storage.getItem(KEY)).toBeNull();

    storage.setItem(KEY, '["title"]');
    expect(readRememberedSort('view:all')).toBeNull();

    const now = Date.now();
    storage.setItem(
      KEY,
      JSON.stringify({
        'view:all': { sort: 'relevance', order: null, at: now },
        'collection:a': { sort: 'title', order: 'sideways', at: now },
        'collection:b': { sort: 'title', order: null, at: 'yesterday' },
        'collection:c': { sort: 'title', order: null, at: now },
      }),
    );
    expect(readRememberedSort('view:all')).toBeNull();
    expect(readRememberedSort('collection:a')).toBeNull();
    expect(readRememberedSort('collection:b')).toBeNull();
    expect(readRememberedSort('collection:c')).toEqual({ sort: 'title', order: null });
    touchRememberedSort('view:all');
    expect(Object.keys(stored(storage) as object)).toEqual(['collection:c']);
  });

  it('drops a scope it no longer uses: the one the library\'s views once shared, Uncollected\'s', () => {
    const now = Date.now();
    storage.setItem(
      KEY,
      JSON.stringify({
        library: { sort: 'title', order: null, at: now },
        'view:uncollected': { sort: 'title', order: null, at: now },
        'view:': { sort: 'title', order: null, at: now },
        'view:reading': { sort: 'title', order: 'desc', at: now },
      }),
    );
    expect(readRememberedSort('library')).toBeNull();
    expect(readRememberedSort('view:uncollected')).toBeNull();
    touchRememberedSort('view:problem');
    expect(stored(storage)).toEqual({ 'view:reading': { sort: 'title', order: 'desc', at: now } });
  });

  it('does nothing, and throws nothing, without storage', () => {
    removeLocalStorage();
    expect(() => rememberSort('view:all', { sort: 'title', order: null })).not.toThrow();
    expect(readRememberedSort('view:all')).toBeNull();
    expect(() => touchRememberedSort('view:all')).not.toThrow();
  });

  it('keeps no older copy when storage is full', () => {
    rememberSort('view:all', { sort: 'title', order: null });
    vi.spyOn(storage, 'setItem').mockImplementation(() => {
      throw new DOMException('full', 'QuotaExceededError');
    });
    rememberSort('view:all', { sort: 'difficulty', order: null });
    expect(readRememberedSort('view:all')).toBeNull();
  });
});
