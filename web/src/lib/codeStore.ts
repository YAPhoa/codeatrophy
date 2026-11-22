// The code being written on a problem lives on the server, as one working
// copy per language (docs/api.md, "Working copies"). This browser keeps only
// a safety net and a few conveniences, in localStorage:
//
// - `unsaved:<itemId>:<language>`: an edit the server has not confirmed yet,
//   as JSON `{ "source": "…", "base": "<updatedAt>" | null, "sending": "…" }`:
//   its code, the `updatedAt` of the server copy it was based on (`null` for
//   none; left out when not known), and the code of a save that was under
//   way as it was made (left out when none was). Removed once a save of it
//   succeeds. When the problem opens, `openWorkspace` decides whether it
//   still wins.
// - `code:<itemId>:<language>`: code kept by older versions, which kept it
//   only here. Uploaded once where the server has no copy, then removed.
// - `lang:<itemId>`, `lang:last`: the language last chosen on a problem and
//   anywhere, for a problem with nothing on the server yet.
// - `stdin:<itemId>`: the custom input of a problem.

import type { WorkingCopy } from '../api/types';
import { keysStartingWith, readJson, readString, remove, writeJson, writeString } from './storage';

const unsavedPrefix = (itemId: string) => `unsaved:${itemId}:`;
const legacyPrefix = (itemId: string) => `code:${itemId}:`;
const langKey = (itemId: string) => `lang:${itemId}`;
const LAST_LANG = 'lang:last';
const inputKey = (itemId: string) => `stdin:${itemId}`;

/**
 * The largest custom input that is remembered, in bytes. The API takes far
 * more (`limits.maxTestDataBytes`), but localStorage is small and shared.
 */
export const MAX_STORED_INPUT_BYTES = 64 * 1024;

/** Every entry under `prefix`, by the language that ends its key. */
function byLanguage(prefix: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of keysStartingWith(prefix)) {
    const value = readString(key);
    if (value !== null) out[key.slice(prefix.length)] = value;
  }
  return out;
}

/** An edit the server has not confirmed. */
export interface UnsavedEdit {
  source: string;
  /** The `updatedAt` of the server copy the edit was based on, `null` when there was none; absent when not known. */
  base?: string | null;
  /** The code of a save under way as the edit was made, which may have landed since; absent when none was. */
  sending?: string;
}

/** This browser's edits of a problem that the server has not confirmed, by language. Entries of another shape are ignored. */
export function readUnsaved(itemId: string): Record<string, UnsavedEdit> {
  const prefix = unsavedPrefix(itemId);
  const out: Record<string, UnsavedEdit> = {};
  for (const key of keysStartingWith(prefix)) {
    const entry = readJson<unknown>(key, null);
    if (typeof entry !== 'object' || entry === null) continue;
    const { source, base, sending } = entry as Record<string, unknown>;
    if (typeof source !== 'string') continue;
    out[key.slice(prefix.length)] = {
      source,
      ...(typeof base === 'string' || base === null ? { base } : {}),
      ...(typeof sending === 'string' ? { sending } : {}),
    };
  }
  return out;
}

export function writeUnsaved(itemId: string, language: string, source: string, base: string | null | undefined, sending?: string): void {
  writeJson(unsavedPrefix(itemId) + language, { source, ...(base !== undefined ? { base } : {}), ...(sending !== undefined ? { sending } : {}) });
}

export function clearUnsaved(itemId: string, language: string): void {
  remove(unsavedPrefix(itemId) + language);
}

/** Code an older version kept only in this browser, by language. */
export function readLegacy(itemId: string): Record<string, string> {
  return byLanguage(legacyPrefix(itemId));
}

export function clearLegacy(itemId: string, language: string): void {
  remove(legacyPrefix(itemId) + language);
}

export function rememberLanguage(itemId: string, language: string): void {
  writeString(langKey(itemId), language);
  writeString(LAST_LANG, language);
}

/** The language last chosen on this problem in this browser, if any. */
export function rememberedLanguage(itemId: string): string | null {
  return readString(langKey(itemId));
}

/**
 * Choose the language to open a problem with when the server has no say:
 * the one last used on this item, else the one last used anywhere, else the
 * first language that has starter code, else the first the judge offers.
 */
export function pickLanguage(itemId: string, available: readonly string[], starterCode: Record<string, string>): string | null {
  if (available.length === 0) return null;
  const candidates = [readString(langKey(itemId)), readString(LAST_LANG), ...Object.keys(starterCode)];
  for (const c of candidates) {
    if (c && available.includes(c)) return c;
  }
  return available[0] ?? null;
}

