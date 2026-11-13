import { Suspense } from 'react';
import { lazyPart } from '../lib/newBuild';
import { cx } from './Button';
import { ReloadNotice } from './ReloadNotice';

const Impl = lazyPart(
  () => import('./MarkdownImpl'),
  // The renderer of the build this tab runs is gone; the text is shown as it is.
  ({ source }: { source: string }) => (
    <>
      <ReloadNotice />
      <pre className="md-fallback">{source}</pre>
    </>
  ),
);

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
