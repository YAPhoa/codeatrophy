import { ArrowDown, ArrowUp, ChevronDown } from 'lucide-react';
import type { ItemSort, SortOrder } from '../../api/types';
import { defaultOrder, directionText, effectiveSort, nextColumnSort, sortDirections, type LibraryFilters, type SortColumn } from '../../lib/filters';
import { cx } from '../../ui/Button';
import { MenuButton, type MenuEntry } from '../../ui/Popover';

const SORT_LABEL: Record<ItemSort, string> = {
  updated: 'Last updated',
  created: 'Date added',
  title: 'Title',
  difficulty: 'Difficulty',
  position: 'Manual order',
  relevance: 'Relevance',
};

interface SortProps {
  filters: LibraryFilters;
  collectionId: string | null;
  onChange: (next: LibraryFilters) => void;
}

function current(filters: LibraryFilters, collectionId: string | null): { sort: ItemSort; order: SortOrder } {
  const sort = effectiveSort(filters, collectionId);
  return { sort, order: filters.order ?? defaultOrder(sort) };
}

const Arrow = ({ order }: { order: SortOrder }) =>
  order === 'asc' ? <ArrowUp size={14} aria-hidden="true" className="sort-arrow" /> : <ArrowDown size={14} aria-hidden="true" className="sort-arrow" />;

/**
 * A column's name in the list's head, which sorts the list by it: in its
 * natural direction, then the other way, then back to the view's own order.
 * The sort in effect shows its direction by an arrow; another column shows,
 * on hover, the arrow a click would give.
 */
export function SortHeader({ column, label, filters, collectionId, onChange, className }: SortProps & { column: SortColumn; label: string; className?: string }) {
  const { sort, order } = current(filters, collectionId);
  const active = sort === column;
  const shown = active ? order : defaultOrder(column);
  const next = current(nextColumnSort(filters, collectionId, column), collectionId);
  const nextText = next.sort === column ? `Sort ${directionText(column, next.order)}` : `Back to ${SORT_LABEL[next.sort].toLowerCase()}`;
  return (
    <button
      type="button"
      className={cx('item-sort', active && 'is-active', className)}
      aria-pressed={active}
      aria-label={`Sort by ${label.toLowerCase()}, ${directionText(column, shown)}`}
      title={nextText}
      onClick={() => onChange(nextColumnSort(filters, collectionId, column))}
    >
      {label}
      <Arrow order={shown} />
    </button>
  );
}

/** The sort as a menu, for a narrow screen, where the list has no columns to name. */
export function SortMenu({ filters, collectionId, onChange }: SortProps) {
  const { sort, order } = current(filters, collectionId);
  const sorts: ItemSort[] = [
    ...(collectionId && !filters.recursive ? (['position'] as const) : []),
    ...(filters.q.trim() ? (['relevance'] as const) : []),
    'updated',
    'title',
    'difficulty',
  ];
  const directions = sortDirections(sort);
  const items: MenuEntry[] = sorts.map((s) => ({ label: SORT_LABEL[s], selected: s === sort, onSelect: () => onChange({ ...filters, sort: s, order: null }) }));
  if (directions)
    items.push('separator', ...directions.map((d) => ({ label: d.label, selected: d.order === order, onSelect: () => onChange({ ...filters, sort, order: d.order }) })));
  const direction = directionText(sort, order);
  return (
    <MenuButton
      size="sm"
      variant="ghost"
      className="item-sort-menu"
      align="end"
      menuLabel="Sort by"
      title={direction ? `Sort: ${SORT_LABEL[sort]}, ${direction}` : 'Sort'}
      items={items}
    >
      <span className="muted">Sort:</span> {SORT_LABEL[sort]}
      <ChevronDown size={12} aria-hidden="true" />
    </MenuButton>
  );
}
