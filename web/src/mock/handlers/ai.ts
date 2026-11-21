// The AI generations. Each runs as a job (../jobs.ts); none writes to the library.

import type { AiCodeResponse, AiTestCasesResponse, AppliedStyle, CodeCheck, HarnessCode, CodeSample, DraftCheck, DraftResponse, GenerationUsage, InterfaceHint, ItemDraft, ProblemInterface, StylePreset, VariantMode } from '../../api/types';
import { applyStyle, breakRunner, checkDraft, checkRunners, draftFromText, MISMATCH_MARKER, proposeTestCases, REPEAT_ALL_MARKER, REPEAT_MARKER, reviseDraft, RUNNER_MARKER, variantOfItem, withInterface } from '../ai';
import { writeCode } from '../code';
import type { MockDb, StoredAiProvider } from '../db';
import { atMostChars, byteLength, charCount, LIMITS, normaliseText } from '../db';
import type { Handler } from '../http';
import type { JobRunner } from '../jobs';
import { accepted, aiUnavailable, invalid, isRecord, objectBody, upstream, Validator } from '../http';
import { buildLargeCases, largeForPrompt, promptCase } from '../largeCase';
import { isLanguage } from '../util';
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

/** How many large test cases are asked for; default `0`. */
function parseLargeTestCases(raw: Record<string, unknown>, v: Validator): number {
  const value = raw.largeTestCases ?? 0;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > LIMITS.maxLargeTestCases) {
    v.add('largeTestCases', `must be between 0 and ${LIMITS.maxLargeTestCases}`);
    return 0;
  }
  return value;
}

/** A draft as a prompt shows it: large test data goes by its name and size. */
function promptDraft(previousDraft: unknown): unknown {
  if (!isRecord(previousDraft) || !Array.isArray(previousDraft.testCases)) return previousDraft;
  const shown = (c: unknown): unknown => {
    if (!isRecord(c) || typeof c.stdin !== 'string' || typeof c.expectedStdout !== 'string') return c;
    if (!largeForPrompt(c.stdin) && !largeForPrompt(c.expectedStdout)) return c;
    return { name: c.name, description: promptCase({ name: typeof c.name === 'string' ? c.name : '', stdin: c.stdin, expectedStdout: c.expectedStdout }) };
  };
  return { ...previousDraft, testCases: previousDraft.testCases.map(shown) };
}

const applied = (style: StylePreset | null): AppliedStyle | null => (style ? { id: style.id, name: style.name } : null);

/**
 * The provider a request names with `providerId`, which must be ready; or
 * `null` when it names none, so the default is used. A named provider does
 * not need a default to exist.
 */
function parseProvider(db: MockDb, raw: Record<string, unknown>, v: Validator): StoredAiProvider | null {
  const id = raw.providerId;
  if (id == null) return null;
  if (typeof id !== 'string') {
    v.add('providerId', 'must be a string or null');
    return null;
  }
  const provider = db.ai.providers.find((p) => p.id === id);
  if (!provider) v.add('providerId', 'is not the id of an existing provider');
  else if (!db.isReady(provider)) v.add('providerId', 'names a provider that is not ready');
  else return provider;
  return null;
}

/** The provider a job uses once it starts, checked again: AI features may have been switched off, or the provider removed, meanwhile. */
function providerAtRun(db: MockDb, named: StoredAiProvider | null): StoredAiProvider {
  if (named === null) return providerFor(db, null);
  const current = db.ai.providers.find((p) => p.id === named.id);
  if (!db.ai.enabled || !current || !db.isReady(current)) throw aiUnavailable();
  return current;
}

/** The provider a valid request goes to: the one it names, else the default; `503` when there is neither, or AI features are switched off. */
function providerFor(db: MockDb, named: StoredAiProvider | null): StoredAiProvider {
  if (!db.ai.enabled) throw aiUnavailable();
  const provider = named ?? db.activeProvider;
  if (!provider) throw aiUnavailable();
  return provider;
}

/** One request to the provider, as the activity log names it. */
interface Call {
  provider: StoredAiProvider;
  operation: 'draft' | 'variant' | 'testcases' | 'code';
  itemId: string | null;
  /** The label of its log entry, when the item is known beforehand. */
  title: string | null;
  schema: string;
  /** What the user's part of the request says. */
  content: string;
}

