import { Fragment, memo, useLayoutEffect, useRef, useState, type AnimationEvent, type DragEvent, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import { Link } from 'react-router';
import { ChevronDown, GitBranch, GripVertical } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { prefetchItem } from '../../api/queries';
import type { ItemSummary } from '../../api/types';
import { ItemPage } from '../../app/screens';
import { useIntent } from '../../lib/intent';
import { STATUS_LABEL, VERDICT_LABEL, absoluteDate, absoluteTime, isFailedVerdict, plural, shortRelativeTime } from '../../lib/format';
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

// ---- The line's tags: as many as fit, then "+N" ----

// One observer for every row. It only reports when a row's tag strip changes
// size (a resize, the sidebar, a row coming into view), never on scroll, and
// it runs after layout, so reading the chips' widths there forces no extra one.
// The fits it finds are applied before the frame is painted, so a row never
// shows its chips cut off first.
type Fit = (width: number) => void;
const fits = new WeakMap<Element, Fit>();
let observer: ResizeObserver | null = null;

function watchWidth(el: Element, fit: Fit) {
  observer ??= new ResizeObserver((entries) => {
    flushSync(() => {
      for (const e of entries) fits.get(e.target)?.(e.contentBoxSize[0]?.inlineSize ?? e.contentRect.width);
    });
  });
  fits.set(el, fit);
  observer.observe(el);
  return () => {
    fits.delete(el);
    observer?.unobserve(el);
  };
}

/** The width of a "+N" chip, from the last one shown; any row's will do. */
let moreWidth = 30;

/**
 * The row's tags on its line: as many as fit in the room the title leaves,
 * then "+N" for the rest. The strip's width depends only on the title's, so
 * changing how many chips show never resizes it, and the fit settles in one
 * pass. Chip widths are measured once, while every chip shows, and kept.
 */
function LineTags({ tags, tab, returning, onReturned, more }: { tags: readonly string[]; tab: number; returning: boolean; onReturned: (e: AnimationEvent) => void; more: { expanded: boolean; controls: string; onToggle: () => void } }) {
  const ref = useRef<HTMLSpanElement>(null);
  const key = tags.join('\n');
  // How many chips show; every one until the strip has been measured.
  const [fit, setFit] = useState({ key, shown: tags.length });
  const shown = fit.key === key ? fit.shown : tags.length;
  if (fit.key !== key) setFit({ key, shown });
  const widths = useRef(new Map<string, number>());
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    return watchWidth(el, (room) => {
      if (room <= 0) return; // Hidden (a narrow screen) or not laid out yet.
      const chips = el.querySelectorAll<HTMLElement>('.chip');
      for (const chip of chips) {
        const w = chip.getBoundingClientRect().width;
        if (chip.classList.contains('chip-more')) moreWidth = w;
        else if (chip.textContent) widths.current.set(chip.textContent, w);
      }
      const gap = parseFloat(getComputedStyle(el.firstElementChild ?? el).columnGap) || 0;
      let used = 0;
      let n = 0;
      for (const [i, tag] of tags.entries()) {
        const w = widths.current.get(tag);
        if (w == null) break;
        const next = used + (n > 0 ? gap : 0) + w;
        const rest = i < tags.length - 1 ? gap + moreWidth : 0;
        if (next + rest > room + 0.5) break;
        used = next;
        n += 1;
      }
      setFit((f) => (f.key === key && f.shown === n ? f : { key, shown: n }));
    });
  }, [tags, key]);
  return (
    <span ref={ref} className={cx('item-tags', returning && 'is-returning')} onAnimationEnd={onReturned}>
      <TagChips tags={tags} max={shown} tabIndex={tab} more={more} />
    </span>
  );
}

// ---- The details under the line ----

