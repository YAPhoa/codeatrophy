import { useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import { ArrowDownAZ, ArrowUpAZ, ChevronDown, Search, Star, X } from 'lucide-react';
import type { Difficulty, ItemSort, ItemStatus, Tag } from '../../api/types';
import { DIFFICULTY_LABEL, STATUS_LABEL } from '../../lib/format';
import { activeFilterCount, defaultOrder, effectiveSort, toggleIn, type LibraryFilters } from '../../lib/filters';
import { Button, IconButton, cx } from '../../ui/Button';
import { Segmented } from '../../ui/Field';
import { MenuButton, Popover } from '../../ui/Popover';
import { StatusIcon } from '../item/controls';

interface FilterBarProps {
  filters: LibraryFilters;
  onChange: (next: LibraryFilters) => void;
  tags: readonly Tag[];
  collectionId: string | null;
  searchRef: RefObject<HTMLInputElement | null>;
  /** Extra view-specific controls, placed after the standard filters. */
  children?: ReactNode;
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
        {count > 0 && <span className="filter-count">{count}</span>}
        <ChevronDown size={12} aria-hidden="true" />
      </Button>
      <Popover anchorRef={ref} open={open} onClose={() => setOpen(false)} role="dialog" label={label} className="popover-panel filter-pop">
        {children(() => setOpen(false))}
      </Popover>
    </>
  );
}

/** Search box plus the filter and sort controls of the library. */
export function FilterBar({ filters, onChange, tags, collectionId, searchRef, children }: FilterBarProps) {
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
  const active = activeFilterCount(filters);

  return (
    <div className="filterbar" role="search" aria-label="Filter items">
      <div className="filter-search">
        <Search size={14} aria-hidden="true" />
        <input
          name="q"
          autoComplete="off"
          ref={searchRef}
          type="search"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Search titles, text and tags…"
          aria-label="Search items"
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              if (text) setText('');
              else e.currentTarget.blur();
            }
          }}
        />
        {text && <IconButton size="sm" label="Clear search" icon={<X size={14} />} onClick={() => setText('')} />}
      </div>

      <Segmented
        size="sm"
        label="Type"
        value={filters.type ?? 'all'}
        onChange={(v) => onChange({ ...filters, type: v === 'all' ? null : v })}
        options={[
          { value: 'all', label: 'All' },
          { value: 'problem', label: 'Problems' },
          { value: 'reading', label: 'Readings' },
        ]}
      />

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

      <Button
        size="sm"
        className={cx('filter-btn', filters.favorite && 'is-active')}
        aria-pressed={filters.favorite}
        icon={<Star size={14} fill={filters.favorite ? 'currentColor' : 'none'} />}
        onClick={() => onChange({ ...filters, favorite: !filters.favorite })}
      >
        Favorites
      </Button>

      {children}

      {active > 0 && (
        <Button
          size="sm"
          variant="ghost"
          icon={<X size={14} />}
          onClick={() => {
            setText('');
            lastPushed.current = '';
            onChange({ ...filters, q: '', type: null, status: [], difficulty: [], tags: [], favorite: false, uncollected: false });
          }}
        >
          Clear
        </Button>
      )}

      <span className="spacer" />

      <MenuButton
        size="sm"
        variant="ghost"
        align="end"
        menuLabel="Sort by"
        title="Sort"
        items={sorts.map((s) => ({
          label: SORT_LABEL[s],
          hint: s === sort ? 'current' : undefined,
          onSelect: () => onChange({ ...filters, sort: s, order: null }),
        }))}
      >
        <span className="muted">Sort:</span> {SORT_LABEL[sort]}
      </MenuButton>
      {sort !== 'position' && sort !== 'relevance' && (
        <IconButton
          size="sm"
          label={order === 'asc' ? 'Ascending — switch to descending' : 'Descending — switch to ascending'}
          icon={order === 'asc' ? <ArrowDownAZ size={16} /> : <ArrowUpAZ size={16} />}
          onClick={() => onChange({ ...filters, sort, order: order === 'asc' ? 'desc' : 'asc' })}
        />
      )}
    </div>
  );
}
