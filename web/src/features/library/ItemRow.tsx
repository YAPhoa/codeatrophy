import { memo, type DragEvent, type KeyboardEvent, type MouseEvent } from 'react';
import { Link } from 'react-router';
import { GitBranch, GripVertical } from 'lucide-react';
import type { ItemSummary } from '../../api/types';
import { plural, relativeTime, absoluteTime } from '../../lib/format';
import { cx } from '../../ui/Button';
import { DifficultyBadge, FavoriteButton, StatusControl, TagChips, TypeIcon, VerdictBadge } from '../item/controls';

interface ItemRowProps {
  item: ItemSummary;
  index: number;
  selected: boolean;
  /** This row is the list's current keyboard position (roving tab stop). */
  current: boolean;
  reorderable: boolean;
  dropEdge: 'before' | 'after' | null;
  onSelect: (index: number, e: MouseEvent | KeyboardEvent | null) => void;
  onFocusRow: (index: number) => void;
  onDragStart: (index: number, e: DragEvent) => void;
  onDragOver: (index: number, e: DragEvent) => void;
  onDrop: (index: number, e: DragEvent) => void;
  onDragEnd: () => void;
}

/** One line of the library list: quick controls on the left, facts on the right. */
export const ItemRow = memo(function ItemRow({ item, index, selected, current, reorderable, dropEdge, onSelect, onFocusRow, onDragStart, onDragOver, onDrop, onDragEnd }: ItemRowProps) {
  // Only the current row's controls are tab stops, so Tab moves through one
  // row and then out of the list; J/K (or arrows) move between rows.
  const tab = current ? 0 : -1;
  return (
    <li
      className={cx('item-row', selected && 'is-selected', current && 'is-current', dropEdge && `drop-${dropEdge}`)}
      data-row={index}
      tabIndex={tab}
      draggable
      aria-label={item.title}
      onFocus={(e) => {
        if (e.target === e.currentTarget || e.currentTarget.contains(e.target)) onFocusRow(index);
      }}
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
        <Link to={`/items/${item.id}`} className="item-title" tabIndex={tab} draggable={false}>
          {item.title}
        </Link>
        {(item.variantOf || item.variantCount > 0) && (
          <span className="item-variant" title={item.variantOf ? 'A variant of another item' : `Has ${plural(item.variantCount, 'variant')}`}>
            <GitBranch size={12} aria-hidden="true" />
            {item.variantCount > 0 && <span>{item.variantCount}</span>}
            <span className="sr-only">{item.variantOf ? 'Variant of another item' : `${item.variantCount} variants`}</span>
          </span>
        )}
        {item.summary && <span className="item-summary">{item.summary}</span>}
      </span>
      <span className="item-cell item-tags">
        <TagChips tags={item.tags} max={2} />
      </span>
      <span className="item-cell item-diff">
        <DifficultyBadge difficulty={item.difficulty} />
      </span>
      <span className="item-cell item-result">
        {item.type === 'problem' &&
          (item.lastVerdict ? (
            <VerdictBadge verdict={item.lastVerdict} short />
          ) : (
            <span className="muted">{item.testCaseCount === 0 ? 'no tests' : plural(item.testCaseCount, 'test')}</span>
          ))}
      </span>
      <time className="item-cell item-updated" dateTime={item.updatedAt} title={`Updated ${absoluteTime(item.updatedAt)}`}>
        {relativeTime(item.updatedAt)}
      </time>
      {reorderable && (
        <span className="item-cell item-grip" title="Drag to reorder, or use Alt+↑ / Alt+↓" aria-hidden="true">
          <GripVertical size={14} />
        </span>
      )}
    </li>
  );
});
