// The AI endpoints. They never write to the library.

import type { AppliedStyle, GenerationUsage, InterfaceHint, ItemDraft, ProblemInterface, StylePreset, VariantMode } from '../../api/types';
import { applyStyle, breakRunner, checkDraft, draftFromText, MISMATCH_MARKER, proposeTestCases, REPEAT_ALL_MARKER, REPEAT_MARKER, reviseDraft, RUNNER_MARKER, variantOfItem, withInterface } from '../ai';
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

/** One request to the provider, as the activity log names it. */
interface Call {
  operation: 'draft' | 'variant' | 'testcases';
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
const requestOf = (call: Call) => ({ system: SYSTEM_PROMPT, messages: [{ role: 'user', content: call.content }], schema: call.schema, maxOutputTokens: 64000 });

const NO_TOKENS = { inputTokens: null, outputTokens: null, reasoningTokens: null, cacheReadTokens: null, cacheWriteTokens: null };

/** Typing `MOCK:FAIL` anywhere in the request simulates a provider failure, which is logged and counted like any request. */
function failIfAsked(db: MockDb, call: Call, ...texts: (string | null)[]): void {
  if (texts.some((t) => t?.includes('MOCK:FAIL'))) {
    const error = 'the AI provider returned an error: 529 overloaded_error — Overloaded';
    const provider = db.activeProvider;
    if (provider) {
      db.logRequest(provider, { operation: call.operation, itemId: call.itemId, title: call.title, status: 'failed', error, durationMs: 1300, usage: NO_TOKENS, request: requestOf(call), response: null });
    }
    throw upstream(error);
  }
}

/**
 * What a generation cost, written to the activity log and counted towards
 * the provider that made it. The figures follow from the sizes of what went
 * in and what came out, at about four characters a token on top of the
 * instructions every request carries. A hosted Anthropic model reports its
 * prompt cache and no reasoning; other services the reverse.
 */
function spend(db: MockDb, call: Call, output: unknown, title: string | null = call.title): GenerationUsage {
  const provider = db.activeProvider;
  const response = JSON.stringify(output);
  const inputTokens = 1800 + Math.ceil(call.content.length / 4);
  const outputTokens = Math.ceil(response.length / 4);
  const tokens =
    provider?.kind === 'openai_compatible'
      ? { inputTokens, outputTokens, reasoningTokens: Math.round(outputTokens * 0.3), cacheReadTokens: null, cacheWriteTokens: null }
      : { inputTokens, outputTokens, reasoningTokens: null, cacheReadTokens: 0, cacheWriteTokens: 0 };
  const durationMs = 2500 + outputTokens * 11;
  const logId = provider
    ? db.logRequest(provider, { operation: call.operation, itemId: call.itemId, title, status: 'ok', error: null, durationMs, usage: tokens, request: requestOf(call), response })
    : null;
  return { logId, model: (provider && db.modelOf(provider)) ?? '', durationMs, ...tokens };
}

const asks = (marker: string, ...texts: (string | null)[]): boolean => texts.some((t) => t?.includes(marker));

/** The user's part of a request: the text, then whatever else was given with it. */
function said(text: string, instruction: string | null, previousDraft: unknown, style: StylePreset | null): string {
  return [
    text,
    style ? `Style to follow:\n${style.instructions}` : null,
    previousDraft != null ? `The draft so far:\n${JSON.stringify(previousDraft)}` : null,
    instruction ? `Instruction: ${instruction}` : null,
  ]
    .filter((part) => part !== null)
    .join('\n\n');
}

/** The response of a draft or variant call: the draft in the chosen style, with its reference solution and runners checked. */
function drafted(db: MockDb, result: ItemDraft, style: StylePreset | null, call: Call, ...texts: (string | null)[]) {
  const styled = applyStyle(result, style);
  // After the style, which decides the languages that are left to break and to check.
  const draft = asks(RUNNER_MARKER, ...texts) ? breakRunner(styled) : styled;
  const check = checkDraft(db, draft, asks(MISMATCH_MARKER, ...texts));
  // A new draft is logged under the title that came back.
  const usage = spend(db, call, draft, call.title ?? (draft.title || null));
  return ok({ draft, style: applied(style), check, usage });
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
  const interfaceHint = raw.interfaceHint ?? 'auto';
  if (interfaceHint !== 'auto' && interfaceHint !== 'program' && interfaceHint !== 'function') {
    v.add('interfaceHint', 'must be auto, program or function');
  }
  const instruction = parseInstruction(raw, v);
  const previousDraft = parsePreviousDraft(raw, v);
  v.check();
  const style = resolveStyle(db, raw);
  if (!db.aiEnabled) throw aiUnavailable();

  await sleep(db.delay('aiDraft'));
  const call: Call = { operation: 'draft', itemId: null, title: null, schema: 'item_draft', content: said(text as string, instruction, previousDraft, style) };
  failIfAsked(db, call, text as string, instruction);
  const result = draftFromText(text as string, typeHint as 'auto' | 'problem' | 'reading', instruction, previousDraft, interfaceHint as InterfaceHint);
  return drafted(db, result, style, call, text as string, instruction);
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
  const interfaceHint = raw.interfaceHint ?? null;
  if (interfaceHint !== null && interfaceHint !== 'program' && interfaceHint !== 'function') {
    v.add('interfaceHint', 'must be program or function');
  } else if (interfaceHint !== null && item.type === 'reading') v.add('interfaceHint', 'does not apply to a reading');
  v.check();
  const style = resolveStyle(db, raw);
  if (!db.aiEnabled) throw aiUnavailable();

  await sleep(db.delay('aiDraft'));
  const call: Call = { operation: 'variant', itemId: item.id, title: item.title, schema: 'item_draft', content: said(`Write a variant (${mode}) of this item.\n\n# ${item.title}\n\n${item.body}`, instruction, previousDraft, style) };
  failIfAsked(db, call, instruction);
  // With an earlier variant draft and an instruction this is a revision of
  // that draft, not a fresh variant.
  const result =
    previousDraft != null && instruction ? reviseDraft(previousDraft, instruction) : variantOfItem(db, item, mode, instruction);
  // A variant keeps the original's interface unless the request asks for the other one.
  const shaped = interfaceHint === null ? result : withInterface(result, interfaceHint as ProblemInterface);
  return drafted(db, shaped, style, call, instruction);
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
  else if (item.problem?.interface === 'function' && !(language in item.problem.harness)) {
    v.add('language', 'has no harness on this problem');
  }
  const instruction = parseInstruction(raw, v);
  v.check();
  if (!db.aiEnabled) throw aiUnavailable();

  await sleep(db.delay('aiTests'));
  const inputs = db.casesOf(item.id).map((c) => c.stdin.trimEnd()).join('\n---\n');
  const call: Call = {
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
  return ok({ ...proposal, usage: spend(db, call, answered) });
}

export function aiRoutes(db: MockDb): [string, string, Handler][] {
  return [
    ['POST', '/ai/draft', (req) => draft(db, req)],
    ['POST', '/items/:id/ai/variant', (req) => variant(db, req)],
    ['POST', '/items/:id/ai/testcases', (req) => testCases(db, req)],
  ];
}
