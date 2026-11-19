import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent, type MouseEvent } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, ChevronRight, Download, Folder, FolderPlus, FolderSearch, Inbox, MoreHorizontal, Pencil, Plus, SearchX, Sparkles, Trash2, Upload } from 'lucide-react';
import { api } from '../../api/client';
import { qk, useCollections, useItemPage, useMeta, useQuickUpdate, useStats, useTags } from '../../api/queries';
import type { Collection, ItemStatus, ItemSummary, Stats } from '../../api/types';
import { ITEM_STATUSES } from '../../api/types';
import { useDocumentTitle } from '../../app/useDocumentTitle';
import { DRAG_ITEMS } from '../../app/Sidebar';
import { activeFilterCount, barFilterCount, canReorder, clearBarFilters, filtersToSearch, parseFilters, toListParams, type LibraryFilters } from '../../lib/filters';
import { plural } from '../../lib/format';
import { useHotkeys } from '../../lib/hotkeys';
import { exitDuration, prefersReducedMotion, useChangeCount, useLoadingShown } from '../../lib/motion';
import { isBooting } from '../../lib/boot';
import { useNewItemHref } from '../../lib/newItem';
import { parsePage, setPageSize, usePageSize, withPage } from '../../lib/paging';
import { writeString } from '../../lib/storage';
import { moveIndex, pathTo, placeAfter, siblingsOf } from '../../lib/tree';
import { Button, LinkButton, cx } from '../../ui/Button';
import { Checkbox } from '../../ui/Field';
import { MenuButton } from '../../ui/Popover';
import { NumberChange } from '../../ui/Animated';
import { EmptyState, ErrorState, Spinner } from '../../ui/misc';
import { useToast } from '../../ui/Toast';
import { useCollectionActions } from '../collections/CollectionActions';
import { BulkBar } from './BulkBar';
import { FilterBar } from './FilterBar';
import { ItemRow, detailsId } from './ItemRow';
import { Pager } from './Pager';
import { SortHeader, SortMenu } from './SortControls';

const nextStatus = (s: ItemStatus): ItemStatus => ITEM_STATUSES[(ITEM_STATUSES.indexOf(s) + 1) % ITEM_STATUSES.length] ?? 'todo';

/**
 * How many items the view lists with no bar filter, from counts already
 * loaded, or `null` where none matches the view exactly: a collection's count
 * covers direct members only, so it does not fit "Include nested", and no
 * count fits a view narrowed two ways (Favorites of one type, say).
 */
function unfilteredTotal(f: LibraryFilters, collection: Collection | null, stats: Stats | undefined): number | null {
  if (collection) return f.recursive || f.type || f.favorite ? null : collection.itemCount;
  if (!stats) return null;
  const views = (f.type ? 1 : 0) + (f.favorite ? 1 : 0) + (f.uncollected ? 1 : 0);
  if (views > 1) return null;
  if (f.type) return stats.items.byType[f.type];
  if (f.favorite) return stats.items.favorites;
  if (f.uncollected) return stats.items.uncollected;
  return stats.items.total;
}

/** How many placeholder rows a first load shows at most. */
const SKELETON_ROWS = 8;
const SKELETON_WIDTHS = ['46%', '62%', '38%', '55%', '70%', '42%', '58%', '50%'];

/** Placeholder rows in the shape of the real ones, 40px each, while the first page loads. */
function SkeletonRows({ count, leaving }: { count: number; leaving?: boolean }) {
  return (
    <ul className={cx('item-list', 'item-skeleton', leaving && 'is-leaving')} aria-hidden="true">
      {Array.from({ length: count }, (_, i) => (
        <li key={i} className="item-row">
          <span className="item-cell item-check" />
          <span className="item-cell item-status">
            <span className="skel skel-icon" />
          </span>
          <span className="item-cell item-type">
            <span className="skel skel-icon" />
          </span>
          <span className="item-main">
            <span className="skel skel-line" style={{ width: SKELETON_WIDTHS[i % SKELETON_WIDTHS.length] }} />
          </span>
          <span className="item-cell item-kind" />
          <span className="item-cell item-verdict" />
          <span className="item-cell item-updated">
            <span className="skel skel-line skel-short" />
          </span>
        </li>
      ))}
    </ul>
  );
}

/**
 * How the rows that replace the skeleton arrive: over it, with a cross-blur,
 * when it was on screen (`cross`); fading in on their own when it was still
 * hidden (`fade`). A reload keeps the app hidden until the first rows are in
 * (lib/boot.ts), and then they simply appear, as they do under reduced motion.
 */
