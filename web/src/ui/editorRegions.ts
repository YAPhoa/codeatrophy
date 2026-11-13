/*
 * Folded regions in the code editor (see lib/regions.ts): every editor can
 * fold and unfold a marked region from the gutter, whatever the language;
 * the solve editor also folds them when it is given code.
 */

import { foldEffect, foldService, foldedRanges, unfoldEffect } from '@codemirror/language';
import type { EditorState, StateEffect, Text } from '@codemirror/state';
import { markedRegions, type MarkedRegion } from '../lib/regions';

/** Documents are immutable, so the regions of each are worked out once. */
const parsed = new WeakMap<Text, MarkedRegion[]>();

function regionsOf(doc: Text): MarkedRegion[] {
  let regions = parsed.get(doc);
  if (!regions) {
    regions = markedRegions(doc.toString());
    parsed.set(doc, regions);
  }
  return regions;
}

/** What folds away: from the end of the `region` line to the end of the `endregion` line, so the first stays in view. */
function foldRange(doc: Text, region: MarkedRegion): { from: number; to: number } {
  return { from: doc.line(region.open).to, to: doc.line(region.close).to };
}

/** Makes a marked region foldable on its opening line; it comes before what the language itself can fold. */
export const regionFolding = foldService.of((state, lineStart) => {
  const line = state.doc.lineAt(lineStart).number;
  const region = regionsOf(state.doc).find((r) => r.open === line);
  return region ? foldRange(state.doc, region) : null;
});

/** Effects that fold the outermost marked regions of `doc`. */
export function foldRegionEffects(doc: Text): StateEffect<unknown>[] {
  return regionsOf(doc)
    .filter((r) => r.depth === 0)
    .map((r) => foldEffect.of(foldRange(doc, r)));
}

/** Effects that unfold everything that is folded in `state`. */
export function unfoldAllEffects(state: EditorState): StateEffect<unknown>[] {
  const effects: StateEffect<unknown>[] = [];
  foldedRanges(state).between(0, state.doc.length, (from, to) => {
    effects.push(unfoldEffect.of({ from, to }));
  });
  return effects;
}
