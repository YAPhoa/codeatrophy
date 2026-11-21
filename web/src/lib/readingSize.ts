import { useSyncExternalStore } from 'react';
import { readString, writeString } from './storage';

/** The size of rendered Markdown (statements, readings, notes), kept per browser like the theme. */
export type ReadingSize = 'small' | 'default' | 'large';

/** Each size's --reading-scale. tokens.css sets the same numbers; keep the two in step. */
export const READING_SCALE: Record<ReadingSize, number> = { small: 0.9, default: 1, large: 1.15 };

const KEY = 'readingSize';
const listeners = new Set<() => void>();

export function getReadingSize(): ReadingSize {
  const v = readString(KEY);
  return v === 'small' || v === 'large' ? v : 'default';
}

// markdown.css scales its sizes by --reading-scale, which tokens.css sets from this attribute.
function apply(): void {
  const size = getReadingSize();
  if (size === 'default') delete document.documentElement.dataset.readingSize;
  else document.documentElement.dataset.readingSize = size;
}

export function setReadingSize(size: ReadingSize): void {
  writeString(KEY, size);
  apply();
  listeners.forEach((fn) => fn());
}

export function initReadingSize(): void {
  apply();
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function useReadingSize(): ReadingSize {
  return useSyncExternalStore(subscribe, getReadingSize);
}
