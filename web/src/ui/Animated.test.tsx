import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { IconSwap, MorphText, NumberChange, sharedEnds } from './Animated';

describe('sharedEnds', () => {
  it('finds the letters two labels share at the start and the end', () => {
    expect(sharedEnds('Copy', 'Copied')).toEqual([3, 0]);
    expect(sharedEnds('Follow', 'Following')).toEqual([6, 0]);
    expect(sharedEnds('Save', 'Saved')).toEqual([4, 0]);
    expect(sharedEnds('Check in', 'Checked in')).toEqual([5, 3]);
  });

  it('never counts a letter twice when one label holds the other', () => {
    expect(sharedEnds('aa', 'aaa')).toEqual([2, 0]);
    expect(sharedEnds('Done', 'Done')).toEqual([4, 0]);
    expect(sharedEnds('', 'x')).toEqual([0, 0]);
  });
});

// A first render is the state at rest: nothing in it may animate.
describe('changes in place, on a first render', () => {
  it('draws the icon alone, not marked as entering', () => {
    const html = renderToStaticMarkup(
      <IconSwap swapKey="done">
        <svg />
      </IconSwap>,
    );
    expect(html).not.toContain('is-in');
    expect(html).not.toContain('icon-swap-out');
  });

  it('draws plain text and plain digits', () => {
    expect(renderToStaticMarkup(<MorphText text="Copy" />)).toBe('<span class="morph">Copy</span>');
    expect(renderToStaticMarkup(<NumberChange value={42} />)).toBe('42');
  });
});
