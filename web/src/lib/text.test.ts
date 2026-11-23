import { describe, expect, it } from 'vitest';
import { byteLength, charCount, hasDisallowedControl, isSingleLine } from './text';

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

// Every character the server's unicode.IsControl reports: C0, DEL and C1.
const controls = [...Array.from({ length: 0x20 }, (_, i) => i), ...Array.from({ length: 0x21 }, (_, i) => 0x7f + i)].map((c) => String.fromCharCode(c));

describe('hasDisallowedControl, as domain.HasDisallowedControl', () => {
  it('allows newline and tab, and nothing else that is a control character', () => {
    for (const c of controls) expect(hasDisallowedControl(`a${c}b`), `U+${c.charCodeAt(0).toString(16)}`).toBe(c !== '\n' && c !== '\t');
  });

  it('lets the line and paragraph separators and other text through', () => {
    expect(hasDisallowedControl('a\u2028b\u2029c')).toBe(false);
    expect(hasDisallowedControl('plain text, é 😀 \u00a0 \u00ad')).toBe(false);
  });
});

describe('isSingleLine, as domain.IsSingleLine', () => {
  it('refuses every control character, tab and newline included', () => {
    for (const c of controls) expect(isSingleLine(`a${c}b`), `U+${c.charCodeAt(0).toString(16)}`).toBe(false);
  });

  it('refuses the Unicode line and paragraph separators', () => {
    expect(isSingleLine('a\u2028b')).toBe(false);
    expect(isSingleLine('a\u2029b')).toBe(false);
  });

  it('takes any other text', () => {
    expect(isSingleLine('')).toBe(true);
    expect(isSingleLine('Two Sum, é 😀 \u00a0 \u00a0\u200b')).toBe(true);
  });
});
