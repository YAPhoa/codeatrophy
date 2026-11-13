/**
 * Whether the device is used with a mouse or trackpad. Focusing a field when
 * a page opens is a convenience there; on a touch screen it throws up the
 * keyboard and scrolls the page before anything has been read.
 */
export function finePointer(): boolean {
  return window.matchMedia?.('(hover: hover) and (pointer: fine)').matches !== false;
}
