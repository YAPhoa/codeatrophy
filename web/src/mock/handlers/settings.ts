// Settings endpoints: the AI provider and the user's preferences.

import type { AiProviderId } from '../../api/types';
import type { MockDb, ProviderConfig } from '../db';
import { AI_DEFAULTS, AI_PROVIDERS, atMostChars, charCount, LIMITS, sameOrigin } from '../db';
import type { Handler, Req } from '../http';
import { invalid, isRecord, objectBody, ok, Validator } from '../http';
import { sleep } from '../util';

const isProvider = (value: unknown): value is AiProviderId => AI_PROVIDERS.includes(value as AiProviderId);

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

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

function putSettings(db: MockDb, req: Req) {
  const raw = objectBody(req);
  const v = new Validator();
  // Work on a copy so a rejected update leaves nothing half-applied.
  const next = structuredClone(db.ai);

  if (raw.providers !== undefined) {
    if (!isRecord(raw.providers)) v.add('providers', 'must be an object');
    else {
      for (const [id, update] of Object.entries(raw.providers)) {
        if (!isProvider(id)) {
          v.add(`providers.${id}`, 'is not a known provider');
          continue;
        }
        if (!isRecord(update)) {
          v.add(`providers.${id}`, 'must be an object');
          continue;
        }
        const config: ProviderConfig = next.providers[id];
        const baseUrlBefore = config.savedBaseUrl ?? config.envBaseUrl ?? AI_DEFAULTS[id].baseUrl;
        let keySupplied = false;
        const model = optionalText(update.model, `providers.${id}.model`, v);
        if (model != null && charCount(model) > LIMITS.maxModelIdChars) {
          v.add(`providers.${id}.model`, atMostChars(LIMITS.maxModelIdChars));
        } else if (model !== undefined) config.savedModel = model;
        const baseUrl = optionalText(update.baseUrl, `providers.${id}.baseUrl`, v);
        if (baseUrl != null && !isHttpUrl(baseUrl)) v.add(`providers.${id}.baseUrl`, 'must be an http(s) URL');
        else if (baseUrl !== undefined) config.savedBaseUrl = baseUrl;
        // `null` deletes the stored key; an empty string is treated like an
        // omitted one and leaves it alone.
        if (update.apiKey === null) config.savedKey = null;
        else if (update.apiKey !== undefined) {
          const apiKey = optionalText(update.apiKey, `providers.${id}.apiKey`, v);
          if (apiKey != null && charCount(apiKey) > LIMITS.maxApiKeyChars) {
            v.add(`providers.${id}.apiKey`, atMostChars(LIMITS.maxApiKeyChars));
          } else if (apiKey != null) {
            config.savedKey = apiKey;
            keySupplied = true;
          }
        }
        // A saved key belongs to the server it was saved for: pointing the
        // provider at a different origin drops it, unless this same request
        // brings the key for the new one.
        const baseUrlAfter = config.savedBaseUrl ?? config.envBaseUrl ?? AI_DEFAULTS[id].baseUrl;
        if (!keySupplied && !sameOrigin(baseUrlBefore, baseUrlAfter)) config.savedKey = null;
      }
    }
  }
  if (raw.activeProvider !== undefined) {
    if (raw.activeProvider !== null && !isProvider(raw.activeProvider)) {
      v.add('activeProvider', 'must be a known provider id or null');
    } else next.activeProvider = raw.activeProvider;
  }
  v.check();

  const previous = db.ai;
  db.ai = next;
  if (next.activeProvider !== null && !db.providerState(next.activeProvider).ready) {
    db.ai = previous;
    throw invalid(
      'activeProvider',
      next.activeProvider === 'anthropic'
        ? 'cannot be selected: the provider needs an API key'
        : db.effectiveModel(next.activeProvider) === null
          ? 'cannot be selected: the provider needs a model and a base URL'
          : 'cannot be selected: the provider needs an API key for this base URL',
    );
  }
  return ok(db.aiSettings());
}

/** Pretend to call the provider once, with any overrides from the request. */
async function testSettings(db: MockDb, req: Req) {
  const raw = objectBody(req);
  if (!isProvider(raw.provider)) throw invalid('provider', 'must be a known provider id');
  const provider = raw.provider;
  const v = new Validator();
  const model = optionalText(raw.model, 'model', v) ?? db.effectiveModel(provider) ?? AI_DEFAULTS[provider].model;
  const configuredBaseUrl = db.effectiveBaseUrl(provider) ?? AI_DEFAULTS[provider].baseUrl;
  const baseUrl = optionalText(raw.baseUrl, 'baseUrl', v) ?? configuredBaseUrl;
  // The configured key is never sent to a server other than the one it was
  // set up for: a test against a different origin uses only a key typed into
  // this request.
  const typedKey = optionalText(raw.apiKey, 'apiKey', v) ?? null;
  const elsewhere = !sameOrigin(baseUrl, configuredBaseUrl);
  const key = typedKey ?? (elsewhere ? null : db.effectiveKey(provider));
  v.check();

  await sleep(db.delay('aiTest'));
  const failure = (error: string) => ok({ ok: false, model, latencyMs: null, error });
  if (baseUrl !== null && !isHttpUrl(baseUrl)) return failure(`invalid base URL "${baseUrl}"`);
  if (model === null) return failure('No model is set for this provider.');
  const keyRequired = provider === 'anthropic' || sameOrigin(baseUrl, AI_DEFAULTS[provider].baseUrl);
  if (keyRequired && key === null) {
    return failure(
      elsewhere && db.effectiveKey(provider) !== null
        ? 'No API key was sent: the configured key is only used with the base URL it was set up for. Enter a key to test this URL.'
        : 'No API key is configured for this provider.',
    );
  }
  if (baseUrl !== null && /unreachable/i.test(baseUrl)) {
    const host = new URL(baseUrl).host;
    return failure(`Could not reach ${host}: dial tcp: lookup ${host.replace(/:\d+$/, '')}: no such host`);
  }
  if (key !== null && /bad|invalid/i.test(key)) {
    return failure(
      provider === 'anthropic'
        ? 'The provider rejected the API key (401 authentication_error: invalid x-api-key).'
        : 'The provider rejected the API key (401: Incorrect API key provided).',
    );
  }
  return ok({ ok: true, model, latencyMs: 380 + Math.floor(Math.random() * 500), error: null });
}

// ---- Preferences --------------------------------------------------------------

type PreferenceRule = { kind: 'boolean' } | { kind: 'oneOf'; values: readonly number[] } | { kind: 'range'; min: number; max: number };

/** Every preference by dotted path. The defaults are `DEFAULT_PREFERENCES` in ../db. */
const PREFERENCE_RULES: Readonly<Record<string, PreferenceRule>> = {
  hideTestCases: { kind: 'boolean' },
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
    ['POST', '/settings/ai/test', (req) => testSettings(db, req)],
    ['GET', '/settings/preferences', () => ok(structuredClone(db.preferences))],
    ['PUT', '/settings/preferences', (req) => putPreferences(db, req)],
  ];
}
