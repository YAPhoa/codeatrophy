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
