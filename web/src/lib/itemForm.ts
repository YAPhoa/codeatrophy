// The item editor works on a flat form state. This module converts between
// that state and the API shapes: an AI draft, a stored item, the body of a
// create request, and a minimal PATCH containing only what changed.

import type {
  CheckedCase,
  CompareMode,
  Difficulty,
  DraftCheck,
  DraftTestCase,
  HarnessCode,
  Item,
  ItemCheckRequest,
  ItemCheckResponse,
  ItemDraft,
  ItemInput,
  ItemPatch,
  ItemType,
  LargeCaseReport,
  Limits,
  ProblemInterface,
  SourceCode,
  TestCaseInput,
  TestOrigin,
} from '../api/types';
import { formatBytes, formatNumber, withUnit } from './format';
import { byteLength, charCount, isSingleLine } from './text';
import { isLargeText } from './largeText';

export interface FormTestCase {
  /** Client-side key for list rendering; never sent to the server. */
  key: string;
  name: string;
  stdin: string;
  expectedStdout: string;
  isSample: boolean;
  origin: TestOrigin;
  /** Carried from a draft whose reference solution printed this output; cleared when the case is edited. */
  verified: boolean;
  /** One of the large test cases the generation built; a revision does not carry it over. */
  large?: boolean;
  /**
   * The program that printed this case's input, saved with it. `null` when
   * it has none, or no longer has one because its input was edited;
   * `undefined` in a form kept from before cases carried their generators.
   */
  generator?: SourceCode | null;
  /** The fields of a large case cleared or typed into since; the others show only their size. */
  unlocked?: TestDataKey[];
  /** What "Verify all" found for this case, while the form is as it was checked. */
  outcome?: CheckedCase;
}

export type TestDataKey = 'stdin' | 'expectedStdout';

/** Whether a field of a case shows only its size: one a large case came with, until it is cleared. */
export const concealedData = (t: FormTestCase, field: TestDataKey): boolean => t.large === true && t[field] !== '' && !t.unlocked?.includes(field);

/**
 * A case with a change made in the form. Editing what it feeds in or expects
 * undoes its verification, as on the server; an input edited no longer comes
 * from its generator, which is dropped.
 */
export function editedCase(t: FormTestCase, change: Partial<FormTestCase>): FormTestCase {
  return {
    ...t,
    ...change,
    ...('stdin' in change || 'expectedStdout' in change ? { verified: false, outcome: undefined } : {}),
    ...('stdin' in change ? { generator: null } : {}),
  };
}

/** The cases with the large ones last, as the form lists them; otherwise in their order. */
export const largeLast = (cases: readonly FormTestCase[]): FormTestCase[] => [...cases.filter((t) => !t.large), ...cases.filter((t) => t.large)];

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
  interface: ProblemInterface;
  starterCode: Record<string, string>;
  /**
   * Runner code per language. Kept while the form is open even when the
   * interface is `program`, so that switching back and forth loses nothing;
   * what is saved is `effectiveHarness`.
   */
  harness: Record<string, HarnessCode>;
  /** Only used when creating: a new item is saved together with these cases. */
  testCases: FormTestCase[];
  /** Only used when creating: the solution a draft came with, saved as the item's reference solution. */
  referenceSolution: SourceCode | null;
}

export const PROBLEM_DEFAULTS = { timeLimitMs: 2000, memoryLimitKb: 262144, compare: 'tokens' as CompareMode, interface: 'program' as ProblemInterface };

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
    harness: {},
    testCases: [],
    referenceSolution: null,
  };
}

/**
 * A form restored from storage may have been written before a field
 * existed. Fill in what is missing, so the rest of the app can rely on the
 * whole shape.
 */
export function upgradeForm(form: ItemFormState): ItemFormState {
  return { ...emptyForm(form.type), ...form, testCases: form.testCases.map((t) => ({ ...t, verified: t.verified === true })) };
}

export function normalizeTags(tags: readonly string[]): string[] {
  return Array.from(new Set(tags.map((t) => t.trim().toLowerCase()).filter(Boolean))).sort();
}

/**
 * `largeCases` says which of the draft's test cases are large ones, if any,
 * and with which generator, for a generation from before each case carried
 * its own.
 */
