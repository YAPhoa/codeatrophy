import { useState, type ComponentPropsWithoutRef } from 'react';
import ReactMarkdown, { type Options } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import rehypeHighlight from 'rehype-highlight';
import 'katex/dist/katex.min.css';
import { ImageOff } from 'lucide-react';
import { headingSlugs } from './markdownPlugins';

// Item bodies can come from imported third-party bundles, so they are treated
// as untrusted: raw HTML in the Markdown is never turned into elements (there
// is deliberately no `rehype-raw` here), KaTeX runs with `trust` off, and
// react-markdown's default URL filter drops `javascript:` and similar links.
const remarkPlugins: Options['remarkPlugins'] = [remarkGfm, remarkMath];
const rehypePlugins: Options['rehypePlugins'] = [
  [rehypeKatex, { throwOnError: false, strict: 'ignore', trust: false }],
  [rehypeHighlight, { detect: false }],
  headingSlugs,
];

function isLocalUrl(src: string): boolean {
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
  const internal = typeof href === 'string' && (href.startsWith('#') || href.startsWith('/'));
  return (
    <a {...rest} href={href} {...(internal ? {} : { target: '_blank', rel: 'noopener noreferrer nofollow' })}>
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

const components: Options['components'] = {
  input: ({ node: _node, ...props }) => <TaskCheckbox {...props} />,
  img: ({ node: _node, ...props }) => <SafeImage {...props} />,
  a: ({ node: _node, ...props }) => <ExternalLink {...props} />,
  table: ({ node: _node, ...props }) => <Table {...props} />,
};

export default function MarkdownImpl({ source }: { source: string }) {
  return (
    <ReactMarkdown remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins} components={components}>
      {source}
    </ReactMarkdown>
  );
}
