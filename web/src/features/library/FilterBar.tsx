import { useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import { ChevronDown, Search, X } from 'lucide-react';
import { useLocation } from 'react-router';
import { useItemFacets } from '../../api/queries';
import { ITEM_STATUSES, type Difficulty, type ItemType, type Tag } from '../../api/types';
import { DIFFICULTY_LABEL, STATUS_LABEL } from '../../lib/format';
import { barFilterCount, clearBarFilters, toListParams, typeInBar, viewNoun, type LibraryFilters } from '../../lib/filters';
import { IconSwap, NumberChange } from '../../ui/Animated';
import { Button, IconButton, cx } from '../../ui/Button';
import { Popover } from '../../ui/Popover';
import { StatusIcon, TypeIcon } from '../item/controls';
import { FacetList } from './FacetList';

const DIFFICULTY_VALUES: readonly (Difficulty | 'none')[] = ['easy', 'medium', 'hard', 'none'];
const TYPE_OPTIONS: readonly { value: ItemType; text: string }[] = [
  { value: 'problem', text: 'Problem' },
  { value: 'reading', text: 'Reading' },
];

/** How many tags the Tags menu lists before any is typed. */
const TAG_PREVIEW = 5;

interface FilterBarProps {
  filters: LibraryFilters;
  onChange: (next: LibraryFilters) => void;
  tags: readonly Tag[];
  collectionId: string | null;
  /** Which visit of a view this is (see LibraryPage); a search typed in one is not carried into the next. */
  visit: string;
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

/**
 * Search box plus the filters of the library. The type is picked in the
 * sidebar, but in a collection and in Favorites here; Favorites in the
 * sidebar; the list's head sorts it.
 */
export function FilterBar({ filters, onChange, tags, collectionId, visit, searchRef, children, className }: FilterBarProps) {
  // The search text is debounced into the URL so typing does not fire a
  // request per keystroke. It belongs to the visit it was typed in: a view
  // opened again, or another one, shows its own search, and a write still
  // pending is dropped, so it cannot land in the next visit's URL.
  const [typed, setTyped] = useState({ visit, text: filters.q });
  let text = typed.text;
  if (typed.visit !== visit) {
    text = filters.q;
    setTyped({ visit, text });
  }
  const setText = (next: string) => setTyped({ visit, text: next });
  const lastPushed = useRef(filters.q);
  useEffect(() => {
    if (filters.q === lastPushed.current) return;
    lastPushed.current = filters.q;
    setTyped({ visit, text: filters.q });
  }, [filters.q, visit]);
  // What is set when the write happens, not when typing began, is what it keeps.
  const latest = useRef({ filters, onChange });
  useEffect(() => {
    latest.current = { filters, onChange };
  });
  // The history entry on screen. The router writes the address at once but
  // draws the page for it later: a write due in between would be made from
  // the filters of the page before, over the one just opened.
  const { key } = useLocation();
  useEffect(() => {
    if (text === lastPushed.current) return;
    const t = window.setTimeout(() => {
      // The router keeps the entry's key in the history state (`default` for the first page).
      const current = (window.history.state as { key?: string } | null)?.key ?? 'default';
      // Not drawn yet: a visit drops the write once it is, a change made on the page writes it again.
      if (current !== key) return;
      lastPushed.current = text;
      latest.current.onChange({ ...latest.current.filters, q: text });
    }, 220);
    return () => window.clearTimeout(t);
  }, [text, key]);

  // Eager, so a menu opens on its counts; each dimension's counts ignore its own filter.
  const facets = useItemFacets(useMemo(() => toListParams(filters, collectionId), [filters, collectionId])).data;

  // The Tags menu lists the tags the view's items carry, the most used first
  // and only a few of them: the rest are found by typing. A tag no item of
  // the view carries is left out, as picking it would show nothing. Picked
  // tags always show, at the top and whatever is typed, so they can be
  // unticked; and once one is picked the search stays, though the picks
  // narrow what the other tags count.
  const [tagFilter, setTagFilter] = useState('');
  const tagQuery = tagFilter.trim().toLowerCase();
  const viewTags = useMemo(() => {
    const picked = new Set(filters.tags);
    return tags
      .map((t) => ({ name: t.name, count: facets ? (facets.byTag[t.name] ?? 0) : undefined, rank: facets ? (facets.byTag[t.name] ?? 0) : t.count, picked: picked.has(t.name) }))
      .filter((t) => t.picked || t.rank > 0)
      .sort((a, b) => Number(b.picked) - Number(a.picked) || b.rank - a.rank || a.name.localeCompare(b.name));
  }, [tags, facets, filters.tags]);
  const pickedTags = useMemo(() => viewTags.filter((t) => t.picked), [viewTags]);
  const otherTags = useMemo(() => {
    const rest = viewTags.filter((t) => !t.picked);
    return tagQuery ? rest.filter((t) => t.name.includes(tagQuery)) : rest.slice(0, TAG_PREVIEW);
  }, [viewTags, tagQuery]);
  const shownTags = useMemo(() => [...pickedTags, ...otherTags], [pickedTags, otherTags]);
  const tagSearch = viewTags.length > TAG_PREVIEW || tagFilter !== '' || filters.tags.length > 0;
  const active = barFilterCount(filters, collectionId);
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

      {typeInBar(filters, collectionId) && (
        <FilterButton label="Type" count={filters.type ? 1 : 0}>
          {() => (
            <FacetList
              autoFocus
              selected={filters.type ? [filters.type] : []}
              // One type at a time: ticking the other one switches to it.
              onChange={(next) => onChange({ ...filters, type: next.find((t) => t !== filters.type) ?? null })}
              options={TYPE_OPTIONS.map((t) => ({
                value: t.value,
                text: t.text,
                count: facets?.byType[t.value],
                label: (
                  <span className={`facet-pill is-${t.value}`}>
                    <TypeIcon type={t.value} size={13} />
                    {t.text}
                  </span>
                ),
              }))}
            />
          )}
        </FilterButton>
      )}

      <FilterButton label="Status" count={filters.status.length}>
        {() => (
          <FacetList
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
          // Empty tags (no item carries them) are nothing to filter by.
          filters.tags.length === 0 && !tags.some((t) => t.count > 0) ? (
            <p className="muted">No tags yet. Add tags when capturing or editing an item.</p>
          ) : (
            <>
              <FacetList
                autoFocus={!tagSearch}
                selected={filters.tags}
                onChange={(next) => onChange({ ...filters, tags: next })}
                before={
                  tagSearch && (
                    <span className="picklist-filter picklist-search">
                      <input
                        name="tag-filter"
                        autoComplete="off"
                        className="input input-sm"
                        placeholder="Type to search…"
                        aria-label="Search tags"
                        value={tagFilter}
                        onChange={(e) => setTagFilter(e.target.value)}
                        data-autofocus
                      />
                      <Search size={14} aria-hidden="true" />
                    </span>
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
                empty={otherTags.length === 0 && (tagQuery || pickedTags.length === 0) && <p className="muted picklist-empty">{tagQuery ? 'No match.' : 'No tags in this view.'}</p>}
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
          onChange(clearBarFilters(filters, collectionId));
        }}
      />
    </div>
  );
}
