// Thin, failure-tolerant wrappers around localStorage. Storage can be
// unavailable (private mode, quota) and stored JSON can be stale or corrupt;
// neither should ever break the UI.

const PREFIX = 'codeatrophy:';

function store(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

export function readJson<T>(key: string, fallback: T): T {
  const raw = store()?.getItem(PREFIX + key);
  if (raw == null) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function writeJson(key: string, value: unknown): void {
  try {
    store()?.setItem(PREFIX + key, JSON.stringify(value));
  } catch {
    // Quota exceeded or storage disabled: the value simply is not remembered.
  }
}

export function readString(key: string): string | null {
  try {
    return store()?.getItem(PREFIX + key) ?? null;
  } catch {
    return null;
  }
}

export function writeString(key: string, value: string): void {
  try {
    store()?.setItem(PREFIX + key, value);
  } catch {
    // See writeJson.
  }
}

export function remove(key: string): void {
  try {
    store()?.removeItem(PREFIX + key);
  } catch {
    // Nothing to do.
  }
}
