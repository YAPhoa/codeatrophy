// A small rehype plugin: give headings stable ids so a table of contents can
// link to them. Written against a structural subset of the hast node types.

interface HastNode {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
}

function textOf(node: HastNode): string {
  if (node.type === 'text') return node.value ?? '';
  return (node.children ?? []).map(textOf).join('');
}

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/[\s-]+/g, '-');
}

/**
 * Assign `id="h-<slug>"` to h1–h4. The prefix keeps ids derived from
 * untrusted text from colliding with ids the application itself uses.
 */
export function headingSlugs() {
  return (tree: HastNode): void => {
    const used = new Map<string, number>();
    const visit = (node: HastNode) => {
      if (node.type === 'element' && node.tagName && /^h[1-4]$/.test(node.tagName)) {
        const base = slugify(textOf(node)) || 'section';
        const n = used.get(base) ?? 0;
        used.set(base, n + 1);
        node.properties = { ...(node.properties ?? {}), id: `h-${base}${n === 0 ? '' : `-${n}`}` };
      }
      for (const child of node.children ?? []) visit(child);
    };
    visit(tree);
  };
}

interface MdastNode {
  type: string;
  value?: string;
  data?: Record<string, unknown>;
  position?: { start: { offset?: number }; end: { offset?: number } };
  children?: MdastNode[];
}

/**
 * A remark plugin: a paragraph that holds nothing but one `$$…$$` is a
 * display equation. remark-math only treats `$$` as display math when the
 * markers sit on lines of their own; written on one line it is inline math
 * that happens to use two dollar signs, drawn small and left-aligned, which
 * is never what the author meant. `$$x$$` inside a sentence stays inline.
 */
export function displayMathAlone() {
  return (tree: MdastNode, file: { value?: unknown }): void => {
    const source = typeof file.value === 'string' ? file.value : String(file.value ?? '');
    const visit = (node: MdastNode) => {
      const children = node.children ?? [];
      children.forEach((child, i) => {
        if (child.type !== 'paragraph') return visit(child);
        const parts = (child.children ?? []).filter((c) => !(c.type === 'text' && (c.value ?? '').trim() === ''));
        const only = parts[0];
        if (parts.length !== 1 || only?.type !== 'inlineMath') return;
        const start = only.position?.start.offset;
        if (start === undefined || !source.startsWith('$$', start)) return;
        const value = only.value ?? '';
        // The same shape remark-math gives a fenced display equation.
        children[i] = {
          type: 'math',
          value,
          position: child.position,
          data: {
            hName: 'pre',
            hChildren: [{ type: 'element', tagName: 'code', properties: { className: ['language-math', 'math-display'] }, children: [{ type: 'text', value }] }],
          },
        };
      });
    };
    visit(tree);
  };
}
