import { useEffect, useRef } from 'react';

/** True when the event target is somewhere the user is typing. */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag === 'INPUT') {
    const type = (target as HTMLInputElement).type;
    return type !== 'checkbox' && type !== 'radio' && type !== 'button';
  }
  return target.closest('.cm-editor') !== null;
}

export const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform ?? '');

/** Label for the platform's primary modifier key. */
export const MOD = isMac ? '⌘' : 'Ctrl';

type Handler = (e: KeyboardEvent) => void;

/**
 * Register document-level keyboard shortcuts. Keys are written like `c`,
 * `?`, `mod+k` or `mod+shift+enter` (`mod` is ⌘ on macOS and Ctrl elsewhere).
 * Plain-key shortcuts are ignored while the user is typing in a field, and
 * all shortcuts are ignored while a modal dialog is open unless
 * `allowInDialog` is set.
 */
export function useHotkeys(bindings: Record<string, Handler>, options: { enabled?: boolean; allowInDialog?: boolean } = {}): void {
  const ref = useRef(bindings);
  useEffect(() => {
    ref.current = bindings;
  });
  const { enabled = true, allowInDialog = false } = options;

  useEffect(() => {
    if (!enabled) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing) return;
      if (!allowInDialog && document.querySelector('[role="dialog"][aria-modal="true"]')) return;
      const mod = isMac ? e.metaKey : e.ctrlKey;
      const parts: string[] = [];
      if (mod) parts.push('mod');
      if (e.altKey) parts.push('alt');
      const key = e.key.toLowerCase();
      // Shift is part of the combo for named keys and letters, but not for symbols like "?".
      if (e.shiftKey && (key.length > 1 || /[a-z0-9]/.test(key))) parts.push('shift');
      parts.push(key);
      const combo = parts.join('+');
      const handler = ref.current[combo];
      if (!handler) return;
      const plain = !mod && !e.altKey;
      if (plain && isTypingTarget(e.target)) return;
      handler(e);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [enabled, allowInDialog]);
}