const SYSTEM_PROMPT =
  'You write entries for a personal library of coding problems and technical readings. Answer with one JSON object that follows the given schema. List everything you inferred or invented under "assumptions".';

/** The request as the server would have sent it; never a key or a header. */
const requestOf = (call: Call) => ({ system: SYSTEM_PROMPT, messages: [{ role: 'user', content: call.content }], schema: call.schema, maxOutputTokens: 64000, effort: call.provider.effort });

const NO_TOKENS = { inputTokens: null, outputTokens: null, reasoningTokens: null, cacheReadTokens: null, cacheWriteTokens: null };

/** Typing `MOCK:FAIL` anywhere in the request simulates a provider failure, which is logged and counted like any request. */
function failIfAsked(db: MockDb, call: Call, ...texts: (string | null)[]): void {
  if (texts.some((t) => t?.includes('MOCK:FAIL'))) {
    const error = 'the AI provider returned an error: 529 overloaded_error — Overloaded';
    db.logRequest(call.provider, { operation: call.operation, itemId: call.itemId, title: call.title, status: 'failed', error, durationMs: 1300, usage: NO_TOKENS, request: requestOf(call), response: null });
    throw upstream(error);
  }
}

/**
 * What a generation cost, written to the activity log and counted towards
 * the provider that made it. The figures follow from the sizes of what went
 * in and what came out, at about four characters a token on top of the
 * instructions every request carries. A hosted Anthropic model reports its
 * prompt cache and no reasoning, Gemini its reasoning and cache reads, and
 * other services their reasoning alone.
 */
function spend(db: MockDb, call: Call, output: unknown, title: string | null = call.title): GenerationUsage {
  const provider = call.provider;
  const response = JSON.stringify(output);
  const inputTokens = 1800 + Math.ceil(call.content.length / 4);
  const outputTokens = Math.ceil(response.length / 4);
  const tokens =
    provider.kind === 'anthropic'
      ? { inputTokens, outputTokens, reasoningTokens: null, cacheReadTokens: 0, cacheWriteTokens: 0 }
      : provider.kind === 'gemini'
        ? { inputTokens, outputTokens, reasoningTokens: Math.round(outputTokens * 0.3), cacheReadTokens: 0, cacheWriteTokens: null }
        : { inputTokens, outputTokens, reasoningTokens: Math.round(outputTokens * 0.3), cacheReadTokens: null, cacheWriteTokens: null };
  const durationMs = 2500 + outputTokens * 11;
  const logId = db.logRequest(provider, { operation: call.operation, itemId: call.itemId, title, status: 'ok', error: null, durationMs, usage: tokens, request: requestOf(call), response });
  return { logId, model: db.modelOf(provider) ?? '', durationMs, ...tokens };
}

const asks = (marker: string, ...texts: (string | null)[]): boolean => texts.some((t) => t?.includes(marker));

/** The user's part of a request: the text, then whatever else was given with it. */
function said(text: string, instruction: string | null, previousDraft: unknown, style: StylePreset | null): string {
  return [
    text,
    style ? `Style to follow:\n${style.instructions}` : null,
    previousDraft != null ? `The draft so far:\n${JSON.stringify(promptDraft(previousDraft))}` : null,
    instruction ? `Instruction: ${instruction}` : null,
  ]
    .filter((part) => part !== null)
    .join('\n\n');
}

/**
 * Append the large test cases to a checked draft, as the check's last step
 * before the runners: each counts in the check when it was added.
 */
function addLargeCases(db: MockDb, draft: ItemDraft, check: DraftCheck, count: number, texts: (string | null)[]): void {
  const problem = draft.problem;
  if (!problem) return;
  const built = buildLargeCases(db, {
    count,
    title: draft.title,
    face: problem.interface,
    timeLimitMs: problem.timeLimitMs,
    referenceSolution: problem.referenceSolution,
    existing: draft.testCases.map((c) => c.stdin),
    index: draft.testCases.length,
    blocked: check.attempted && check.passed < check.total ? 'the reference solution did not pass the other test cases' : null,
    texts,
    operation: 'draft',
  });
  for (const one of built) {
    if (one.stdin === null || one.expectedStdout === null) continue;
    draft.testCases.push({ name: one.report.name ?? 'Large input', stdin: one.stdin, expectedStdout: one.expectedStdout, isSample: false, verified: true, generator: one.report.generator });
    if (check.attempted) {
      check.passed++;
      check.total++;
    }
  }
  check.largeCases = built.map((one) => one.report);
}

