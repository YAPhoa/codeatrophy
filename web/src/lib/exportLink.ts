/** The Export page with a selection of items chosen; the selection is in the address, so a reload keeps it. */
export function exportItemsPath(itemIds: readonly string[]): string {
  const params = new URLSearchParams();
  for (const id of itemIds) params.append('item', id);
  return `/export?${params.toString()}`;
}
