/*
 * What the AI providers section works out from the settings and from the
 * add/edit form before anything is sent: which model and server a provider
 * uses, what it still needs before it can be the default, and the request
 * bodies for saving and for a connection test.
 */

import type { AiProvider, AiProviderInput, AiProviderKind, AiProviderPatch, AiSettings, AiTestRequest } from '../../api/types';
import { hostOf, movesToAnotherServer, originOf } from './aiKeyBinding';

type Kinds = AiSettings['kinds'];

export const KINDS: readonly { id: AiProviderKind; name: string; text: string }[] = [
  { id: 'anthropic', name: 'Anthropic', text: 'Claude models, through the Anthropic API.' },
  { id: 'openai_compatible', name: 'OpenAI-compatible', text: 'OpenAI, OpenRouter, Ollama, LM Studio, vLLM and the like.' },
];

export const kindName = (kind: AiProviderKind): string => KINDS.find((k) => k.id === kind)?.name ?? kind;

/** The model a provider uses: its own, else the kind's default, else none. */
export const modelInEffect = (provider: Pick<AiProvider, 'kind' | 'model'>, kinds: Kinds): string | null => provider.model ?? kinds[provider.kind].defaultModel;

export const baseUrlInEffect = (provider: Pick<AiProvider, 'kind' | 'baseUrl'>, kinds: Kinds): string => provider.baseUrl ?? kinds[provider.kind].defaultBaseUrl;

/** The host a provider talks to when that is not its kind's default server, else `null`. */
export function customHost(provider: Pick<AiProvider, 'kind' | 'baseUrl'>, kinds: Kinds): string | null {
  if (provider.baseUrl === null) return null;
  return originOf(provider.baseUrl) === originOf(kinds[provider.kind].defaultBaseUrl) ? null : hostOf(provider.baseUrl);
}

/**
 * Whether a provider of this kind needs an API key at this base URL. The
 * hosted OpenAI API always needs one; other compatible endpoints may not.
 */
export function keyRequiredAt(kind: AiProviderKind, baseUrl: string | null, kinds: Kinds): boolean {
  if (kinds[kind].keyRequired) return true;
  const origin = originOf(baseUrl);
  return origin !== null && origin === originOf(kinds[kind].defaultBaseUrl);
}

/** "a model and an API key": the parts of `missing`, joined for a sentence. */
export const listNeeds = (missing: readonly string[]): string => missing.join(' and ');

/** What a provider in the list still lacks before it is ready. Empty for a ready one. */
export function needsOf(provider: AiProvider, kinds: Kinds): string[] {
  if (provider.ready) return [];
  const missing: string[] = [];
  if (modelInEffect(provider, kinds) === null) missing.push('a model');
  if (!provider.apiKeySet && keyRequiredAt(provider.kind, baseUrlInEffect(provider, kinds), kinds)) missing.push('an API key');
  return missing;
}

// ---- The add/edit form --------------------------------------------------------

export interface ProviderForm {
  name: string;
  kind: AiProviderKind;
  model: string;
  baseUrl: string;
  /** A new key typed by the user. Never pre-filled: stored keys cannot be read back. */
  apiKey: string;
  removeKey: boolean;
}

export const formOf = (provider: AiProvider): ProviderForm => ({
  name: provider.name,
  kind: provider.kind,
  model: provider.model ?? '',
  baseUrl: provider.baseUrl ?? '',
  apiKey: '',
  removeKey: false,
});

/**
 * A name for a new provider that no saved provider has yet. It says where
 * the provider connects: "Anthropic", "OpenAI", or the host of another
 * server ("localhost:11434"), with a number when that is taken.
 */
export function suggestName(kind: AiProviderKind, baseUrl: string, providers: readonly AiProvider[], kinds: Kinds): string {
  const taken = new Set(providers.filter((p) => p.source === 'settings').map((p) => p.name.trim().toLowerCase()));
  const elsewhere = originOf(baseUrl) !== null && originOf(baseUrl) !== originOf(kinds[kind].defaultBaseUrl);
  const base = elsewhere ? hostOf(baseUrl) : kind === 'openai_compatible' ? 'OpenAI' : kindName(kind);
  for (let n = 1; ; n++) {
    const name = n === 1 ? base : `${base} ${n}`;
    if (!taken.has(name.toLowerCase())) return name;
  }
}

/** Length as the server counts it: Unicode code points after trimming. */
export const charLength = (text: string): number => Array.from(text.trim()).length;

// What a single-line field rejects besides tabs and newlines.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/;
const LINE_BREAK = new RegExp(`[\\n\\r\\t${String.fromCharCode(0x2028, 0x2029)}]`);

/**
 * Why a provider name cannot be saved, or `null`. An empty name is not a
 * problem to point out, only one that keeps the form from being saved.
 * Names are unique among saved providers; `self` is the one being edited.
 */
export function nameProblem(name: string, providers: readonly AiProvider[], self: AiProvider | null, max: number): string | null {
  const text = name.trim();
  const length = charLength(text);
  if (length > max) return `${length - max} over the ${max}-character limit.`;
  if (LINE_BREAK.test(text)) return 'A name is a single line, without tabs.';
  if (CONTROL.test(text)) return 'Contains a control character that cannot be saved.';
  const clash = providers.some((p) => p.source === 'settings' && p.id !== self?.id && p.name.trim().toLowerCase() === text.toLowerCase());
  return clash && text !== '' ? 'Another provider already has this name.' : null;
}

