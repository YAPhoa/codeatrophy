import { afterEach, describe, expect, it } from 'vitest';
import { readJson, writeJson } from './storage';

function fakeStorage(maxChars: number): Storage {
  const data = new Map<string, string>();
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => {
      if (v.length > maxChars) throw new DOMException('full', 'QuotaExceededError');
      data.set(k, v);
    },
    removeItem: (k: string) => void data.delete(k),
  } as unknown as Storage;
}

describe('storage', () => {
  afterEach(() => {
    Reflect.deleteProperty(globalThis, 'localStorage');
  });

  it('reads back what was written', () => {
    Object.defineProperty(globalThis, 'localStorage', { value: fakeStorage(100), configurable: true });
    writeJson('draft', { title: 'A' });
    expect(readJson('draft', null)).toEqual({ title: 'A' });
  });

  it('forgets the older copy when a write does not fit', () => {
    Object.defineProperty(globalThis, 'localStorage', { value: fakeStorage(20), configurable: true });
    writeJson('draft', { v: 1 });
    writeJson('draft', { v: 2, large: 'x'.repeat(50) });
    expect(readJson('draft', null)).toBeNull();
  });

  it('works without storage', () => {
    writeJson('draft', { v: 1 });
    expect(readJson('draft', 'none')).toBe('none');
  });
});