/** What a problem opens with, from its working copies and what this browser kept. */
export interface OpenedWorkspace {
  /** The code of each language that has some of its own, by language; the others open on their starter code. */
  sources: Record<string, string>;
  /** Languages by how recently they were written, the newest first. */
  recent: string[];
  /** Code the server does not have yet and is to be sent, by language. */
  send: Record<string, string>;
  /** Languages whose unsaved edit no longer counts, to be removed: the server holds it already, or holds code written after it. */
  drop: string[];
}

/**
 * Whether an unsaved edit still wins over the server's copy (`undefined` for
 * none). Only the server's own times are compared, never this browser's
 * clock: the edit wins while the server copy is the one it was based on
 * (same `updatedAt`, or none then and none now) or when that is not known.
 * It also wins when the server copy is the code of the save that was under
 * way as the edit was made: that save landed, and the edit came after it.
 * A copy written since, from another device or tab, wins over it. Times are
 * whole seconds, so a copy written in the same second as the base looks
 * unchanged, and the edit wins.
 */
export function unsavedWins(edit: UnsavedEdit, copy: WorkingCopy | undefined): boolean {
  if (edit.sending !== undefined && copy?.source === edit.sending) return true;
  return edit.base === undefined || edit.base === (copy?.updatedAt ?? null);
}

/**
 * Decide which copy of a problem's code wins as it opens, language by language:
 *
 * - an unsaved edit of this browser that the server already holds as it is
 *   is dropped;
 * - otherwise it wins, and is sent, if the server copy has not changed since
 *   the edit was based on it (`unsavedWins`); if it has, the server's copy
 *   wins and the edit is dropped;
 * - otherwise the server's copy;
 * - code an older version kept in this browser (`legacy`) only counts where
 *   the server has no copy and there is no unsaved edit, and is then sent.
 *
 * The unsaved edits that win are the newest, the one in `preferred` (the
 * language last chosen here) first; then the server's copies in its order.
 * Legacy code has no time, so it is not ranked.
 */
export function openWorkspace(
  server: readonly WorkingCopy[],
  unsaved: Readonly<Record<string, UnsavedEdit>>,
  legacy: Readonly<Record<string, string>>,
  preferred: string | null = null,
): OpenedWorkspace {
  const sources: Record<string, string> = {};
  const send: Record<string, string> = {};
  const drop: string[] = [];
  const copies = new Map(server.map((w) => [w.language, w]));
  for (const copy of server) sources[copy.language] = copy.source;
  for (const [language, source] of Object.entries(legacy)) {
    if (language in sources || language in unsaved) continue;
    sources[language] = source;
    send[language] = source;
  }
  const local: string[] = [];
  for (const language of Object.keys(unsaved).sort((a, b) => (a === preferred ? -1 : b === preferred ? 1 : a.localeCompare(b)))) {
    const edit = unsaved[language]!;
    const copy = copies.get(language);
    if (copy?.source === edit.source || !unsavedWins(edit, copy)) {
      drop.push(language);
      continue;
    }
    local.push(language);
    sources[language] = edit.source;
    send[language] = edit.source;
  }
  const recent = [...new Set([...local, ...server.map((w) => w.language)])];
  return { sources, recent, send, drop };
}

/**
 * The language to open with: that of the newest working copy if the judge
 * offers it, else what `pickLanguage` chooses.
 */
export function openingLanguage(itemId: string, available: readonly string[], recent: readonly string[], starterCode: Record<string, string>): string | null {
  const newest = recent[0];
  if (newest !== undefined && available.includes(newest)) return newest;
  return pickLanguage(itemId, available, starterCode);
}

/** The code a language shows: its own, else the starter, else nothing. */
export function codeFor(sources: Readonly<Record<string, string>>, starterCode: Record<string, string>, language: string): string {
  return sources[language] ?? starterCode[language] ?? '';
}

/**
 * The order to send what `openWorkspace` found: the language the editor
 * opens with last, so that it is the newest on the server and the next
 * opening, here or elsewhere, comes back to it.
 */
export function sendOrder(send: Readonly<Record<string, string>>, opening: string | null): string[] {
  const languages = Object.keys(send).sort();
  return opening && languages.includes(opening) ? [...languages.filter((l) => l !== opening), opening] : languages;
}

/** The custom input last used on a problem, or empty. */
export function loadCustomInput(itemId: string): string {
  return readString(inputKey(itemId)) ?? '';
}

/**
 * Remember a problem's custom input. An empty one, or one too large to keep,
 * clears what was stored, so an older input does not come back in its place.
 */
export function saveCustomInput(itemId: string, input: string): void {
  if (input === '' || new Blob([input]).size > MAX_STORED_INPUT_BYTES) remove(inputKey(itemId));
  else writeString(inputKey(itemId), input);
}
