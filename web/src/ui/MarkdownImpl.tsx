import { useState, type ComponentPropsWithoutRef } from 'react';
import ReactMarkdown, { type ExtraProps, type Options } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import rehypeHighlight from 'rehype-highlight';
import 'katex/dist/katex.min.css';
import { ImageOff } from 'lucide-react';
import { CodeTabs } from './CodeTabs';
import { codeTabs, detailsBlocks, displayMathAlone, headingSlugs } from './markdownPlugins';
import { markdownUrlTransform } from './markdownUrl';
import { MermaidDiagram } from './Mermaid';
import { hashTarget, revealTarget } from './revealTarget';

// Item bodies can come from imported third-party bundles, so they are treated
// as untrusted: raw HTML in the Markdown is never turned into elements (there
// is deliberately no `rehype-raw` here), KaTeX runs with `trust` off, and
// react-markdown's default URL filter drops `javascript:` and similar links
// (an image may still be a data URL of an image: `markdownUrl.ts`). The one
// exception to the first is a collapsible `<details>` block, which
// `detailsBlocks` rebuilds from its tags alone (`markdownPlugins.ts`).
// `codeTabs` groups code blocks marked `tab` into one with a tab per language.
const remarkPlugins: Options['remarkPlugins'] = [remarkGfm, remarkMath, displayMathAlone, detailsBlocks, codeTabs];
const rehypePlugins: Options['rehypePlugins'] = [
  // KaTeX writes errorColor inline on a command it will not render; its own
  // #cc0000 is too faint on the dark theme.
  [rehypeKatex, { throwOnError: false, strict: 'ignore', trust: false, errorColor: 'var(--danger)' }],
  // A diagram's source reaches MermaidDiagram as written.
  [rehypeHighlight, { detect: false, plainText: ['mermaid'] }],
  headingSlugs,
];

function isLocalUrl(src: string): boolean {
  // The URL filter lets only image data URLs through (`markdownUrl.ts`).
  if (src.startsWith('data:') || src.startsWith('blob:')) return true;
  try {
    return new URL(src, window.location.href).origin === window.location.origin;
  } catch {
    return false;
  }
}

/**
 * Images hosted elsewhere are not fetched until asked for: loading them would
 * tell a third-party server that (and when) this item was opened.
 */
function SafeImage({ src, alt, title }: ComponentPropsWithoutRef<'img'>) {
  const [allowed, setAllowed] = useState(false);
  if (typeof src !== 'string' || src === '') return null;
  if (allowed || isLocalUrl(src)) return <img src={src} alt={alt ?? ''} title={title} loading="lazy" />;
  let host = src;
  try {
    host = new URL(src).host;
  } catch {
    // Keep the raw value.
  }
  return (
    <button type="button" className="md-image-blocked" onClick={() => setAllowed(true)} title={src}>
      <ImageOff size={14} aria-hidden="true" />
      <span>
        Load image{alt ? ` “${alt}”` : ''} from {host}
      </span>
    </button>
  );
}

function ExternalLink({ href, children, ...rest }: ComponentPropsWithoutRef<'a'>) {
  // Links whose URL was rejected by the sanitiser (`javascript:`, `data:`, …)
  // arrive with an empty href; show their text without making it clickable.
  if (!href) return <span className="md-dead-link" title="This link was removed because its address is not safe to open">{children}</span>;
  const internal = href.startsWith('#') || href.startsWith('/');
  const target = hashTarget(href);
  return (
    <a
      {...rest}
      href={href}
      // A heading or footnote inside a closed details block opens before the jump.
      onClick={target === null ? undefined : () => revealTarget(target)}
      {...(internal ? {} : { target: '_blank', rel: 'noopener noreferrer nofollow' })}
    >
      {children}
    </a>
  );
}

function Table(props: ComponentPropsWithoutRef<'table'>) {
  return (
    <div className="md-table-wrap">
      <table {...props} />
    </div>
  );
}

/** Task-list checkboxes are read-only markers; give them a name for assistive technology. */
function TaskCheckbox(props: ComponentPropsWithoutRef<'input'>) {
  if (props.type !== 'checkbox') return <input {...props} />;
  return <input {...props} disabled aria-label={props.checked ? 'Done' : 'Not done'} />;
}

type Element = NonNullable<ExtraProps['node']>;
type ElementContent = Element['children'][number];

function textOf(node: ElementContent): string {
  if (node.type === 'text') return node.value;
  return node.type === 'element' ? node.children.map(textOf).join('') : '';
}

/** The source of a ```mermaid block, or null for any other `pre`. */
function mermaidSource(pre: Element | undefined): string | null {
  const code = pre?.children.find((c): c is Element => c.type === 'element' && c.tagName === 'code');
  const classes = code?.properties.className;
  if (!code || !Array.isArray(classes) || !classes.includes('language-mermaid')) return null;
  return textOf(code).replace(/\n$/, '');
}

/** The tab languages of a group made by `codeTabs`, or null for any other `div`. */
function tabLanguages(div: Element | undefined): string[] | null {
  const classes = div?.properties.className;
  const languages = div?.properties.dataLanguages;
  if (!Array.isArray(classes) || !classes.includes('md-code-tabs') || typeof languages !== 'string') return null;
  return languages.split(' ');
}

const components: Options['components'] = {
  input: ({ node: _node, ...props }) => <TaskCheckbox {...props} />,
  img: ({ node: _node, ...props }) => <SafeImage {...props} />,
  a: ({ node: _node, ...props }) => <ExternalLink {...props} />,
  table: ({ node: _node, ...props }) => <Table {...props} />,
  // Code is not prose: a page translator must leave it as written.
  code: ({ node: _node, ...props }) => <code translate="no" {...props} />,
  pre: ({ node, ...props }) => {
    const diagram = mermaidSource(node);
    return diagram === null ? <pre translate="no" {...props} /> : <MermaidDiagram source={diagram} />;
  },
  div: ({ node, ...props }) => {
    const languages = tabLanguages(node);
    return languages === null ? <div {...props} /> : <CodeTabs languages={languages}>{props.children}</CodeTabs>;
  },
};

export default function MarkdownImpl({ source }: { source: string }) {
  return (
    <ReactMarkdown remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins} components={components} urlTransform={markdownUrlTransform}>
      {source}
    </ReactMarkdown>
  );
}
