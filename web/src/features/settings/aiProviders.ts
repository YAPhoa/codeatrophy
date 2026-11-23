/*
 * What the AI providers section works out from the settings and from the
 * add/edit form before anything is sent: which model and server a provider
 * uses, what it still needs before it can be the default, and the request
 * bodies for saving, for a connection test and for a model listing.
 */

import type { AiEffort, AiModelsRequest, AiProvider, AiProviderInput, AiProviderKind, AiProviderPatch, AiSettings, AiTestRequest } from '../../api/types';
import { charCount, isSingleLine } from '../../lib/text';
import { hostOf, movesToAnotherServer, originOf } from './aiKeyBinding';
import { endpointKey } from './modelCache';

type Kinds = AiSettings['kinds'];

/** The kinds a provider can be of. `models` are examples of model names, for a field with nothing to offer yet. */
export const KINDS: readonly { id: AiProviderKind; name: string; text: string; models: string }[] = [
  { id: 'anthropic', name: 'Anthropic', text: 'Claude models, through the Anthropic API.', models: 'claude-opus-5-5' },
  { id: 'gemini', name: 'Google Gemini', text: 'Gemini models, through the Gemini API.', models: 'gemini-3.5-flash' },
  { id: 'openai_compatible', name: 'OpenAI-compatible', text: 'OpenAI, OpenRouter, Ollama, LM Studio, vLLM and the like.', models: 'gpt-4.1, llama3.1:70b' },
];

export const kindName = (kind: AiProviderKind): string => KINDS.find((k) => k.id === kind)?.name ?? kind;

/** The effort levels a provider can be set to, lowest first. */
export const EFFORTS: readonly AiEffort[] = ['low', 'medium', 'high'];

/** Whether a connection test sends the effort level. Anthropic's asks for low whatever is set. */
export const effortTested = (kind: AiProviderKind): boolean => kind !== 'anthropic';

/** What the Model field shows while it is empty: the kind's default, else a prompt to pick from the list, else examples. */
export function modelPlaceholder(kind: AiProviderKind, kinds: Kinds, listed: boolean): string {
  const fallback = kinds[kind].defaultModel;
  if (fallback !== null) return fallback;
  if (listed) return 'Pick a model…';
  const examples = KINDS.find((k) => k.id === kind)?.models;
  return examples ? `e.g. ${examples}…` : 'Pick a model…';
}

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
  /** `null` is the model's default. */
  effort: AiEffort | null;
}

/** Whether the form asks for a base URL: an OpenAI-compatible provider has to say which server it means. */
export const baseUrlRequired = (kind: AiProviderKind): boolean => kind === 'openai_compatible';

/** A saved provider's base URL as the form shows it. One saved without it shows the server it has been using, where the form asks for one. */
const shownBaseUrl = (provider: AiProvider, kinds: Kinds): string => provider.baseUrl ?? (baseUrlRequired(provider.kind) ? kinds[provider.kind].defaultBaseUrl : '');

export const formOf = (provider: AiProvider, kinds: Kinds): ProviderForm => ({
  name: provider.name,
  kind: provider.kind,
  model: provider.model ?? '',
  baseUrl: shownBaseUrl(provider, kinds),
  apiKey: '',
  removeKey: false,
  effort: provider.effort,
});

/**
 * A name for a new provider that no saved provider has yet. It says where
 * the provider connects: "Anthropic", "Google Gemini", "OpenAI", or the host
 * of another server ("localhost:11434"), with a number when that is taken.
 * An OpenAI-compatible provider that names no server yet is called by its
 * kind.
 */
export function suggestName(kind: AiProviderKind, baseUrl: string, providers: readonly AiProvider[], kinds: Kinds): string {
  const taken = new Set(providers.filter((p) => p.source === 'settings').map((p) => p.name.trim().toLowerCase()));
  const origin = originOf(baseUrl);
  const elsewhere = origin !== null && origin !== originOf(kinds[kind].defaultBaseUrl);
  const base = elsewhere ? hostOf(baseUrl) : kind === 'openai_compatible' && origin !== null ? 'OpenAI' : kindName(kind);
  for (let n = 1; ; n++) {
    const name = n === 1 ? base : `${base} ${n}`;
    if (!taken.has(name.toLowerCase())) return name;
  }
}

// What breaks a single line, as against other control characters: they get a message of their own.
const LINE_BREAK = /[\n\r\t\u2028\u2029]/;

/**
 * Why a provider name cannot be saved, or `null`. An empty name is not a
 * problem to point out, only one that keeps the form from being saved.
 * Names are unique among saved providers; `self` is the one being edited.
 */
export function nameProblem(name: string, providers: readonly AiProvider[], self: AiProvider | null, max: number): string | null {
  const text = name.trim();
  const length = charCount(text);
  if (length > max) return `${length - max} over the ${max}-character limit.`;
  if (LINE_BREAK.test(text)) return 'A name is a single line, without tabs.';
  if (!isSingleLine(text)) return 'Contains a control character that cannot be saved.';
  const clash = providers.some((p) => p.source === 'settings' && p.id !== self?.id && p.name.trim().toLowerCase() === text.toLowerCase());
  return clash && text !== '' ? 'Another provider already has this name.' : null;
}

