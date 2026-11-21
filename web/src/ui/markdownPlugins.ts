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

// Collapsible blocks. Raw HTML is never rendered (see MarkdownImpl.tsx), with
// one exception: `<details>` (or `<details open>`), an optional
// `<summary>…</summary>` and `</details>` around ordinary Markdown become a
// real details element, so an exercise can hide its answer until clicked.
// GFM parses those tags as `html` nodes beside the Markdown between them; this
// plugin pairs them up and wraps what lies between. Nothing else in the tags is
// honoured: an attribute other than `open` leaves the tag as it was, and the
// summary's content is plain text. A tag that finds no partner stays as raw
// HTML, shown as text like any other.

const OPEN_TAG = /^<details(\s+open)?\s*>/i;
const SUMMARY_TAG = /^<summary\s*>([\s\S]*?)<\/summary\s*>/i;
const CLOSE_TAG = /^<\/details\s*>/i;
const TRAILING_CLOSE_TAG = /<\/details\s*>\s*$/i;

type DetailsToken =
  | { kind: 'open'; open: boolean; raw: string }
  | { kind: 'summary'; text: string; raw: string }
  | { kind: 'close'; raw: string }
  | { kind: 'node'; node: MdastNode };

/** Nodes that hold block content, where a details block may sit. */
const CONTAINERS = new Set(['root', 'blockquote', 'list', 'listItem', 'footnoteDefinition']);

const rawHtml = (raw: string): MdastNode => ({ type: 'html', value: raw });

/** The summary's text as written, on one line; tags inside it are text too. */
const summaryText = (text: string) => text.replace(/\s+/g, ' ').trim();

export function detailsBlocks(this: { parse(text: string): unknown }) {
  // Text that shares an HTML block with the tags (a body written right under
  // `</summary>` without a blank line) is parsed as Markdown on its own.
  const parse = (text: string): MdastNode => {
    const tree = this.parse(text) as MdastNode;
    displayMathAlone()(tree, { value: text });
    transform(tree);
    stripPositions(tree);
    return tree;
  };

  /** The tags at the start and end of an HTML node and the text between, or null when it does not start with one. */
  const lexHtml = (value: string): DetailsToken[] | null => {
    const lead: DetailsToken[] = [];
    let rest = value;
    for (;;) {
      const s = rest.trimStart();
      let m: RegExpMatchArray | null;
      if ((m = s.match(OPEN_TAG))) lead.push({ kind: 'open', open: m[1] !== undefined, raw: m[0] });
      else if ((m = s.match(SUMMARY_TAG))) lead.push({ kind: 'summary', text: summaryText(m[1] ?? ''), raw: m[0] });
      else if ((m = s.match(CLOSE_TAG))) lead.push({ kind: 'close', raw: m[0] });
      else break;
      rest = s.slice(m[0].length);
    }
    if (lead.length === 0) return null;
    const tail: DetailsToken[] = [];
    for (let m = rest.match(TRAILING_CLOSE_TAG); m && m.index !== undefined; m = rest.match(TRAILING_CLOSE_TAG)) {
      tail.unshift({ kind: 'close', raw: m[0].trim() });
      rest = rest.slice(0, m.index);
    }
    const middle = rest.trim();
    return [...lead, ...(middle === '' ? [] : tokensOf(parse(middle).children ?? [])), ...tail];
  };

  const tokensOf = (children: MdastNode[]): DetailsToken[] =>
    children.flatMap((node): DetailsToken[] => {
      if (node.type === 'html') return lexHtml(node.value ?? '') ?? [{ kind: 'node', node }];
      if (node.type !== 'paragraph') return [{ kind: 'node', node }];
      // `last line</details>`: the closing tag ends the paragraph inline.
      const inline = [...(node.children ?? [])];
      const closes: DetailsToken[] = [];
      for (;;) {
        while (inline.length > 0 && inline[inline.length - 1]?.type === 'text' && (inline[inline.length - 1]?.value ?? '').trim() === '') inline.pop();
        const last = inline[inline.length - 1];
        if (last?.type !== 'html' || !/^<\/details\s*>$/i.test((last.value ?? '').trim())) break;
        inline.pop();
        closes.unshift({ kind: 'close', raw: (last.value ?? '').trim() });
      }
      if (closes.length === 0) return [{ kind: 'node', node }];
      const tail = inline[inline.length - 1];
      if (tail?.type === 'text') inline[inline.length - 1] = { ...tail, value: (tail.value ?? '').trimEnd() };
      return [...(inline.length > 0 ? [{ kind: 'node' as const, node: { ...node, children: inline } }] : []), ...closes];
    });

  interface Frame {
    open?: Extract<DetailsToken, { kind: 'open' }>;
    summary?: Extract<DetailsToken, { kind: 'summary' }>;
    children: MdastNode[];
  }

  const details = (frame: Frame): MdastNode => ({
    type: 'details',
    data: { hName: 'details', hProperties: { className: ['md-details'], ...(frame.open?.open ? { open: true } : {}) } },
    children: [
      { type: 'detailsSummary', data: { hName: 'summary', hProperties: { className: ['md-details-summary'] }, hChildren: [{ type: 'text', value: frame.summary?.text || 'Details' }] } },
      ...frame.children,
    ],
  });

  const build = (tokens: DetailsToken[]): MdastNode[] => {
    const stack: Frame[] = [{ children: [] }];
    const top = () => stack[stack.length - 1] as Frame;
    for (const t of tokens) {
      if (t.kind === 'node') top().children.push(t.node);
      else if (t.kind === 'open') stack.push({ open: t, children: [] });
      else if (t.kind === 'summary') {
        const frame = top();
        if (frame.open && !frame.summary && frame.children.length === 0) frame.summary = t;
        else frame.children.push(rawHtml(t.raw));
      } else if (stack.length > 1) {
        const frame = stack.pop() as Frame;
        top().children.push(details(frame));
      } else top().children.push(rawHtml(t.raw));
    }
    // An opening tag never closed is left as it was, its content after it.
    while (stack.length > 1) {
      const frame = stack.pop() as Frame;
      top().children.push(rawHtml(frame.open?.raw ?? ''), ...(frame.summary ? [rawHtml(frame.summary.raw)] : []), ...frame.children);
    }
    return top().children;
  };

  const transform = (node: MdastNode): void => {
    if (!CONTAINERS.has(node.type) || !node.children) return;
    for (const child of node.children) transform(child);
    if (node.type !== 'list') node.children = build(tokensOf(node.children));
  };

  return (tree: MdastNode): void => transform(tree);
}

function stripPositions(node: MdastNode): void {
  delete node.position;
  for (const child of node.children ?? []) stripPositions(child);
}
