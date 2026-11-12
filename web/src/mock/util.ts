// Small helpers shared by the mock modules.

/** Language ids the app owns (docs/api.md, "Enumerations"). */
export const CANONICAL_LANGUAGES: readonly string[] = [
  'c',
  'cpp',
  'csharp',
  'go',
  'java',
  'javascript',
  'kotlin',
  'python',
  'ruby',
  'rust',
  'typescript',
];

export const LANGUAGE_EXTENSIONS: Readonly<Record<string, string>> = {
  c: 'c',
  cpp: 'cpp',
  csharp: 'cs',
  go: 'go',
  java: 'java',
  javascript: 'js',
  kotlin: 'kt',
  python: 'py',
  ruby: 'rb',
  rust: 'rs',
  typescript: 'ts',
};

export function isLanguage(value: unknown): value is string {
  return typeof value === 'string' && CANONICAL_LANGUAGES.includes(value);
}

/** A random UUID. `crypto.randomUUID` only exists in secure contexts, so fall back. */
export function uuid(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const hex = (n: number) =>
    Array.from({ length: n }, () => Math.floor(Math.random() * 16).toString(16)).join('');
  return `${hex(8)}-${hex(4)}-4${hex(3)}-a${hex(3)}-${hex(12)}`;
}

export function slugify(text: string): string {
  const slug = text
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/, '');
  return slug || 'untitled';
}

/** FNV-1a, for cheap deterministic pseudo-randomness. */
export function hash32(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function abortError(): DOMException {
  return new DOMException('Aborted', 'AbortError');
}

/** Wait `ms`, rejecting with an AbortError as soon as `signal` fires. */
export function sleep(ms: number, signal?: AbortSignal | null): Promise<void> {
  if (signal?.aborted) return Promise.reject(abortError());
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export function clone<T>(value: T): T {
  return structuredClone(value);
}

/** `"The Quick brown fox"` → `"The Quick Brown Fox"`, leaving short joining words alone. */
export function titleCase(text: string): string {
  const small = new Set(['a', 'an', 'and', 'as', 'at', 'by', 'for', 'in', 'of', 'on', 'or', 'the', 'to', 'with']);
  return text
    .split(/\s+/)
    .filter(Boolean)
    .map((word, i) => {
      if (i > 0 && small.has(word.toLowerCase())) return word.toLowerCase();
      return word.charAt(0).toUpperCase() + word.slice(1);
    })
    .join(' ');
}
