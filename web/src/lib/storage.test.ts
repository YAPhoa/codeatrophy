import { afterEach, describe, expect, it } from 'vitest';
import { fakeStorage, installLocalStorage, removeLocalStorage } from '../test/fakeStorage';
import { readJson, writeJson } from './storage';

describe('storage', () => {
  afterEach(removeLocalStorage);

  it('reads back what was written', () => {
    installLocalStorage(fakeStorage(100));
    writeJson('draft', { title: 'A' });
    expect(readJson('draft', null)).toEqual({ title: 'A' });
  });

  it('forgets the older copy when a write does not fit', () => {
    installLocalStorage(fakeStorage(20));
    writeJson('draft', { v: 1 });
    writeJson('draft', { v: 2, large: 'x'.repeat(50) });
    expect(readJson('draft', null)).toBeNull();
  });

  it('works without storage', () => {
    writeJson('draft', { v: 1 });
    expect(readJson('draft', 'none')).toBe('none');
  });
});
