import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { withFakeLocalStorage } from '../test/fakeStorage';
import { exitDuration, getReduceMotion, initMotion, movementDuration, parseDuration, prefersReducedMotion, reduceMotionFor, setReduceMotion } from './motion';

describe('parseDuration', () => {
  it('reads milliseconds as written in tokens.css', () => {
    expect(parseDuration('250ms')).toBe(250);
    expect(parseDuration(' 80ms ')).toBe(80);
  });

  it('reads seconds, which is how a production build writes the same tokens', () => {
    expect(parseDuration('.25s')).toBe(250);
    expect(parseDuration('1s')).toBe(1000);
    expect(parseDuration('0.15s')).toBe(150);
  });

  it('is nil for anything that is not a positive time', () => {
    expect(parseDuration('')).toBe(0);
    expect(parseDuration('0s')).toBe(0);
    expect(parseDuration('-1s')).toBe(0);
    expect(parseDuration('250')).toBe(0);
    expect(parseDuration('fast')).toBe(0);
  });
});

describe('the Reduce motion setting', () => {
  withFakeLocalStorage();
  // Tests run in node: just the part of the page the setting is applied to,
  // the OS's reduced-motion setting, which can change, and one token.
  const root = { dataset: {} as DOMStringMap };
  let osReduced = false;
  let onChange: (() => void) | null = null;
  beforeEach(() => {
    root.dataset = {};
    osReduced = false;
    onChange = null;
    Object.defineProperty(globalThis, 'document', { value: { documentElement: root }, configurable: true });
    Object.defineProperty(globalThis, 'getComputedStyle', { value: () => ({ getPropertyValue: (name: string) => (name === '--duration-test' ? '150ms' : '') }), configurable: true });
    Object.defineProperty(globalThis, 'window', {
      value: {
        matchMedia: () => ({
          get matches() {
            return osReduced;
          },
          addEventListener: (_: string, fn: () => void) => void (onChange = fn),
        }),
      },
      configurable: true,
    });
  });
  afterEach(() => {
    for (const name of ['document', 'window', 'getComputedStyle']) Reflect.deleteProperty(globalThis, name);
  });

  it('is what was chosen, or with nothing chosen what the OS asks for', () => {
    expect(reduceMotionFor(null, false)).toBe('off');
    expect(reduceMotionFor(null, true)).toBe('on');
    expect(reduceMotionFor('full', true)).toBe('off');
    expect(reduceMotionFor('reduce', false)).toBe('on');
  });

  it('follows the OS live while nothing is chosen', () => {
    initMotion();
    expect(getReduceMotion()).toBe('off');
    expect(prefersReducedMotion()).toBe(false);
    osReduced = true;
    onChange?.();
    expect(getReduceMotion()).toBe('on');
    expect(root.dataset.motion).toBe('reduce');
    expect(prefersReducedMotion()).toBe(true);
    osReduced = false;
    onChange?.();
    expect(root.dataset.motion).toBeUndefined();
  });

  it('keeps fades and cuts movement while on', () => {
    expect(exitDuration('--duration-test')).toBe(150);
    expect(movementDuration('--duration-test')).toBe(150);
    setReduceMotion('on');
    expect(exitDuration('--duration-test')).toBe(150);
    expect(movementDuration('--duration-test')).toBe(0);
  });

  it('once chosen, is stored next to the theme and no longer follows the OS', () => {
    initMotion();
    osReduced = true;
    setReduceMotion('off');
    expect(localStorage.getItem('codeatrophy:motion')).toBe('full');
    expect(root.dataset.motion).toBeUndefined();
    onChange?.();
    expect(root.dataset.motion).toBeUndefined();

    osReduced = false;
    setReduceMotion('on');
    expect(localStorage.getItem('codeatrophy:motion')).toBe('reduce');
    expect(root.dataset.motion).toBe('reduce');
    onChange?.();
    expect(getReduceMotion()).toBe('on');
  });

  it('is applied from storage when the app starts, and ignores a value it does not know', () => {
    localStorage.setItem('codeatrophy:motion', 'reduce');
    initMotion();
    expect(root.dataset.motion).toBe('reduce');
    localStorage.setItem('codeatrophy:motion', 'sideways');
    osReduced = true;
    expect(getReduceMotion()).toBe('on');
    osReduced = false;
    expect(getReduceMotion()).toBe('off');
  });
});