/** The result of a draft or variant generation: the draft in the chosen style, with its reference solution and runners checked. */
function drafted(db: MockDb, result: ItemDraft, style: StylePreset | null, call: Call, large: number, ...texts: (string | null)[]): DraftResponse {
  const styled = applyStyle(result, style);
  // After the style, which decides the languages that are left to break and to check.
  const draft = asks(RUNNER_MARKER, ...texts) ? breakRunner(styled) : styled;
  const check = checkDraft(db, draft, asks(MISMATCH_MARKER, ...texts));
  // A new draft is logged under the title that came back. What the model
  // wrote does not include the large cases, which the server builds.
  const usage = spend(db, call, draft, call.title ?? (draft.title || null));
  if (large > 0 && check) addLargeCases(db, draft, check, large, texts);
  return { draft, style: applied(style), check, usage };
}

// The request is validated before the provider is looked at, so an invalid
// request is a `422` even on an instance with no provider configured.

export function prepareDraft(db: MockDb, raw: Record<string, unknown>): Prepared<DraftResponse> {
  const v = new Validator();
  const text = typeof raw.text === 'string' ? normaliseText(raw.text) : raw.text;
  if (typeof text !== 'string' || text.trim() === '') v.add('text', 'is required');
  else if (charCount(text) > LIMITS.maxDraftTextChars) v.add('text', atMostChars(LIMITS.maxDraftTextChars));
  const typeHint = raw.typeHint ?? 'auto';
  if (typeHint !== 'auto' && typeHint !== 'problem' && typeHint !== 'reading') {
    v.add('typeHint', 'must be auto, problem or reading');
  }
  const interfaceHint = raw.interfaceHint ?? 'auto';
  if (interfaceHint !== 'auto' && interfaceHint !== 'program' && interfaceHint !== 'function') {
    v.add('interfaceHint', 'must be auto, program or function');
  }
  const instruction = parseInstruction(raw, v);
  const previousDraft = parsePreviousDraft(raw, v);
  const large = parseLargeTestCases(raw, v);
  const named = parseProvider(db, raw, v);
  v.check();
  const style = resolveStyle(db, raw);
  const provider = providerFor(db, named);
  return {
    itemId: null,
    title: shortTitle(text as string),
    provider,
    delay: delayOf(db, 'aiDraft', text as string, instruction),
    run: () => {
      const call: Call = { provider: providerAtRun(db, named), operation: 'draft', itemId: null, title: null, schema: 'item_draft', content: said(text as string, instruction, previousDraft, style) };
      failIfAsked(db, call, text as string, instruction);
      const result = draftFromText(text as string, typeHint as 'auto' | 'problem' | 'reading', instruction, previousDraft, interfaceHint as InterfaceHint);
      return drafted(db, result, style, call, large, text as string, instruction);
    },
  };
}

export function prepareVariant(db: MockDb, itemId: string, raw: Record<string, unknown>): Prepared<DraftResponse> {
  const item = db.getItem(itemId);
  const v = new Validator();
  const mode = (raw.mode ?? 'similar') as VariantMode;
  if (!MODES.includes(mode)) v.add('mode', 'must be similar, easier, harder or twist');
  else if (item.type === 'reading' && mode !== 'similar') v.add('mode', 'must be similar for a reading');
  const instruction = parseInstruction(raw, v);
  const previousDraft = parsePreviousDraft(raw, v);
  const interfaceHint = raw.interfaceHint ?? null;
  if (interfaceHint !== null && interfaceHint !== 'program' && interfaceHint !== 'function') {
    v.add('interfaceHint', 'must be program or function');
  } else if (interfaceHint !== null && item.type === 'reading') v.add('interfaceHint', 'does not apply to a reading');
  const large = parseLargeTestCases(raw, v);
  const named = parseProvider(db, raw, v);
  v.check();
  const style = resolveStyle(db, raw);
  const provider = providerFor(db, named);
  return {
    itemId: item.id,
    title: item.title,
    provider,
    delay: delayOf(db, 'aiDraft', instruction),
    run: () => {
      // The original may have been deleted while the job waited.
      const original = db.getItem(itemId);
      const call: Call = { provider: providerAtRun(db, named), operation: 'variant', itemId: original.id, title: original.title, schema: 'item_draft', content: said(`Write a variant (${mode}) of this item.\n\n# ${original.title}\n\n${original.body}`, instruction, previousDraft, style) };
      failIfAsked(db, call, instruction);
      // With an earlier variant draft and an instruction this is a revision of
      // that draft, not a fresh variant.
      const result =
        previousDraft != null && instruction ? reviseDraft(previousDraft, instruction) : variantOfItem(db, original, mode, instruction);
      // A variant keeps the original's interface unless the request asks for the other one.
      const shaped = interfaceHint === null ? result : withInterface(result, interfaceHint as ProblemInterface);
      return drafted(db, shaped, style, call, large, instruction);
    },
  };
}

