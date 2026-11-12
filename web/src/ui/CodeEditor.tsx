import { lazy, Suspense } from 'react';
import type { CodeEditorProps } from './CodeEditorImpl';
import { cx } from './Button';

export type { CodeEditorProps, EditorShortcut } from './CodeEditorImpl';

const Impl = lazy(() => import('./CodeEditorImpl'));

/**
 * Code editor. CodeMirror is loaded on first use; until then the text is
 * shown read-only so the layout does not jump.
 */
export function CodeEditor(props: CodeEditorProps) {
  return (
    <Suspense fallback={<pre className={cx('code-editor code-editor-fallback', props.className)}>{props.value}</pre>}>
      <Impl {...props} />
    </Suspense>
  );
}
