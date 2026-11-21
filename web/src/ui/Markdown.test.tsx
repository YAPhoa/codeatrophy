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

// Raw HTML is not rendered, but a `<details>` block is rebuilt from its tags
// alone, so an answer or hint can stay hidden until clicked.
describe('collapsible details blocks', () => {
  const block = (summary: string, body: string, open = '') =>
    `<details class="md-details"${open}><summary class="md-details-summary">${summary}</summary>${body}</details>`;

  it('wraps the Markdown between the tags, with the summary on a line of its own or beside the opening tag', () => {
    const expected = block('Answer', '<p>It is <strong>42</strong>.</p>');
    expect(render('<details>\n<summary>Answer</summary>\n\nIt is **42**.\n\n</details>')).toBe(expected);
    expect(render('<details><summary>Answer</summary>\n\nIt is **42**.\n\n</details>')).toBe(expected);
    expect(render('<details>\n\n<summary>Answer</summary>\n\nIt is **42**.\n\n</details>')).toBe(expected);
    expect(render('<DETAILS >\n<Summary >Answer</SUMMARY>\n\nIt is **42**.\n\n</Details >')).toBe(expected);
  });

  it('reads a body written without blank lines as Markdown too', () => {
    const expected = block('Answer', '<p>It is <strong>42</strong>.</p>');
    expect(render('<details>\n<summary>Answer</summary>\nIt is **42**.\n</details>')).toBe(expected);
    expect(render('<details><summary>Answer</summary>It is **42**.</details>')).toBe(expected);
    expect(render('<details>\n<summary>Answer</summary>\n\nIt is **42**.</details>')).toBe(expected);
    expect(render('<details>\n<summary>Hint</summary>\nTry a heap.\n\n- push\n- pop\n\n</details>')).toBe(block('Hint', '<p>Try a heap.</p><ul>\n<li>push</li>\n<li>pop</li>\n</ul>'));
  });

  it('keeps `open`, and nests', () => {
    const html = render('<details open>\n<summary>Outer</summary>\n\nA\n\n<details>\n<summary>Inner</summary>\n\nB\n\n</details>\n\n</details>');
    expect(html).toBe(block('Outer', `<p>A</p>${block('Inner', '<p>B</p>')}`, ' open=""'));
  });

  it('works inside a list item and a blockquote', () => {
    expect(render('1. Find the cycle.\n\n   <details>\n   <summary>Answer</summary>\n\n   Floyd.\n\n   </details>')).toContain(block('Answer', '<p>Floyd.</p>'));
    expect(render('> <details>\n> <summary>Answer</summary>\n>\n> Floyd.\n>\n> </details>')).toContain(block('Answer', '<p>Floyd.</p>'));
  });

  it('renders code, math, tables, headings and diagrams inside as anywhere else', () => {
    const html = render('<details>\n<summary>Solution</summary>\n\n## Idea\n\n$$O(n \\log n)$$\n\n```python\ndef f():\n    return 1\n```\n\n```mermaid\nflowchart LR\n  A --> B\n```\n\n| a |\n| - |\n| 1 |\n\n</details>');
    expect(html.startsWith('<details class="md-details"><summary class="md-details-summary">Solution</summary><h2 id="h-idea">Idea</h2>')).toBe(true);
    expect(html).toContain('class="katex-display"');
    expect(html).toContain('hljs-keyword');
    expect(html).toContain('<code class="language-mermaid">flowchart LR');
    expect(html).toContain('<table>');
    expect(html.endsWith('</table></div></details>')).toBe(true);
  });

  it('names a block without a summary "Details"', () => {
    expect(render('<details>\n\nHidden.\n\n</details>')).toBe(block('Details', '<p>Hidden.</p>'));
    expect(render('<details>\n<summary>  </summary>\n\nHidden.\n\n</details>')).toBe(block('Details', '<p>Hidden.</p>'));
  });

  it('shows the summary as plain text, tags and all', () => {
    const html = render('<details>\n<summary><b>Answer</b> <img src=x onerror="alert(1)"></summary>\n\nx\n\n</details>');
    expect(html).toContain('<summary class="md-details-summary">&lt;b&gt;Answer&lt;/b&gt; &lt;img src=x onerror=&quot;alert(1)&quot;&gt;</summary>');
    expect(html).not.toMatch(/<b>|<img/i);
  });

  it('does not recognise an opening tag with any attribute but `open`', () => {
    for (const tag of ['<details onclick="alert(1)">', '<details class="x">', '<details open onclick="alert(1)">', '<details open="open">']) {
      const html = render(`${tag}\n<summary>Answer</summary>\n\nx\n\n</details>`);
      expect(html).not.toMatch(/<details|<summary/i);
      expect(html).not.toMatch(/<[a-z][^>]*\son\w+=/i);
      expect(html).toContain('&lt;details');
      expect(html).toContain('<p>x</p>');
    }
  });

  it('leaves other HTML unrendered, inside a block or out', () => {
    const html = render('<details>\n<summary>Answer</summary>\n\n<script>alert(1)</script>\n\n<div onmouseover="x()">hover</div>\n\n<img src="x" onerror="alert(2)">\n\n</details>\n\n<div>\n<details>\n</div>');
    expect(html).not.toMatch(/<script|<div|<img/i);
    expect(html).not.toMatch(/<[a-z][^>]*\son\w+=/i);
    expect(html).toContain('&lt;script&gt;');
    expect(html.match(/<details/g)?.length).toBe(1);
  });

  it('leaves a tag without its partner as raw text, as other HTML', () => {
    expect(render('<details>\n<summary>Answer</summary>\n\nNever closed.')).toBe('&lt;details&gt;\n&lt;summary&gt;Answer&lt;/summary&gt;\n<p>Never closed.</p>');
    expect(render('Stray.\n\n</details>')).toBe('<p>Stray.</p>\n&lt;/details&gt;');
    expect(render('<summary>Alone</summary>')).toBe('&lt;summary&gt;Alone&lt;/summary&gt;');
    // A summary that is not the first thing in the block stays text too.
    expect(render('<details>\n\nx\n\n<summary>Late</summary>\n\n</details>')).toBe(block('Details', '<p>x</p>&lt;summary&gt;Late&lt;/summary&gt;'));
    // An extra closing tag after a complete block.
    expect(render('<details>\n\nx\n\n</details>\n\n</details>')).toBe(`${block('Details', '<p>x</p>')}\n&lt;/details&gt;`);
  });

  it('leaves tags inside a line of text as they are', () => {
    expect(render('See <details><summary>S</summary>x</details> here.')).toBe('<p>See &lt;details&gt;&lt;summary&gt;S&lt;/summary&gt;x&lt;/details&gt; here.</p>');
  });
});
