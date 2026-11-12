// AI settings endpoints.

import type { AiProviderId } from '../../api/types';
import type { MockDb, ProviderConfig } from '../db';
import { AI_DEFAULTS, AI_PROVIDERS, atMostChars, charCount, LIMITS } from '../db';
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
          } else if (apiKey != null) config.savedKey = apiKey;
        }
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
        : 'cannot be selected: the provider needs a model and a base URL',
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
  const baseUrl =
    optionalText(raw.baseUrl, 'baseUrl', v) ?? db.effectiveBaseUrl(provider) ?? AI_DEFAULTS[provider].baseUrl;
  const key = optionalText(raw.apiKey, 'apiKey', v) ?? db.effectiveKey(provider);
  v.check();

  await sleep(db.delay('aiTest'));
  const failure = (error: string) => ok({ ok: false, model, latencyMs: null, error });
  if (baseUrl !== null && !isHttpUrl(baseUrl)) return failure(`invalid base URL "${baseUrl}"`);
  if (model === null) return failure('No model is set for this provider.');
  if (provider === 'anthropic' && key === null) return failure('No API key is configured for this provider.');
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

export function settingsRoutes(db: MockDb): [string, string, Handler][] {
  return [
    ['GET', '/settings/ai', () => ok(db.aiSettings())],
    ['PUT', '/settings/ai', (req) => putSettings(db, req)],
    ['POST', '/settings/ai/test', (req) => testSettings(db, req)],
  ];
}
