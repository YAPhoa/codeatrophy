import type { ChangeSource } from '../api/types';

/**
 * One piece of the line that says who created and last changed an item:
 * wording, or a value the client reported (`value: true`, a model or an MCP
 * client's name), which is shown cut short with its full text on hover.
 */
export interface ChangePart {
  text: string;
  value?: true;
}

interface Source {
  via: ChangeSource['via'];
  client: string | null;
  model: string | null;
}

const VIAS = new Set(['http', 'mcp', 'import']);

/** Blank strings count as none; anything that is not a change source is none. */
function normalise(s: ChangeSource | null | undefined): Source | null {
  if (!s || typeof s !== 'object' || !VIAS.has(s.via)) return null;
  const text = (v: unknown) => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);
  return { via: s.via, client: text(s.client), model: text(s.model) };
}

const value = (text: string): ChangePart => ({ text, value: true });

/** "by <model> via <client>", "via <client>", "by <model> via MCP" or "via MCP", after `verb`. */
function overMcp(verb: string, s: Source): ChangePart[] {
  const via = s.client ? [{ text: ' via ' }, value(s.client)] : [{ text: ' via MCP' }];
  return s.model ? [{ text: `${verb} by ` }, value(s.model), ...via] : [{ text: verb }, ...via];
}

function createdPart(s: Source | null): ChangePart[] {
  if (!s) return [];
  switch (s.via) {
    case 'http':
      // Written by hand in the UI: nothing worth saying.
      return s.model ? [{ text: 'Created by ' }, value(s.model)] : [];
    case 'mcp':
      return overMcp('Created', s);
    case 'import':
      return [{ text: 'Imported' }];
  }
}

/** `byOthers`: the creation names an AI or an import, so a later edit by hand is worth saying. */
function updatedPart(u: Source | null, c: Source | null, byOthers: boolean): ChangePart[] {
  if (!u) return [];
  if (c && u.via === c.via && u.client === c.client && u.model === c.model) return [];
  switch (u.via) {
    case 'http':
      if (u.model) return [{ text: 'updated by ' }, value(u.model)];
      return byOthers ? [{ text: 'updated by you' }] : [];
    case 'mcp':
      return overMcp('updated', u);
    case 'import':
      return [{ text: 'updated by import' }];
  }
}

/**
 * The line that says who created an item and who last changed it, such as
 * "Created by claude-opus-5-5 via claude-code · updated by you". Empty when
 * there is nothing to say: both unknown, or written by hand and edited by
 * hand (an edit by hand is said only after an AI's or an import's work).
 */
export function changeSourceLine(createdBy: ChangeSource | null | undefined, lastUpdatedBy: ChangeSource | null | undefined): ChangePart[] {
  const c = normalise(createdBy);
  const created = createdPart(c);
  const updated = updatedPart(normalise(lastUpdatedBy), c, created.length > 0);
  const parts = created.length > 0 && updated.length > 0 ? [...created, { text: ' · ' }, ...updated] : [...created, ...updated];
  const first = parts[0];
  if (first) parts[0] = { ...first, text: first.text.charAt(0).toUpperCase() + first.text.slice(1) };
  return parts;
}

/** `changeSourceLine` as plain text. */
export function changeSourceText(createdBy: ChangeSource | null | undefined, lastUpdatedBy: ChangeSource | null | undefined): string {
  return changeSourceLine(createdBy, lastUpdatedBy)
    .map((p) => p.text)
    .join('');
}
