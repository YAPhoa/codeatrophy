/*
 * An API key belongs to the server it was saved for. The server never sends
 * a stored key to a different origin: saving a base URL that points
 * elsewhere deletes the saved key (unless a new one comes with it), and a
 * connection test against such a URL only uses a key typed for that test.
 * These helpers let the settings form say so before the user saves.
 */

/** Scheme, host and port of a URL, or null when the text is not an absolute http(s) URL. */
export function originOf(url: string | null | undefined): string | null {
  const text = (url ?? '').trim();
  if (text === '') return null;
  try {
    const parsed = new URL(text);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.origin : null;
  } catch {
    return null;
  }
}

/**
 * Whether going from `current` to `next` moves to a different server. Text
 * that is not a URL yet (still being typed) does not count as a move.
 */
export function movesToAnotherServer(current: string | null | undefined, next: string | null | undefined): boolean {
  const from = originOf(current);
  const to = originOf(next);
  return from !== null && to !== null && from !== to;
}

/** The host (with port) of a URL for display, falling back to the text itself. */
export function hostOf(url: string | null | undefined): string {
  const text = (url ?? '').trim();
  try {
    return new URL(text).host || text;
  } catch {
    return text;
  }
}
