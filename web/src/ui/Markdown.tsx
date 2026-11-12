import { lazy, Suspense } from 'react';
import { cx } from './Button';

const Impl = lazy(() => import('./MarkdownImpl'));

interface MarkdownProps {
  source: string;
  className?: string;
  /** Typography for long-form reading rather than dense UI. */
  longform?: boolean;
  /** Shown instead of nothing when the source is empty. */
  emptyText?: string;
}

/**
 * Renders Markdown (GitHub-flavoured, with `$…$` / `$$…$$` math and
 * highlighted code). The renderer is loaded on first use.
 */
export function Markdown({ source, className, longform, emptyText }: MarkdownProps) {
  if (source.trim() === '' && emptyText) return <p className="md-empty">{emptyText}</p>;
  return (
    <div className={cx('md', longform && 'md-longform', className)}>
      <Suspense fallback={<pre className="md-fallback">{source}</pre>}>
        <Impl source={source} />
      </Suspense>
    </div>
  );
}
