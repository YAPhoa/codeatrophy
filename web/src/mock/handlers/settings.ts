// Settings endpoints: the AI providers and the user's preferences.

import type { AiProviderKind, AiTestResponse } from '../../api/types';
import type { MockDb, StoredAiProvider } from '../db';
import { AI_KIND_IDS, AI_KINDS, atMostChars, charCount, keyNeeded, LIMITS, noUsage, sameOrigin } from '../db';
import type { Handler, Req } from '../http';
import { badRequest, conflict, created, enumParam, invalid, isRecord, noContent, notFound, objectBody, ok, pagination, Validator } from '../http';
import { sleep, uuid } from '../util';

const isKind = (value: unknown): value is AiProviderKind => AI_KIND_IDS.includes(value as AiProviderKind);

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

// What a single-line field rejects: every control character, and the Unicode
// line and paragraph separators.
// eslint-disable-next-line no-control-regex
const NOT_SINGLE_LINE = /[\u0000-\u001F\u007F-\u009F\u2028\u2029]/;

/** A string, `null`, or absent; blank strings count as `null`. */
function optionalText(value: unknown, field: string, v: Validator): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'string') {
    v.add(field, 'must be a string or null');
    return undefined;
  }
  return value.trim() === '' ? null : value.trim();
}

function checkName(value: unknown, v: Validator): string | undefined {
  if (typeof value !== 'string') {
    v.add('name', 'must be a string');
    return undefined;
  }
  const name = value.trim();
  const length = charCount(name);
  if (length < 1) v.add('name', 'is required');
  else if (length > LIMITS.maxAiProviderNameChars) v.add('name', `must be at most ${LIMITS.maxAiProviderNameChars} characters (it has ${length})`);
  else if (NOT_SINGLE_LINE.test(name)) v.add('name', 'must be a single line without control characters');
  else return name;
  return undefined;
}

function checkModel(value: unknown, v: Validator): string | null | undefined {
  const model = optionalText(value, 'model', v);
  if (model == null) return model;
  if (charCount(model) > LIMITS.maxModelIdChars) v.add('model', atMostChars(LIMITS.maxModelIdChars));
  else if (NOT_SINGLE_LINE.test(model)) v.add('model', 'must be a single line without control characters');
  else return model;
  return undefined;
}

function checkBaseUrl(value: unknown, v: Validator): string | null | undefined {
  const baseUrl = optionalText(value, 'baseUrl', v);
  if (baseUrl == null) return baseUrl;
  if (isHttpUrl(baseUrl)) return baseUrl;
  v.add('baseUrl', 'must be an http(s) URL');
  return undefined;
}

/**
 * A key to store or send. `null` asks for the stored key to be deleted; an
 * empty string is treated like an omitted key and comes back as `undefined`.
 */
function checkApiKey(value: unknown, v: Validator): string | null | undefined {
  if (value === null) return null;
  const apiKey = optionalText(value, 'apiKey', v);
  if (apiKey == null) return undefined;
  if (charCount(apiKey) <= LIMITS.maxApiKeyChars) return apiKey;
  v.add('apiKey', atMostChars(LIMITS.maxApiKeyChars));
  return undefined;
}

/** Names are unique among saved providers, ignoring case. Environment providers are not counted. */
function nameTaken(db: MockDb, name: string, except?: StoredAiProvider): boolean {
  return db.ai.providers.some((p) => p !== except && p.source === 'settings' && p.name.toLowerCase() === name.toLowerCase());
}

/** What a provider still lacks before it is ready, as the server words it. */
function missing(db: MockDb, p: StoredAiProvider): string {
  const parts: string[] = [];
  if (db.modelOf(p) === null) parts.push('a model');
  if (p.apiKey === null && keyNeeded(p.kind, db.baseUrlOf(p))) parts.push(p.kind === 'anthropic' ? 'an API key' : 'an API key for this base URL');
  return parts.join(' and ');
}

/** Environment providers are read-only here. */
function requireSaved(provider: StoredAiProvider): void {
  if (provider.source === 'environment') {
    throw conflict('this provider is supplied by the server\'s environment variables and cannot be changed or deleted here');
  }
}

function putSettings(db: MockDb, req: Req) {
  const raw = objectBody(req);
  const id = raw.defaultProviderId;
  if (id === undefined) throw invalid('defaultProviderId', 'is required; send null to turn AI features off');
  if (id === null) db.ai.defaultProviderId = null;
  else {
    const provider = db.ai.providers.find((p) => p.id === id);
    if (!provider) throw invalid('defaultProviderId', 'is not the id of an existing provider');
    if (!db.isReady(provider)) throw invalid('defaultProviderId', `cannot be chosen: the provider needs ${missing(db, provider)}`);
    db.ai.defaultProviderId = provider.id;
  }
  return ok(db.aiSettings());
}