export function modelProblem(model: string, max: number): string | null {
  const text = model.trim();
  const length = charCount(text);
  if (length > max) return `${length - max} over the ${max}-character limit.`;
  return isSingleLine(text) ? null : 'A model name is a single line, without tabs or control characters.';
}

/** Why a base URL cannot be used, or `null`. Empty is fine where the kind has a server of its own. */
export function baseUrlProblem(baseUrl: string, kind: AiProviderKind): string | null {
  if (baseUrl.trim() === '') return baseUrlRequired(kind) ? 'Enter the base URL.' : null;
  return originOf(baseUrl) !== null ? null : 'Enter the whole address, starting with http:// or https://.';
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
  if (form.effort !== null) body.effort = form.effort;
  return body;
}

/** Only what differs from the saved provider is sent, so untouched values (and the key) stay as they are. */
export function patchBody(form: ProviderForm, provider: AiProvider, kinds: Kinds): AiProviderPatch {
  const patch: AiProviderPatch = {};
  if (form.name.trim() !== provider.name) patch.name = form.name.trim();
  if (form.model.trim() !== (provider.model ?? '')) patch.model = form.model.trim() || null;
  if (form.baseUrl.trim() !== shownBaseUrl(provider, kinds)) patch.baseUrl = form.baseUrl.trim() || null;
  if (form.apiKey.trim()) patch.apiKey = form.apiKey.trim();
  else if (form.removeKey && provider.apiKeySet) patch.apiKey = null;
  if (form.effort !== provider.effort) patch.effort = form.effort;
  return patch;
}

/**
 * The provider of a model listing: the values in the form, saved or not, so
 * a key can be tried before it is stored.
 *
 * For a saved provider the values are overrides, and a `null` override
 * means "as saved" rather than "none". A field the user emptied is
 * therefore sent as the kind's default, which is what saving it would
 * lead to.
 */
export function modelsBody(form: ProviderForm, provider: AiProvider | null, kinds: Kinds): AiModelsRequest {
  const baseUrl = form.baseUrl.trim() || null;
  const apiKey = form.apiKey.trim() || null;
  if (!provider) return { kind: form.kind, baseUrl, apiKey };
  return { providerId: provider.id, baseUrl: baseUrl ?? kinds[provider.kind].defaultBaseUrl, apiKey };
}

/**
 * A connection test of the values in the form: the listing's provider and
 * the model, with the same meaning of an emptied field, and the effort
 * level, where `null` is the model's default.
 */
export function testBody(form: ProviderForm, provider: AiProvider | null, kinds: Kinds): AiTestRequest {
  const model = form.model.trim() || null;
  return { ...modelsBody(form, provider, kinds), model: provider ? (model ?? kinds[provider.kind].defaultModel) : model, effort: form.effort };
}

/** The endpoint the form's requests go to, as model lists are remembered under; `null` while the base URL is not a URL. */
const endpointOfForm = (form: ProviderForm, kinds: Kinds): string | null => endpointKey(form.kind, form.baseUrl.trim() || kinds[form.kind].defaultBaseUrl);

/** What a passed connection test covers: the endpoint, the key typed into the form (empty for none), and the effort level it sent. */
export interface PassedTest {
  endpoint: string;
  apiKey: string;
  effort: AiEffort | null;
}

export const passedTestOf = (form: ProviderForm, kinds: Kinds): PassedTest | null => {
  const endpoint = endpointOfForm(form, kinds);
  return endpoint === null ? null : { endpoint, apiKey: form.apiKey.trim(), effort: form.effort };
};

/**
 * A test of the endpoint and key now in the form has passed, and of the
 * effort level where the test sends it. The model and the name can have
 * changed since.
 */
export const testPassedFor = (form: ProviderForm, kinds: Kinds, passed: PassedTest | null): boolean => {
  const now = passedTestOf(form, kinds);
  return (
    now !== null && passed !== null && now.endpoint === passed.endpoint && now.apiKey === passed.apiKey && (!effortTested(form.kind) || now.effort === passed.effort)
  );
};

/**
 * Whether saving the form waits for a connection test. A new provider is
 * added once a test of its endpoint and key has passed. A saved one saves
 * freely while its connection is as saved (its endpoint, and no new key;
 * deleting the key is not a new one; the effort level, where a test sends
 * it), and otherwise once a test of the new connection has passed. `passed`
 * is what the last passed test covered.
 */
export function needsTest(form: ProviderForm, provider: AiProvider | null, kinds: Kinds, passed: PassedTest | null): boolean {
  if (testPassedFor(form, kinds, passed)) return false;
  return (
    provider === null ||
    form.apiKey.trim() !== '' ||
    endpointOfForm(form, kinds) !== endpointKey(provider.kind, baseUrlInEffect(provider, kinds)) ||
    (effortTested(form.kind) && form.effort !== provider.effort)
  );
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
