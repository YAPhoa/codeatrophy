import { useEffect, useMemo, useSyncExternalStore } from 'react';
import type { ItemSort, SortOrder } from '../api/types';
import type { RememberedSort } from './filters';
import { readString, remove, writeJson } from './storage';

// The library's remembered sorts (filters.ts, "The remembered sort"), kept
// in this browser under one key, by scope (`sortScope`):
//   { "view:problem": { "sort": "title", "order": null, "at": 1763750000000 }, "collection:<id>": … }
// `at` is the last visit to the scope's view, in ms. An entry lasts 30 days
// from it, so the sorts of collections no longer opened go on their own;
// anything expired, unreadable or invalid is ignored, and dropped at the
// next write. So is a scope no longer used: `library`, which the sidebar's
// views once shared, or `view:uncollected`, a view no longer there.

const KEY = 'librarySort';
export const SORT_TTL_MS = 30 * 24 * 60 * 60 * 1000;

interface Entry extends RememberedSort {
  at: number;
}

// Relevance is never remembered: it is a search's own order.
const SORTS: readonly string[] = ['updated', 'created', 'title', 'difficulty', 'position'];

const SCOPE = /^(view:(all|problem|reading|favorite)|collection:.+)$/;

function alive(e: unknown, now: number): e is Entry {
  if (!e || typeof e !== 'object') return false;
  const { sort, order, at } = e as Record<string, unknown>;
  return (
    typeof sort === 'string' &&
    SORTS.includes(sort) &&
    (order === null || order === 'asc' || order === 'desc') &&
    typeof at === 'number' &&
    Number.isFinite(at) &&
    now - at <= SORT_TTL_MS
  );
}

/** The entries alive at `now`, and whether storage holds anything else (to drop it). */
function load(now: number): { entries: Record<string, Entry>; stale: boolean } {
  const raw = readString(KEY);
  if (raw == null) return { entries: {}, stale: false };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { entries: {}, stale: true };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { entries: {}, stale: true };
  const entries: Record<string, Entry> = {};
  let stale = false;
  for (const [scope, e] of Object.entries(parsed)) {
    if (SCOPE.test(scope) && alive(e, now)) entries[scope] = { sort: e.sort as ItemSort, order: e.order as SortOrder | null, at: e.at };
    else stale = true;
  }
  return { entries, stale };
}

const listeners = new Set<() => void>();

function save(entries: Record<string, Entry>): void {
  if (Object.keys(entries).length === 0) remove(KEY);
  else writeJson(KEY, entries);
  listeners.forEach((fn) => fn());
}

/** The sort remembered for a scope, or `null`. */
export function readRememberedSort(scope: string, now = Date.now()): RememberedSort | null {
  const e = load(now).entries[scope];
  return e ? { sort: e.sort, order: e.order } : null;
}

/** Remember a scope's sort, or forget it (`null`). */
export function rememberSort(scope: string, sort: RememberedSort | null, now = Date.now()): void {
  const { entries } = load(now);
  if (sort) entries[scope] = { sort: sort.sort, order: sort.order, at: now };
  else delete entries[scope];
  save(entries);
}

/** A visit to a scope's view: its entry's 30 days start again, and expired ones go. */
export function touchRememberedSort(scope: string, now = Date.now()): void {
  const { entries, stale } = load(now);
  const e = entries[scope];
  if (e) entries[scope] = { ...e, at: now };
  if (e || stale) save(entries);
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// As one string, which React can compare from one read to the next.
const encode = (s: RememberedSort | null) => (s ? `${s.sort} ${s.order ?? ''}` : '');

function decode(text: string): RememberedSort | null {
  if (!text) return null;
  const [sort, order] = text.split(' ');
  return { sort: sort as ItemSort, order: order ? (order as SortOrder) : null };
}

/** The sort remembered for a scope; opening the scope's view counts as a visit. */
export function useRememberedSort(scope: string): RememberedSort | null {
  useEffect(() => touchRememberedSort(scope), [scope]);
  const text = useSyncExternalStore(subscribe, () => encode(readRememberedSort(scope)));
  return useMemo(() => decode(text), [text]);
}
