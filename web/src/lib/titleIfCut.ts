import type { MouseEvent } from 'react';

/**
 * On hover, gives text cut off with an ellipsis, or clamped to a few lines,
 * its full wording as a tooltip, and none when it fits. Put it on the element
 * that cuts its text (`onMouseEnter={titleIfCut}`).
 */
export function titleIfCut(e: MouseEvent<HTMLElement>): void {
  const el = e.currentTarget;
  const cut = el.scrollWidth > el.clientWidth || el.scrollHeight > el.clientHeight + 1;
  el.title = cut ? (el.textContent ?? '').trim() : '';
}