function createProvider(db: MockDb, req: Req) {
  const raw = objectBody(req);
  const v = new Validator();
  const name = raw.name === undefined ? (v.add('name', 'is required'), undefined) : checkName(raw.name, v);
  if (!isKind(raw.kind)) v.add('kind', raw.kind === undefined ? 'is required' : 'must be a known provider kind');
  const model = checkModel(raw.model, v);
  const baseUrl = checkBaseUrl(raw.baseUrl, v);
  const apiKey = checkApiKey(raw.apiKey, v);
  if (name !== undefined && nameTaken(db, name)) v.add('name', 'is already used by another provider');
  v.check();
  if (db.ai.providers.filter((p) => p.source === 'settings').length >= LIMITS.maxAiProviders) {
    throw conflict(`an instance can hold at most ${LIMITS.maxAiProviders} AI providers; delete one first`);
  }
  const now = db.now();
  // A new provider is never made the default here; that is `PUT /settings/ai`.
  const provider: StoredAiProvider = {
    id: uuid(),
    name: name!,
    kind: raw.kind as AiProviderKind,
    model: model ?? null,
    baseUrl: baseUrl ?? null,
    apiKey: apiKey ?? null,
    source: 'settings',
    usage: noUsage(),
    createdAt: now,
    updatedAt: now,
  };
  db.ai.providers.push(provider);
  return created(db.providerView(provider));
}

function patchProvider(db: MockDb, req: Req) {
  const provider = db.getProvider(req.params.id!);
  requireSaved(provider);
  const raw = objectBody(req);
  const v = new Validator();
  const name = raw.name === undefined ? undefined : checkName(raw.name, v);
  if (raw.kind !== undefined && raw.kind !== provider.kind) v.add('kind', 'cannot be changed after creation');
  const model = checkModel(raw.model, v);
  const baseUrl = checkBaseUrl(raw.baseUrl, v);
  const apiKey = checkApiKey(raw.apiKey, v);
  if (name !== undefined && nameTaken(db, name, provider)) v.add('name', 'is already used by another provider');
  v.check();

  const baseUrlBefore = db.baseUrlOf(provider);
  if (name !== undefined) provider.name = name;
  if (model !== undefined) provider.model = model;
  if (baseUrl !== undefined) provider.baseUrl = baseUrl;
  if (apiKey !== undefined) provider.apiKey = apiKey;
  // A saved key belongs to the server it was saved for: pointing the
  // provider at a different origin drops it, unless this same request brings
  // the key for the new one.
  if (typeof apiKey !== 'string' && !sameOrigin(baseUrlBefore, db.baseUrlOf(provider))) provider.apiKey = null;
  provider.updatedAt = db.now();
  // The default stays selected even when this leaves it not ready; AI
  // features are then off until it is fixed.
  return ok(db.providerView(provider));
}

function deleteProvider(db: MockDb, req: Req) {
  const provider = db.getProvider(req.params.id!);
  requireSaved(provider);
  db.ai.providers = db.ai.providers.filter((p) => p !== provider);
  if (db.ai.defaultProviderId === provider.id) db.ai.defaultProviderId = null;
  return noContent();
}

// What the pretend services answer when asked for their models.
const ANTHROPIC_MODELS = ['claude-haiku-5-5', 'claude-opus-5-5', 'claude-sonnet-5-5'];
const OPENAI_MODELS = ['gpt-4.1', 'gpt-4.1-mini', 'gpt-4.1-nano', 'gpt-4o', 'gpt-4o-mini', 'o3', 'o4-mini', 'text-embedding-3-large', 'text-embedding-3-small'];
const LOCAL_MODELS = ['deepseek-r1:14b', 'gemma3:12b', 'llama3.1:70b', 'llama3.1:8b', 'mistral-nemo:12b', 'qwen2.5-coder:14b'];

function modelsAt(kind: AiProviderKind, baseUrl: string): string[] {
  if (kind === 'anthropic') return [...ANTHROPIC_MODELS];
  return sameOrigin(baseUrl, AI_KINDS[kind].defaultBaseUrl) ? [...OPENAI_MODELS] : [...LOCAL_MODELS];
}

/**
 * Pretend to check a configuration against its service: fetch the model
 * list, then make one generation request when there is a model to make it
 * with. Markers steer the outcome: `unreachable` in the base URL, `bad` or
 * `invalid` in the key, and `no-models` in the base URL for a server that
 * does not list its models.
 */
