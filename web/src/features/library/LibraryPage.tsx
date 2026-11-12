import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent, type MouseEvent } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, ChevronRight, Download, Folder, FolderPlus, FolderSearch, Inbox, MoreHorizontal, Pencil, Plus, SearchX, Sparkles, Trash2, Upload } from 'lucide-react';
import { api } from '../../api/client';
import { qk, useCollections, useItemPages, useMeta, useQuickUpdate, useStats, useTags } from '../../api/queries';
import type { ItemStatus, ItemSummary } from '../../api/types';
import { ITEM_STATUSES } from '../../api/types';
import { useDocumentTitle } from '../../app/useDocumentTitle';
import { DRAG_ITEMS } from '../../app/Sidebar';
import { activeFilterCount, canReorder, filtersToSearch, parseFilters, toListParams, type LibraryFilters } from '../../lib/filters';
import { plural } from '../../lib/format';
import { useHotkeys } from '../../lib/hotkeys';
import { writeString } from '../../lib/storage';
import { moveIndex, pathTo, placeAfter, siblingsOf } from '../../lib/tree';
import { Button, LinkButton, cx } from '../../ui/Button';
import { Checkbox } from '../../ui/Field';
import { MenuButton } from '../../ui/Popover';
import { EmptyState, ErrorState, PageLoading, Spinner } from '../../ui/misc';
import { useToast } from '../../ui/Toast';
import { useCollectionActions } from '../collections/CollectionActions';
import { BulkBar } from './BulkBar';
import { FilterBar } from './FilterBar';
import { ItemRow } from './ItemRow';

const nextStatus = (s: ItemStatus): ItemStatus => ITEM_STATUSES[(ITEM_STATUSES.indexOf(s) + 1) % ITEM_STATUSES.length] ?? 'todo';

