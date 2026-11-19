import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Select, enabledFrom, selectKey, startAt, typeAhead, type SelectOption } from './Select';

// Unit tests run without a DOM, so what a key does is tested on the pure
// functions the select runs on; the browser tests (e2e/select.spec.ts) drive
// the control itself, with the pointer and the keyboard.

const options: SelectOption[] = [
  { value: 'a', label: 'Apple' },
  { value: 'b', label: 'Banana', disabled: true },
  { value: 'c', label: 'Cherry' },
  { value: 'd', label: 'Citrus', depth: 1 },
  { value: 'e', label: 'Date' },
  { value: 'f', label: 'Elder', disabled: true },
];

const closed = { open: false, active: -1 };

describe('enabledFrom and startAt', () => {
  it('step past options that cannot be chosen', () => {
    expect(enabledFrom(options, 1, 1)).toBe(2);
    expect(enabledFrom(options, 5, -1)).toBe(4);
    expect(enabledFrom(options, 5, 1)).toBe(-1);
  });

  it('start from the choice, or the first that can be chosen', () => {
    expect(startAt(options, 3)).toBe(3);
    expect(startAt(options, -1)).toBe(0);
    expect(startAt(options, 1)).toBe(0);
  });
});

describe('selectKey, closed', () => {
  it('opens on the arrows, Enter and Space, on the choice in effect', () => {
    for (const key of ['ArrowDown', 'ArrowUp', 'Enter', ' ']) expect(selectKey(key, closed, options, 2)).toEqual({ state: { open: true, active: 2 }, pick: null });
  });

  it('opens on the first or the last that can be chosen with Home and End', () => {
    expect(selectKey('Home', closed, options, 2)?.state).toEqual({ open: true, active: 0 });
    expect(selectKey('End', closed, options, 2)?.state).toEqual({ open: true, active: 4 });
  });

  it('leaves Escape and Tab alone, for a dialog or the page to have', () => {
    expect(selectKey('Escape', closed, options, 2)).toBeNull();
    expect(selectKey('Tab', closed, options, 2)).toBeNull();
  });
});

describe('selectKey, open', () => {
  const at = (active: number) => ({ open: true, active });

  it('moves with the arrows past a disabled option, and stops at either end', () => {
    expect(selectKey('ArrowDown', at(0), options, 0)?.state.active).toBe(2);
    expect(selectKey('ArrowUp', at(2), options, 0)?.state.active).toBe(0);
    expect(selectKey('ArrowDown', at(4), options, 0)?.state.active).toBe(4);
    expect(selectKey('ArrowUp', at(0), options, 0)?.state.active).toBe(0);
  });

  it('goes to the first and the last that can be chosen with Home and End', () => {
    expect(selectKey('Home', at(4), options, 0)?.state.active).toBe(0);
    expect(selectKey('End', at(0), options, 0)?.state.active).toBe(4);
  });

  it('picks the option reached with Enter or Space, and closes', () => {
    expect(selectKey('Enter', at(3), options, 0)).toEqual({ state: { open: false, active: 3 }, pick: 3 });
    expect(selectKey(' ', at(4), options, 0)).toEqual({ state: { open: false, active: 4 }, pick: 4 });
    expect(selectKey('ArrowUp', at(2), options, 0, { alt: true })).toEqual({ state: { open: false, active: 2 }, pick: 2 });
  });

  it('never picks a disabled option', () => {
    expect(selectKey('Enter', at(1), options, 0)?.pick).toBeNull();
  });

  it('closes without picking on Escape and Tab', () => {
    expect(selectKey('Escape', at(3), options, 0)).toEqual({ state: { open: false, active: 3 }, pick: null });
    expect(selectKey('Tab', at(3), options, 0)).toEqual({ state: { open: false, active: 3 }, pick: null });
  });

  it('leaves a space typed into a name to the type-ahead', () => {
    expect(selectKey(' ', at(3), options, 0, { searching: true })).toBeNull();
  });
});

describe('typeAhead', () => {
  it('steps through the options that start with a letter, from the one after where it is, round to the start', () => {
    expect(typeAhead(options, 0, 'c')).toBe(2);
    expect(typeAhead(options, 2, 'c')).toBe(3);
    expect(typeAhead(options, 3, 'c')).toBe(2);
    expect(typeAhead(options, 3, 'cc')).toBe(2);
  });

  it('finds the first that starts with several letters, the one it is on included', () => {
    expect(typeAhead(options, 0, 'ci')).toBe(3);
    expect(typeAhead(options, 3, 'cit')).toBe(3);
    expect(typeAhead(options, -1, 'DA')).toBe(4);
  });

  it('skips disabled options and finds nothing when nothing matches', () => {
    expect(typeAhead(options, 0, 'b')).toBe(-1);
    expect(typeAhead(options, 0, 'e')).toBe(-1);
    expect(typeAhead(options, 0, 'z')).toBe(-1);
    expect(typeAhead(options, 0, '')).toBe(-1);
  });
});

describe('Select, closed', () => {
  const html = renderToStaticMarkup(<Select value="c" onChange={() => {}} options={options} id="fruit" name="fruit" aria-describedby="fruit-hint" aria-invalid />);

  it('is a combobox that pops up a listbox, wired to its hint and error', () => {
    const trigger = html.match(/^<button [^>]*>/)?.[0] ?? '';
    for (const attribute of ['type="button"', 'id="fruit"', 'name="fruit"', 'value="c"', 'role="combobox"', 'aria-haspopup="listbox"', 'aria-expanded="false"', 'aria-controls="'])
      expect(trigger).toContain(attribute);
    expect(html).toContain('aria-describedby="fruit-hint"');
    expect(html).toContain('aria-invalid="true"');
    expect(html).not.toContain('aria-activedescendant');
    expect(html).not.toContain('role="listbox"');
  });

  it('shows the plain name of the choice, the other labels only as attributes for its width', () => {
    expect(html).toContain('<span class="select-value">Cherry</span>');
    expect(html.replace(/<[^>]*>/g, '')).toBe('Cherry');
    expect(html).toContain('data-label="Elder"');
  });

  it('shows the first option for a value it does not have, as a native select does', () => {
    expect(renderToStaticMarkup(<Select value="x" onChange={() => {}} options={options} />)).toContain('<span class="select-value">Apple</span>');
  });

  it('can be disabled', () => {
    expect(renderToStaticMarkup(<Select value="a" onChange={() => {}} options={options} disabled />)).toMatch(/<button[^>]* disabled=""/);
  });
});
