import { describe, expect, it } from 'vitest';
import indexHtml from '../../index.html?raw';

describe('the page’s colour scheme', () => {
  // The root's color-scheme follows the app's theme (index.html, tokens.css).
  // A color-scheme meta would add the OS setting as the page's own, which a
  // frame an extension injects with a scheme the browser does not know takes
  // up: in Firefox, an OS in dark then shows that frame as a white box.
  it('is not declared by a meta in index.html', () => {
    expect(indexHtml).not.toMatch(/<meta\b[^>]*\bname\s*=\s*["']?color-scheme\b/i);
  });
});
