// Work-in-progress solution code, kept per item and language in localStorage
// so that switching language, reloading, or coming back next week does not
// lose it.

import { readString, remove, writeString } from './storage';

const codeKey = (itemId: string, language: string) => `code:${itemId}:${language}`;
const langKey = (itemId: string) => `lang:${itemId}`;
const LAST_LANG = 'lang:last';

export function loadCode(itemId: string, language: string): string | null {
  return readString(codeKey(itemId, language));
}

export function saveCode(itemId: string, language: string, source: string): void {
  writeString(codeKey(itemId, language), source);
}

export function clearCode(itemId: string, language: string): void {
  remove(codeKey(itemId, language));
}

export function rememberLanguage(itemId: string, language: string): void {
  writeString(langKey(itemId), language);
  writeString(LAST_LANG, language);
}

/**
 * Choose the language to open a problem with: the one last used on this item,
 * else the one last used anywhere, else the first language that has starter
 * code, else the first the judge offers.
 */
export function pickLanguage(itemId: string, available: readonly string[], starterCode: Record<string, string>): string | null {
  if (available.length === 0) return null;
  const candidates = [readString(langKey(itemId)), readString(LAST_LANG), ...Object.keys(starterCode)];
  for (const c of candidates) {
    if (c && available.includes(c)) return c;
  }
  return available[0] ?? null;
}

/** The code to show when a language is selected: saved work, else the starter, else empty. */
export function initialCode(itemId: string, language: string, starterCode: Record<string, string>): string {
  return loadCode(itemId, language) ?? starterCode[language] ?? '';
}