function useSkeletonReveal(pending: boolean, skeletonShown: boolean): 'cross' | 'fade' | null {
  const [state, setState] = useState<{ pending: boolean; seen: boolean; n: number; reveal: 'cross' | 'fade' | null }>({ pending, seen: false, n: 0, reveal: null });
  let current = state;
  if (pending && skeletonShown && !current.seen) current = { ...current, seen: true };
  if (current.pending !== pending) {
    const animate = !pending && exitDuration('--duration-slow') > 0 && !isBooting();
    current = { pending, seen: false, n: current.n + 1, reveal: animate ? (current.seen ? 'cross' : 'fade') : null };
  }
  if (current !== state) setState(current);
  const { n, reveal } = current;
  useEffect(() => {
    if (!reveal) return;
    const t = window.setTimeout(() => setState((s) => (s.n === n ? { ...s, reveal: null } : s)), exitDuration(reveal === 'cross' ? '--duration-slow' : '--duration-fast'));
    return () => window.clearTimeout(t);
  }, [n, reveal]);
  return reveal;
}

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

  // One page at a time; the page is in the URL, and changing the filters or
  // the sort (setFilters) leaves it out, so they start again from the first.
  const pageSize = usePageSize();
  const page = parsePage(searchParams);
  const offset = (page - 1) * pageSize;
  const query = useItemPage(params, pageSize, offset);

  const [orderOverride, setOrderOverride] = useState<string[] | null>(null);
  const serverItems = useMemo<ItemSummary[]>(() => query.data?.items ?? [], [query.data]);
  const items = useMemo(() => {
    if (!orderOverride) return serverItems;
    const byId = new Map(serverItems.map((it) => [it.id, it]));
    return orderOverride.map((id) => byId.get(id)).filter((it): it is ItemSummary => !!it);
  }, [serverItems, orderOverride]);
  const total = query.data?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  // The skeleton, like any loading indicator, shows only once the load is slow.
  const skeletonShown = useLoadingShown(query.isPending);
  const reveal = useSkeletonReveal(query.isPending, skeletonShown);

  useEffect(() => setOrderOverride(null), [collectionId, serverItems]);

  // A page past the end (items deleted, a link kept from a longer list) shows the last one instead.
  const pastEnd = query.isSuccess && !query.isPlaceholderData && page > pageCount;
  useEffect(() => {
    if (pastEnd) setSearchParams((sp) => withPage(sp, pageCount), { replace: true });
  }, [pastEnd, pageCount, setSearchParams]);

  // Another page starts at the list's top: brought into view if it is scrolled past.
  const wrapRef = useRef<HTMLDivElement>(null);
  const shownPage = useRef(page);
  useEffect(() => {
    if (shownPage.current === page) return;
    shownPage.current = page;
    const el = wrapRef.current;
    const scroller = el?.closest('.main');
    if (el && scroller && el.getBoundingClientRect().top < scroller.getBoundingClientRect().top) {
      el.scrollIntoView({ block: 'start', behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
    }
  }, [page]);

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

  // ---- Rows opened to show their details ----
  // Kept by id, so a refetch or a reorder leaves them open; several can be.
  const [openIds, setOpenIds] = useState<Set<string>>(new Set());
  // Read through a ref, so toggling one row does not hand every row a new callback.
  const openRef = useRef(openIds);
  useEffect(() => {
    openRef.current = openIds;
  }, [openIds]);
  const toggleOpen = useCallback(
    (index: number, force?: boolean) => {
      const item = items[index];
      if (!item) return;
      const wasOpen = openRef.current.has(item.id);
      const open = force ?? !wasOpen;
      if (open === wasOpen) return;
      // Closing takes the details out of reach, so focus inside them goes back to the row.
      if (!open && document.getElementById(detailsId(item.id))?.contains(document.activeElement)) focusRow(index);
      // Opening takes the tags off the row's line, so focus on one there (or on its "+N") moves to the row's expand button.
      if (open) {
        const row = listRef.current?.querySelector(`[data-row="${index}"]`);
        if (row?.querySelector('.item-tags')?.contains(document.activeElement)) row.querySelector<HTMLElement>('.item-expand button')?.focus();
      }
      const next = new Set(openRef.current);
      if (open) next.add(item.id);
      else next.delete(item.id);
      openRef.current = next;
      setOpenIds(next);
    },
    [items, focusRow],
  );

  // ---- Reordering inside a collection ----
  // The list shown may be one page of a long collection, while saving an
  // order needs every member id. Each move is therefore applied to the
  // server's full membership, and moves are queued so that quick successive
  // ones build on each other.
  const orderQueue = useRef<Promise<unknown>>(Promise.resolve());
  const pendingMoves = useRef(0);
  // A row moved to the top of a later page goes before the one it displaced,
  // which may follow an item on the page before: it is placed after that one.
  const saveMove = useCallback(
    (movedId: string, afterId: string | null, beforeId: string | null) => {
      if (!collectionId) return;
      pendingMoves.current += 1;
      const step = orderQueue.current.then(async () => {
        const { itemIds } = await api.collections.itemIds(collectionId);
        const rest = itemIds.filter((id) => id !== movedId);
        const after = afterId ?? (beforeId ? (rest[rest.indexOf(beforeId) - 1] ?? null) : null);
        await api.collections.setItems(collectionId, placeAfter(itemIds, movedId, after));
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
      saveMove(moved.id, to > 0 ? (next[to - 1] ?? null) : null, next[to + 1] ?? null);
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
    } else if ((e.key === 'ArrowRight' || e.key === 'ArrowLeft') && onRow) {
      e.preventDefault();
      toggleOpen(cursor, e.key === 'ArrowRight');
    } else if (e.key === 'd') {
      e.preventDefault();
      toggleOpen(cursor);
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
  // A collection's name is not known until the collections load; its view is not titled "Library" meanwhile.
  const title = collection
    ? collection.name
    : collectionId
      ? ''
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
  // Readings have no verdicts, so a list of only readings has no column for them.
  const noVerdict = filters.type === 'reading';

  const sortProps = { filters, collectionId, onChange: setFilters };
  const filterCount = activeFilterCount(filters);
  const barFilters = barFilterCount(filters);
  const viewTotal = unfilteredTotal(filters, collection, stats.data);
  const libraryEmpty = stats.data?.items.total === 0;
  const allSelected = items.length > 0 && items.every((i) => selection.has(i.id));
  const newHref = useNewItemHref();
  const skeletonRows = Math.max(1, Math.min(viewTotal ?? SKELETON_ROWS, SKELETON_ROWS));
  // The selection bar and the filter bar take turns; the one coming in fades in, after the first swap only.
  const barSwapped = useChangeCount(selection.size > 0) > 0;

  if (collectionId && collectionsQuery.isSuccess && !collection) {
    return (
      <div className="page">
        <EmptyState icon={<FolderSearch size={20} />} page title="This collection does not exist" actions={<LinkButton to="/">Back to the library</LinkButton>}>
          It may have been deleted. Its items, if any, are still in the library.
        </EmptyState>
      </div>
    );
  }

  return (
    <div className="page page-wide library">
      <header className="page-header">
        <div className="grow">
          {path.length > 1 && (
            <nav className="crumbs" aria-label="Collection path">
              {path.slice(0, -1).map((c, i) => (
                <span key={c.id} className="row row-tight">
                  {i > 0 && <ChevronRight size={12} aria-hidden="true" />}
                  <Link to={`/collections/${c.id}`}>{c.name}</Link>
                </span>
              ))}
              <ChevronRight size={12} aria-hidden="true" />
            </nav>
          )}
          <h1 className="page-title">
            {title || '\u00a0'}
            <span className="page-count">
              {query.isSuccess && (
                <>
                  <span aria-hidden="true">
                    <NumberChange value={total} />
                  </span>
                  <span className="sr-only">, {plural(total, 'item')}</span>
                </>
              )}
            </span>
          </h1>
          {collection?.description && <p className="page-sub">{collection.description}</p>}
          {filters.uncollected && !collection && <p className="page-sub">Items that are not in any collection yet.</p>}
          {children.length > 0 && (
            <div className="subcollections">
              {children.map((c) => (
                <Link key={c.id} to={`/collections/${c.id}`} className="subcollection">
                  <Folder size={14} aria-hidden="true" />
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
              { label: 'Export this collection…', icon: <Download size={14} />, to: `/settings/export?collection=${collection.id}` },
              { label: 'Delete collection', icon: <Trash2 size={14} />, danger: true, onSelect: () => collectionActions.remove(collection) },
            ]}
          />
        )}
      </header>

      {libraryEmpty && filterCount === 0 && !collection ? (
        <EmptyState
          icon={<Sparkles size={20} />}
          title="Your library is empty"
          actions={
            <>
              <LinkButton to="/new" variant="primary" icon={<Plus size={16} />}>
                Capture your first item
              </LinkButton>
              <LinkButton to="/settings/import" icon={<Upload size={16} />}>
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
            <BulkBar selected={selectedItems} collection={collection} onClear={() => setSelection(new Set())} className={cx(barSwapped && 'is-swapped-in')} />
          ) : (
            <FilterBar
              filters={filters}
              onChange={setFilters}
              tags={tags}
              collectionId={collectionId}
              searchRef={searchRef}
              className={cx(barSwapped && 'is-swapped-in')}
            >
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
            <div className={cx('item-list-wrap', noVerdict && 'no-verdict', 'loading-delay', !skeletonShown && 'is-pending')} role="status">
              <div className="item-list-head">
                <span className="item-cell item-check">
                  <span className="skel skel-box" />
                </span>
                <span className="item-head-label">Loading…</span>
              </div>
              <div className="item-list-body">
                <SkeletonRows count={skeletonRows} />
              </div>
            </div>
          ) : query.isError ? (
            <ErrorState error={query.error} onRetry={() => void query.refetch()} />
          ) : items.length === 0 ? (
            barFilters > 0 ? (
              <EmptyState
                icon={<SearchX size={20} />}
                title="No items match"
                actions={<Button onClick={() => setFilters(clearBarFilters(filters))}>Clear filters</Button>}
              >
                Try fewer filters or a different search.
              </EmptyState>
            ) : collection ? (
              <EmptyState
                icon={<Inbox size={20} />}
                title="Nothing in this collection yet"
                actions={
                  <>
                    <LinkButton to={newHref} variant="primary" icon={<Plus size={16} />}>
                      Capture into this collection
                    </LinkButton>
                    <LinkButton to="/">Pick from the library</LinkButton>
                  </>
                }
              >
                In the library, select items and choose “Add to collection”, or drag rows onto a collection in the sidebar.
              </EmptyState>
            ) : (
              <EmptyState icon={<Inbox size={20} />} title="Nothing here">
                No items in this view.
              </EmptyState>
            )
          ) : (
            <div ref={wrapRef} className={cx('item-list-wrap', reorderable && 'is-reorderable', noVerdict && 'no-verdict', query.isPlaceholderData && 'is-stale')}>
              {/* Always shown, so selecting a row or filtering never pushes the list down. */}
              <div className="item-list-head">
                <span className="item-cell item-check">
                  <input
                    type="checkbox"
                    aria-label={allSelected ? 'Deselect all' : 'Select all on this page'}
                    checked={allSelected}
                    ref={(el) => {
                      if (el) el.indeterminate = !allSelected && selection.size > 0;
                    }}
                    onChange={() => setSelection(allSelected ? new Set() : new Set(items.map((i) => i.id)))}
                  />
                </span>
                {/* The columns' names sort the list; a narrow screen, with no columns, has a menu instead. */}
                <SortHeader column="title" label="Title" className="is-title" {...sortProps} />
                <SortHeader column="difficulty" label="Difficulty" className="is-kind" {...sortProps} />
                {!noVerdict && (
                  <span className="item-col-head is-verdict" aria-hidden="true">
                    Verdict
                  </span>
                )}
                <SortHeader column="updated" label="Updated" className="is-updated" {...sortProps} />
                <SortMenu {...sortProps} />
                {query.isFetching && <Spinner size={14} label="Refreshing…" />}
              </div>
              <div className="item-list-body">
                <ul
                  className={cx('item-list', reorderable && 'is-reorderable', selection.size > 0 && 'is-selecting', reveal === 'cross' && 'is-revealing', reveal === 'fade' && 'is-arriving')}
                  ref={listRef}
                  onKeyDown={onListKeyDown}
                  aria-label={`${title}: items`}
                >
                  {items.map((item, i) => (
                    <ItemRow
                      key={item.id}
                      item={item}
                      index={i}
                      selected={selection.has(item.id)}
                      current={i === cursor}
                      reorderable={reorderable}
                      open={openIds.has(item.id)}
                      dropEdge={drag && drag.over === i && drag.from !== i ? drag.edge : null}
                      onSelect={onSelect}
                      onToggleOpen={toggleOpen}
                      onFocusRow={setCursor}
                      onDragStart={onDragStart}
                      onDragOver={onDragOver}
                      onDrop={onDrop}
                      onDragEnd={onDragEnd}
                    />
                  ))}
                </ul>
                {reveal === 'cross' && <SkeletonRows count={skeletonRows} leaving />}
              </div>
              <div className="item-list-foot">
                {reorderable && <p className="item-list-hint">Drag rows or press Alt+↑ / Alt+↓ to reorder.</p>}
                <Pager
                  page={page}
                  pageCount={pageCount}
                  offset={offset}
                  shown={serverItems.length}
                  total={total}
                  pageSize={pageSize}
                  onPageSize={(size) => {
                    setPageSize(size);
                    setSearchParams((sp) => withPage(sp, 1), { replace: true });
                  }}
                />
              </div>
            </div>
          )}
        </>
      )}
      <span className="sr-only" aria-live="polite">
        {query.isSuccess ? plural(total, 'item') : ''}
      </span>
    </div>
  );
}
