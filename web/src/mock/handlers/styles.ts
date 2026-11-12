// Style preset endpoints, and resolving the preset a generation should use.

import type { StylePreset } from '../../api/types';
import type { MockDb } from '../db';
import { charCount, LIMITS, normaliseText } from '../db';
import type { Handler, Req } from '../http';
import { conflict, created, invalid, noContent, notFound, objectBody, ok, Validator } from '../http';
import { uuid } from '../util';

// Every C0/C1 control character except tab and newline.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/;

/**
 * Normalise line endings, trim and check a preset text field. Lengths are
 * counted in Unicode code points. A name is a single line.
 */
function checkText(value: unknown, field: 'name' | 'instructions', v: Validator): string | undefined {
  if (typeof value !== 'string') {
    v.add(field, 'must be a string');
    return undefined;
  }
  const max = field === 'name' ? LIMITS.maxStyleNameChars : LIMITS.maxStyleInstructionsChars;
  const text = normaliseText(value).trim();
  const length = charCount(text);
  if (length < 1) v.add(field, 'is required');
  else if (length > max) v.add(field, `must be at most ${max} characters (it has ${length})`);
  else if (field === 'name' && /[\n\t]/.test(text)) v.add(field, 'must be a single line (no newline or tab)');
  else if (CONTROL.test(text)) v.add(field, 'must not contain control characters other than newline and tab');
  else return text;
  return undefined;
}

function getStyle(db: MockDb, id: string): StylePreset {
  const style = db.styles.find((s) => s.id === id);
  if (!style) throw notFound('style preset');
  return style;
}

function nameTaken(db: MockDb, name: string, except?: StylePreset): boolean {
  return db.styles.some((s) => s !== except && s.name.toLowerCase() === name.toLowerCase());
}

/** Default first, then by name ignoring case. */
function listStyles(db: MockDb) {
  const items = [...db.styles].sort(
    (a, b) => Number(b.isDefault) - Number(a.isDefault) || a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }),
  );
  return ok({ items: items.map((s) => ({ ...s })) });
}

function createStyle(db: MockDb, req: Req) {
  const raw = objectBody(req);
  const v = new Validator();
  const name = raw.name === undefined ? (v.add('name', 'is required'), undefined) : checkText(raw.name, 'name', v);
  const instructions =
    raw.instructions === undefined
      ? (v.add('instructions', 'is required'), undefined)
      : checkText(raw.instructions, 'instructions', v);
  if (raw.isDefault !== undefined && typeof raw.isDefault !== 'boolean') v.add('isDefault', 'must be a boolean');
  if (name !== undefined && nameTaken(db, name)) v.add('name', 'is already used by another preset');
  v.check();
  if (db.styles.length >= LIMITS.maxStylePresets) {
    throw conflict(`an instance can hold at most ${LIMITS.maxStylePresets} style presets; delete one first`);
  }
  const now = db.now();
  const style: StylePreset = {
    id: uuid(),
    name: name!,
    instructions: instructions!,
    isDefault: raw.isDefault === true,
    createdAt: now,
    updatedAt: now,
  };
  if (style.isDefault) for (const other of db.styles) other.isDefault = false;
  db.styles.push(style);
  return created({ ...style });
}

function patchStyle(db: MockDb, req: Req) {
  const style = getStyle(db, req.params.id!);
  const raw = objectBody(req);
  const v = new Validator();
  const name = raw.name === undefined ? undefined : checkText(raw.name, 'name', v);
  const instructions = raw.instructions === undefined ? undefined : checkText(raw.instructions, 'instructions', v);
  if (raw.isDefault !== undefined && typeof raw.isDefault !== 'boolean') v.add('isDefault', 'must be a boolean');
  if (name !== undefined && nameTaken(db, name, style)) v.add('name', 'is already used by another preset');
  v.check();
  if (name !== undefined) style.name = name;
  if (instructions !== undefined) style.instructions = instructions;
  if (raw.isDefault === true) for (const other of db.styles) other.isDefault = other === style;
  if (raw.isDefault === false) style.isDefault = false;
  style.updatedAt = db.now();
  return ok({ ...style });
}

/**
 * The preset a draft or variant request asks for: the default when `styleId`
 * is omitted, none for an explicit `null`, otherwise the named preset.
 */
export function resolveStyle(db: MockDb, raw: Record<string, unknown>): StylePreset | null {
  const id = raw.styleId;
  if (id === undefined) return db.styles.find((s) => s.isDefault) ?? null;
  if (id === null) return null;
  const style = typeof id === 'string' ? db.styles.find((s) => s.id === id) : undefined;
  if (!style) throw invalid('styleId', 'is not the id of an existing style preset');
  return style;
}

export function styleRoutes(db: MockDb): [string, string, Handler][] {
  return [
    ['GET', '/styles', () => listStyles(db)],
    ['POST', '/styles', (req) => createStyle(db, req)],
    ['PATCH', '/styles/:id', (req) => patchStyle(db, req)],
    [
      'DELETE',
      '/styles/:id',
      (req) => {
        const style = getStyle(db, req.params.id!);
        db.styles = db.styles.filter((s) => s !== style);
        return noContent();
      },
    ],
  ];
}
