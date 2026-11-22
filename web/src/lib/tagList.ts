import { useSyncExternalStore } from 'react';
import type { SortOrder, Tag } from '../api/types';
import { readString, writeString } from './storage';

// The Tags page lists the tags by name or by how many items carry them. The
// sort is in the URL (`sort=items`, and `order=` when it is not the column's
// natural direction), left out for the default, by name from A to Z. As in
// the library (filters.ts, "The remembered sort"), the sort last chosen is
// remembered in this browser (sortStore.ts) and stands in for a URL that
// names none; a URL that names one wins. Whether empty tags are hidden is
// kept per browser; they are, unless asked.

export const TAG_SORTS = ['name', 'items'] as const;
export type TagSort = (typeof TAG_SORTS)[number];

export interface TagOrder {
  sort: TagSort;
  order: SortOrder;
}

export const DEFAULT_TAG_ORDER: TagOrder = { sort: 'name', order: 'asc' };

/** A column's natural direction: names from A to Z, counts the most first. */
export const naturalTagOrder = (sort: TagSort): SortOrder => (sort === 'name' ? 'asc' : 'desc');

/** A sort as remembered: `order` is `null` for the column's natural direction. */
export interface RememberedTagSort {
  sort: TagSort;
  order: SortOrder | null;
}

/** The sort the URL names: `sort=` and `order=`, each `null` when left out. */
export interface TagSortParams {
  sort: TagSort | null;
  order: SortOrder | null;
}

/** The order the page shows: the URL's when it names one, else the remembered one, else the default. */
export function shownTagOrder(url: TagSortParams, remembered: RememberedTagSort | null): TagOrder {
  const named = url.sort !== null || url.order !== null ? url : remembered;
  if (!named) return DEFAULT_TAG_ORDER;
  const sort = named.sort ?? DEFAULT_TAG_ORDER.sort;
  return { sort, order: named.order ?? naturalTagOrder(sort) };
}

/**
 * What choosing `next` writes: the URL's parameters, and the sort to
 * remember. The default is left out of the URL and forgets the remembered
 * sort; any other goes into the URL as it always has, and is remembered.
 */
export function tagSortChange(next: TagOrder): { url: TagSortParams; remember: RememberedTagSort | null } {
  if (next.sort === DEFAULT_TAG_ORDER.sort && next.order === DEFAULT_TAG_ORDER.order) return { url: { sort: null, order: null }, remember: null };
  const order = next.order === naturalTagOrder(next.sort) ? null : next.order;
  return { url: { sort: next.sort === DEFAULT_TAG_ORDER.sort ? null : next.sort, order }, remember: { sort: next.sort, order } };
}

/** A direction in words, as an accessible name says it. */
export function tagDirectionText(sort: TagSort, order: SortOrder): string {
  if (sort === 'name') return order === 'asc' ? 'A to Z' : 'Z to A';
  return order === 'desc' ? 'most first' : 'fewest first';
}

/**
 * The order after a click on a column's name: by it in its natural
 * direction, then the other way, then back to the default. For the name,
 * which is the default, that is A to Z and Z to A in turn.
 */
export function nextTagOrder(current: TagOrder, column: TagSort): TagOrder {
  if (current.sort !== column) return { sort: column, order: naturalTagOrder(column) };
  if (current.order === naturalTagOrder(column)) return { sort: column, order: current.order === 'asc' ? 'desc' : 'asc' };
  return DEFAULT_TAG_ORDER;
}

// Byte-wise, as the server orders names.
const byName = (a: Tag, b: Tag) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

/** The tags in that order; tags with as many items go by name, from A to Z. */
export function sortTags(tags: readonly Tag[], { sort, order }: TagOrder): Tag[] {
  const sign = order === 'asc' ? 1 : -1;
  return [...tags].sort((a, b) => (sort === 'name' ? sign * byName(a, b) : sign * (a.count - b.count) || byName(a, b)));
}

const HIDE_EMPTY_KEY = 'tagsHideEmpty';
const listeners = new Set<() => void>();

export function getHideEmptyTags(): boolean {
  return readString(HIDE_EMPTY_KEY) !== 'false';
}

export function setHideEmptyTags(hide: boolean): void {
  writeString(HIDE_EMPTY_KEY, String(hide));
  listeners.forEach((fn) => fn());
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function useHideEmptyTags(): boolean {
  return useSyncExternalStore(subscribe, getHideEmptyTags);
}
