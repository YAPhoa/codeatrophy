import { Suspense, useEffect, useState } from 'react';
import { lazyPart } from '../lib/newBuild';
import { cx } from './Button';
import { ReloadNotice } from './ReloadNotice';

const loadImpl = () => import('./MarkdownImpl');
// Every screen that imports this one shows Markdown as soon as it opens, so the
// renderer starts loading with the screen rather than on its first render.
loadImpl().catch(() => {});

const Impl = lazyPart(
  loadImpl,
  // The renderer of the build this tab runs is gone; the text is shown as it is.
  ({ source }: { source: string }) => (
    <>
      <ReloadNotice />
      <pre translate="no" className="md-fallback">{source}</pre>
    </>
  ),
);

/**
 * Stands in while the renderer loads. The raw text is laid out but hidden, so
 * a reload does not flash unrendered Markdown; it fades in as it is only if
 * the renderer is slow to arrive. It waits longer than a loading indicator
 * (`useLoadingShown`): it is the text itself, not a sign of progress.
 */
function Pending({ source }: { source: string }) {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setShown(true), 800);
    return () => clearTimeout(t);
  }, []);
  return (
    <pre translate="no" className={cx('md-fallback', 'loading-delay', !shown && 'is-pending')}>
      {source}
    </pre>
  );
}

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
      <Suspense fallback={<Pending source={source} />}>
        <Impl source={source} />
      </Suspense>
    </div>
  );
}
