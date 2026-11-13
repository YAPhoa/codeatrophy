import { Suspense } from 'react';
import { usePreferences } from '../api/queries';
import { lazyPart } from '../lib/newBuild';
import type { CodeEditorProps } from './CodeEditorImpl';
import { cx } from './Button';
import { resolveEditorOptions } from './editorOptions';
import { ReloadNotice } from './ReloadNotice';

export type { CodeEditorProps, EditorShortcut } from './CodeEditorImpl';

const Impl = lazyPart(
  () => import('./CodeEditorImpl'),
  // The editor of the build this tab runs is gone; the text stays, read-only.
  (props: CodeEditorProps) => (
    <>
      <ReloadNotice />
      <Fallback {...props} />
    </>
  ),
);

/**
 * Code editor. CodeMirror is loaded on first use; until then the text is
 * shown read-only, set the way the editor will set it, so the layout does
 * not jump.
 *
 * The editor follows the user's editor preferences (completion, bracket
 * handling, wrapping, tab size, font size) on its own; nothing has to be
 * passed in for that.
 */
export function CodeEditor(props: CodeEditorProps) {
  return (
    <Suspense fallback={<Fallback {...props} />}>
      <Impl {...props} />
    </Suspense>
  );
}

function Fallback({ value, className, prose, wrap }: CodeEditorProps) {
  const options = resolveEditorOptions(usePreferences().editor, { prose, wrap });
  return (
    <pre
      translate="no"
      className={cx('code-editor code-editor-fallback', className)}
      style={{
        fontFamily: 'var(--font-mono)',
        fontSize: options.fontSize,
        lineHeight: `${options.lineHeight}px`,
        tabSize: options.tabSize,
        whiteSpace: options.lineWrapping ? 'pre-wrap' : 'pre',
      }}
    >
      {value}
    </pre>
  );
}
