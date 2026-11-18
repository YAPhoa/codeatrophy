import { useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import { ChevronDown, Search, X } from 'lucide-react';
import type { Difficulty, ItemSort, ItemStatus, Tag } from '../../api/types';
import { DIFFICULTY_LABEL, STATUS_LABEL } from '../../lib/format';
import { barFilterCount, clearBarFilters, defaultOrder, effectiveSort, sortDirections, toggleIn, viewNoun, type LibraryFilters } from '../../lib/filters';
import { IconSwap, NumberChange } from '../../ui/Animated';
import { Button, IconButton, cx } from '../../ui/Button';
import { MenuButton, Popover, type MenuEntry } from '../../ui/Popover';
import { StatusIcon } from '../item/controls';

interface FilterBarProps {
  filters: LibraryFilters;
  onChange: (next: LibraryFilters) => void;
  tags: readonly Tag[];
  collectionId: string | null;
  searchRef: RefObject<HTMLInputElement | null>;
  /** Extra view-specific controls, placed after the standard filters. */
  children?: ReactNode;
  className?: string;
}

const SORT_LABEL: Record<ItemSort, string> = {
  updated: 'Last updated',
  created: 'Date added',
  title: 'Title',
  difficulty: 'Difficulty',
  position: 'Manual order',
  relevance: 'Relevance',
};

function FilterButton({ label, count, children }: { label: string; count: number; children: (close: () => void) => ReactNode }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  return (
    <>
      <Button
        ref={ref}
        size="sm"
        className={cx('filter-btn', count > 0 && 'is-active')}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        {label}
        {/* The count takes the chevron's place, so the button keeps its width when a filter is set. */}
        <IconSwap swapKey={count > 0} className="filter-slot">
          {count > 0 ? <span className="filter-count">{count > 9 ? '9+' : <NumberChange value={count} />}</span> : <ChevronDown size={12} aria-hidden="true" />}
        </IconSwap>
      </Button>
      <Popover anchorRef={ref} open={open} onClose={() => setOpen(false)} role="dialog" label={label} className="popover-panel filter-pop">
        {children(() => setOpen(false))}
      </Popover>
    </>
  );
}

/** Search box plus the filter and sort controls of the library. The type and Favorites are picked in the sidebar. */
export function FilterBar({ filters, onChange, tags, collectionId, searchRef, children, className }: FilterBarProps) {
  // The search text is debounced into the URL so typing does not fire a request per keystroke.
  const [text, setText] = useState(filters.q);
  const lastPushed = useRef(filters.q);
  useEffect(() => {
    if (filters.q !== lastPushed.current) {
      lastPushed.current = filters.q;
      setText(filters.q);
    }
  }, [filters.q]);
  useEffect(() => {
    if (text === lastPushed.current) return;
    const t = window.setTimeout(() => {
      lastPushed.current = text;
      onChange({ ...filters, q: text });
    }, 220);
    return () => window.clearTimeout(t);
    // Only the text should restart the timer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text]);

  const [tagFilter, setTagFilter] = useState('');
  const visibleTags = useMemo(() => {
    const q = tagFilter.trim().toLowerCase();
    return q ? tags.filter((t) => t.name.includes(q)) : tags;
  }, [tags, tagFilter]);

  const sort = effectiveSort(filters, collectionId);
  const order = filters.order ?? defaultOrder(sort);
  const hasQuery = filters.q.trim() !== '';
  const sorts: ItemSort[] = [
    ...(collectionId && !filters.recursive ? (['position'] as const) : []),
    ...(hasQuery ? (['relevance'] as const) : []),
    'updated',
    'created',
    'title',
    'difficulty',
  ];
  const active = barFilterCount(filters);
  const directions = sortDirections(sort);
  const direction = directions?.find((d) => d.order === order);
  const sortItems: MenuEntry[] = sorts.map((s) => ({
    label: SORT_LABEL[s],
    selected: s === sort,
    onSelect: () => onChange({ ...filters, sort: s, order: null }),
  }));
  if (directions) {
    sortItems.push(
      'separator',
      ...directions.map((d) => ({ label: d.label, selected: d.order === order, onSelect: () => onChange({ ...filters, sort, order: d.order }) })),
    );
  }
  // Names the view so the box is not taken for the search of the whole library (Ctrl+K).
  const noun = viewNoun(filters, collectionId);

  return (
    <div className={cx('filterbar', className)} role="search" aria-label="Filter items">
      <div className="filter-search">
        <Search size={14} aria-hidden="true" />
        <input
          name="q"
          autoComplete="off"
          ref={searchRef}
          type="search"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={`Filter ${noun}…`}
          aria-label={`Filter ${noun}`}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              if (text) setText('');
              else e.currentTarget.blur();
            }
          }}
        />
        {text && <IconButton size="sm" label="Clear search" icon={<X size={14} />} onClick={() => setText('')} />}
      </div>

      <FilterButton label="Status" count={filters.status.length}>
        {() => (
          <div className="picklist">
            {(['todo', 'in_progress', 'done'] as ItemStatus[]).map((s) => (
              <label key={s} className="picklist-item">
                <input type="checkbox" checked={filters.status.includes(s)} onChange={() => onChange({ ...filters, status: toggleIn(filters.status, s) })} />
                <StatusIcon status={s} size={14} />
                {STATUS_LABEL[s]}
              </label>
            ))}
          </div>
        )}
      </FilterButton>

      <FilterButton label="Difficulty" count={filters.difficulty.length}>
        {() => (
          <div className="picklist">
            {(['easy', 'medium', 'hard', 'none'] as (Difficulty | 'none')[]).map((d) => (
              <label key={d} className="picklist-item">
                <input
                  type="checkbox"
                  checked={filters.difficulty.includes(d)}
                  onChange={() => onChange({ ...filters, difficulty: toggleIn(filters.difficulty, d) })}
                />
                {d === 'none' ? 'Not set' : DIFFICULTY_LABEL[d]}
              </label>
            ))}
          </div>
        )}
      </FilterButton>

      <FilterButton label="Tags" count={filters.tags.length}>
        {() => (
          <>
            {tags.length > 8 && (
              <input
                name="tag-filter"
                autoComplete="off"
                className="input input-sm picklist-filter"
                placeholder="Filter tags…"
                aria-label="Filter tags"
                value={tagFilter}
                onChange={(e) => setTagFilter(e.target.value)}
                data-autofocus
              />
            )}
            {tags.length === 0 ? (
              <p className="muted">No tags yet. Add tags when capturing or editing an item.</p>
            ) : (
              <div className="picklist">
                {visibleTags.map((t) => (
                  <label key={t.name} className="picklist-item">
                    <input type="checkbox" checked={filters.tags.includes(t.name)} onChange={() => onChange({ ...filters, tags: toggleIn(filters.tags, t.name) })} />
                    <span className="truncate">{t.name}</span>
                    <span className="picklist-count">{t.count}</span>
                  </label>
                ))}
                {visibleTags.length === 0 && <p className="muted picklist-empty">No match.</p>}
              </div>
            )}
            {filters.tags.length > 1 && <p className="field-hint picklist-note">Showing items that have all selected tags.</p>}
          </>
        )}
      </FilterButton>

      {children}

      {/* Kept in place while hidden, so its appearing cannot wrap the bar. */}
      <Button
        size="sm"
        variant="ghost"
        icon={<X size={14} />}
        className={cx('filter-clear', active === 0 && 'is-idle')}
        tabIndex={active > 0 ? undefined : -1}
        aria-hidden={active > 0 ? undefined : true}
        onClick={() => {
          setText('');
          lastPushed.current = '';
          onChange(clearBarFilters(filters));
        }}
      >
        Clear filters
      </Button>

      <span className="spacer" />

      <MenuButton
        size="sm"
        className="filter-btn"
        align="end"
        menuLabel="Sort by"
        title={direction ? `Sort: ${SORT_LABEL[sort]}, ${direction.label.replace(/^[A-Z](?=[a-z])/, (c) => c.toLowerCase())}` : 'Sort'}
        items={sortItems}
      >
        <span className="muted">Sort:</span> {SORT_LABEL[sort]}
        <ChevronDown size={12} aria-hidden="true" />
      </MenuButton>
    </div>
  );
}
