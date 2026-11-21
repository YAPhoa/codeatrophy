import { exitDuration, prefersReducedMotion } from './motion';

/**
 * After a failed save, take the user to the first thing that is wrong: focus
 * the first invalid control, or — for an error that belongs to no single
 * control, such as one under a code editor — bring its message into view and
 * focus the control beside it. The control gives a short shake as well.
 *
 * Call it right after setting the errors; it waits for them to be on screen.
 */
export function focusFirstInvalid(root: ParentNode = document): void {
  requestAnimationFrame(() => {
    const control = root.querySelector<HTMLElement>('[aria-invalid="true"]');
    const message = root.querySelector<HTMLElement>('.field-error');
    const controlFirst = control !== null && (message === null || (control.compareDocumentPosition(message) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0);
    const target = controlFirst ? control : (message?.parentElement?.querySelector<HTMLElement>('[contenteditable="true"], textarea, input, select') ?? null);
    (controlFirst ? control : message)?.scrollIntoView({ block: 'center', behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
    target?.focus({ preventScroll: true });
    if (target) shake(target.closest<HTMLElement>(SHAKEN_WHOLE) ?? target);
  });
}

/** Controls drawn as a box around the element that takes focus: the box shakes, not the text inside it. */
const SHAKEN_WHOLE = '.taginput, .editor-frame, .body-editor';

const shakeEnds = new WeakMap<HTMLElement, number>();

/** How long one shake lasts, in ms; nil under reduced motion. */
export const shakeDuration = (): number => exitDuration('--duration-micro') * 4;

/** Plays `.is-shaking` (ui.css) from the start, even when the last shake has not ended. */
export function shake(el: HTMLElement): void {
  const ms = shakeDuration();
  if (ms === 0) return;
  el.classList.remove('is-shaking');
  void el.offsetWidth;
  el.classList.add('is-shaking');
  window.clearTimeout(shakeEnds.get(el));
  shakeEnds.set(el, window.setTimeout(() => el.classList.remove('is-shaking'), ms));
}
