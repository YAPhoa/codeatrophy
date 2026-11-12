// The item editor works on a flat form state. This module converts between
// that state and the API shapes: an AI draft, a stored item, the body of a
// create request, and a minimal PATCH containing only what changed.

import type {
  CompareMode,
  Difficulty,
  Item,
  ItemDraft,
  ItemInput,
  ItemPatch,
  ItemType,
  Limits,
  TestCaseInput,
  TestOrigin,
} from '../api/types';
import { formatBytes } from './format';

export interface FormTestCase {
  /** Client-side key for list rendering; never sent to the server. */
  key: string;
  name: string;
  stdin: string;
  expectedStdout: string;
  isSample: boolean;
  origin: TestOrigin;
}

export interface ItemFormState {
  type: ItemType;
  title: string;
  summary: string;
  body: string;
  difficulty: Difficulty | null;
  tags: string[];
  collectionIds: string[];
  sourceUrl: string;
  sourceNote: string;
  timeLimitMs: number;
  memoryLimitKb: number;
  compare: CompareMode;
  starterCode: Record<string, string>;
  /** Only used when creating: a new item is saved together with these cases. */
  testCases: FormTestCase[];
}

export const PROBLEM_DEFAULTS = { timeLimitMs: 2000, memoryLimitKb: 262144, compare: 'tokens' as CompareMode };

// Keys only need to be unique within a form, including one restored from
// storage after a reload, hence the per-load random prefix.
const keyPrefix = Math.random().toString(36).slice(2, 8);
let keySeq = 0;
export const newKey = (): string => `${keyPrefix}-${++keySeq}`;

export function emptyForm(type: ItemType = 'problem'): ItemFormState {
  return {
    type,
    title: '',
    summary: '',
    body: '',
    difficulty: null,
    tags: [],
    collectionIds: [],
    sourceUrl: '',
    sourceNote: '',
    ...PROBLEM_DEFAULTS,
    starterCode: {},
    testCases: [],
  };
}

export function normalizeTags(tags: readonly string[]): string[] {
  return Array.from(new Set(tags.map((t) => t.trim().toLowerCase()).filter(Boolean))).sort();
}

export function formFromDraft(draft: ItemDraft, defaults: Partial<ItemFormState> = {}): ItemFormState {
  return {
    ...emptyForm(draft.type),
    ...defaults,
    type: draft.type,
    title: draft.title,
    summary: draft.summary,
    body: draft.body,
    difficulty: draft.difficulty,
    tags: normalizeTags([...(defaults.tags ?? []), ...draft.tags]),
    timeLimitMs: draft.problem?.timeLimitMs ?? PROBLEM_DEFAULTS.timeLimitMs,
    memoryLimitKb: draft.problem?.memoryLimitKb ?? PROBLEM_DEFAULTS.memoryLimitKb,
    compare: draft.problem?.compare ?? PROBLEM_DEFAULTS.compare,
    starterCode: { ...(draft.problem?.starterCode ?? {}) },
    testCases: draft.testCases.map((t) => ({ ...t, key: newKey(), origin: 'ai' as const })),
  };
}

/**
 * The draft to send back as `previousDraft` when asking for a revision: the
 * form as the user has edited it, so their changes are not thrown away.
 */
export function draftFromForm(form: ItemFormState, assumptions: readonly string[]): ItemDraft {
  const isProblem = form.type === 'problem';
  return {
    type: form.type,
    title: form.title,
    summary: form.summary,
    body: form.body,
    difficulty: form.difficulty,
    tags: normalizeTags(form.tags),
    problem: isProblem
      ? {
          timeLimitMs: form.timeLimitMs,
          memoryLimitKb: form.memoryLimitKb,
          compare: form.compare,
          starterCode: { ...form.starterCode },
        }
      : null,
    testCases: isProblem
      ? form.testCases.map(({ name, stdin, expectedStdout, isSample }) => ({ name, stdin, expectedStdout, isSample }))
      : [],
    assumptions: [...assumptions],
  };
}

export function formFromItem(item: Item): ItemFormState {
  return {
    type: item.type,
    title: item.title,
    summary: item.summary,
    body: item.body,
    difficulty: item.difficulty,
    tags: [...item.tags],
    collectionIds: [...item.collectionIds],
    sourceUrl: item.source.url ?? '',
    sourceNote: item.source.note ?? '',
    timeLimitMs: item.problem?.timeLimitMs ?? PROBLEM_DEFAULTS.timeLimitMs,
    memoryLimitKb: item.problem?.memoryLimitKb ?? PROBLEM_DEFAULTS.memoryLimitKb,
    compare: item.problem?.compare ?? PROBLEM_DEFAULTS.compare,
    starterCode: { ...(item.problem?.starterCode ?? {}) },
    testCases: [],
  };
}

