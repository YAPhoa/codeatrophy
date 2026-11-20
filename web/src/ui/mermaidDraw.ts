// Drawing a Mermaid diagram from item text, apart from React and from the
// mermaid package itself (it is loaded only when a page has a diagram), so
// that the rules can be tested without a browser.
//
// Item text is untrusted: diagrams are drawn at mermaid's `strict` security
// level (no click handlers or scripts, labels as plain SVG text) and anything
// that goes wrong ends in `null`, which the page shows as the diagram's source.

/** The part of the mermaid API this uses. */
export interface MermaidApi {
  initialize(config: Record<string, unknown>): void;
  parse(text: string, options: { suppressErrors: true }): Promise<unknown>;
  render(id: string, text: string, container?: Element): Promise<{ svg: string }>;
}

/** Where mermaid lays a diagram out while it measures it, and how to clear up after. */
export interface DrawEnv {
  /** A detached-from-view element in the document for mermaid to work in. */
  mount(): Element;
  /** Remove the element and anything mermaid left in the document for diagram `id`. */
  unmount(host: Element, id: string): void;
}

export type Theme = 'light' | 'dark';

/** How long a diagram may take before it is given up on. */
export const DRAW_TIMEOUT_MS = 10_000;

/** The CSS tokens a diagram's colours come from, by mermaid theme variable. */
const TOKENS = {
  background: '--surface',
  mainBkg: '--surface-3',
  primaryColor: '--surface-3',
  secondaryColor: '--surface-2',
  tertiaryColor: '--surface',
  primaryBorderColor: '--border-strong',
  secondaryBorderColor: '--border-strong',
  tertiaryBorderColor: '--border',
  nodeBorder: '--border-strong',
  clusterBkg: '--bg',
  clusterBorder: '--border-strong',
  primaryTextColor: '--text',
  secondaryTextColor: '--text',
  tertiaryTextColor: '--text',
  textColor: '--text',
  titleColor: '--text',
  lineColor: '--text-3',
  edgeLabelBackground: '--surface',
  noteBkgColor: '--warn-soft',
  noteBorderColor: '--warn-border',
  noteTextColor: '--text',
  actorBkg: '--surface-3',
  actorBorder: '--border-strong',
  actorTextColor: '--text',
  actorLineColor: '--text-3',
  signalColor: '--text-2',
  signalTextColor: '--text',
  labelBoxBkgColor: '--surface-3',
  labelBoxBorderColor: '--border-strong',
  labelTextColor: '--text',
  loopTextColor: '--text',
  activationBkgColor: '--surface-2',
  activationBorderColor: '--border-strong',
  sequenceNumberColor: '--on-accent',
  // State diagrams draw their start and end points in these.
  specialStateColor: '--text-2',
  innerEndBackground: '--text-2',
} as const;

/** Flat, like the rest of the app: no drop shadows under the shapes. */
const FLAT = { dropShadow: 'none' };

const HEX = /^#[0-9a-f]{3}(?:[0-9a-f]{3})?$/i;

/**
 * Mermaid's configuration for the app's theme. Its colours are the app's CSS
 * tokens (`readToken` gives a token's value) on mermaid's `base` theme; if a
 * token is not a plain colour mermaid can compute with, it falls back to its
 * built-in light or dark theme.
 */
export function mermaidConfig(theme: Theme, readToken: (name: string) => string): Record<string, unknown> {
  const vars: Record<string, string | boolean> = {};
  let usable = true;
  for (const [key, token] of Object.entries(TOKENS)) {
    const value = readToken(token).trim();
    if (!HEX.test(value)) usable = false;
    vars[key] = value;
  }
  const fontFamily = readToken('--font-sans').replace(/\s+/g, ' ').trim() || 'sans-serif';
  return {
    startOnLoad: false,
    securityLevel: 'strict',
    // Labels as SVG text rather than HTML inside the SVG.
    htmlLabels: false,
    // An error is ours to show; mermaid draws no error picture of its own.
    suppressErrorRendering: true,
    logLevel: 'fatal',
    // Settings a diagram's own `%%{init}%%` or front matter may not change, on
    // top of mermaid's own list.
    secure: ['secure', 'securityLevel', 'startOnLoad', 'maxTextSize', 'maxEdges', 'suppressErrorRendering', 'logLevel', 'htmlLabels', 'themeCSS', 'fontFamily', 'altFontFamily'],
    fontFamily,
    ...(usable
      ? { theme: 'base', themeVariables: { ...vars, ...FLAT, darkMode: theme === 'dark', fontFamily, fontSize: '14px' } }
      : { theme: theme === 'dark' ? 'dark' : 'default' }),
  };
}

