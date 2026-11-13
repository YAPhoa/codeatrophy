/**
 * After a failed save, take the user to the first thing that is wrong: focus
 * the first invalid control, or — for an error that belongs to no single
 * control, such as one under a code editor — bring its message into view and
 * focus the control beside it.
 *
 * Call it right after setting the errors; it waits for them to be on screen.
 */
export function focusFirstInvalid(root: ParentNode = document): void {
  requestAnimationFrame(() => {
    const control = root.querySelector<HTMLElement>('[aria-invalid="true"]');
    const message = root.querySelector<HTMLElement>('.field-error');
    const controlFirst = control !== null && (message === null || (control.compareDocumentPosition(message) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0);
    const target = controlFirst ? control : (message?.parentElement?.querySelector<HTMLElement>('[contenteditable="true"], textarea, input, select') ?? null);
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
    (controlFirst ? control : message)?.scrollIntoView({ block: 'center', behavior: reduced ? 'auto' : 'smooth' });
    target?.focus({ preventScroll: true });
  });
}