async function testSettings(db: MockDb, req: Req) {
  const raw = objectBody(req);
  const byId = raw.providerId != null;
  if (byId && raw.kind != null) throw invalid('kind', 'must not be given together with providerId');
  if (!byId && raw.kind == null) throw invalid('providerId', 'or kind is required');
  const saved = byId ? db.ai.providers.find((p) => p.id === raw.providerId) : undefined;
  if (byId && !saved) throw invalid('providerId', 'is not the id of an existing provider');
  if (!byId && !isKind(raw.kind)) throw invalid('kind', 'must be a known provider kind');
  const kind = saved ? saved.kind : (raw.kind as AiProviderKind);

  const v = new Validator();
  const model = checkModel(raw.model, v) ?? (saved ? db.modelOf(saved) : AI_KINDS[kind].defaultModel);
  const configuredBaseUrl = saved ? db.baseUrlOf(saved) : AI_KINDS[kind].defaultBaseUrl;
  const baseUrl = checkBaseUrl(raw.baseUrl, v) ?? configuredBaseUrl;
  // The provider's key is never sent to a server other than the one it was
  // saved for: a test against a different origin uses only a key typed into
  // this request.
  const typedKey = checkApiKey(raw.apiKey, v) ?? null;
  const elsewhere = !sameOrigin(baseUrl, configuredBaseUrl);
  const key = typedKey ?? (elsewhere ? null : (saved?.apiKey ?? null));
  v.check();

  await sleep(db.delay('aiTest'));
  const reply = (result: Partial<AiTestResponse>) =>
    ok({ ok: false, model: null, latencyMs: null, error: null, models: null, modelsError: null, ...result } satisfies AiTestResponse);
  // The generation step of a saved provider's test is a request like any other: logged, and counted towards its usage.
  const generated = (result: Partial<AiTestResponse>) => {
    if (saved) {
      const none = { inputTokens: null, outputTokens: null, reasoningTokens: null, cacheReadTokens: null, cacheWriteTokens: null };
      db.logRequest(saved, {
        operation: 'test',
        itemId: null,
        title: null,
        model,
        status: result.ok ? 'ok' : 'failed',
        error: result.ok ? null : (result.error ?? null),
        durationMs: result.latencyMs ?? 240,
        usage: result.ok ? { ...none, inputTokens: 14, outputTokens: 5 } : none,
        request: { messages: [{ role: 'user', content: 'Reply with the single word: ok' }], maxOutputTokens: 16 },
        response: result.ok ? 'ok' : null,
      });
    }
    return reply(result);
  };

  // Without a key the service insists on, there is nothing to ask it.
  if (key === null && keyNeeded(kind, baseUrl)) {
    return reply({
      error:
        elsewhere && saved != null && saved.apiKey !== null
          ? 'No API key was sent: the saved key is only used with the base URL it was saved for. Enter a key to test this URL.'
          : 'No API key is set for this provider.',
    });
  }

  const host = new URL(baseUrl).host;
  if (/unreachable/i.test(baseUrl)) {
    const error = `Could not reach ${host}: dial tcp: lookup ${host.replace(/:\d+$/, '')}: no such host`;
    return model === null ? reply({ model, error, modelsError: error }) : generated({ model, error, modelsError: error });
  }
  if (key !== null && /bad|invalid/i.test(key)) {
    const error =
      kind === 'anthropic'
        ? 'The provider rejected the API key (401 authentication_error: invalid x-api-key).'
        : 'The provider rejected the API key (401: Incorrect API key provided).';
    return model === null ? reply({ model, error, modelsError: error }) : generated({ model, error, modelsError: error });
  }

  const listed = !/no-?models/i.test(baseUrl);
  const models = listed ? modelsAt(kind, baseUrl) : null;
  const modelsError = listed ? null : `${host} does not list its models (404 Not Found for /models).`;
  if (model === null) {
    // Nothing to generate with: fetching the list is the whole test.
    return models !== null ? reply({ ok: true, models }) : reply({ error: 'No model is set, and the model list could not be fetched.', modelsError });
  }
  if (models !== null && !models.includes(model)) {
    return generated({ model, error: `The provider does not know the model "${model}" (404 model_not_found).`, models });
  }
  return generated({ ok: true, model, latencyMs: 380 + Math.floor(Math.random() * 500), models, modelsError });
}

// ---- AI activity log -----------------------------------------------------------

const LOG_OPERATIONS = ['draft', 'variant', 'testcases', 'test'] as const;
const LOG_STATUSES = ['ok', 'failed', 'cancelled'] as const;

/**
 * A batch of the log, newest first. The cursor names the last entry of the
 * batch before, so entries written in the meantime neither repeat nor push
 * anything out of the next one.
 */
function listLog(db: MockDb, req: Req) {
  const { limit } = pagination(req.query, LIMITS.maxPageSize);
  const providerId = req.query.get('providerId');
  const operation = enumParam(req.query, 'operation', LOG_OPERATIONS);
  const status = enumParam(req.query, 'status', LOG_STATUSES);
  const cursor = req.query.get('before');
  if (cursor !== null && !/^\d+$/.test(cursor)) throw badRequest('before is not a cursor of this list');
  const matching = db.aiLog.filter((e) => (providerId === null || e.providerId === providerId) && (operation === undefined || e.operation === operation) && (status === undefined || e.status === status));
  const older = (cursor === null ? matching : matching.filter((e) => e.seq < Number(cursor))).reverse();
  const batch = older.slice(0, limit);
  const last = batch[batch.length - 1];
  return ok({ items: batch.map((e) => db.logEntryView(e)), next: last && older.length > batch.length ? String(last.seq) : null, total: matching.length });
}

