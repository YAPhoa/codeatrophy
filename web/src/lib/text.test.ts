import { describe, expect, it } from 'vitest';
import { byteLength, charCount } from './text';

describe('text measures', () => {
  it('counts characters as code points, the way the server does', () => {
    expect(charCount('a😀b')).toBe(3);
    expect(charCount('')).toBe(0);
  });

  it('measures size in UTF-8 bytes', () => {
    expect(byteLength('é😀')).toBe(6);
    expect(byteLength('abc')).toBe(3);
  });
});