export function prepareTestCases(db: MockDb, itemId: string, raw: Record<string, unknown>): Prepared<AiTestCasesResponse> {
  const item = db.getItem(itemId);
  if (item.type !== 'problem') throw invalid('item', 'is a reading; only problems have test cases');
  const v = new Validator();
  const count = raw.count ?? 8;
  if (typeof count !== 'number' || !Number.isInteger(count) || count < 1 || count > LIMITS.maxGeneratedTestCases) {
    v.add('count', `must be between 1 and ${LIMITS.maxGeneratedTestCases}`);
  }
  const language = raw.language ?? 'python';
  if (!isLanguage(language)) v.add('language', 'is not a known language id');
  else if (item.problem?.interface === 'function' && !(language in item.problem.harness)) {
    v.add('language', 'has no harness on this problem');
  }
  const instruction = parseInstruction(raw, v);
  const large = parseLargeTestCases(raw, v);
  parseOrigin(raw, v);
  const named = parseProvider(db, raw, v);
  v.check();
  const provider = providerFor(db, named);
  return {
    itemId: item.id,
    title: item.title,
    provider,
    delay: delayOf(db, 'aiTests', instruction),
    run: () => {
      const item = db.getItem(itemId);
      // Large test data is never sent to the model.
      const inputs = db.casesOf(item.id).map(promptCase).join('\n---\n');
      const call: Call = {
        provider: providerAtRun(db, named),
        operation: 'testcases',
        itemId: item.id,
        title: item.title,
        schema: 'test_cases',
        content: said(`Write a reference solution in ${language as string} and ${count as number} test cases for this problem.\n\n# ${item.title}\n\n${item.body}\n\nInputs it already has:\n${inputs || '(none)'}`, instruction, null, null),
      };
      failIfAsked(db, call, instruction);
      const proposal = proposeTestCases(db, item, count as number, language as string, asks(REPEAT_ALL_MARKER, instruction) ? (count as number) : asks(REPEAT_MARKER, instruction) ? Math.min(2, (count as number) - 1) : 0);
      // The model answers with the solution and the cases; running them is the server's part.
      const answered = { referenceSolution: proposal.referenceSolution, cases: proposal.cases.map((c) => ({ name: c.name, rationale: c.rationale, stdin: c.stdin, predictedStdout: c.predictedStdout })) };
      const usage = spend(db, call, answered);
      if (large > 0) {
        const built = buildLargeCases(db, {
          count: large,
          title: item.title,
          face: item.problem?.interface ?? 'program',
          timeLimitMs: item.problem?.timeLimitMs ?? 2000,
          referenceSolution: proposal.referenceSolution,
          existing: [...db.casesOf(item.id).map((c) => c.stdin), ...proposal.cases.map((c) => c.stdin)],
          index: proposal.cases.length,
          blocked: null,
          texts: [instruction],
          operation: 'testcases',
        });
        for (const one of built) {
          if (one.stdin === null || one.expectedStdout === null) continue;
          // The model has not seen the input, so there is no prediction to compare.
          proposal.cases.push({
            name: one.report.name ?? 'Large input',
            rationale: 'As large as the constraints allow; a solution of the wrong complexity runs out of time.',
            stdin: one.stdin,
            expectedStdout: one.expectedStdout,
            predictedStdout: null,
            isSample: false,
            verified: true,
            predictionMatched: null,
            error: null,
            generator: one.report.generator,
          });
        }
        proposal.largeCases = built.map((one) => one.report);
      }
      return { ...proposal, usage };
    },
  };
}

