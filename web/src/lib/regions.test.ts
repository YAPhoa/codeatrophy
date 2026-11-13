import { describe, expect, it } from 'vitest';
import { markedRegions, outermostRegions } from './regions';

const lines = (...l: string[]) => l.join('\n');

describe('markedRegions', () => {
  it('pairs a region with its endregion, in each comment style', () => {
    expect(markedRegions(lines('import sys', '# region input', 'n = int(input())', '# endregion', 'solve(n)'))).toEqual([{ open: 2, close: 4, depth: 0 }]);
    expect(markedRegions(lines('// region input', 'int n; cin >> n;', '// endregion'))).toEqual([{ open: 1, close: 3, depth: 0 }]);
    expect(markedRegions(lines('-- region', 'x', '-- endregion'))).toEqual([{ open: 1, close: 3, depth: 0 }]);
  });

  it('allows indentation, no space after the comment marker, and a label', () => {
    expect(markedRegions(lines('def main():', '    #region read the grid', '    grid = read()', '    #endregion', '    print(grid)'))).toEqual([{ open: 2, close: 4, depth: 0 }]);
    expect(markedRegions(lines('\t//   region  input  ', '\tx', '\t//endregion  ', ''))).toEqual([{ open: 1, close: 3, depth: 0 }]);
    // A label after endregion is tolerated.
    expect(markedRegions(lines('# region input', 'x', '# endregion input'))).toEqual([{ open: 1, close: 3, depth: 0 }]);
  });

  it('nests, and marks the depth of each region', () => {
    const text = lines('# region outer', '# region inner', 'x', '# endregion', 'y', '# region second', '# endregion', '# endregion', '# region after', '# endregion');
    expect(markedRegions(text)).toEqual([
      { open: 1, close: 8, depth: 0 },
      { open: 2, close: 4, depth: 1 },
      { open: 6, close: 7, depth: 1 },
      { open: 9, close: 10, depth: 0 },
    ]);
    expect(outermostRegions(text).map((r) => r.open)).toEqual([1, 9]);
  });

  it('treats a marker without its partner as ordinary text', () => {
    expect(markedRegions(lines('# endregion', '# region a', 'x', '# endregion', '# endregion'))).toEqual([{ open: 2, close: 4, depth: 0 }]);
    expect(markedRegions(lines('# region never closed', 'x'))).toEqual([]);
    // The unclosed outer line encloses nothing, so the inner region is outermost.
    const text = lines('# region open', '# region inner', 'x', '# endregion');
    expect(markedRegions(text)).toEqual([{ open: 2, close: 4, depth: 0 }]);
    expect(outermostRegions(text)).toEqual([{ open: 2, close: 4, depth: 0 }]);
  });

  it('only matches a line that holds nothing but the marker comment', () => {
    for (const line of ['# regional', '# regions', '#endregional', '# region:input', 'x = 1  # region', '/* region */', '/ region', 'region', '# end region', '-region']) {
      expect(markedRegions(lines(line, 'x', '# endregion')), line).toEqual([]);
    }
    expect(markedRegions(lines('# region', 'x', 'y = 2  # endregion'))).toEqual([]);
  });

  it('finds nothing in text without markers', () => {
    expect(markedRegions('')).toEqual([]);
    expect(markedRegions(lines('print(1)', ''))).toEqual([]);
  });
});