export function formFromDraft(draft: ItemDraft, defaults: Partial<ItemFormState> = {}, largeCases: readonly LargeCaseReport[] = []): ItemFormState {
  const largeAt = new Map(largeCases.flatMap((c) => (c.status === 'added' && c.index !== null ? [[c.index, c.generator] as const] : [])));
  const large = (t: DraftTestCase, i: number): Partial<FormTestCase> => {
    const generator = t.generator ?? largeAt.get(i) ?? null;
    return { ...(largeAt.has(i) || generator ? { large: true } : {}), generator: generator && { ...generator } };
  };
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
    interface: draft.problem?.interface ?? PROBLEM_DEFAULTS.interface,
    starterCode: { ...(draft.problem?.starterCode ?? {}) },
    harness: structuredClone(draft.problem?.harness ?? {}),
    testCases: largeLast(draft.testCases.map((t, i) => ({ ...t, verified: t.verified === true, key: newKey(), origin: 'ai' as const, ...large(t, i) }))),
    referenceSolution: draft.problem?.referenceSolution ? { ...draft.problem.referenceSolution } : null,
  };
}

/**
 * The draft to send back as `previousDraft` when asking for a revision: the
 * form as the user has edited it, so their changes are not thrown away.
 * Large test data is left out: it is never shown to the model, so a
 * revision could not carry it over, and it would only take up the bound on
 * the request's size.
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
          interface: form.interface,
          timeLimitMs: form.timeLimitMs,
          memoryLimitKb: form.memoryLimitKb,
          compare: form.compare,
          starterCode: { ...form.starterCode },
          harness: effectiveHarness(form),
          referenceSolution: form.referenceSolution ? { ...form.referenceSolution } : null,
        }
      : null,
    testCases: isProblem
      ? form.testCases
          .filter((t) => !t.large && !isLargeText(t.stdin) && !isLargeText(t.expectedStdout))
          .map(({ name, stdin, expectedStdout, isSample, verified, generator }) => ({ name, stdin, expectedStdout, isSample, verified, generator: generator ?? null }))
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
    interface: item.problem?.interface ?? PROBLEM_DEFAULTS.interface,
    starterCode: { ...(item.problem?.starterCode ?? {}) },
    harness: structuredClone(item.problem?.harness ?? {}),
    testCases: [],
    // Solutions of a saved item are edited on their own page.
    referenceSolution: null,
  };
}

function cleanStarter(starter: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [lang, src] of Object.entries(starter)) {
    if (src.trim() !== '') out[lang] = src;
  }
  return out;
}

/**
 * The harness a form stands for: none for a `program` problem, and for a
 * `function` problem the languages whose runner has any code in it. A
 * language with an empty runner is left out, so it is not offered as one
 * that can be run.
 */
export function effectiveHarness(form: Pick<ItemFormState, 'interface' | 'harness'>): Record<string, HarnessCode> {
  const out: Record<string, HarnessCode> = {};
  if (form.interface !== 'function') return out;
  for (const [lang, code] of Object.entries(form.harness)) {
    if (code.prefix.trim() !== '' || code.suffix.trim() !== '') out[lang] = { prefix: code.prefix, suffix: code.suffix };
  }
  return out;
}

/** The languages the code section of a form lists: those with starter code and, for a `function` problem, those with a runner. */
export function formLanguages(form: Pick<ItemFormState, 'interface' | 'starterCode' | 'harness'>): string[] {
  return Array.from(new Set([...Object.keys(form.starterCode), ...(form.interface === 'function' ? Object.keys(form.harness) : [])]));
}

/** Add a language to a form: starter code, and a runner to fill in for a `function` problem. */
export function addFormLanguage<T extends Pick<ItemFormState, 'interface' | 'starterCode' | 'harness'>>(form: T, language: string): T {
  return {
    ...form,
    starterCode: { ...form.starterCode, [language]: form.starterCode[language] ?? '' },
    harness: form.interface === 'function' ? { ...form.harness, [language]: form.harness[language] ?? { prefix: '', suffix: '' } } : form.harness,
  };
}

/** Remove a language from a form, starter code and runner together. */
export function removeFormLanguage<T extends Pick<ItemFormState, 'starterCode' | 'harness'>>(form: T, language: string): T {
  const starterCode = { ...form.starterCode };
  const harness = { ...form.harness };
  delete starterCode[language];
  delete harness[language];
  return { ...form, starterCode, harness };
}

const orNull = (s: string): string | null => (s.trim() === '' ? null : s.trim());

export interface CreateExtras {
  rawInput?: string | null;
  variantOf?: string | null;
}

/**
 * A case of a form as it is sent: with its input and, to be saved with it
 * (`withGenerator`), the generator that printed it. Sent together, the
 * server stores both as given and runs nothing.
 */
