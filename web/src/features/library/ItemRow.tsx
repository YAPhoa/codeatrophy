import { Fragment, memo, type DragEvent, type KeyboardEvent, type MouseEvent } from 'react';
import { Link } from 'react-router';
import { ChevronDown, GitBranch, GripVertical } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { prefetchItem } from '../../api/queries';
import type { Collection, ItemSummary } from '../../api/types';
import { ItemPage } from '../../app/screens';
import { useIntent } from '../../lib/intent';
import { isFailedVerdict, plural, relativeTime, absoluteTime } from '../../lib/format';
import { pathTo } from '../../lib/tree';
import { Button, cx } from '../../ui/Button';
import { preloadCodeEditor } from '../../ui/CodeEditor';
import { Collapse } from '../../ui/Collapse';
import { DifficultyBadge, FavoriteButton, StatusControl, TagChips, TypeIcon, VerdictBadge } from '../item/controls';

interface ItemRowProps {
  item: ItemSummary;
  index: number;
  selected: boolean;
  /** This row is the list's current keyboard position (roving tab stop). */
  current: boolean;
  reorderable: boolean;
  /** Whether the details under the row's line are shown. */
  open: boolean;
  /** Every collection, to name the ones the item is in. */
  collections: readonly Collection[];
  dropEdge: 'before' | 'after' | null;
  onSelect: (index: number, e: MouseEvent | KeyboardEvent | null) => void;
  onToggleOpen: (index: number) => void;
  onFocusRow: (index: number) => void;
  onDragStart: (index: number, e: DragEvent) => void;
  onDragOver: (index: number, e: DragEvent) => void;
  onDrop: (index: number, e: DragEvent) => void;
  onDragEnd: () => void;
}

/** On hover, gives text cut off with an ellipsis its full wording as a tooltip, and none when it fits. */
function titleIfCut(e: MouseEvent<HTMLElement>) {
  const el = e.currentTarget;
  el.title = el.scrollWidth > el.clientWidth ? (el.textContent ?? '') : '';
}

/** The id of a row's details, for the controls that open them. */
export const detailsId = (itemId: string) => `item-details-${itemId}`;

/** Created on, updated on: relative, with the exact time as a tooltip. */
function When({ label, iso }: { label: string; iso: string }) {
  return (
    <span>
      {label}{' '}
      <time dateTime={iso} title={absoluteTime(iso)}>
        {relativeTime(iso)}
      </time>
    </span>
  );
}

/** What the row's line cuts short: the whole summary, every tag, the dates and the collections. */
function ItemDetails({ item, collections, tab }: { item: ItemSummary; collections: readonly Collection[]; tab: number }) {
  const paths = item.collectionIds.map((id) => pathTo(collections, id)).filter((p) => p.length > 0);
  return (
    <div className="item-details" id={detailsId(item.id)}>
      {item.summary && <p className="item-details-summary">{item.summary}</p>}
      {item.tags.length > 0 && <TagChips tags={item.tags} tabIndex={tab} />}
      <p className="item-details-facts">
        <When label="Created" iso={item.createdAt} />
        <span aria-hidden="true">·</span>
        <When label="Updated" iso={item.updatedAt} />
        {paths.length > 0 && (
          <>
            <span aria-hidden="true">·</span>
            <span>
              In:{' '}
              {paths.map((path, i) => (
                <Fragment key={path[path.length - 1]!.id}>
                  {i > 0 && ', '}
                  <Link to={`/collections/${path[path.length - 1]!.id}`} tabIndex={tab} draggable={false}>
                    {path.map((c) => c.name).join(' / ')}
                  </Link>
                </Fragment>
              ))}
            </span>
          </>
        )}
      </p>
    </div>
  );
}

