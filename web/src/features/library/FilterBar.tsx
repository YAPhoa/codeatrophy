import { useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import { ChevronDown, Search, X } from 'lucide-react';
import { useItemFacets } from '../../api/queries';
import { ITEM_STATUSES, type Difficulty, type Tag } from '../../api/types';
import { DIFFICULTY_LABEL, STATUS_LABEL } from '../../lib/format';
import { barFilterCount, clearBarFilters, toListParams, viewNoun, type LibraryFilters } from '../../lib/filters';
import { IconSwap, NumberChange } from '../../ui/Animated';
import { Button, IconButton, cx } from '../../ui/Button';
import { Popover } from '../../ui/Popover';
import { StatusIcon } from '../item/controls';
import { FacetList } from './FacetList';

const DIFFICULTY_VALUES: readonly (Difficulty | 'none')[] = ['easy', 'medium', 'hard', 'none'];

/** How many tags the Tags menu lists before any is typed. */
const TAG_PREVIEW = 5;

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

/** Search box plus the filters of the library. The type and Favorites are picked in the sidebar; the list's head sorts it. */
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

  // Eager, so a menu opens on its counts; each dimension's counts ignore its own filter.
  const facets = useItemFacets(useMemo(() => toListParams(filters, collectionId), [filters, collectionId])).data;

  // The Tags menu lists the tags the view's items carry, the most used first
  // and only a few of them: the rest are found by typing. A tag no item of
  // the view carries is left out, as picking it would show nothing; a picked
  // tag always shows, first, so it can be unticked.
  const [tagFilter, setTagFilter] = useState('');
  const tagQuery = tagFilter.trim().toLowerCase();
  const viewTags = useMemo(() => {
    const picked = new Set(filters.tags);
    return tags
      .map((t) => ({ name: t.name, count: facets ? (facets.byTag[t.name] ?? 0) : undefined, rank: facets ? (facets.byTag[t.name] ?? 0) : t.count, picked: picked.has(t.name) }))
      .filter((t) => t.picked || t.rank > 0)
      .sort((a, b) => Number(b.picked) - Number(a.picked) || b.rank - a.rank || a.name.localeCompare(b.name));
  }, [tags, facets, filters.tags]);
  const shownTags = useMemo(
    () => (tagQuery ? viewTags.filter((t) => t.name.includes(tagQuery)) : viewTags.slice(0, Math.max(TAG_PREVIEW, filters.tags.length))),
    [viewTags, tagQuery, filters.tags.length],
  );
  const active = barFilterCount(filters);
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
          <FacetList
            noneText="Any status"
            autoFocus
            selected={filters.status}
            onChange={(status) => onChange({ ...filters, status })}
            options={ITEM_STATUSES.map((s) => ({
              value: s,
              text: STATUS_LABEL[s],
              count: facets?.byStatus[s],
              label: (
                <span className={`facet-pill is-${s}`}>
                  <StatusIcon status={s} size={13} />
                  {STATUS_LABEL[s]}
                </span>
              ),
            }))}
          />
        )}
      </FilterButton>

      <FilterButton label="Difficulty" count={filters.difficulty.length}>
        {() => (
          <FacetList
            noneText="Any difficulty"
            autoFocus
            selected={filters.difficulty}
            onChange={(difficulty) => onChange({ ...filters, difficulty })}
            options={DIFFICULTY_VALUES.map((d) => {
              const text = d === 'none' ? 'Not set' : DIFFICULTY_LABEL[d];
              return {
                value: d,
                text,
                count: facets?.byDifficulty[d],
                label: (
                  <span className={`facet-pill is-${d}`}>
                    <span className={`difficulty-dot is-${d}`} aria-hidden="true" />
                    {text}
                  </span>
                ),
              };
            })}
          />
        )}
      </FilterButton>

      <FilterButton label="Tags" count={filters.tags.length}>
        {() =>
          tags.length === 0 ? (
            <p className="muted">No tags yet. Add tags when capturing or editing an item.</p>
          ) : (
            <>
              <FacetList
                noneText="Any tag"
                autoFocus={viewTags.length <= TAG_PREVIEW}
                selected={filters.tags}
                onChange={(next) => onChange({ ...filters, tags: next })}
                before={
                  (viewTags.length > TAG_PREVIEW || tagFilter !== '') && (
                    <input
                      name="tag-filter"
                      autoComplete="off"
                      className="input input-sm picklist-filter"
                      placeholder="Type to search…"
                      aria-label="Search tags"
                      value={tagFilter}
                      onChange={(e) => setTagFilter(e.target.value)}
                      data-autofocus
                    />
                  )
                }
                options={shownTags.map((t) => ({
                  value: t.name,
                  text: t.name,
                  count: t.count,
                  label: (
                    <span className="facet-tag truncate">
                      <span className="facet-hash" aria-hidden="true">
                        #
                      </span>
                      {t.name}
                    </span>
                  ),
                }))}
                empty={shownTags.length === 0 && <p className="muted picklist-empty">{tagQuery ? 'No match.' : 'No tags in this view.'}</p>}
              />
              {filters.tags.length > 1 && <p className="field-hint picklist-note">Showing items that have all selected tags.</p>}
            </>
          )
        }
      </FilterButton>

      {children}

      {/* Kept in place while hidden, so its appearing cannot wrap the bar; an
          icon alone, so the room it keeps does not wrap the bar either. */}
      <IconButton
        size="sm"
        label="Clear filters"
        icon={<X size={14} />}
        className={cx('filter-clear', active === 0 && 'is-idle')}
        tabIndex={active > 0 ? undefined : -1}
        aria-hidden={active > 0 ? undefined : true}
        onClick={() => {
          setText('');
          lastPushed.current = '';
          onChange(clearBarFilters(filters));
        }}
      />
    </div>
  );
}