function cleanStarter(starter: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [lang, src] of Object.entries(starter)) {
    if (src.trim() !== '') out[lang] = src;
  }
  return out;
}

const orNull = (s: string): string | null => (s.trim() === '' ? null : s.trim());

export interface CreateExtras {
  rawInput?: string | null;
  variantOf?: string | null;
}

/** Body for `POST /items` from a reviewed form. */
export function inputFromForm(form: ItemFormState, extras: CreateExtras = {}): ItemInput {
  const isProblem = form.type === 'problem';
  const input: ItemInput = {
    type: form.type,
    title: form.title.trim(),
    summary: form.summary.trim(),
    body: form.body,
    difficulty: form.difficulty,
    tags: normalizeTags(form.tags),
    collectionIds: [...form.collectionIds],
    source: { url: orNull(form.sourceUrl), note: orNull(form.sourceNote) },
    rawInput: extras.rawInput ?? null,
    variantOf: extras.variantOf ?? null,
  };
  if (isProblem) {
    input.problem = {
      timeLimitMs: form.timeLimitMs,
      memoryLimitKb: form.memoryLimitKb,
      compare: form.compare,
      starterCode: cleanStarter(form.starterCode),
    };
    input.testCases = form.testCases.map(
      (t): TestCaseInput => ({
        name: t.name.trim(),
        stdin: t.stdin,
        expectedStdout: t.expectedStdout,
        isSample: t.isSample,
        origin: t.origin,
      }),
    );
  }
  return input;
}

const sameList = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((v, i) => v === b[i]);

const sameRecord = (a: Record<string, string>, b: Record<string, string>) => {
  const ka = Object.keys(a).sort();
  const kb = Object.keys(b).sort();
  return sameList(ka, kb) && ka.every((k) => a[k] === b[k]);
};

/**
 * Body for `PATCH /items/{id}` containing only the fields that differ from
 * `original`. Sending less means a concurrent edit to a field the user did
 * not touch is never overwritten.
 */
export function patchFromForm(original: Item, form: ItemFormState): ItemPatch {
  const patch: ItemPatch = {};
  const title = form.title.trim();
  const summary = form.summary.trim();
  if (title !== original.title) patch.title = title;
  if (summary !== original.summary) patch.summary = summary;
  if (form.body !== original.body) patch.body = form.body;
  if (form.difficulty !== original.difficulty) patch.difficulty = form.difficulty;

  const tags = normalizeTags(form.tags);
  if (!sameList(tags, original.tags)) patch.tags = tags;

  const collections = [...form.collectionIds];
  if (!sameList(collections.slice().sort(), original.collectionIds.slice().sort())) patch.collectionIds = collections;

  const source: ItemPatch['source'] = {};
  if (orNull(form.sourceUrl) !== original.source.url) source.url = orNull(form.sourceUrl);
  if (orNull(form.sourceNote) !== original.source.note) source.note = orNull(form.sourceNote);
  if (Object.keys(source).length > 0) patch.source = source;

  if (original.type === 'problem' && original.problem) {
    const p: NonNullable<ItemPatch['problem']> = {};
    if (form.timeLimitMs !== original.problem.timeLimitMs) p.timeLimitMs = form.timeLimitMs;
    if (form.memoryLimitKb !== original.problem.memoryLimitKb) p.memoryLimitKb = form.memoryLimitKb;
    if (form.compare !== original.problem.compare) p.compare = form.compare;
    const starter = cleanStarter(form.starterCode);
    if (!sameRecord(starter, original.problem.starterCode)) p.starterCode = starter;
    if (Object.keys(p).length > 0) patch.problem = p;
  }
  return patch;
}

/** True when the patch would change fields that are part of the item's revisioned content. */
export function patchTouchesContent(patch: ItemPatch): boolean {
  return Object.keys(patch).some((k) => k !== 'collectionIds' && k !== 'expectedRevision');
}

export type FormErrors = Partial<
  Record<'title' | 'summary' | 'body' | 'timeLimitMs' | 'memoryLimitKb' | 'tags' | 'sourceUrl' | 'sourceNote' | 'testCases', string>
>;

/** Length as the server counts it: in Unicode code points. */
export const charCount = (s: string): number => {
  let n = 0;
  for (const _ of s) n++;
  return n;
};

const encoder = new TextEncoder();
/** Size in bytes once encoded as UTF-8. */
export const byteLength = (s: string): number => encoder.encode(s).length;

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

