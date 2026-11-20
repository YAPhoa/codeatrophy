import { useSyncExternalStore } from 'react';
import { readString, writeString } from './storage';

/** How wide the reader's text column may grow, kept per browser like the reading text size. */
export type TextWidth = 'narrow' | 'standard' | 'wide' | 'full';

export const TEXT_WIDTHS: readonly { value: TextWidth; label: string }[] = [
  { value: 'narrow', label: 'Narrow' },
  { value: 'standard', label: 'Standard' },
  { value: 'wide', label: 'Wide' },
  { value: 'full', label: 'Full' },
];

/**
 * The cap on the text column at the reader's 17px text. Standard is 720px,
 * about 85 characters a line; Narrow 540px, about 65; Wide 940px, about 110.
 * Full has none: the column takes the whole pane.
 */
export const TEXT_COLUMN_PX = { narrow: 540, standard: 720, wide: 940 } as const;

/** The width of the outline ("On this page") when it is docked beside the text. */
export const OUTLINE_PX = 220;

/**
 * How far below its cap the column may give way to keep the outline docked
 * beside it, so a pane only a little short of the whole column (a laptop
 * with the sidebar open, at Standard) keeps its outline.
 */
export const DOCK_TOLERANCE_PX = 80;

/**
 * How much more room than it needs a folded outline waits for before it
 * docks again, so a scrollbar coming or going cannot flip it back and forth.
 */
export const DOCK_MARGIN_PX = 24;

/** The column's cap as a CSS length: in a grid track, 100% grows it into all the free space. */
export function columnCap(width: TextWidth): string {
  return width === 'full' ? '100%' : `${TEXT_COLUMN_PX[width]}px`;
}

/**
 * Whether the outline docks beside the text, given the room the pane leaves
 * for the two (inside its padding, less the gap between them). The chosen
 * width wins: the outline docks only while the column keeps its cap, less
 * `DOCK_TOLERANCE_PX`, and beside at least a Wide column when the width is
 * Full; otherwise it folds into a button and the column gets its whole cap.
 * Once docked it stays until the room falls short; folded, it waits for
 * `DOCK_MARGIN_PX` more (`wasDocked` false).
 */
export function outlineDocks(width: TextWidth, room: number, wasDocked: boolean): boolean {
  const column = width === 'full' ? TEXT_COLUMN_PX.wide : TEXT_COLUMN_PX[width] - DOCK_TOLERANCE_PX;
  const need = column + OUTLINE_PX;
  return room >= need + (wasDocked ? 0 : DOCK_MARGIN_PX);
}

const KEY = 'textWidth';
const listeners = new Set<() => void>();
// The choice made in this page, which holds for the visit even when storage cannot keep it.
let chosen: TextWidth | null = null;

/** A stored value as a width; anything unknown (or nothing) is the default, "standard". */
export function parseTextWidth(value: string | null): TextWidth {
  return value === 'narrow' || value === 'wide' || value === 'full' ? value : 'standard';
}

export function getTextWidth(): TextWidth {
  return chosen ?? parseTextWidth(readString(KEY));
}

export function setTextWidth(width: TextWidth): void {
  chosen = width;
  writeString(KEY, width);
  listeners.forEach((fn) => fn());
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** The chosen width. */
export function useTextWidth(): TextWidth {
  return useSyncExternalStore(subscribe, getTextWidth, () => 'standard');
}
