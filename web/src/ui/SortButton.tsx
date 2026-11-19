import { ArrowDown, ArrowUp } from 'lucide-react';
import type { SortOrder } from '../api/types';
import { cx } from './Button';

interface SortButtonProps {
  /** The column's name, as the head shows it. */
  label: string;
  /** Whether the list is sorted by this column. */
  active: boolean;
  /** The direction in effect, or for another column the one a click gives. */
  order: SortOrder;
  /** That direction in words, for the accessible name: "A to Z". */
  direction: string | null;
  /** What a click does, as a tooltip. */
  title: string;
  onClick: () => void;
  className?: string;
}

/**
 * A column's name in a list's head, which sorts the list by it. The sort in
 * effect shows its direction by an arrow, never by weight; another column
 * shows, on hover, the arrow a click would give.
 */
export function SortButton({ label, active, order, direction, title, onClick, className }: SortButtonProps) {
  const Arrow = order === 'asc' ? ArrowUp : ArrowDown;
  return (
    <button
      type="button"
      className={cx('sort-button', active && 'is-active', className)}
      aria-pressed={active}
      aria-label={direction ? `Sort by ${label.toLowerCase()}, ${direction}` : `Sort by ${label.toLowerCase()}`}
      title={title}
      onClick={onClick}
    >
      {label}
      <Arrow size={14} aria-hidden="true" className="sort-arrow" />
    </button>
  );
}