function getLogEntry(db: MockDb, req: Req) {
  const entry = db.aiLog.find((e) => e.id === req.params.id);
  if (!entry) throw notFound('AI log entry');
  return ok(db.logDetailView(entry));
}

/** Remove every entry, or those from before a moment. The providers' usage counts stay as they are. */
function clearLog(db: MockDb, req: Req) {
  const before = req.query.get('before');
  if (before !== null && Number.isNaN(Date.parse(before))) throw badRequest('before must be a timestamp');
  db.aiLog = before === null ? [] : db.aiLog.filter((e) => Date.parse(e.createdAt) >= Date.parse(before));
  return noContent();
}

// ---- Preferences --------------------------------------------------------------

type PreferenceRule = { kind: 'boolean' } | { kind: 'oneOf'; values: readonly number[] } | { kind: 'range'; min: number; max: number };

/** Every preference by dotted path. The defaults are `DEFAULT_PREFERENCES` in ../db. */
const PREFERENCE_RULES: Readonly<Record<string, PreferenceRule>> = {
  hideTestCases: { kind: 'boolean' },
  generatedTestCases: { kind: 'range', min: 1, max: LIMITS.maxGeneratedTestCases },
  'editor.autocomplete': { kind: 'boolean' },
  'editor.closeBrackets': { kind: 'boolean' },
  'editor.matchBrackets': { kind: 'boolean' },
  'editor.lineWrapping': { kind: 'boolean' },
  'editor.tabSize': { kind: 'oneOf', values: [2, 4, 8] },
  'editor.fontSize': { kind: 'range', min: 10, max: 24 },
};

function preferenceProblem(rule: PreferenceRule, value: unknown): string | null {
  if (rule.kind === 'boolean') return typeof value === 'boolean' ? null : 'must be a boolean';
  if (typeof value !== 'number' || !Number.isInteger(value)) return 'must be an integer';
  if (rule.kind === 'oneOf') return rule.values.includes(value) ? null : `must be one of ${rule.values.join(', ')}`;
  return value >= rule.min && value <= rule.max ? null : `must be between ${rule.min} and ${rule.max}`;
}

/** Merge a partial preferences document, at any depth. One bad key or value rejects the whole update. */
function putPreferences(db: MockDb, req: Req) {
  const v = new Validator();
  const updates: [string[], unknown][] = [];
  const walk = (prefix: string[], node: Record<string, unknown>) => {
    for (const [key, value] of Object.entries(node)) {
      const parts = [...prefix, key];
      const path = parts.join('.');
      const rule = PREFERENCE_RULES[path];
      if (rule) {
        const problem = preferenceProblem(rule, value);
        if (problem) v.add(path, problem);
        else updates.push([parts, value]);
      } else if (Object.keys(PREFERENCE_RULES).some((known) => known.startsWith(`${path}.`))) {
        if (!isRecord(value)) v.add(path, 'must be an object');
        else walk(parts, value);
      } else v.add(path, 'unknown preference');
    }
  };
  walk([], objectBody(req));
  v.check();

  for (const [parts, value] of updates) {
    let target = db.preferences as unknown as Record<string, unknown>;
    for (const part of parts.slice(0, -1)) target = target[part] as Record<string, unknown>;
    target[parts[parts.length - 1]!] = value;
  }
  return ok(structuredClone(db.preferences));
}

export function settingsRoutes(db: MockDb): [string, string, Handler][] {
  return [
    ['GET', '/settings/ai', () => ok(db.aiSettings())],
    ['PUT', '/settings/ai', (req) => putSettings(db, req)],
    ['POST', '/settings/ai/providers', (req) => createProvider(db, req)],
    ['PATCH', '/settings/ai/providers/:id', (req) => patchProvider(db, req)],
    ['DELETE', '/settings/ai/providers/:id', (req) => deleteProvider(db, req)],
    ['POST', '/settings/ai/test', (req) => testSettings(db, req)],
    ['GET', '/settings/ai/log', (req) => listLog(db, req)],
    ['GET', '/settings/ai/log/:id', (req) => getLogEntry(db, req)],
    ['DELETE', '/settings/ai/log', (req) => clearLog(db, req)],
    ['GET', '/settings/preferences', () => ok(structuredClone(db.preferences))],
    ['PUT', '/settings/preferences', (req) => putPreferences(db, req)],
  ];
}
