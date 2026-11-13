/** Hand the browser a file to save. */
export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** Save a value as an indented JSON file. */
export function saveJson(value: unknown, filename: string): void {
  saveBlob(new Blob([`${JSON.stringify(value, null, 2)}\n`], { type: 'application/json' }), filename);
}