/** An optional text field; anything but a string or null is a `422`. */
function parseText(raw: Record<string, unknown>, field: string, v: Validator): string {
  const value = raw[field];
  if (value == null) return '';
  if (typeof value !== 'string') {
    v.add(field, 'must be a string');
    return '';
  }
  return normaliseText(value);
}

/** The sample cases a code request shows the model; the first is what the runners are checked on. */
function parseSamples(raw: Record<string, unknown>, v: Validator): CodeSample[] {
  const value = raw.samples ?? [];
  if (!Array.isArray(value)) {
    v.add('samples', 'must be an array');
    return [];
  }
  if (value.length > LIMITS.maxTestCasesPerItem) v.add('samples', `at most ${LIMITS.maxTestCasesPerItem} test cases`);
  return value.flatMap((s: unknown, i): CodeSample[] => {
    if (!isRecord(s) || (s.stdin != null && typeof s.stdin !== 'string') || (s.expectedStdout != null && typeof s.expectedStdout !== 'string')) {
      v.add(`samples.${i}`, 'must have a string stdin and expectedStdout');
      return [];
    }
    const sample = { stdin: (s.stdin as string | undefined) ?? '', expectedStdout: (s.expectedStdout as string | undefined) ?? '' };
    if (byteLength(sample.stdin) > LIMITS.maxTestDataBytes || byteLength(sample.expectedStdout) > LIMITS.maxTestDataBytes) {
      v.add(`samples.${i}`, `stdin and expectedStdout must each be at most ${LIMITS.maxTestDataBytes} bytes`);
    }
    return [sample];
  });
}

/** The runners of generated code, each stub run unchanged on the first sample; nothing runs without a judge or a sample. */
function checkCode(db: MockDb, code: { starterCode: Record<string, string>; harness: Record<string, HarnessCode> }, samples: readonly CodeSample[]): CodeCheck {
  const judge = db.options.judge;
  if (judge === 'none' || samples.length === 0) return { attempted: false, engine: null, runners: [] };
  const problem = { interface: 'function' as const, timeLimitMs: 2000, memoryLimitKb: 262144, compare: 'tokens' as const, ...code, referenceSolution: null };
  const draft: ItemDraft = { type: 'problem', title: '', summary: '', body: '', difficulty: null, tags: [], problem, testCases: [], assumptions: [] };
  return { attempted: true, engine: 'judge0', runners: checkRunners(draft, judge === 'down') };
}

export function prepareCode(db: MockDb, raw: Record<string, unknown>): Prepared<AiCodeResponse> {
  const v = new Validator();
  const title = parseText(raw, 'title', v).trim();
  const body = parseText(raw, 'body', v);
  if (charCount(title) > LIMITS.maxTitleChars) v.add('title', atMostChars(LIMITS.maxTitleChars));
  if (byteLength(body) > LIMITS.maxTextBytes) v.add('body', `must be at most ${LIMITS.maxTextBytes} bytes`);
  if (title === '' && body.trim() === '') v.add('body', 'is required');
  const face = raw.interface ?? 'program';
  if (face !== 'program' && face !== 'function') v.add('interface', 'must be program or function');
  const languages: string[] = [];
  if (!Array.isArray(raw.languages)) v.add('languages', raw.languages == null ? 'is required' : 'must be an array');
  else if (raw.languages.length === 0) v.add('languages', 'is required');
  else
    for (const l of raw.languages as unknown[]) {
      if (!isLanguage(l)) v.add('languages', `unknown language ${JSON.stringify(l)}`);
      else if (!languages.includes(l)) languages.push(l);
    }
  const samples = parseSamples(raw, v);
  const itemId = raw.itemId ?? null;
  if (itemId !== null && (typeof itemId !== 'string' || !db.items.has(itemId))) v.add('itemId', 'item does not exist');
  parseOrigin(raw, v);
  const named = parseProvider(db, raw, v);
  v.check();
  const style = resolveStyle(db, raw);
  const provider = providerFor(db, named);
  const labelItem = itemId === null ? null : db.getItem(itemId as string);
  return {
    itemId: (itemId as string | null),
    title: title || shortTitle(body) || labelItem?.title || 'Untitled problem',
    provider,
    delay: delayOf(db, 'aiTests', title, body),
    run: () => {
      const item = itemId === null ? null : (db.items.get(itemId as string) ?? null);
      const shown = samples.slice(0, 5).map((s) => promptCase({ name: '', ...s })).join('\n---\n');
      const call: Call = {
        provider: providerAtRun(db, named),
        operation: 'code',
        itemId: item?.id ?? null,
        title: title || item?.title || null,
        schema: 'code',
        content: said(`Write the ${face === 'function' ? 'stub and the runner' : 'starter code'} of this problem in ${languages.join(', ')}.\n\n# ${title}\n\n${body}\n\nSamples:\n${shown || '(none)'}`, null, null, style),
      };
      failIfAsked(db, call, title, body);
      let written = writeCode({ title, body, face: face as 'program' | 'function', languages, samples });
      if (face === 'function' && asks(RUNNER_MARKER, title, body)) {
        // As a model can leave one runner broken; the pretend judge reads the marker as a compile error.
        const broken = breakRunner({ type: 'problem', title, summary: '', body, difficulty: null, tags: [], testCases: [], assumptions: [],
          problem: { interface: 'function', timeLimitMs: 2000, memoryLimitKb: 262144, compare: 'tokens', ...written, referenceSolution: null } });
        written = { starterCode: broken.problem!.starterCode, harness: broken.problem!.harness };
      }
      const usage = spend(db, call, { code: languages.filter((l) => l in written.starterCode).map((l) => ({ language: l, starterCode: written.starterCode[l], ...written.harness[l] })) });
      return { ...written, check: face === 'function' ? checkCode(db, written, samples) : null, style: applied(style), usage };
    },
  };
}