/** Why a tag would be rejected by the server, or `null` if it is fine. */
export function tagProblem(tag: string, limits: Limits | undefined): string | null {
  if (tag.includes('/')) return 'A tag cannot contain “/”.';
  if (CONTROL.test(tag)) return 'A tag cannot contain control characters.';
  if (limits && charCount(tag) > limits.maxTagChars) return `Each tag can be at most ${limits.maxTagChars} characters.`;
  return null;
}

/**
 * Client-side checks mirroring the server's validation rules, so most
 * mistakes never leave the page. The bounds come from `GET /meta`; without
 * them only the checks that need no bound run, and the server decides.
 */
export function validateForm(form: ItemFormState, limits: Limits | undefined): FormErrors {
  const errors: FormErrors = {};
  const title = form.title.trim();
  if (title.length === 0) errors.title = 'A title is required.';
  else if (limits && charCount(title) > limits.maxTitleChars) errors.title = `Keep the title within ${limits.maxTitleChars} characters.`;

  if (limits && charCount(form.summary.trim()) > limits.maxSummaryChars) {
    errors.summary = `Keep the summary within ${limits.maxSummaryChars.toLocaleString()} characters.`;
  }
  if (limits && byteLength(form.body) > limits.maxTextBytes) errors.body = `The text is larger than ${formatBytes(limits.maxTextBytes)}.`;

  const tags = normalizeTags(form.tags);
  const badTag = tags.map((t) => tagProblem(t, limits)).find((p) => p !== null);
  if (limits && tags.length > limits.maxTags) errors.tags = `At most ${limits.maxTags} tags.`;
  else if (badTag) errors.tags = badTag;

  const url = form.sourceUrl.trim();
  if (url !== '') {
    if (!/^https?:\/\//i.test(url)) errors.sourceUrl = 'A link must start with http:// or https://.';
    else if (limits && charCount(url) > limits.maxSourceUrlChars) errors.sourceUrl = `Keep the link within ${limits.maxSourceUrlChars.toLocaleString()} characters.`;
  }

  if (limits && charCount(form.sourceNote.trim()) > limits.maxSourceNoteChars) {
    errors.sourceNote = `Keep the note within ${limits.maxSourceNoteChars.toLocaleString()} characters.`;
  }

  if (form.type === 'problem') {
    if (limits) {
      const { timeLimitMs: time, memoryLimitKb: memory } = limits;
      if (!Number.isFinite(form.timeLimitMs) || form.timeLimitMs < time.min || form.timeLimitMs > time.max) {
        errors.timeLimitMs = `Between ${time.min} and ${time.max} ms.`;
      }
      if (!Number.isFinite(form.memoryLimitKb) || form.memoryLimitKb < memory.min || form.memoryLimitKb > memory.max) {
        errors.memoryLimitKb = `Between ${memory.min / 1024} and ${memory.max / 1024} MB.`;
      }
      if (form.testCases.length > limits.maxTestCasesPerItem) {
        errors.testCases = `At most ${limits.maxTestCasesPerItem.toLocaleString()} test cases.`;
      } else if (form.testCases.some((t) => charCount(t.name.trim()) > limits.maxTestCaseNameChars)) {
        errors.testCases = `Keep each case name within ${limits.maxTestCaseNameChars} characters.`;
      } else if (form.testCases.some((t) => byteLength(t.stdin) > limits.maxTestDataBytes || byteLength(t.expectedStdout) > limits.maxTestDataBytes)) {
        errors.testCases = `An input or expected output is larger than ${formatBytes(limits.maxTestDataBytes)}.`;
      }
    } else {
      if (!Number.isFinite(form.timeLimitMs)) errors.timeLimitMs = 'Enter a number.';
      if (!Number.isFinite(form.memoryLimitKb)) errors.memoryLimitKb = 'Enter a number.';
    }
  }
  return errors;
}

/**
 * Why a draft cannot be sent back for revision, or `null` if it can: the
 * server bounds the size of `previousDraft`.
 */
export function revisionProblem(draft: ItemDraft, limits: Limits | undefined): string | null {
  if (!limits) return null;
  const size = byteLength(JSON.stringify(draft));
  return size > limits.maxPreviousDraftBytes
    ? `The draft is ${formatBytes(size)}, more than the ${formatBytes(limits.maxPreviousDraftBytes)} that can be sent for revision. Shorten it, or edit it by hand.`
    : null;
}

const FIELD_KEYS: Record<string, keyof FormErrors> = {
  title: 'title',
  summary: 'summary',
  body: 'body',
  tags: 'tags',
  'source.url': 'sourceUrl',
  'source.note': 'sourceNote',
  'problem.timeLimitMs': 'timeLimitMs',
  'problem.memoryLimitKb': 'memoryLimitKb',
};

/** The server words field messages as predicates ("is required"); make them stand alone. */
export const fieldMessage = (message: string): string => (/^(is|must|may|cannot|can)\b/.test(message) ? `This ${message}.` : message);

/**
 * Map the `fields` of a `validation_failed` response onto the form. Keys the
 * form has no place for are returned in `rest`, so that nothing the server
 * said is dropped.
 */
export function formErrorsFromFields(fields: Record<string, string | number>): { errors: FormErrors; rest: string[] } {
  const errors: FormErrors = {};
  const rest: string[] = [];
  for (const [key, value] of Object.entries(fields)) {
    const message = fieldMessage(String(value));
    const testCase = /^testCases\.(\d+)\.(\w+)$/.exec(key);
    const target = FIELD_KEYS[key];
    if (testCase) errors.testCases ??= `Case ${Number(testCase[1]) + 1}, ${testCase[2]}: ${String(value)}.`;
    else if (key === 'testCases') errors.testCases = message;
    else if (target) errors[target] = message;
    else rest.push(`${key}: ${String(value)}`);
  }
  return { errors, rest };
}

// ---- Concurrent edits -------------------------------------------------------

/** Form fields that take part in conflict detection (everything editable on an existing item). */
export const EDITABLE_FIELDS = [
  'title',
  'summary',
  'body',
  'difficulty',
  'tags',
  'collectionIds',
  'sourceUrl',
  'sourceNote',
  'timeLimitMs',
  'memoryLimitKb',
  'compare',
  'starterCode',
] as const satisfies readonly (keyof ItemFormState)[];

export type EditableField = (typeof EDITABLE_FIELDS)[number];

export const FIELD_LABEL: Record<EditableField, string> = {
  title: 'Title',
  summary: 'Summary',
  body: 'Text',
  difficulty: 'Difficulty',
  tags: 'Tags',
  collectionIds: 'Collections',
  sourceUrl: 'Source link',
  sourceNote: 'Source note',
  timeLimitMs: 'Time limit',
  memoryLimitKb: 'Memory limit',
  compare: 'Output comparison',
  starterCode: 'Starter code',
};

function fieldEquals(field: EditableField, a: ItemFormState, b: ItemFormState): boolean {
  switch (field) {
    case 'tags':
      return sameList(normalizeTags(a.tags), normalizeTags(b.tags));
    case 'collectionIds':
      return sameList(a.collectionIds.slice().sort(), b.collectionIds.slice().sort());
    case 'starterCode':
      return sameRecord(cleanStarter(a.starterCode), cleanStarter(b.starterCode));
    case 'title':
    case 'summary':
    case 'sourceUrl':
    case 'sourceNote':
      return a[field].trim() === b[field].trim();
    default:
      return a[field] === b[field];
  }
}

/** The editable fields whose values differ between two form states. */
export function changedFields(a: ItemFormState, b: ItemFormState): EditableField[] {
  return EDITABLE_FIELDS.filter((f) => !fieldEquals(f, a, b));
}

export interface MergeResult {
  /** Their version with the user's own edits applied on top. */
  merged: ItemFormState;
  /** Fields changed only on the server; adopted as they are. */
  theirs: EditableField[];
  /** Fields changed only by the user; kept. */
  mine: EditableField[];
  /** Fields changed on both sides to different values. `merged` keeps the user's value for these. */
  overlapping: EditableField[];
}

/**
 * Three-way merge at field granularity, for when an item was changed
 * elsewhere while it was being edited. `base` is what the user started from,
 * `mine` the form as edited, `theirs` the item's current state.
 */
export function mergeForms(base: ItemFormState, mine: ItemFormState, theirs: ItemFormState): MergeResult {
  const mineChanged = new Set(changedFields(base, mine));
  const theirsChanged = new Set(changedFields(base, theirs));
  const merged: ItemFormState = { ...theirs, testCases: mine.testCases };
  const overlapping: EditableField[] = [];
  const assign = <K extends EditableField>(field: K) => {
    merged[field] = mine[field];
  };
  for (const field of EDITABLE_FIELDS) {
    if (!mineChanged.has(field)) continue;
    assign(field);
    if (theirsChanged.has(field) && !fieldEquals(field, mine, theirs)) overlapping.push(field);
  }
  return {
    merged,
    theirs: [...theirsChanged].filter((f) => !mineChanged.has(f)),
    mine: [...mineChanged].filter((f) => !theirsChanged.has(f) || fieldEquals(f, mine, theirs)),
    overlapping,
  };
}
