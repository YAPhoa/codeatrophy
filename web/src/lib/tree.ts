// Helpers for the collection tree. The API returns collections as a flat list
// (`parentId` + `position`); the client builds and navigates the tree.

import type { Collection } from '../api/types';

export interface CollectionNode {
  collection: Collection;
  children: CollectionNode[];
  depth: number;
}

/**
 * Build the tree from the flat list. Collections whose parent is missing are
 * treated as roots, and a cycle (which the server rejects, but a client should
 * not hang on) is broken by ignoring the offending link.
 */
export function buildTree(collections: readonly Collection[]): CollectionNode[] {
  const byId = new Map<string, CollectionNode>();
  for (const c of collections) byId.set(c.id, { collection: c, children: [], depth: 0 });

  const roots: CollectionNode[] = [];
  for (const node of byId.values()) {
    const parentId = node.collection.parentId;
    const parent = parentId ? byId.get(parentId) : undefined;
    if (parent && !isAncestor(byId, node.collection.id, parent.collection.id)) parent.children.push(node);
    else roots.push(node);
  }

  const sortRec = (nodes: CollectionNode[], depth: number) => {
    nodes.sort((a, b) => a.collection.position - b.collection.position || a.collection.name.localeCompare(b.collection.name));
    for (const n of nodes) {
      n.depth = depth;
      sortRec(n.children, depth + 1);
    }
  };
  sortRec(roots, 0);
  return roots;
}

/** True if `ancestorId` is `id` itself or one of its ancestors, following parent links. */
function isAncestor(byId: Map<string, CollectionNode>, ancestorId: string, id: string): boolean {
  const seen = new Set<string>();
  let cur: string | null = id;
  while (cur && !seen.has(cur)) {
    if (cur === ancestorId) return true;
    seen.add(cur);
    cur = byId.get(cur)?.collection.parentId ?? null;
  }
  return false;
}

/** Depth-first flattening, parents before children. */
export function flattenTree(nodes: readonly CollectionNode[]): CollectionNode[] {
  const out: CollectionNode[] = [];
  const walk = (list: readonly CollectionNode[]) => {
    for (const n of list) {
      out.push(n);
      walk(n.children);
    }
  };
  walk(nodes);
  return out;
}

export function findNode(nodes: readonly CollectionNode[], id: string): CollectionNode | null {
  for (const n of nodes) {
    if (n.collection.id === id) return n;
    const hit = findNode(n.children, id);
    if (hit) return hit;
  }
  return null;
}

/** Ids of every collection below `id` (not including `id`). */
export function descendantIds(nodes: readonly CollectionNode[], id: string): string[] {
  const node = findNode(nodes, id);
  return node ? flattenTree(node.children).map((n) => n.collection.id) : [];
}

/** The chain of collections from the root down to `id`, inclusive. */
export function pathTo(collections: readonly Collection[], id: string): Collection[] {
  const byId = new Map(collections.map((c) => [c.id, c]));
  const path: Collection[] = [];
  const seen = new Set<string>();
  let cur = byId.get(id);
  while (cur && !seen.has(cur.id)) {
    path.unshift(cur);
    seen.add(cur.id);
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }
  return path;
}

export function siblingsOf(collections: readonly Collection[], id: string): Collection[] {
  const self = collections.find((c) => c.id === id);
  if (!self) return [];
  return collections.filter((c) => c.parentId === self.parentId).sort((a, b) => a.position - b.position);
}

/** Return a copy of `list` with the element at `from` moved to index `to`. */
export function moveIndex<T>(list: readonly T[], from: number, to: number): T[] {
  const out = list.slice();
  if (from < 0 || from >= out.length) return out;
  const clamped = Math.max(0, Math.min(out.length - 1, to));
  const [moved] = out.splice(from, 1);
  out.splice(clamped, 0, moved as T);
  return out;
}

/**
 * Return a copy of `ids` with `moved` placed directly after `after`, or first
 * when `after` is `null`. If `after` is not in the list the element stays
 * where it was.
 */
export function placeAfter(ids: readonly string[], moved: string, after: string | null): string[] {
  if (!ids.includes(moved) || moved === after) return ids.slice();
  if (after !== null && !ids.includes(after)) return ids.slice();
  const out = ids.filter((id) => id !== moved);
  out.splice(after === null ? 0 : out.indexOf(after) + 1, 0, moved);
  return out;
}