function caseInput(t: FormTestCase, withGenerator: boolean): TestCaseInput {
  return {
    name: t.name.trim(),
    stdin: t.stdin,
    ...(withGenerator && t.generator ? { generator: { ...t.generator } } : {}),
    expectedStdout: t.expectedStdout,
    isSample: t.isSample,
    origin: t.origin,
    verified: t.verified,
  };
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
      interface: form.interface,
      timeLimitMs: form.timeLimitMs,
      memoryLimitKb: form.memoryLimitKb,
      compare: form.compare,
      starterCode: cleanStarter(form.starterCode),
      harness: effectiveHarness(form),
      referenceSolution: form.referenceSolution && form.referenceSolution.source.trim() !== '' ? { ...form.referenceSolution } : null,
    };
    input.testCases = form.testCases.map((t) => caseInput(t, true));
  }
  return input;
}

const sameList = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((v, i) => v === b[i]);

const sameRecord = (a: Record<string, string>, b: Record<string, string>) => {
  const ka = Object.keys(a).sort();
  const kb = Object.keys(b).sort();
  return sameList(ka, kb) && ka.every((k) => a[k] === b[k]);
};

const sameHarness = (a: Record<string, HarnessCode>, b: Record<string, HarnessCode>) => {
  const ka = Object.keys(a).sort();
  const kb = Object.keys(b).sort();
  return sameList(ka, kb) && ka.every((k) => a[k]!.prefix === b[k]!.prefix && a[k]!.suffix === b[k]!.suffix);
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
    const originalInterface = original.problem.interface ?? PROBLEM_DEFAULTS.interface;
    const originalHarness = original.problem.harness ?? {};
    const harness = effectiveHarness(form);
    if (form.interface !== originalInterface) p.interface = form.interface;
    // Sent with a change of interface as well: a `program` problem must not keep a harness.
    if (!sameHarness(harness, originalHarness) || (p.interface === 'program' && Object.keys(originalHarness).length > 0)) p.harness = harness;
    if (Object.keys(p).length > 0) patch.problem = p;
  }
  return patch;
}

/** True when the patch would change fields that are part of the item's revisioned content. */
export function patchTouchesContent(patch: ItemPatch): boolean {
  return Object.keys(patch).some((k) => k !== 'collectionIds' && k !== 'expectedRevision');
}

export type FormErrors = Partial<
  Record<'title' | 'summary' | 'body' | 'timeLimitMs' | 'memoryLimitKb' | 'tags' | 'sourceUrl' | 'sourceNote' | 'code' | 'testCases', string>
>;

