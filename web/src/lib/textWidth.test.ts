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
    expect(outlineDocks('standard', beside(720), true)).toBe(true);
    expect(outlineDocks('standard', beside(696), true)).toBe(true);
    expect(outlineDocks('standard', beside(640), true)).toBe(true);
    expect(outlineDocks('standard', beside(639), true)).toBe(false);
    expect(outlineDocks('narrow', beside(460), true)).toBe(true);
    expect(outlineDocks('narrow', beside(459), true)).toBe(false);
    expect(outlineDocks('wide', beside(860), true)).toBe(true);
    expect(outlineDocks('wide', beside(859), true)).toBe(false);
    // Full keeps it beside a whole Wide column at least.
    expect(outlineDocks('full', beside(940), true)).toBe(true);
    expect(outlineDocks('full', beside(939), true)).toBe(false);
    expect(outlineDocks('full', 3000, true)).toBe(true);
  });

  it('waits for a little more room before a folded outline docks again', async () => {
    const { outlineDocks, OUTLINE_PX, DOCK_MARGIN_PX } = await load();
    const need = 640 + OUTLINE_PX;
    expect(outlineDocks('standard', need, false)).toBe(false);
    expect(outlineDocks('standard', need + DOCK_MARGIN_PX - 1, false)).toBe(false);
    expect(outlineDocks('standard', need + DOCK_MARGIN_PX, false)).toBe(true);
    // Docked, it stays down to the exact need.
    expect(outlineDocks('standard', need, true)).toBe(true);
    expect(outlineDocks('standard', need - 1, true)).toBe(false);
  });

  it('caps the column in px, and Full not at all', async () => {
    const { columnCap } = await load();
    expect(columnCap('narrow')).toBe('540px');
    expect(columnCap('standard')).toBe('720px');
    expect(columnCap('wide')).toBe('940px');
    expect(columnCap('full')).toBe('100%');
  });
});
