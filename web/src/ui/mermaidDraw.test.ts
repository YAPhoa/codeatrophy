import { describe, expect, it, vi } from 'vitest';
import { drawDiagram, mermaidConfig, naturalSize, withoutRemote, type DrawEnv, type MermaidApi } from './mermaidDraw';

const SVG =
  '<svg id="mermaid-1" width="100%" xmlns="http://www.w3.org/2000/svg" class="flowchart" style="max-width: 523.5px;" viewBox="-8 -8 523.5 300" role="graphics-document document" aria-roledescription="flowchart-v2"><g/></svg>';

/** A stand-in for mermaid: "BAD" does not parse, "THROW" fails while drawing, "HANG" never finishes. */
function fakeApi(): MermaidApi & { rendered: string[] } {
  const rendered: string[] = [];
  return {
    rendered,
    initialize: vi.fn(),
    parse: (text) => Promise.resolve(text.includes('BAD') ? false : { diagramType: 'flowchart' }),
    render: (id, text) => {
      rendered.push(text);
      if (text.includes('THROW')) return Promise.reject(new Error('boom'));
      if (text.includes('HANG')) return new Promise(() => {});
      return Promise.resolve({ svg: SVG.replace('mermaid-1', id) });
    },
  };
}

function fakeEnv(): DrawEnv & { mounted: number; unmounted: string[] } {
  const env = {
    mounted: 0,
    unmounted: [] as string[],
    mount: () => {
      env.mounted++;
      return {} as Element;
    },
    unmount: (_host: Element, id: string) => void env.unmounted.push(id),
  };
  return env;
}

describe('drawDiagram', () => {
  it('draws a diagram at its own size, and clears up after', async () => {
    const api = fakeApi();
    const env = fakeEnv();
    const svg = await drawDiagram(api, 'flowchart LR\n  A --> B', {}, env);
    expect(svg).toMatch(/^<svg width="523.5" height="300" style="max-width:100%;min-width:393px;height:auto" id="mermaid-\d+"/);
    expect(svg).not.toContain('523.5px');
    expect(env.unmounted).toHaveLength(1);
  });

  it('gives null, without drawing, for a diagram that does not parse', async () => {
    const api = fakeApi();
    const env = fakeEnv();
    expect(await drawDiagram(api, 'BAD', {}, env)).toBeNull();
    expect(api.rendered).toEqual([]);
    expect(env.mounted).toBe(0);
  });

  it('gives null when mermaid throws, returns its error picture or takes too long', async () => {
    const api = fakeApi();
    const env = fakeEnv();
    expect(await drawDiagram(api, 'THROW', {}, env)).toBeNull();
    expect(await drawDiagram(api, 'HANG', {}, env, 20)).toBeNull();
    const bomb = { ...api, render: () => Promise.resolve({ svg: '<svg aria-roledescription="error"></svg>' }) };
    expect(await drawDiagram(bomb, 'flowchart LR', {}, env)).toBeNull();
    expect(env.unmounted).toHaveLength(env.mounted);
  });

  it('draws a working diagram next to a broken one', async () => {
    const api = fakeApi();
    const env = fakeEnv();
    const [good, bad, thrown, other] = await Promise.all([
      drawDiagram(api, 'flowchart LR\n  A --> B', {}, env),
      drawDiagram(api, 'BAD', {}, env),
      drawDiagram(api, 'THROW', {}, env),
      drawDiagram(api, 'flowchart TD\n  C --> D', {}, env),
    ]);
    expect(good).toContain('<svg');
    expect(bad).toBeNull();
    expect(thrown).toBeNull();
    expect(other).toContain('<svg');
    // One at a time, in order.
    expect(api.rendered).toEqual(['flowchart LR\n  A --> B', 'THROW', 'flowchart TD\n  C --> D']);
  });
});

describe('mermaidConfig', () => {
  const tokens = (value: string) => () => value;

  it('is strict, and takes its colours from the app tokens', () => {
    const config = mermaidConfig('dark', tokens('#101010'));
    expect(config).toMatchObject({ securityLevel: 'strict', startOnLoad: false, htmlLabels: false, suppressErrorRendering: true, theme: 'base' });
    expect(config.themeVariables).toMatchObject({ primaryColor: '#101010', darkMode: true });
    expect(config.secure).toEqual(expect.arrayContaining(['securityLevel', 'themeCSS', 'htmlLabels']));
  });

  it('falls back to mermaid’s own themes when a token is not a plain colour', () => {
    expect(mermaidConfig('dark', tokens(''))).toMatchObject({ theme: 'dark', securityLevel: 'strict' });
    expect(mermaidConfig('light', tokens('rgb(0 0 0 / 10%)'))).toMatchObject({ theme: 'default' });
  });
});

describe('naturalSize', () => {
  it('leaves an SVG without a viewBox as it is', () => {
    expect(naturalSize('<svg width="100%"><g/></svg>')).toBe('<svg width="100%"><g/></svg>');
  });
});

describe('withoutRemote', () => {
  it('drops links and remote CSS, keeping references inside the SVG', () => {
    const svg =
      '<svg><style>@import url("https://x.example/a.css"); .n{fill:url(https://x.example/p.png)} .m{marker-end:url(#arrow)}</style>' +
      '<a href="https://x.example"><image xlink:href="https://x.example/p.png"/></a><use href="#node"/>' +
      '<path style="fill:url(&quot;https://x.example/q&quot;)" marker-end="url(#mermaid-1_end)"/></svg>';
    const out = withoutRemote(svg);
    expect(out).not.toContain('x.example');
    expect(out).toContain('url(#arrow)');
    expect(out).toContain('url(#mermaid-1_end)');
    expect(out).toContain('href="#node"');
    expect(out).not.toMatch(/<a\b|<\/a>/);
    expect(out).toContain('<g><image/></g>');
  });
});