/** Why a tag would be rejected by the server, or `null` if it is fine. */
export function tagProblem(tag: string, limits: Limits | undefined): string | null {
  if (tag.includes('/')) return 'A tag cannot contain “/”.';
  if (!isSingleLine(tag)) return 'A tag cannot contain control characters.';
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
      const runner = Object.values(effectiveHarness(form)).flatMap((h) => [h.prefix, h.suffix]);
      if ([...Object.values(form.starterCode), ...runner].some((src) => byteLength(src) > limits.maxSourceBytes)) {
        errors.code = `Starter or runner code is larger than ${formatBytes(limits.maxSourceBytes)}.`;
      }
      if (!Number.isFinite(form.timeLimitMs) || form.timeLimitMs < time.min || form.timeLimitMs > time.max) {
        errors.timeLimitMs = `Between ${formatNumber(time.min)} and ${withUnit(time.max, 'ms')}.`;
      }
      if (!Number.isFinite(form.memoryLimitKb) || form.memoryLimitKb < memory.min || form.memoryLimitKb > memory.max) {
        errors.memoryLimitKb = `Between ${formatNumber(memory.min / 1024)} and ${withUnit(memory.max / 1024, 'MB')}.`;
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
 * Everything a draft's check depends on: the solution, the runner and the
 * cases it was run on. While this is unchanged the check still describes the
 * form; once it differs the check is out of date.
 */
export function checkedState(form: ItemFormState): string {
  return JSON.stringify([form.interface, form.compare, form.referenceSolution, effectiveHarness(form), form.testCases.map((t) => [t.stdin, t.expectedStdout])]);
}

/**
 * Body of `POST /items/check` for a form: its problem and test cases, as they
 * would be saved. Each case goes with the input it has, so no generator runs again.
 */
export function checkRequestFromForm(form: ItemFormState): ItemCheckRequest {
  const input = inputFromForm({ ...form, type: 'problem' });
  return { problem: input.problem ?? {}, testCases: form.testCases.map((t) => caseInput(t, false)) };
}

/** A draft under review, as the capture and variant pages keep it. */
export interface CheckedDraft {
  form: ItemFormState | null;
  /** What running the reference solution found, and the `checkedState` of the form it ran on. */
  check?: DraftCheck | null;
  checked?: string;
}

/**
 * Apply the answer of `POST /items/check` to a draft, as a draft's own check
 * is applied when it arrives: each case's verified mark by position, and the
 * check. Each case also keeps its outcome. `sent` is the `checkedState` of the form that was checked; when the
 * form has moved on from it the answer is stale and `null` is returned. The
 * large test cases belong to the generation, not to the check, so their
 * reports are kept.
 */
export function withCheck<S extends CheckedDraft>(draft: S, sent: string, answer: ItemCheckResponse): S | null {
  if (!draft.form) return null;
  const current = upgradeForm(draft.form);
  if (checkedState(current) !== sent) return null;
  const form = {
    ...current,
    testCases: current.testCases.map((t, i) => {
      const outcome = answer.cases[i] ?? { outcome: 'not_run' as const, error: null };
      return { ...t, verified: outcome.outcome === 'passed', outcome };
    }),
  };
  return { ...draft, form, check: { ...answer.check, largeCases: draft.check?.largeCases ?? [] }, checked: checkedState(form) };
}

/**
 * The cases "Verify all" found wrong, or that made the reference solution
 * fail: they can be discarded together. None when no case passed, since then
 * the reference solution or the runner is the likelier culprit, and none for
 * cases the check did not get to.
 */
export function discardableCases(form: Pick<ItemFormState, 'testCases'>): string[] {
  const bad = form.testCases.filter((t) => t.outcome?.outcome === 'wrong' || t.outcome?.outcome === 'failed');
  return form.testCases.some((t) => t.outcome?.outcome === 'passed') ? bad.map((t) => t.key) : [];
}

/**
 * A draft without some of its test cases. When its check still describes
 * the form, the check is brought along: it then counts only the cases that
 * are left, and has nothing to report once all of those passed.
 */
export function withoutCases<S extends CheckedDraft>(draft: S, keys: readonly string[]): S {
  if (!draft.form) return draft;
  const current = upgradeForm(draft.form);
  const form = { ...current, testCases: current.testCases.filter((t) => !keys.includes(t.key)) };
  if (!draft.check || draft.checked !== checkedState(current)) return { ...draft, form };
  const left = form.testCases;
  const allPassed = left.every((t) => t.outcome?.outcome === 'passed');
  const check = { ...draft.check, total: left.length, passed: left.filter((t) => t.verified).length, error: allPassed ? null : draft.check.error };
  return { ...draft, form, check, checked: checkedState(form) };
}

/**
 * Put removed test cases back where they were, for an undo. `before` is the
 * list as it stood when they were removed; the form may have been edited
 * since, so a case that is there again is left alone and a position past the
 * end means the end. The large cases stay last.
 */
export function restoreCases<T extends Pick<ItemFormState, 'testCases'>>(form: T, before: readonly FormTestCase[], keys: readonly string[]): T {
  const testCases = [...form.testCases];
  before.forEach((t, index) => {
    if (!keys.includes(t.key) || testCases.some((c) => c.key === t.key)) return;
    testCases.splice(Math.min(index, testCases.length), 0, t);
  });
  return { ...form, testCases: largeLast(testCases) };
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
    else if (/^problem\.(interface|harness|starterCode)\b/.test(key)) errors.code ??= `${key.replace(/^problem\./, '')}: ${String(value)}.`;
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
  'interface',
  'starterCode',
  'harness',
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
  interface: 'What you write',
  starterCode: 'Starter code',
  harness: 'Runner',
};

function fieldEquals(field: EditableField, a: ItemFormState, b: ItemFormState): boolean {
  switch (field) {
    case 'tags':
      return sameList(normalizeTags(a.tags), normalizeTags(b.tags));
    case 'collectionIds':
      return sameList(a.collectionIds.slice().sort(), b.collectionIds.slice().sort());
    case 'starterCode':
      return sameRecord(cleanStarter(a.starterCode), cleanStarter(b.starterCode));
    case 'harness':
      return sameHarness(effectiveHarness(a), effectiveHarness(b));
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
  const merged: ItemFormState = { ...theirs, testCases: mine.testCases, referenceSolution: mine.referenceSolution };
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
