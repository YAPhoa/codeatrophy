import { useEffect, useRef, useState } from 'react';
import { useLoadingShown } from '../lib/motion';
import { useAppliedTheme } from '../lib/theme';
import { cx } from './Button';
import { drawDiagram, mermaidConfig, type MermaidApi, type Theme } from './mermaidDraw';

// The mermaid package is large; it is loaded the first time a page has a diagram.
let loading: Promise<MermaidApi> | null = null;
function loadMermaid(): Promise<MermaidApi> {
  loading ??= import('mermaid').then((m) => m.default as unknown as MermaidApi);
  // A failed load (an old build's files gone, the network down) is tried again next time.
  loading.catch(() => (loading = null));
  return loading;
}

/** Mermaid measures a diagram's text in the document: it works in a box laid out off screen. */
const env = {
  mount(): Element {
    const host = document.createElement('div');
    host.setAttribute('aria-hidden', 'true');
    host.style.cssText = 'position:fixed;left:-100000px;top:0;visibility:hidden;pointer-events:none';
    document.body.appendChild(host);
    return host;
  },
  unmount(host: Element, id: string): void {
    host.remove();
    // What mermaid may leave behind in <body> when it fails part way.
    for (const leftover of [id, `d${id}`, `i${id}`]) document.getElementById(leftover)?.remove();
    document.querySelectorAll('body > #cy[style*="display"]').forEach((el) => el.remove());
  },
};

async function draw(source: string, theme: Theme): Promise<string | null> {
  let api: MermaidApi;
  try {
    api = await loadMermaid();
  } catch {
    return null;
  }
  const style = getComputedStyle(document.documentElement);
  return drawDiagram(api, source, mermaidConfig(theme, (name) => style.getPropertyValue(name)), env);
}

/** While the text is being edited, a diagram is drawn again once typing pauses. */
const REDRAW_AFTER_MS = 400;

/**
 * A ```mermaid block, drawn as a diagram. Until the first drawing is ready
 * the source holds its place, hidden unless that takes a while; if it cannot
 * be drawn, the source is shown as an ordinary code block with a one-line note.
 */
export function MermaidDiagram({ source }: { source: string }) {
  const theme = useAppliedTheme();
  // `svg` is null when the diagram could not be drawn; the state is null until the first attempt ends.
  const [drawn, setDrawn] = useState<{ svg: string | null } | null>(null);
  const shownSource = useRef<string | null>(null);
  const pendingShown = useLoadingShown(drawn === null);

  useEffect(() => {
    let live = true;
    // The first drawing, and a new theme, need no wait.
    const delay = shownSource.current === null || shownSource.current === source ? 0 : REDRAW_AFTER_MS;
    shownSource.current = source;
    const t = setTimeout(() => {
      void draw(source, theme).then((svg) => {
        if (live) setDrawn({ svg });
      });
    }, delay);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [source, theme]);

  if (drawn?.svg) {
    return (
      <div className="md-mermaid" translate="no">
        {/* The one place a string becomes markup. It is mermaid's own output at
            its `strict` level, which escapes the diagram's text, draws no HTML
            labels and passes the SVG through DOMPurify before returning it, so
            it carries no script, handler or link out of the item's text. */}
        <div className="md-mermaid-svg" dangerouslySetInnerHTML={{ __html: drawn.svg }} />
      </div>
    );
  }
  return (
    <>
      <pre translate="no" className={cx(!drawn && 'loading-delay', !drawn && !pendingShown && 'is-pending')}>
        <code className="language-mermaid">{source}</code>
      </pre>
      {drawn && <p className="md-mermaid-note">This diagram could not be drawn.</p>}
    </>
  );
}