export function modelProblem(model: string, max: number): string | null {
  const text = model.trim();
  const length = charLength(text);
  if (length > max) return `${length - max} over the ${max}-character limit.`;
  return LINE_BREAK.test(text) || CONTROL.test(text) ? 'A model name is a single line, without tabs or control characters.' : null;
}

/** Why a base URL cannot be used, or `null`. Empty is fine: the kind's default applies. */
export function baseUrlProblem(baseUrl: string): string | null {
  return baseUrl.trim() === '' || originOf(baseUrl) !== null ? null : 'Enter the whole address, starting with http:// or https://.';
}

export interface Outlook {
  /** Where requests go now, and where they would go after saving the form. */
  currentBaseUrl: string | null;
  nextBaseUrl: string;
  /** A key is saved, and the form points at another server than the one it belongs to. */
  serverChanges: boolean;
  /** Saving would delete the saved key: it must not be sent to the new server. */
  savedKeyDropped: boolean;
  keyRequired: boolean;
  keyWillBeSet: boolean;
  /** What the provider would still lack after saving, as in `needsOf`. */
  missing: string[];
}

/** What saving the form would lead to. `provider` is the one being edited, `null` for a new one. */
export function outlookOf(form: ProviderForm, provider: AiProvider | null, kinds: Kinds): Outlook {
  const kind = kinds[form.kind];
  const currentBaseUrl = provider ? baseUrlInEffect(provider, kinds) : null;
  const nextBaseUrl = form.baseUrl.trim() || kind.defaultBaseUrl;
  const typedKey = form.apiKey.trim() !== '';
  const serverChanges = provider?.apiKeySet === true && movesToAnotherServer(currentBaseUrl, nextBaseUrl);
  const savedKeyDropped = serverChanges && !typedKey;
  const keyRequired = keyRequiredAt(form.kind, nextBaseUrl, kinds);
  const keyWillBeSet = typedKey || (provider?.apiKeySet === true && !savedKeyDropped && !form.removeKey);
  const missing: string[] = [];
  if (form.model.trim() === '' && kind.defaultModel === null) missing.push('a model');
  if (keyRequired && !keyWillBeSet) missing.push(savedKeyDropped ? `an API key for ${hostOf(nextBaseUrl)}` : 'an API key');
  return { currentBaseUrl, nextBaseUrl, serverChanges, savedKeyDropped, keyRequired, keyWillBeSet, missing };
}

export function createBody(form: ProviderForm): AiProviderInput {
  const body: AiProviderInput = { name: form.name.trim(), kind: form.kind };
  if (form.model.trim()) body.model = form.model.trim();
  if (form.baseUrl.trim()) body.baseUrl = form.baseUrl.trim();
  if (form.apiKey.trim()) body.apiKey = form.apiKey.trim();
  return body;
}

/** Only what differs from the saved provider is sent, so untouched values (and the key) stay as they are. */
export function patchBody(form: ProviderForm, provider: AiProvider): AiProviderPatch {
  const patch: AiProviderPatch = {};
  if (form.name.trim() !== provider.name) patch.name = form.name.trim();
  if (form.model.trim() !== (provider.model ?? '')) patch.model = form.model.trim() || null;
  if (form.baseUrl.trim() !== (provider.baseUrl ?? '')) patch.baseUrl = form.baseUrl.trim() || null;
  if (form.apiKey.trim()) patch.apiKey = form.apiKey.trim();
  else if (form.removeKey && provider.apiKeySet) patch.apiKey = null;
  return patch;
}

/**
 * A connection test of the values in the form, saved or not, so a key can
 * be tried before it is stored.
 *
 * For a saved provider the values are overrides, and a `null` override
 * means "as saved" rather than "none". A field the user emptied is
 * therefore sent as the kind's default, which is what saving it would
 * lead to.
 */
export function testBody(form: ProviderForm, provider: AiProvider | null, kinds: Kinds): AiTestRequest {
  const model = form.model.trim() || null;
  const baseUrl = form.baseUrl.trim() || null;
  const apiKey = form.apiKey.trim() || null;
  if (!provider) return { kind: form.kind, model, baseUrl, apiKey };
  const kind = kinds[provider.kind];
  return { providerId: provider.id, model: model ?? kind.defaultModel, baseUrl: baseUrl ?? kind.defaultBaseUrl, apiKey };
}

/**
 * The models to offer for what is in the field: all of them while it is
 * empty or holds one of them (so the list can be browsed after a pick),
 * otherwise those containing the text, the ones starting with it first.
 */
export function matchModels(models: readonly string[], text: string): string[] {
  const q = text.trim().toLowerCase();
  if (q === '' || models.some((m) => m.toLowerCase() === q)) return [...models];
  const hits = models.filter((m) => m.toLowerCase().includes(q));
  return [...hits.filter((m) => m.toLowerCase().startsWith(q)), ...hits.filter((m) => !m.toLowerCase().startsWith(q))];
}