/** How far a diagram may shrink to fit its box before it scrolls instead. */
export const MIN_DIAGRAM_SCALE = 0.75;

/**
 * Size the diagram to fit its box, shrinking to no less than
 * `MIN_DIAGRAM_SCALE` of its own size and never growing past it, instead of
 * mermaid's "as wide as the box": a wide diagram then scrolls inside its box
 * rather than shrinking until its labels cannot be read.
 */
export function naturalSize(svg: string): string {
  return svg.replace(/^<svg\b[^>]*>/, (tag) => {
    const box = /\sviewBox="\s*[-\d.e]+[\s,]+[-\d.e]+[\s,]+([\d.e]+)[\s,]+([\d.e]+)\s*"/i.exec(tag);
    if (!box) return tag;
    const [, w, h] = box;
    const min = Math.round(Number(w) * MIN_DIAGRAM_SCALE);
    return tag
      .replace(/\s(?:width|height|style)="[^"]*"/g, '')
      .replace(/^<svg\b/, `<svg width="${w}" height="${h}" style="max-width:100%;min-width:${min}px;height:auto"`);
  });
}

/**
 * Drop anything in the SVG that would make the browser fetch from elsewhere
 * or follow a link: links (made plain groups), `href`s other than to a place
 * in the SVG itself, CSS
 * `url()`s other than to one (markers, gradients) and `@import`. Loading a
 * picture from another server would tell it the item was opened, and the
 * app makes no request to a third-party origin.
 */
export function withoutRemote(svg: string): string {
  return svg
    .replace(/<a\b/gi, '<g')
    .replace(/<\/a>/gi, '</g>')
    .replace(/\s(?:xlink:)?href\s*=\s*(?:"(?!#)[^"]*"|'(?!#)[^']*')/gi, '')
    .replace(/url\(\s*(?:&quot;|["'])?\s*(?!#)[^)]*\)/gi, 'none')
    .replace(/@import[^;]*;?/gi, '');
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timed out')), ms);
    promise.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(t);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}

let sequence = 0;
// Mermaid keeps the diagram it is drawing in module state, so one is drawn at a time.
let queue: Promise<unknown> = Promise.resolve();

/**
 * Draw `source` as an SVG string, or `null` when it cannot be drawn: a syntax
 * error, mermaid throwing, or taking longer than `timeoutMs`. Never rejects.
 */
export function drawDiagram(
  api: MermaidApi,
  source: string,
  config: Record<string, unknown>,
  env: DrawEnv,
  timeoutMs = DRAW_TIMEOUT_MS,
): Promise<string | null> {
  const job = async (): Promise<string | null> => {
    const id = `mermaid-${++sequence}`;
    let host: Element | null = null;
    try {
      api.initialize(config);
      const parsed = await withTimeout(api.parse(source, { suppressErrors: true }), timeoutMs);
      if (!parsed) return null;
      host = env.mount();
      const { svg } = await withTimeout(api.render(id, source, host), timeoutMs);
      if (!svg.startsWith('<svg') || svg.includes('aria-roledescription="error"')) return null;
      return naturalSize(withoutRemote(svg));
    } catch {
      return null;
    } finally {
      if (host) env.unmount(host, id);
    }
  };
  const run = queue.then(job, job);
  queue = run;
  return run;
}
