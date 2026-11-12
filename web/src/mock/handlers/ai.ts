// The AI endpoints. They never write to the library.

import type { AppliedStyle, StylePreset, VariantMode } from '../../api/types';
import { applyStyle, draftFromText, proposeTestCases, reviseDraft, variantOfItem } from '../ai';
import type { MockDb } from '../db';
import { atMostChars, byteLength, charCount, LIMITS, normaliseText } from '../db';
import type { Handler, Req } from '../http';
import { aiUnavailable, invalid, objectBody, ok, upstream, Validator } from '../http';
import { isLanguage, sleep } from '../util';
import { resolveStyle } from './styles';

const MODES: readonly VariantMode[] = ['similar', 'easier', 'harder', 'twist'];

/** An optional free-form instruction; blank counts as absent. */
function parseInstruction(raw: Record<string, unknown>, v: Validator): string | null {
  const value = raw.instruction;
  if (value == null) return null;
  if (typeof value !== 'string') {
    v.add('instruction', 'must be a string or null');
    return null;
  }
  const text = normaliseText(value).trim();
  if (charCount(text) > LIMITS.maxInstructionChars) v.add('instruction', atMostChars(LIMITS.maxInstructionChars));
  return text === '' ? null : text;
}

/** An optional draft to revise. Its size as JSON is bounded. */
function parsePreviousDraft(raw: Record<string, unknown>, v: Validator): unknown {
  const value = raw.previousDraft;
  if (value == null) return null;
  if (byteLength(JSON.stringify(value)) > LIMITS.maxPreviousDraftBytes) {
    v.add('previousDraft', `must be at most ${LIMITS.maxPreviousDraftBytes} bytes`);
  }
  return value;
}

const applied = (style: StylePreset | null): AppliedStyle | null => (style ? { id: style.id, name: style.name } : null);

/** Typing `MOCK:FAIL` anywhere in the request simulates a provider failure. */
function failIfAsked(...texts: (string | null)[]): void {
  if (texts.some((t) => t?.includes('MOCK:FAIL'))) {
    throw upstream('the AI provider returned an error: 529 overloaded_error — Overloaded');
  }
}

// The request is validated before the provider is looked at, so an invalid
// request is a `422` even on an instance with no provider configured.

async function draft(db: MockDb, req: Req) {
  const raw = objectBody(req);
  const v = new Validator();
  const text = typeof raw.text === 'string' ? normaliseText(raw.text) : raw.text;
  if (typeof text !== 'string' || text.trim() === '') v.add('text', 'is required');
  else if (charCount(text) > LIMITS.maxDraftTextChars) v.add('text', atMostChars(LIMITS.maxDraftTextChars));
  const typeHint = raw.typeHint ?? 'auto';
  if (typeHint !== 'auto' && typeHint !== 'problem' && typeHint !== 'reading') {
    v.add('typeHint', 'must be auto, problem or reading');
  }
  const instruction = parseInstruction(raw, v);
  const previousDraft = parsePreviousDraft(raw, v);
  v.check();
  const style = resolveStyle(db, raw);
  if (!db.aiEnabled) throw aiUnavailable();

  await sleep(db.delay('aiDraft'));
  failIfAsked(text as string, instruction);
  const result = draftFromText(text as string, typeHint as 'auto' | 'problem' | 'reading', instruction, previousDraft);
  return ok({ draft: applyStyle(result, style), style: applied(style) });
}

async function variant(db: MockDb, req: Req) {
  const item = db.getItem(req.params.id!);
  const raw = objectBody(req);
  const v = new Validator();
  const mode = (raw.mode ?? 'similar') as VariantMode;
  if (!MODES.includes(mode)) v.add('mode', 'must be similar, easier, harder or twist');
  else if (item.type === 'reading' && mode !== 'similar') v.add('mode', 'must be similar for a reading');
  const instruction = parseInstruction(raw, v);
  const previousDraft = parsePreviousDraft(raw, v);
  v.check();
  const style = resolveStyle(db, raw);
  if (!db.aiEnabled) throw aiUnavailable();

  await sleep(db.delay('aiDraft'));
  failIfAsked(instruction);
  // With an earlier variant draft and an instruction this is a revision of
  // that draft, not a fresh variant.
  const result =
    previousDraft != null && instruction ? reviseDraft(previousDraft, instruction) : variantOfItem(db, item, mode, instruction);
  return ok({ draft: applyStyle(result, style), style: applied(style) });
}

async function testCases(db: MockDb, req: Req) {
  const item = db.getItem(req.params.id!);
  if (item.type !== 'problem') throw invalid('item', 'is a reading; only problems have test cases');
  const raw = objectBody(req);
  const v = new Validator();
  const count = raw.count ?? 8;
  if (typeof count !== 'number' || !Number.isInteger(count) || count < 1 || count > LIMITS.maxGeneratedTestCases) {
    v.add('count', `must be between 1 and ${LIMITS.maxGeneratedTestCases}`);
  }
  const language = raw.language ?? 'python';
  if (!isLanguage(language)) v.add('language', 'is not a known language id');
  const instruction = parseInstruction(raw, v);
  v.check();
  if (!db.aiEnabled) throw aiUnavailable();

  await sleep(db.delay('aiTests'));
  failIfAsked(instruction);
  return ok(proposeTestCases(db, item, count as number, language as string));
}

export function aiRoutes(db: MockDb): [string, string, Handler][] {
  return [
    ['POST', '/ai/draft', (req) => draft(db, req)],
    ['POST', '/items/:id/ai/variant', (req) => variant(db, req)],
    ['POST', '/items/:id/ai/testcases', (req) => testCases(db, req)],
  ];
}
