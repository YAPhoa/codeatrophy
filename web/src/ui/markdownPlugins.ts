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
