import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as TextWidthModule from './textWidth';

type Module = typeof TextWidthModule;

function fakeStorage(failWrites = false): Storage {
  const data = new Map<string, string>();
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => {
      if (failWrites) throw new DOMException('full', 'QuotaExceededError');
      data.set(k, v);
    },
    removeItem: (k: string) => void data.delete(k),
  } as unknown as Storage;
}

function useStorage(storage: Storage): void {
  Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true });
}

// A fresh copy of the module for each test, as a page load would have.
async function load(): Promise<Module> {
  vi.resetModules();
  return import('./textWidth');
}

describe('text width', () => {
  afterEach(() => {
    Reflect.deleteProperty(globalThis, 'localStorage');
  });

  it('is standard until one is chosen', async () => {
    useStorage(fakeStorage());
    const { getTextWidth } = await load();
    expect(getTextWidth()).toBe('standard');
  });

  it('keeps the choice for the next page load', async () => {
    useStorage(fakeStorage());
    for (const width of ['narrow', 'wide', 'full', 'standard'] as const) {
      (await load()).setTextWidth(width);
      expect((await load()).getTextWidth()).toBe(width);
    }
  });

  it('takes an unknown stored value as standard', async () => {
    const { parseTextWidth } = await load();
    expect(parseTextWidth(null)).toBe('standard');
    expect(parseTextWidth('')).toBe('standard');
    expect(parseTextWidth('Wide')).toBe('standard');
    expect(parseTextWidth('"wide"')).toBe('standard');
    expect(parseTextWidth('900px')).toBe('standard');
    useStorage(fakeStorage());
    globalThis.localStorage.setItem('codeatrophy:textWidth', 'enormous');
    expect((await load()).getTextWidth()).toBe('standard');
  });

  it('holds a choice for the visit when storage cannot keep it', async () => {
    useStorage(fakeStorage(true));
    const failing = await load();
    expect(() => failing.setTextWidth('wide')).not.toThrow();
    expect(failing.getTextWidth()).toBe('wide');
    expect((await load()).getTextWidth()).toBe('standard');

    Reflect.deleteProperty(globalThis, 'localStorage');
    const missing = await load();
    expect(missing.getTextWidth()).toBe('standard');
    missing.setTextWidth('full');
    expect(missing.getTextWidth()).toBe('full');
  });

  it('docks the outline only while the column keeps nearly its whole cap', async () => {
    const { outlineDocks, OUTLINE_PX, DOCK_TOLERANCE_PX } = await load();
    expect(DOCK_TOLERANCE_PX).toBe(80);
    const beside = (column: number) => column + OUTLINE_PX;
    expect(outlineDocks('standard', OUTLINE_PX, beside(720), true)).toBe(true);
    expect(outlineDocks('standard', OUTLINE_PX, beside(696), true)).toBe(true);
    expect(outlineDocks('standard', OUTLINE_PX, beside(640), true)).toBe(true);
    expect(outlineDocks('standard', OUTLINE_PX, beside(639), true)).toBe(false);
    expect(outlineDocks('narrow', OUTLINE_PX, beside(460), true)).toBe(true);
    expect(outlineDocks('narrow', OUTLINE_PX, beside(459), true)).toBe(false);
    expect(outlineDocks('wide', OUTLINE_PX, beside(860), true)).toBe(true);
    expect(outlineDocks('wide', OUTLINE_PX, beside(859), true)).toBe(false);
    // Full keeps it beside a whole Wide column at least.
    expect(outlineDocks('full', OUTLINE_PX, beside(940), true)).toBe(true);
    expect(outlineDocks('full', OUTLINE_PX, beside(939), true)).toBe(false);
    expect(outlineDocks('full', OUTLINE_PX, 3000, true)).toBe(true);
  });

  it('waits for a little more room before a folded outline docks again', async () => {
    const { outlineDocks, OUTLINE_PX, DOCK_MARGIN_PX } = await load();
    const need = 640 + OUTLINE_PX;
    expect(outlineDocks('standard', OUTLINE_PX, need, false)).toBe(false);
    expect(outlineDocks('standard', OUTLINE_PX, need + DOCK_MARGIN_PX - 1, false)).toBe(false);
    expect(outlineDocks('standard', OUTLINE_PX, need + DOCK_MARGIN_PX, false)).toBe(true);
    // Docked, it stays down to the exact need.
    expect(outlineDocks('standard', OUTLINE_PX, need, true)).toBe(true);
    expect(outlineDocks('standard', OUTLINE_PX, need - 1, true)).toBe(false);
  });

  it('widens the outline with the reading text size, 220px at the default', async () => {
    const { outlineWidth } = await load();
    expect(outlineWidth('default')).toBe(220);
    expect(outlineWidth('small')).toBe(198);
    expect(outlineWidth('large')).toBe(253);
  });

  it('docks a larger outline only when the room holds it', async () => {
    const { outlineDocks, outlineWidth } = await load();
    const large = outlineWidth('large');
    // Room for the default outline beside a Standard column is not room for the large one.
    expect(outlineDocks('standard', 220, 640 + 220, true)).toBe(true);
    expect(outlineDocks('standard', large, 640 + 220, true)).toBe(false);
    expect(outlineDocks('standard', large, 640 + large - 1, true)).toBe(false);
    expect(outlineDocks('standard', large, 640 + large, true)).toBe(true);
    expect(outlineDocks('full', large, 940 + large, true)).toBe(true);
    expect(outlineDocks('full', large, 940 + large - 1, true)).toBe(false);
    // A small outline docks in a little less.
    expect(outlineDocks('standard', outlineWidth('small'), 640 + 198, true)).toBe(true);
  });

  it('caps the column in px, and Full not at all', async () => {
    const { columnCap } = await load();
    expect(columnCap('narrow')).toBe('540px');
    expect(columnCap('standard')).toBe('720px');
    expect(columnCap('wide')).toBe('940px');
    expect(columnCap('full')).toBe('100%');
  });
});
