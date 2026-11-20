import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import MarkdownImpl from './MarkdownImpl';

const render = (source: string) => renderToStaticMarkup(<MarkdownImpl source={source} />);

// Item bodies can come from third-party bundles, so the renderer must treat
// them as untrusted.
describe('Markdown rendering of untrusted input', () => {
  it('does not turn raw HTML into elements', () => {
    const html = render('Hello\n\n<script>alert(1)</script>\n\n<img src="x" onerror="alert(2)">\n\n<iframe src="https://evil.example"></iframe>\n\n<div onmouseover="x()">hover</div>');
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/<iframe/i);
    expect(html).not.toMatch(/<img/i);
    expect(html).not.toMatch(/<div onmouseover/i);
    // The markup survives only as escaped text, never as an attribute of a real element.
    expect(html).not.toMatch(/<[a-z][^>]*\son\w+=/i);
    expect(html).toContain('&lt;script&gt;');
  });

  it('drops script and data URLs from links', () => {
    const html = render('[a](javascript:alert(1)) [b](data:text/html;base64,PHNjcmlwdD4=) [c](vbscript:x) [ok](https://example.com/page)');
    expect(html).not.toMatch(/javascript:/i);
    expect(html).not.toMatch(/href="data:/i);
    expect(html).not.toMatch(/vbscript:/i);
    expect(html).toContain('href="https://example.com/page"');
    expect(html).toContain('rel="noopener noreferrer nofollow"');
  });

  it('does not fetch remote images until asked', () => {
    const html = render('![tracking pixel](https://tracker.example/p.gif)');
    expect(html).not.toMatch(/<img/i);
    expect(html).toContain('tracker.example');
    expect(html).toMatch(/<button/);
  });

  it('keeps KaTeX from emitting script links', () => {
    const html = render('$\\href{javascript:alert(1)}{x}$');
    expect(html).not.toMatch(/href="javascript:/i);
  });

  it('colours a TeX command it will not render with the theme, not KaTeX\'s fixed red', () => {
    const html = render('$\\href{https://example.com}{x}$');
    expect(html).toContain('color:var(--danger)');
    expect(html).not.toContain('#cc0000');
  });

  it('shows an image embedded as an image data URL, but no other data URL', () => {
    const svg = "data:image/svg+xml,%3Csvg%20xmlns='http://www.w3.org/2000/svg'/%3E";
    const html = render(`![a](${svg}) ![b](data:text/html;base64,PHNjcmlwdD4=) [c](${svg})`);
    expect(html).toContain(`<img src="${svg.replace(/'/g, '&#x27;')}" alt="a"`);
    expect(html).not.toMatch(/data:text/);
    expect(html).not.toMatch(/href="data:/);
  });

  it('hands a mermaid fence to the diagram as written, untouched by the highlighter', () => {
    const html = render('```mermaid\nflowchart LR\n  A["<b>x</b>"] --> B\n```\n\n```python\nx = 1\n```');
    // Before the diagram is drawn its source holds the place, as text.
    expect(html).toContain('<code class="language-mermaid">flowchart LR\n  A[&quot;&lt;b&gt;x&lt;/b&gt;&quot;] --&gt; B</code>');
    expect(html).not.toMatch(/<b>/);
    expect(html.match(/hljs/g)?.length ?? 0).toBeGreaterThan(0);
    expect(html.slice(0, html.indexOf('</pre>'))).not.toContain('hljs');
  });

  it('renders GitHub-flavoured Markdown, math and highlighted code', () => {
    const html = render('| a | b |\n| - | - |\n| 1 | 2 |\n\n- [x] done\n\n~~gone~~\n\n$1 \\le n \\le 10^5$\n\n```python\ndef f():\n    return 1\n```\n\n## Input');
    expect(html).toContain('<table>');
    expect(html).toContain('type="checkbox"');
    expect(html).toContain('<del>gone</del>');
    expect(html).toContain('class="katex"');
    expect(html).toContain('hljs-keyword');
    expect(html).toContain('id="h-input"');
  });
});

// remark-math draws `$$…$$` as a display equation only when the markers sit
// on lines of their own; a paragraph holding only a one-line `$$…$$` is
// meant as one too.
describe('display math', () => {
  const displays = (html: string) => html.match(/class="katex-display"/g)?.length ?? 0;

  it('draws a one-line $$…$$ standing alone as a display equation', () => {
    expect(displays(render('Before.\n\n$$1 = \\frac{1}{E[m]}$$\n\nAfter.'))).toBe(1);
  });

  it('keeps fenced display math as it was', () => {
    expect(displays(render('$$\n1 = \\frac{1}{E[m]}\n$$'))).toBe(1);
  });

  it('leaves $$…$$ inside a sentence inline', () => {
    const html = render('So $$x^2$$ grows, and $y$ too.');
    expect(displays(html)).toBe(0);
    expect(html.match(/class="katex"/g)?.length).toBe(2);
  });
});
