import { useEffect, useRef, type FocusEvent } from 'react';

/** How long the pointer rests on something, or focus stays in it, before that counts as meaning to open it. */
export const INTENT_MS = 100;

/**
 * Event handlers that call `act` once the pointer has rested on the element,
 * or focus has stayed within it, for INTENT_MS: time enough to load what it
 * opens before the click. Leaving sooner cancels, so sweeping the pointer
 * down a list asks for nothing. Pressing on it acts at once. One timer per
 * element, and none at rest.
 */
export function useIntent(act: () => void) {
  const timer = useRef<number | undefined>(undefined);
  const latest = useRef(act);
  useEffect(() => {
    latest.current = act;
  });
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const start = () => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => latest.current(), INTENT_MS);
  };
  const cancel = () => window.clearTimeout(timer.current);
  return {
    onPointerEnter: start,
    onPointerLeave: cancel,
    // Pressing is intent enough: a quick click still gains the time until release.
    onPointerDown: () => {
      cancel();
      latest.current();
    },
    onFocus: start,
    onBlur: (e: FocusEvent) => {
      // Focus moving within the element is still focus in it.
      if (!(e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget))) cancel();
    },
  };
}
