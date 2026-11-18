import type { QueryClient } from '@tanstack/react-query';

/**
 * The longest the first paint waits. Past it the app shows as far as it has
 * got: a part still loading keeps its place, and its own indicator appears
 * once LOADING_SHOWS_AFTER_MS (lib/motion.ts) have passed, a little later.
 */
export const REVEAL_BY_MS = 300;
/** Stand-ins that mean the page is still filling in. */
const STAND_INS = '.page-state, .md-fallback, .code-editor-fallback, .item-skeleton';

/** Whether the app is still hidden while it starts. */
export function isBooting(): boolean {
  return document.documentElement.classList.contains('is-booting');
}

/**
 * index.html hides the app while it starts (`is-booting` on <html>). Show it
 * once the first data has arrived (or failed), no stand-ins are left and the
 * fonts in use have loaded, so a reload paints the shell, the sidebar's
 * counts and the first screen in one frame rather than piece by piece. The
 * stylesheet fades it in. Only the first paint waits: later navigation never
 * does.
 */
export function revealWhenSettled(queryClient: QueryClient): void {
  const start = performance.now();
  // Settled for two frames in a row: between a query ending and the next
  // screen starting its own there can be one frame with nothing pending.
  let settled = 0;
  const check = () => {
    const ready =
      queryClient.isFetching() === 0 &&
      document.fonts?.status !== 'loading' &&
      document.getElementById('root')?.firstElementChild != null &&
      document.querySelector(STAND_INS) === null;
    settled = ready ? settled + 1 : 0;
    if (settled >= 2 || performance.now() - start > REVEAL_BY_MS) document.documentElement.classList.remove('is-booting');
    else requestAnimationFrame(check);
  };
  requestAnimationFrame(check);
}