/** What the line leaves out: the whole summary, then every tag and the other facts, each beside its label. */
function ItemDetails({ item, tab }: { item: ItemSummary; tab: number }) {
  const facts: { label: string; value: ReactNode }[] = [];
  if (item.tags.length > 0) facts.push({ label: 'Tags', value: <TagChips tags={item.tags} tabIndex={tab} /> });
  if (item.type === 'problem') facts.push({ label: 'Tests', value: item.testCaseCount === 0 ? 'None' : plural(item.testCaseCount, 'test case') });
  facts.push({
    label: 'Created',
    value: (
      <time dateTime={item.createdAt} title={absoluteTime(item.createdAt)}>
        {absoluteDate(item.createdAt)}
      </time>
    ),
  });
  return (
    <div className="item-details" id={detailsId(item.id)}>
      {/* Opens the item like the title; the title is the row's one tab stop for it. */}
      {item.summary && (
        <Link to={`/items/${item.id}`} className="item-details-summary" tabIndex={-1} draggable={false}>
          {item.summary}
        </Link>
      )}
      {!item.summary && <p className="item-details-empty">No description.</p>}
      <dl className="item-details-facts">
        {facts.map((f) => (
          <Fragment key={f.label}>
            <dt>{f.label}</dt>
            <dd>{f.value}</dd>
          </Fragment>
        ))}
      </dl>
    </div>
  );
}

/** One line of the library list: status and type on the left, facts in columns on the right, and details that open below. */
export const ItemRow = memo(function ItemRow({
  item,
  index,
  selected,
  current,
  reorderable,
  open,
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
  // Set when the row closes, so the line's tags fade back in, and
  // cleared once they have, so a resize that hides and shows them again does
  // not replay the fade.
  const [returning, setReturning] = useState(false);
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    setReturning(!open);
  }
  const onReturned = (e: AnimationEvent) => {
    if (e.target === e.currentTarget) setReturning(false);
  };
  // Resting on a row (pointer or focus) loads the item and its screen, so opening it shows no loading state.
  const qc = useQueryClient();
  const intent = useIntent(() => {
    prefetchItem(qc, item.id, item.type);
    ItemPage.preload();
    if (item.type === 'problem') preloadCodeEditor();
  });
  // The status icon already says when a problem is solved, so the line shows
  // only a failed last verdict; the icon's tooltip gives any last one.
  const verdict = item.type === 'problem' ? item.lastVerdict : null;
  const statusTitle = verdict ? `${STATUS_LABEL[item.status]} · Last verdict: ${VERDICT_LABEL[verdict]}` : undefined;
  // A click on the row's line or details opens or closes it, but not one
  // meant for a control in it (or a near miss in a control's cell, or one in
  // a menu it portals out), one that ends selecting text, or one with a
  // modifier key held.
  const onClick = (e: MouseEvent<HTMLLIElement>) => {
    const target = e.target as Element;
    if (e.button !== 0 || e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) return;
    if (!e.currentTarget.contains(target) || target.closest('a, button, input, label, .item-check, .item-status, .item-star, .item-expand, .item-grip')) return;
    if (window.getSelection()?.toString()) return;
    onToggleOpen(index);
  };
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
      onClick={onClick}
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
      <span className="item-cell item-status">
        <StatusControl item={item} compact size="sm" title={statusTitle} />
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
        {/* An open row shows every tag in its details, so the line leaves them out. */}
        {!open && item.tags.length > 0 && (
          <LineTags
            tags={item.tags}
            tab={tab}
            returning={returning}
            onReturned={onReturned}
            more={{ expanded: open, controls: detailsId(item.id), onToggle: () => onToggleOpen(index) }}
          />
        )}
      </span>
      <span className="item-cell item-kind">
        <DifficultyBadge difficulty={item.difficulty} />
      </span>
      <span className="item-cell item-verdict">{verdict && isFailedVerdict(verdict) && <VerdictBadge verdict={verdict} short />}</span>
      <time className="item-cell item-updated" dateTime={item.updatedAt} title={`Created ${absoluteTime(item.createdAt)}\nUpdated ${absoluteTime(item.updatedAt)}`}>
        {shortRelativeTime(item.updatedAt)}
      </time>
      <span className="item-cell item-star">
        <FavoriteButton item={item} size="sm" />
      </span>
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
        <ItemDetails item={item} tab={tab} />
      </Collapse>
    </li>
  );
});
