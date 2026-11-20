import { describe, expect, it } from 'vitest';
import { parseDuration } from './motion';

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
