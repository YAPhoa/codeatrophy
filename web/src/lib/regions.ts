// Folded regions: lines of starter code the solver need not read, such as
// input parsing, marked with a pair of comment lines (`# region input` …
// `# endregion`). The solve editor opens them folded. The convention is
// described under "Folded regions" in docs/api.md.

export interface MarkedRegion {
  /** Line number (1-based) of the `region` line. */
  open: number;
  /** Line number (1-based) of the `endregion` line that closes it. */
  close: number;
  /** How many marked regions enclose this one: 0 for an outermost region. */
  depth: number;
}

/**
 * A marker line: only a line comment (`#`, `//` or `--`) reading `region`,
 * optionally followed by a label, or `endregion`. Whitespace is allowed
 * before the comment and after its marker. The word must stand alone, so
 * `# regional` is ordinary text. A label after `endregion` is tolerated.
 */
const MARKER = /^\s*(?:#|\/\/|--)\s*(endregion|region)(?:\s.*)?$/;

/**
 * The marked regions of a text, in order of their opening lines. Each
 * `endregion` closes the nearest open `region`; a marker left without its
 * partner is ordinary text and opens or closes nothing.
 */
export function markedRegions(text: string): MarkedRegion[] {
  const open: number[] = [];
  const pairs: { open: number; close: number }[] = [];
  text.split('\n').forEach((line, i) => {
    const marker = MARKER.exec(line);
    if (!marker) return;
    if (marker[1] === 'region') {
      open.push(i + 1);
      return;
    }
    const start = open.pop();
    if (start !== undefined) pairs.push({ open: start, close: i + 1 });
  });
  pairs.sort((a, b) => a.open - b.open);
  // Paired this way, two regions are either nested or apart; an unpaired
  // `region` line encloses nothing, so it does not count towards the depth.
  const enclosing: MarkedRegion[] = [];
  const regions: MarkedRegion[] = [];
  for (const pair of pairs) {
    while (enclosing.length > 0 && enclosing[enclosing.length - 1]!.close < pair.open) enclosing.pop();
    const region = { ...pair, depth: enclosing.length };
    regions.push(region);
    enclosing.push(region);
  }
  return regions;
}

/** The regions that are folded when code is opened: the outermost ones. */
export function outermostRegions(text: string): MarkedRegion[] {
  return markedRegions(text).filter((r) => r.depth === 0);
}
