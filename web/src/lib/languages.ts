// Display names and file extensions for the canonical language ids owned by
// the app (docs/api.md). The set actually runnable comes from `GET /meta`.

export interface LanguageInfo {
  id: string;
  name: string;
  ext: string;
}

export const LANGUAGES: readonly LanguageInfo[] = [
  { id: 'python', name: 'Python', ext: 'py' },
  { id: 'cpp', name: 'C++', ext: 'cpp' },
  { id: 'c', name: 'C', ext: 'c' },
  { id: 'java', name: 'Java', ext: 'java' },
  { id: 'javascript', name: 'JavaScript', ext: 'js' },
  { id: 'typescript', name: 'TypeScript', ext: 'ts' },
  { id: 'go', name: 'Go', ext: 'go' },
  { id: 'rust', name: 'Rust', ext: 'rs' },
  { id: 'csharp', name: 'C#', ext: 'cs' },
  { id: 'kotlin', name: 'Kotlin', ext: 'kt' },
  { id: 'ruby', name: 'Ruby', ext: 'rb' },
];

const BY_ID = new Map(LANGUAGES.map((l) => [l.id, l]));

export function languageName(id: string): string {
  return BY_ID.get(id)?.name ?? id;
}

/** Sort language ids in the canonical display order; unknown ids go last, alphabetically. */
export function sortLanguages(ids: readonly string[]): string[] {
  const order = (id: string) => {
    const i = LANGUAGES.findIndex((l) => l.id === id);
    return i === -1 ? LANGUAGES.length : i;
  };
  return ids.slice().sort((a, b) => order(a) - order(b) || a.localeCompare(b));
}

/**
 * Label for a language picker. With the judge's language list it includes the
 * toolchain version ("C++ (GCC 9.2.0)"), which decides which language features
 * a solution can use.
 */
export function languageLabel(id: string, judgeLanguages: readonly { id: string; name: string; version: string }[] = []): string {
  const judged = judgeLanguages.find((l) => l.id === id);
  if (!judged) return languageName(id);
  const name = judged.name || languageName(id);
  return judged.version ? `${name} (${judged.version})` : name;
}
