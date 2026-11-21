/**
 * Open every closed `<details>` around the element with this id, so that a
 * link to it (the reader's outline, a `#…` link in the text) lands on it
 * rather than on the collapsed block. Call it before the link navigates.
 */
export function revealTarget(id: string): void {
  let details = document.getElementById(id)?.parentElement?.closest('details');
  while (details) {
    details.open = true;
    details = details.parentElement?.closest('details');
  }
}

/** The target id of an in-page link (`#h-…`), or null for any other href. */
export function hashTarget(href: string): string | null {
  if (!href.startsWith('#') || href.length < 2) return null;
  try {
    return decodeURIComponent(href.slice(1));
  } catch {
    return href.slice(1);
  }
}