/**
 * What a generation does once its job runs, prepared when it is asked for:
 * the request is validated then, and `run` generates (or throws the error the
 * job fails with). `delay` is how long the pretend provider takes.
 */
export interface Prepared<R> {
  itemId: string | null;
  /** The job's label. */
  title: string;
  provider: StoredAiProvider;
  delay: number;
  run: () => R;
}

/** `MOCK:SLOW` anywhere in a request's text makes its generation take a minute, at any speed: time to look at it running, or cancel it. */
export const SLOW_MARKER = 'MOCK:SLOW';

function delayOf(db: MockDb, kind: 'aiDraft' | 'aiTests', ...texts: (string | null)[]): number {
  return asks(SLOW_MARKER, ...texts) ? 60_000 : db.delay(kind);
}

/** The start of a text, as a label: its first line, cut at a word near 60 characters. */
export function shortTitle(text: string): string {
  const line = text.trim().split('\n')[0]?.trim() ?? '';
  if (line.length <= 60) return line;
  const cut = line.slice(0, 60);
  const space = cut.lastIndexOf(' ');
  return `${(space > 30 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/** `origin`: an opaque single line of at most 2000 characters, kept on the job. */
export function parseOrigin(raw: Record<string, unknown>, v: Validator): string | null {
  const value = raw.origin;
  if (value == null) return null;
  if (typeof value !== 'string') v.add('origin', 'must be a string or null');
  else if (value.length > 2000) v.add('origin', atMostChars(2000));
  // eslint-disable-next-line no-control-regex -- control characters are what is refused
  else if (/[\u0000-\u001f\u007f\u0085\u2028\u2029]/.test(value)) v.add('origin', 'must be a single line');
  else return value;
  return null;
}

export function aiRoutes(db: MockDb, jobs: JobRunner): [string, string, Handler][] {
  return [
    [
      'POST',
      '/items/:id/ai/testcases',
      (req) => {
        const raw = objectBody(req);
        const job = jobs.start({ kind: 'testcases', request: raw, itemId: req.params.id!, origin: typeof raw.origin === 'string' ? raw.origin : null, draftId: null }, prepareTestCases(db, req.params.id!, raw));
        return accepted(jobs.view(job));
      },
    ],
    [
      'POST',
      '/ai/code',
      (req) => {
        const raw = objectBody(req);
        const prepared = prepareCode(db, raw);
        const job = jobs.start({ kind: 'code', request: raw, itemId: prepared.itemId, origin: typeof raw.origin === 'string' ? raw.origin : null, draftId: null }, prepared);
        return accepted(jobs.view(job));
      },
    ],
  ];
}
