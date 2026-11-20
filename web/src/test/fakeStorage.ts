// An in-memory Storage for tests, which run in node where there is none.

import { afterEach, beforeEach } from 'vitest';

/**
 * A minimal in-memory Storage. A write of a value longer than `maxChars`
 * fails as a full browser storage does.
 */
export function fakeStorage(maxChars = Infinity): Storage {
  const data = new Map<string, string>();
  return {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (k) => data.get(k) ?? null,
    key: (i) => [...data.keys()][i] ?? null,
    removeItem: (k) => void data.delete(k),
    setItem: (k, v) => {
      const value = String(v);
      if (value.length > maxChars) throw new DOMException('full', 'QuotaExceededError');
      data.set(k, value);
    },
  };
}

/** Make `storage` the global localStorage, until `removeLocalStorage`. */
export function installLocalStorage(storage: Storage = fakeStorage()): Storage {
  Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true });
  return storage;
}

/** Take the global localStorage away again, as node has none. */
export function removeLocalStorage(): void {
  Reflect.deleteProperty(globalThis, 'localStorage');
}

/** Give each test of the enclosing block an empty localStorage of its own. */
export function withFakeLocalStorage(): void {
  beforeEach(() => void installLocalStorage());
  afterEach(removeLocalStorage);
}