/** The library: every item, or one collection, with search, filters, sorting and bulk actions. */
export function LibraryPage() {
  const { collectionId = null } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const meta = useMeta();
  const stats = useStats();
  const { data: tags = [] } = useTags();
  const collectionsQuery = useCollections();
  const collections = useMemo(() => collectionsQuery.data ?? [], [collectionsQuery.data]);
  const collectionActions = useCollectionActions();
  const quickUpdate = useQuickUpdate();

  const filters = useMemo(() => parseFilters(searchParams), [searchParams]);
  const setFilters = useCallback((next: LibraryFilters) => setSearchParams(filtersToSearch(next), { replace: true }), [setSearchParams]);

  const collection = collectionId ? (collections.find((c) => c.id === collectionId) ?? null) : null;
  const params = useMemo(() => toListParams(filters, collectionId), [filters, collectionId]);
  const reorderable = canReorder(filters, collectionId);

  const paged = useItemPages(params);

  const [orderOverride, setOrderOverride] = useState<string[] | null>(null);
  const serverItems = useMemo<ItemSummary[]>(() => paged.data?.pages.flatMap((p) => p.items) ?? [], [paged.data]);
  const items = useMemo(() => {
    if (!orderOverride) return serverItems;
    const byId = new Map(serverItems.map((it) => [it.id, it]));
    return orderOverride.map((id) => byId.get(id)).filter((it): it is ItemSummary => !!it);
  }, [serverItems, orderOverride]);
  const total = paged.data?.pages[0]?.total ?? 0;
  const query = paged;

  useEffect(() => setOrderOverride(null), [collectionId, serverItems]);

  // Remember where the user was, so item pages can link back to this exact view.
  useEffect(() => {
    writeString('library:last', window.location.pathname + window.location.search);
  }, [collectionId, searchParams]);

  // ---- Selection and keyboard position ----
  const [selection, setSelection] = useState<Set<string>>(new Set());
  const [cursor, setCursor] = useState(0);
  const anchor = useRef<number | null>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setSelection(new Set());
    anchor.current = null;
  }, [collectionId]);

  // Drop selected ids that are no longer in the list (deleted, filtered out).
  useEffect(() => {
    setSelection((prev) => {
      if (prev.size === 0) return prev;
      const present = new Set(items.map((i) => i.id));
      const next = new Set([...prev].filter((id) => present.has(id)));
      return next.size === prev.size ? prev : next;
    });
    setCursor((c) => Math.min(c, Math.max(0, items.length - 1)));
  }, [items]);

  const selectedItems = useMemo(() => items.filter((i) => selection.has(i.id)), [items, selection]);

  const onSelect = useCallback(
    (index: number, e: MouseEvent | KeyboardEvent | null) => {
      const item = items[index];
      if (!item) return;
      setSelection((prev) => {
        const next = new Set(prev);
        if (e && 'shiftKey' in e && e.shiftKey && anchor.current != null) {
          const [a, b] = [Math.min(anchor.current, index), Math.max(anchor.current, index)];
          for (let i = a; i <= b; i++) {
            const id = items[i]?.id;
            if (id) next.add(id);
          }
        } else if (next.has(item.id)) {
          next.delete(item.id);
        } else {
          next.add(item.id);
        }
        return next;
      });
      anchor.current = index;
    },
    [items],
  );

  const focusRow = useCallback((index: number) => {
    const row = listRef.current?.querySelector<HTMLElement>(`[data-row="${index}"]`);
    row?.focus();
    row?.scrollIntoView({ block: 'nearest' });
  }, []);

  // ---- Reordering inside a collection ----
  // The list shown may be one page of a long collection, while saving an
  // order needs every member id. Each move is therefore applied to the
  // server's full membership, and moves are queued so that quick successive
  // ones build on each other.
  const orderQueue = useRef<Promise<unknown>>(Promise.resolve());
  const pendingMoves = useRef(0);
  const saveMove = useCallback(
    (movedId: string, afterId: string | null) => {
      if (!collectionId) return;
      pendingMoves.current += 1;
      const step = orderQueue.current.then(async () => {
        const { itemIds } = await api.collections.itemIds(collectionId);
        await api.collections.setItems(collectionId, placeAfter(itemIds, movedId, afterId));
      });
      orderQueue.current = step.catch(() => undefined);
      step
        .catch((e: unknown) => {
          setOrderOverride(null);
          toast.error(e);
        })
        .finally(() => {
          pendingMoves.current -= 1;
          // Refresh once, after the last queued move has been saved.
          if (pendingMoves.current === 0) void qc.invalidateQueries({ queryKey: qk.items });
        });
    },
    [collectionId, qc, toast],
  );

  const moveRow = useCallback(
    (from: number, to: number) => {
      const moved = items[from];
      if (!reorderable || !moved || to < 0 || to >= items.length || from === to) return;
      const next = moveIndex(items, from, to).map((i) => i.id);
      setOrderOverride(next);
      saveMove(moved.id, to > 0 ? (next[to - 1] ?? null) : null);
      setCursor(to);
      requestAnimationFrame(() => focusRow(to));
    },
    [reorderable, items, saveMove, focusRow],
  );

  const [drag, setDrag] = useState<{ from: number; over: number; edge: 'before' | 'after' } | null>(null);
  const dragFrom = useRef<number | null>(null);

  const onDragStart = useCallback(
    (index: number, e: DragEvent) => {
      const item = items[index];
      if (!item) return;
      const ids = selection.has(item.id) ? [...selection] : [item.id];
      e.dataTransfer.setData(DRAG_ITEMS, JSON.stringify(ids));
      e.dataTransfer.setData('text/plain', item.title);
      e.dataTransfer.effectAllowed = 'copyMove';
      dragFrom.current = index;
    },
    [items, selection],
  );

  const onDragOver = useCallback(
    (index: number, e: DragEvent) => {
      if (!reorderable || dragFrom.current == null) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
      const edge = e.clientY < rect.top + rect.height / 2 ? 'before' : 'after';
      setDrag((d) => (d && d.over === index && d.edge === edge ? d : { from: dragFrom.current ?? 0, over: index, edge }));
    },
    [reorderable],
  );

  const onDrop = useCallback(
    (index: number, e: DragEvent) => {
      const from = dragFrom.current;
      if (!reorderable || from == null) return;
      e.preventDefault();
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
      const after = e.clientY >= rect.top + rect.height / 2;
      let to = index + (after ? 1 : 0);
      if (from < to) to -= 1;
      setDrag(null);
      dragFrom.current = null;
      moveRow(from, to);
    },
    [reorderable, moveRow],
  );

  const onDragEnd = useCallback(() => {
    setDrag(null);
    dragFrom.current = null;
  }, []);

  // ---- Keyboard ----
  const onListKeyDown = (e: KeyboardEvent<HTMLUListElement>) => {
    const target = e.target as HTMLElement;
    // Let menus, checkboxes and links inside a row handle their own keys.
    const onRow = target.matches('[data-row]');
    const item = items[cursor];
    if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      e.preventDefault();
      moveRow(cursor, cursor + (e.key === 'ArrowUp' ? -1 : 1));
      return;
    }
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === 'ArrowDown' || e.key === 'j') {
      e.preventDefault();
      focusRow(Math.min(items.length - 1, cursor + 1));
    } else if (e.key === 'ArrowUp' || e.key === 'k') {
      e.preventDefault();
      focusRow(Math.max(0, cursor - 1));
    } else if (e.key === 'Home' && onRow) {
      e.preventDefault();
      focusRow(0);
    } else if (e.key === 'End' && onRow) {
      e.preventDefault();
      focusRow(items.length - 1);
    } else if (!item) {
      return;
    } else if (e.key === 'Enter' && onRow) {
      e.preventDefault();
      navigate(`/items/${item.id}`);
    } else if (e.key === 'x' || (e.key === ' ' && onRow)) {
      e.preventDefault();
      onSelect(cursor, e);
    } else if (e.key === 'f') {
      e.preventDefault();
      quickUpdate.mutate({ id: item.id, change: { favorite: !item.favorite } }, { onError: (err) => toast.error(err) });
    } else if (e.key === 's') {
      e.preventDefault();
      quickUpdate.mutate({ id: item.id, change: { status: nextStatus(item.status) } }, { onError: (err) => toast.error(err) });
    }
  };

  useHotkeys({
    '/': (e) => {
      e.preventDefault();
      searchRef.current?.focus();
      searchRef.current?.select();
    },
    j: (e) => {
      if (listRef.current?.contains(document.activeElement)) return;
      e.preventDefault();
      focusRow(cursor);
    },
    k: (e) => {
      if (listRef.current?.contains(document.activeElement)) return;
      e.preventDefault();
      focusRow(cursor);
    },
    escape: () => {
      if (selection.size > 0) setSelection(new Set());
    },
  });

  // ---- Header ----
  const path = collection ? pathTo(collections, collection.id) : [];
  const children = collection ? collections.filter((c) => c.parentId === collection.id).sort((a, b) => a.position - b.position) : [];
  const siblings = collection ? siblingsOf(collections, collection.id) : [];
  const siblingIndex = collection ? siblings.findIndex((c) => c.id === collection.id) : -1;
  const title = collection
    ? collection.name
    : filters.uncollected
      ? 'Uncollected'
      : filters.favorite
        ? 'Favorites'
        : filters.type === 'problem'
          ? 'Problems'
          : filters.type === 'reading'
            ? 'Readings'
            : 'Library';
  useDocumentTitle(title);

  const filterCount = activeFilterCount(filters);
  const libraryEmpty = stats.data?.items.total === 0;
  const allSelected = items.length > 0 && items.every((i) => selection.has(i.id));
  const newHref = collection ? `/new?collection=${collection.id}` : '/new';

  if (collectionId && collectionsQuery.isSuccess && !collection) {
    return (
      <div className="page">
        <EmptyState icon={<FolderSearch size={24} />} title="This collection does not exist" actions={<LinkButton to="/">Back to the library</LinkButton>}>
          It may have been deleted. Its items, if any, are still in the library.
        </EmptyState>
      </div>
    );
  }

  return (
    <div className="page page-wide library">
      <header className="page-header">
        <div className="grow">
          {collection && (
            <nav className="crumbs" aria-label="Collection path">
              <Link to="/">Library</Link>
              {path.slice(0, -1).map((c) => (
                <span key={c.id} className="row" style={{ gap: 4 }}>
                  <ChevronRight size={12} aria-hidden="true" />
                  <Link to={`/collections/${c.id}`}>{c.name}</Link>
                </span>
              ))}
              <ChevronRight size={12} aria-hidden="true" />
            </nav>
          )}
          <h1 className="page-title">
            {title}
            <span className="page-count" aria-label={`${total} items`}>
              {query.isSuccess ? total : ''}
            </span>
          </h1>
          {collection?.description && <p className="page-sub">{collection.description}</p>}
          {filters.uncollected && !collection && <p className="page-sub">Items that are not in any collection yet.</p>}
          {children.length > 0 && (
            <div className="subcollections">
              {children.map((c) => (
                <Link key={c.id} to={`/collections/${c.id}`} className="subcollection">
                  <Folder size={13} aria-hidden="true" />
                  {c.name}
                  <span className="muted">{c.itemCount}</span>
                </Link>
              ))}
            </div>
          )}
        </div>
        {collection && (
          <MenuButton
            label="Collection actions"
            align="end"
            icon={<MoreHorizontal size={16} />}
            items={[
              { label: 'Rename or move…', icon: <Pencil size={14} />, onSelect: () => collectionActions.edit(collection) },
              { label: 'New collection inside…', icon: <FolderPlus size={14} />, onSelect: () => collectionActions.create(collection.id) },
              'separator',
              { label: 'Move up', icon: <ArrowUp size={14} />, disabled: siblingIndex <= 0, onSelect: () => collectionActions.shift(collection, -1) },
              {
                label: 'Move down',
                icon: <ArrowDown size={14} />,
                disabled: siblingIndex === -1 || siblingIndex >= siblings.length - 1,
                onSelect: () => collectionActions.shift(collection, 1),
              },
              'separator',
              { label: 'Export this collection…', icon: <Download size={14} />, onSelect: () => navigate(`/export?collection=${collection.id}`) },
              { label: 'Delete collection', icon: <Trash2 size={14} />, danger: true, onSelect: () => collectionActions.remove(collection) },
            ]}
          />
        )}
        <LinkButton to={newHref} variant="primary" icon={<Plus size={15} />}>
          New item
        </LinkButton>
      </header>

      {libraryEmpty && filterCount === 0 && !collection ? (
        <EmptyState
          icon={<Sparkles size={24} />}
          title="Your library is empty"
          actions={
            <>
              <LinkButton to="/new" variant="primary" icon={<Plus size={15} />}>
                Capture your first item
              </LinkButton>
              <LinkButton to="/import" icon={<Upload size={15} />}>
                Import a bundle
              </LinkButton>
            </>
          }
        >
          Paste a problem you half remember, or an article worth keeping.{' '}
          {meta.data?.ai.enabled
            ? 'The AI turns it into a complete entry and shows you what it assumed, and nothing is saved until you have reviewed it.'
            : 'You can write entries by hand now, and set up an AI provider in Settings to have rough notes drafted for you.'}
        </EmptyState>
      ) : (
        <>
          {selection.size > 0 ? (
            <BulkBar selected={selectedItems} collection={collection} onClear={() => setSelection(new Set())} />
          ) : (
            <FilterBar filters={filters} onChange={setFilters} tags={tags} collectionId={collectionId} searchRef={searchRef}>
              {collection && children.length > 0 && (
                <Checkbox
                  className="filter-check"
                  checked={filters.recursive}
                  onChange={(v) => setFilters({ ...filters, recursive: v })}
                  label="Include nested"
                />
              )}
            </FilterBar>
          )}

          {query.isPending ? (
            <PageLoading />
          ) : query.isError ? (
            <ErrorState error={query.error} onRetry={() => void query.refetch()} />
          ) : items.length === 0 ? (
            filterCount > 0 ? (
              <EmptyState
                icon={<SearchX size={24} />}
                title="No items match"
                actions={<Button onClick={() => setFilters({ ...filters, q: '', type: null, status: [], difficulty: [], tags: [], favorite: false, uncollected: false })}>Clear filters</Button>}
              >
                Try fewer filters or a different search.
              </EmptyState>
            ) : collection ? (
              <EmptyState
                icon={<Inbox size={24} />}
                title="Nothing in this collection yet"
                actions={
                  <>
                    <LinkButton to={newHref} variant="primary" icon={<Plus size={15} />}>
                      Capture into this collection
                    </LinkButton>
                    <LinkButton to="/">Pick from the library</LinkButton>
                  </>
                }
              >
                In the library, select items and choose “Add to collection”, or drag rows onto a collection in the sidebar.
              </EmptyState>
            ) : (
              <EmptyState icon={<Inbox size={24} />} title="Nothing here">
                No items in this view.
              </EmptyState>
            )
          ) : (
            <div className={cx('item-list-wrap', query.isPlaceholderData && 'is-stale')}>
              <div className="item-list-head">
                <span className="item-cell item-check">
                  <input
                    type="checkbox"
                    aria-label={allSelected ? 'Deselect all' : 'Select all shown'}
                    checked={allSelected}
                    ref={(el) => {
                      if (el) el.indeterminate = !allSelected && selection.size > 0;
                    }}
                    onChange={() => setSelection(allSelected ? new Set() : new Set(items.map((i) => i.id)))}
                  />
                </span>
                <span className="item-head-label">
                  {reorderable ? 'Manual order — drag rows or press Alt+↑ / Alt+↓ to rearrange' : `${plural(total, 'item')}`}
                </span>
                {query.isFetching && <Spinner size={13} label="Refreshing" />}
              </div>
              <ul className={cx('item-list', reorderable && 'is-reorderable')} ref={listRef} onKeyDown={onListKeyDown} aria-label={`${title}: items`}>
                {items.map((item, i) => (
                  <ItemRow
                    key={item.id}
                    item={item}
                    index={i}
                    selected={selection.has(item.id)}
                    current={i === cursor}
                    reorderable={reorderable}
                    dropEdge={drag && drag.over === i && drag.from !== i ? drag.edge : null}
                    onSelect={onSelect}
                    onFocusRow={setCursor}
                    onDragStart={onDragStart}
                    onDragOver={onDragOver}
                    onDrop={onDrop}
                    onDragEnd={onDragEnd}
                  />
                ))}
              </ul>
              {paged.hasNextPage && (
                <div className="item-list-more">
                  <Button busy={paged.isFetchingNextPage} onClick={() => void paged.fetchNextPage()}>
                    Load more ({total - items.length} remaining)
                  </Button>
                </div>
              )}
            </div>
          )}
        </>
      )}
      <span className="sr-only" aria-live="polite">
        {query.isSuccess ? `${total} items` : ''}
      </span>
    </div>
  );
}