/** One line of the library list: quick controls on the left, facts on the right, and details that open below. */
export const ItemRow = memo(function ItemRow({
  item,
  index,
  selected,
  current,
  reorderable,
  open,
  collections,
  dropEdge,
  onSelect,
  onToggleOpen,
  onFocusRow,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
}: ItemRowProps) {
  // Only the current row's controls are tab stops, so Tab moves through one
  // row and then out of the list; J/K (or arrows) move between rows.
  const tab = current ? 0 : -1;
  // Resting on a row (pointer or focus) loads the item and its screen, so opening it shows no loading state.
  const qc = useQueryClient();
  const intent = useIntent(() => {
    prefetchItem(qc, item.id, item.type);
    ItemPage.preload();
    if (item.type === 'problem') preloadCodeEditor();
  });
  return (
    <li
      className={cx('item-row', selected && 'is-selected', current && 'is-current', open && 'is-open', dropEdge && `drop-${dropEdge}`)}
      data-row={index}
      tabIndex={tab}
      draggable
      aria-label={item.title}
      onPointerEnter={intent.onPointerEnter}
      onPointerLeave={intent.onPointerLeave}
      onPointerDown={intent.onPointerDown}
      onFocus={(e) => {
        if (e.target === e.currentTarget || e.currentTarget.contains(e.target)) onFocusRow(index);
        intent.onFocus();
      }}
      onBlur={intent.onBlur}
      onDragStart={(e) => onDragStart(index, e)}
      onDragOver={(e) => onDragOver(index, e)}
      onDrop={(e) => onDrop(index, e)}
      onDragEnd={onDragEnd}
    >
      <span className="item-cell item-check">
        <input
          type="checkbox"
          tabIndex={tab}
          checked={selected}
          aria-label={`Select ${item.title}`}
          onChange={() => undefined}
          onClick={(e) => onSelect(index, e)}
        />
      </span>
      <span className="item-cell">
        <FavoriteButton item={item} size="sm" />
      </span>
      <span className="item-cell">
        <StatusControl item={item} compact size="sm" />
      </span>
      <span className="item-cell item-type">
        <TypeIcon type={item.type} />
      </span>
      <span className="item-main">
        <span className="item-head">
          <Link to={`/items/${item.id}`} className="item-title" tabIndex={tab} draggable={false} onMouseEnter={titleIfCut}>
            {item.title}
          </Link>
          {(item.variantOf || item.variantCount > 0) && (
            <span className="item-variant" title={item.variantOf ? 'A variant of another item' : `Has ${plural(item.variantCount, 'variant')}`}>
              <GitBranch size={12} aria-hidden="true" />
              {item.variantCount > 0 && <span>{item.variantCount}</span>}
              <span className="sr-only">{item.variantOf ? 'Variant of another item' : `${item.variantCount} variants`}</span>
            </span>
          )}
        </span>
        {item.summary && (
          <span className="item-summary" onMouseEnter={titleIfCut}>
            {item.summary}
          </span>
        )}
        {item.tags.length > 0 && (
          <span className="item-tags">
            <TagChips tags={item.tags} max={2} tabIndex={tab} more={{ expanded: open, controls: detailsId(item.id), onToggle: () => onToggleOpen(index) }} />
          </span>
        )}
      </span>
      <span className="item-cell item-diff">
        <DifficultyBadge difficulty={item.difficulty} />
      </span>
      <span className="item-cell item-result">
        {/* The status icon already says when a problem is solved, so only a failed last verdict is shown. */}
        {item.type === 'problem' && (
          <>
            {item.lastVerdict && isFailedVerdict(item.lastVerdict) && <VerdictBadge verdict={item.lastVerdict} short />}
            <span className="item-tests muted">{item.testCaseCount === 0 ? 'no tests' : plural(item.testCaseCount, 'test')}</span>
          </>
        )}
      </span>
      <time className="item-cell item-updated" dateTime={item.updatedAt} title={`Updated ${absoluteTime(item.updatedAt)}`}>
        {relativeTime(item.updatedAt)}
      </time>
      <span className="item-cell item-expand">
        <Button
          variant="ghost"
          size="sm"
          tabIndex={tab}
          aria-expanded={open}
          aria-controls={detailsId(item.id)}
          aria-label={open ? 'Hide details' : 'Show details'}
          title={open ? 'Hide details' : 'Show details'}
          icon={<ChevronDown size={14} aria-hidden="true" className={cx('item-expand-icon', open && 'is-open')} />}
          onClick={(e) => {
            e.stopPropagation();
            onToggleOpen(index);
          }}
        />
      </span>
      {reorderable && (
        <span className="item-cell item-grip" title="Drag to reorder, or use Alt+↑ / Alt+↓" aria-hidden="true">
          <GripVertical size={14} />
        </span>
      )}
      <Collapse open={open}>
        <ItemDetails item={item} collections={collections} tab={tab} />
      </Collapse>
    </li>
  );
});
