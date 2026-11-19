import { useSyncExternalStore } from 'react';
import { readString, writeString } from './storage';

// The library lists one page at a time. The page is in the URL (`page=`,
// left out for the first), so back, forward and reload keep it; how many
// items a page holds is kept per browser.

export const PAGE_SIZES = [25, 50, 100, 200] as const;
export type PageSize = (typeof PAGE_SIZES)[number];
const DEFAULT_PAGE_SIZE: PageSize = 50;

const KEY = 'libraryPageSize';
const listeners = new Set<() => void>();

export function getPageSize(): PageSize {
  const n = Number(readString(KEY));
  return (PAGE_SIZES as readonly number[]).includes(n) ? (n as PageSize) : DEFAULT_PAGE_SIZE;
}

export function setPageSize(size: PageSize): void {
  writeString(KEY, String(size));
  listeners.forEach((fn) => fn());
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function usePageSize(): PageSize {
  return useSyncExternalStore(subscribe, getPageSize);
}

/** The page a URL asks for: a whole number from 1, and 1 for anything else. */
export function parsePage(sp: URLSearchParams): number {
  const n = Number(sp.get('page'));
  return Number.isInteger(n) && n > 1 ? n : 1;
}

/** `sp` with its page set to `page`, which the URL leaves out for the first. */
export function withPage(sp: URLSearchParams, page: number): URLSearchParams {
  const next = new URLSearchParams(sp);
  if (page > 1) next.set('page', String(page));
  else next.delete('page');
  return next;
}

/**
 * The page numbers a pager shows: the first and last, the current one and
 * its neighbours, and `gap` for each run left out. A gap never stands for a
 * single page, which is shown instead: 1 … 4 5 6 … 12, 1 2 3 4 5 … 12.
 */
export function pageList(current: number, count: number): (number | 'gap')[] {
  const shown = new Set([1, count, current - 1, current, current + 1].filter((n) => n >= 1 && n <= count));
  // Near either end, keep five numbers together rather than a gap of one.
  if (current <= 4) for (let n = 1; n <= Math.min(5, count); n++) shown.add(n);
  if (current >= count - 3) for (let n = Math.max(1, count - 4); n <= count; n++) shown.add(n);
  const sorted = [...shown].sort((a, b) => a - b);
  const out: (number | 'gap')[] = [];
  for (const [i, n] of sorted.entries()) {
    const prev = sorted[i - 1];
    if (prev != null && n - prev === 2) out.push(prev + 1);
    else if (prev != null && n - prev > 2) out.push('gap');
    out.push(n);
  }
  return out;
}
