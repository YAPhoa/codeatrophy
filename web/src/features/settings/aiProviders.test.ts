import { describe, expect, it } from 'vitest';
import type { AiProvider, AiSettings } from '../../api/types';
import {
  baseUrlProblem,
  createBody,
  customHost,
  formOf,
  keyRequiredAt,
  matchModels,
  modelInEffect,
  modelPlaceholder,
  modelProblem,
  modelsBody,
  nameProblem,
  needsOf,
  needsTest,
  outlookOf,
  passedTestOf,
  patchBody,
  suggestName,
  testBody,
  type ProviderForm,
} from './aiProviders';

const kinds: AiSettings['kinds'] = {
  anthropic: { defaultModel: 'claude-opus-5-5', defaultBaseUrl: 'https://api.anthropic.com', keyRequired: true },
  gemini: { defaultModel: null, defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta', keyRequired: true },
  openai_compatible: { defaultModel: null, defaultBaseUrl: 'https://api.openai.com/v1', keyRequired: false },
};

const unused = { requests: 0, failed: 0, inputTokens: 0, outputTokens: 0 };

const provider = (over: Partial<AiProvider> = {}): AiProvider => ({
  usage: { last30Days: unused, allTime: unused, lastUsedAt: null },
  id: 'p1',
  name: 'Personal key',
  kind: 'anthropic',
  model: null,
  baseUrl: null,
  apiKeySet: true,
  apiKeyHint: '…x7Qa',
  effort: null,
  source: 'settings',
  isDefault: false,
  ready: true,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  ...over,
});

const form = (over: Partial<ProviderForm> = {}): ProviderForm => ({ name: 'New', kind: 'openai_compatible', model: '', baseUrl: '', apiKey: '', removeKey: false, effort: null, ...over });

describe('what a provider uses', () => {
  it('falls back to the default model of its kind', () => {
    expect(modelInEffect(provider(), kinds)).toBe('claude-opus-5-5');
    expect(modelInEffect(provider({ model: 'claude-sonnet-5-5' }), kinds)).toBe('claude-sonnet-5-5');
    expect(modelInEffect(provider({ kind: 'openai_compatible' }), kinds)).toBeNull();
    expect(modelInEffect(provider({ kind: 'gemini' }), kinds)).toBeNull();
    expect(modelInEffect(provider({ kind: 'gemini', model: 'gemini-3.5-flash' }), kinds)).toBe('gemini-3.5-flash');
  });

  it('names the host only when it is not the default server', () => {
    expect(customHost(provider(), kinds)).toBeNull();
    expect(customHost(provider({ baseUrl: 'https://api.anthropic.com/v2' }), kinds)).toBeNull();
    expect(customHost(provider({ kind: 'openai_compatible', baseUrl: 'http://localhost:11434/v1' }), kinds)).toBe('localhost:11434');
    expect(customHost(provider({ kind: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1' }), kinds)).toBeNull();
    expect(customHost(provider({ kind: 'gemini', baseUrl: 'https://gateway.example.org/google' }), kinds)).toBe('gateway.example.org');
  });

  it('requires a key for Anthropic and Gemini anywhere, and for OpenAI-compatible only on the default server', () => {
    expect(keyRequiredAt('anthropic', 'https://gateway.example.org', kinds)).toBe(true);
    expect(keyRequiredAt('gemini', 'https://generativelanguage.googleapis.com/v1beta', kinds)).toBe(true);
    expect(keyRequiredAt('gemini', 'https://gateway.example.org/google', kinds)).toBe(true);
    expect(keyRequiredAt('gemini', null, kinds)).toBe(true);
    expect(keyRequiredAt('openai_compatible', 'https://api.openai.com/v1', kinds)).toBe(true);
    expect(keyRequiredAt('openai_compatible', 'http://localhost:11434/v1', kinds)).toBe(false);
    expect(keyRequiredAt('openai_compatible', 'not a url', kinds)).toBe(false);
  });

  it('says what a provider that is not ready still needs', () => {
    expect(needsOf(provider(), kinds)).toEqual([]);
    expect(needsOf(provider({ ready: false, apiKeySet: false, apiKeyHint: null }), kinds)).toEqual(['an API key']);
    expect(needsOf(provider({ kind: 'openai_compatible', ready: false, apiKeySet: false }), kinds)).toEqual(['a model', 'an API key']);
    expect(needsOf(provider({ kind: 'openai_compatible', ready: false, apiKeySet: false, baseUrl: 'http://localhost:11434/v1' }), kinds)).toEqual(['a model']);
    // Gemini has no default model, and needs a key on any server.
    expect(needsOf(provider({ kind: 'gemini', ready: false, apiKeySet: false, apiKeyHint: null }), kinds)).toEqual(['a model', 'an API key']);
    expect(needsOf(provider({ kind: 'gemini', ready: false, apiKeySet: false, apiKeyHint: null, baseUrl: 'https://gateway.example.org/google' }), kinds)).toEqual(['a model', 'an API key']);
    expect(needsOf(provider({ kind: 'gemini', ready: false }), kinds)).toEqual(['a model']);
    expect(needsOf(provider({ kind: 'gemini', ready: false, model: 'gemini-3.5-flash', apiKeySet: false, apiKeyHint: null }), kinds)).toEqual(['an API key']);
  });
});

describe('suggestName', () => {
  it('names a new provider after where it connects', () => {
    expect(suggestName('anthropic', '', [], kinds)).toBe('Anthropic');
    expect(suggestName('openai_compatible', '', [], kinds)).toBe('OpenAI-compatible');
    expect(suggestName('openai_compatible', 'http://localhost:11434/v1', [], kinds)).toBe('localhost:11434');
    expect(suggestName('openai_compatible', 'https://api.openai.com/v2', [], kinds)).toBe('OpenAI');
    // A URL still being typed does not count yet.
    expect(suggestName('openai_compatible', 'localhost', [], kinds)).toBe('OpenAI-compatible');
  });

  it('names a Gemini provider by its kind on Google\'s server, and by the host of a gateway', () => {
    expect(suggestName('gemini', '', [], kinds)).toBe('Google Gemini');
    expect(suggestName('gemini', 'https://generativelanguage.googleapis.com/v1beta', [], kinds)).toBe('Google Gemini');
    expect(suggestName('gemini', 'https://gateway.example.org/google', [], kinds)).toBe('gateway.example.org');
    expect(suggestName('gemini', '', [provider({ kind: 'gemini', name: 'Google Gemini' })], kinds)).toBe('Google Gemini 2');
  });

  it('adds a number when the name is taken by a saved provider', () => {
    const taken = [provider({ name: 'anthropic' }), provider({ id: 'p2', name: 'Anthropic 2' }), provider({ id: 'env-anthropic', name: 'Anthropic 3', source: 'environment' })];
    expect(suggestName('anthropic', '', taken, kinds)).toBe('Anthropic 3');
  });
});

describe('validation', () => {
  it('checks a name against the limit and the other saved providers', () => {
    const others = [provider(), provider({ id: 'env-anthropic', name: 'From the environment', source: 'environment' })];
    expect(nameProblem('Work key', others, null, 60)).toBeNull();
    expect(nameProblem('', others, null, 60)).toBeNull();
    expect(nameProblem(' personal KEY ', others, null, 60)).toMatch(/already has this name/);
    // Its own name is not a clash, and neither is an environment provider's.
    expect(nameProblem('Personal key', others, others[0]!, 60)).toBeNull();
    expect(nameProblem('From the environment', others, null, 60)).toBeNull();
    expect(nameProblem('n'.repeat(61), others, null, 60)).toBe('1 over the 60-character limit.');
    expect(nameProblem('é'.repeat(60), others, null, 60)).toBeNull();
    expect(nameProblem('two\tparts', others, null, 60)).toMatch(/single line/);
  });

  it('checks a model name and a base URL', () => {
    expect(modelProblem('gpt-4.1', 200)).toBeNull();
    expect(modelProblem('', 200)).toBeNull();
    expect(modelProblem('m'.repeat(201), 200)).toMatch(/over the 200-character limit/);
    expect(modelProblem('a\tb', 200)).toMatch(/single line/);
    expect(baseUrlProblem('', 'anthropic')).toBeNull();
    expect(baseUrlProblem('', 'gemini')).toBeNull();
    expect(baseUrlProblem('gateway.example.org', 'gemini')).toMatch(/http/);
    expect(baseUrlProblem(' ', 'openai_compatible')).toBe('Enter the base URL.');
    expect(baseUrlProblem('http://localhost:11434/v1', 'openai_compatible')).toBeNull();
    expect(baseUrlProblem('localhost:11434', 'openai_compatible')).toMatch(/http/);
  });
});

describe('outlookOf', () => {
  it('lets a new provider on a server of its own do without a key', () => {
    expect(outlookOf(form(), null, kinds)).toMatchObject({ keyRequired: true, keyWillBeSet: false, missing: ['a model', 'an API key'], serverChanges: false });
    expect(outlookOf(form({ baseUrl: 'http://localhost:11434/v1', model: 'llama3.1:8b' }), null, kinds)).toMatchObject({ keyRequired: false, missing: [] });
    expect(outlookOf(form({ kind: 'anthropic', apiKey: 'sk-ant-1' }), null, kinds).missing).toEqual([]);
  });

  it('asks a new Gemini provider for a model and a key, on its own server or a gateway', () => {
    expect(outlookOf(form({ kind: 'gemini' }), null, kinds)).toMatchObject({
      nextBaseUrl: 'https://generativelanguage.googleapis.com/v1beta',
      keyRequired: true,
      keyWillBeSet: false,
      missing: ['a model', 'an API key'],
    });
    expect(outlookOf(form({ kind: 'gemini', baseUrl: 'https://gateway.example.org/google', model: 'gemini-3.5-flash' }), null, kinds)).toMatchObject({ keyRequired: true, missing: ['an API key'] });
    expect(outlookOf(form({ kind: 'gemini', apiKey: 'AIza-1', model: 'gemini-3.5-flash' }), null, kinds).missing).toEqual([]);
  });

  it('keeps the saved key while the server stays the same', () => {
    const saved = provider();
    expect(outlookOf(formOf(saved, kinds), saved, kinds)).toMatchObject({ keyWillBeSet: true, savedKeyDropped: false, missing: [] });
    expect(outlookOf({ ...formOf(saved, kinds), baseUrl: 'https://api.anthropic.com/v2' }, saved, kinds)).toMatchObject({ serverChanges: false, keyWillBeSet: true });
    expect(outlookOf({ ...formOf(saved, kinds), removeKey: true }, saved, kinds)).toMatchObject({ keyWillBeSet: false, missing: ['an API key'] });
  });

  it('drops the saved key when the base URL moves to another server', () => {
    const saved = provider();
    const moved = { ...formOf(saved, kinds), baseUrl: 'https://gateway.example.org/anthropic' };
    expect(outlookOf(moved, saved, kinds)).toMatchObject({
      currentBaseUrl: 'https://api.anthropic.com',
      nextBaseUrl: 'https://gateway.example.org/anthropic',
      serverChanges: true,
      savedKeyDropped: true,
      keyWillBeSet: false,
      missing: ['an API key for gateway.example.org'],
    });
    // A key typed for the new server goes with it.
    expect(outlookOf({ ...moved, apiKey: 'sk-gw-1' }, saved, kinds)).toMatchObject({ serverChanges: true, savedKeyDropped: false, keyWillBeSet: true, missing: [] });
    // Without a saved key there is nothing to lose.
    expect(outlookOf(moved, provider({ apiKeySet: false, apiKeyHint: null }), kinds)).toMatchObject({ serverChanges: false, savedKeyDropped: false });
  });
});

describe('request bodies', () => {
  it('creates with the values that were filled in', () => {
    expect(createBody(form({ name: '  Work  ' }))).toEqual({ name: 'Work', kind: 'openai_compatible' });
    expect(createBody(form({ name: 'Ollama', model: ' llama3.1:8b ', baseUrl: 'http://localhost:11434/v1 ', apiKey: ' sk-1 ' }))).toEqual({
      name: 'Ollama',
      kind: 'openai_compatible',
      model: 'llama3.1:8b',
      baseUrl: 'http://localhost:11434/v1',
      apiKey: 'sk-1',
    });
    expect(createBody(form({ name: 'Deep', effort: 'high' }))).toEqual({ name: 'Deep', kind: 'openai_compatible', effort: 'high' });
  });

  it('patches only what changed, and never touches the key unasked', () => {
    const saved = provider({ model: 'claude-sonnet-5-5', baseUrl: 'https://gateway.example.org' });
    expect(patchBody(formOf(saved, kinds), saved, kinds)).toEqual({});
    expect(patchBody({ ...formOf(saved, kinds), name: 'Work key ' }, saved, kinds)).toEqual({ name: 'Work key' });
    expect(patchBody({ ...formOf(saved, kinds), model: '', baseUrl: '' }, saved, kinds)).toEqual({ model: null, baseUrl: null });
    expect(patchBody({ ...formOf(saved, kinds), apiKey: 'sk-new' }, saved, kinds)).toEqual({ apiKey: 'sk-new' });
    expect(patchBody({ ...formOf(saved, kinds), removeKey: true }, saved, kinds)).toEqual({ apiKey: null });
    // A typed key wins over a pending deletion; there is nothing to delete without a saved key.
    expect(patchBody({ ...formOf(saved, kinds), removeKey: true, apiKey: 'sk-new' }, saved, kinds)).toEqual({ apiKey: 'sk-new' });
    expect(patchBody({ ...formOf(saved, kinds), removeKey: true }, { ...saved, apiKeySet: false }, kinds)).toEqual({});
    // An OpenAI-compatible provider saved without a base URL shows the server it uses, and that is not a change.
    const hosted = provider({ kind: 'openai_compatible', model: 'gpt-4.1', baseUrl: null });
    expect(formOf(hosted, kinds).baseUrl).toBe('https://api.openai.com/v1');
    expect(patchBody(formOf(hosted, kinds), hosted, kinds)).toEqual({});
    expect(patchBody({ ...formOf(hosted, kinds), baseUrl: 'http://localhost:11434/v1' }, hosted, kinds)).toEqual({ baseUrl: 'http://localhost:11434/v1' });
    // A Gemini provider has a server of its own: without a base URL the field stays empty, as Anthropic's does.
    const gemini = provider({ kind: 'gemini', model: 'gemini-3.5-flash', baseUrl: null });
    expect(formOf(gemini, kinds).baseUrl).toBe('');
    expect(patchBody(formOf(gemini, kinds), gemini, kinds)).toEqual({});
    // The effort level, to another one or back to the model's default.
    const deep = provider({ effort: 'high' });
    expect(formOf(deep, kinds).effort).toBe('high');
    expect(patchBody(formOf(deep, kinds), deep, kinds)).toEqual({});
    expect(patchBody({ ...formOf(deep, kinds), effort: 'medium' }, deep, kinds)).toEqual({ effort: 'medium' });
    expect(patchBody({ ...formOf(deep, kinds), effort: null }, deep, kinds)).toEqual({ effort: null });
  });

  it('tests an unsaved configuration by kind', () => {
    expect(testBody(form(), null, kinds)).toEqual({ kind: 'openai_compatible', model: null, baseUrl: null, apiKey: null, effort: null });
    expect(testBody(form({ kind: 'gemini', model: 'gemini-3.5-flash', apiKey: 'AIza-1' }), null, kinds)).toEqual({ kind: 'gemini', model: 'gemini-3.5-flash', baseUrl: null, apiKey: 'AIza-1', effort: null });
    expect(testBody(form({ model: 'gpt-4.1', apiKey: 'sk-1', effort: 'low' }), null, kinds)).toEqual({ kind: 'openai_compatible', model: 'gpt-4.1', baseUrl: null, apiKey: 'sk-1', effort: 'low' });
  });

  it('tests a saved provider with the form as overrides, an emptied field meaning the default', () => {
    const saved = provider({ model: 'claude-sonnet-5-5', baseUrl: 'https://gateway.example.org' });
    expect(testBody(formOf(saved, kinds), saved, kinds)).toEqual({ providerId: 'p1', model: 'claude-sonnet-5-5', baseUrl: 'https://gateway.example.org', apiKey: null, effort: null });
    // The effort level is always sent: null is the model's default, not "as saved".
    expect(testBody({ ...formOf(saved, kinds), model: '', baseUrl: '', apiKey: 'sk-typed', effort: 'high' }, saved, kinds)).toEqual({
      providerId: 'p1',
      model: 'claude-opus-5-5',
      baseUrl: 'https://api.anthropic.com',
      apiKey: 'sk-typed',
      effort: 'high',
    });
  });

  it('lists the models of the same provider a test would use, without a model', () => {
    expect(modelsBody(form({ model: 'gpt-4.1', apiKey: 'sk-1' }), null, kinds)).toEqual({ kind: 'openai_compatible', baseUrl: null, apiKey: 'sk-1' });
    const saved = provider({ model: 'claude-sonnet-5-5', baseUrl: 'https://gateway.example.org' });
    expect(modelsBody(formOf(saved, kinds), saved, kinds)).toEqual({ providerId: 'p1', baseUrl: 'https://gateway.example.org', apiKey: null });
    expect(modelsBody({ ...formOf(saved, kinds), baseUrl: '', apiKey: 'sk-typed' }, saved, kinds)).toEqual({ providerId: 'p1', baseUrl: 'https://api.anthropic.com', apiKey: 'sk-typed' });
  });
});

describe('needsTest', () => {
  const passed = (f: ProviderForm) => passedTestOf(f, kinds);

  it('holds back a new provider until its endpoint and key have passed a test, whatever the model since', () => {
    const base = form({ model: 'gpt-4.1', apiKey: 'sk-1' });
    expect(needsTest(base, null, kinds, null)).toBe(true);
    expect(needsTest(base, null, kinds, passed(base))).toBe(false);
    expect(needsTest({ ...base, model: 'gpt-4.1-mini', name: 'Renamed', apiKey: ' sk-1 ' }, null, kinds, passed(base))).toBe(false);
    // The default base URL typed out, with a trailing slash, is the same endpoint.
    expect(needsTest({ ...base, baseUrl: 'https://api.openai.com/v1/' }, null, kinds, passed(base))).toBe(false);
    expect(needsTest({ ...base, apiKey: 'sk-2' }, null, kinds, passed(base))).toBe(true);
    expect(needsTest({ ...base, baseUrl: 'http://localhost:11434/v1' }, null, kinds, passed(base))).toBe(true);
    expect(needsTest({ ...base, kind: 'anthropic' }, null, kinds, passed(base))).toBe(true);
    expect(needsTest({ ...base, kind: 'gemini' }, null, kinds, passed(base))).toBe(true);
  });

  it('lets a saved provider save untested while its connection is as saved, and asks for a test of a new one', () => {
    const saved = provider({ kind: 'openai_compatible', model: 'llama3.1:8b', baseUrl: 'http://localhost:11434/v1' });
    expect(needsTest({ ...formOf(saved, kinds), model: 'qwen2.5-coder:14b', name: 'Renamed' }, saved, kinds, null)).toBe(false);
    expect(needsTest({ ...formOf(saved, kinds), removeKey: true }, saved, kinds, null)).toBe(false);
    // Put back, with a trailing slash, it is the saved endpoint again.
    expect(needsTest({ ...formOf(saved, kinds), baseUrl: 'http://localhost:11434/v1/' }, saved, kinds, null)).toBe(false);

    const keyed = { ...formOf(saved, kinds), apiKey: 'sk-new' };
    expect(needsTest(keyed, saved, kinds, null)).toBe(true);
    expect(needsTest(keyed, saved, kinds, passed(keyed))).toBe(false);
    const moved = { ...formOf(saved, kinds), baseUrl: 'http://gpu.lan:8000/v1' };
    expect(needsTest(moved, saved, kinds, null)).toBe(true);
    expect(needsTest({ ...moved, model: 'other' }, saved, kinds, passed(moved))).toBe(false);
    expect(needsTest({ ...formOf(saved, kinds), baseUrl: 'not a url' }, saved, kinds, null)).toBe(true);
  });

  it('asks for a test of another effort level where the test sends it, and not for Anthropic', () => {
    for (const kind of ['openai_compatible', 'gemini'] as const) {
      const saved = provider({ kind, model: 'm', baseUrl: kind === 'gemini' ? null : 'http://localhost:11434/v1' });
      const deeper = { ...formOf(saved, kinds), effort: 'high' as const };
      expect(needsTest(deeper, saved, kinds, null)).toBe(true);
      expect(needsTest(deeper, saved, kinds, passed(deeper))).toBe(false);
      expect(needsTest({ ...deeper, effort: 'low' }, saved, kinds, passed(deeper))).toBe(true);
      // A new provider's passed test stands for the level it sent only.
      const fresh = form({ kind, model: 'm', apiKey: 'k', effort: 'low' });
      expect(needsTest(fresh, null, kinds, passed(fresh))).toBe(false);
      expect(needsTest({ ...fresh, effort: null }, null, kinds, passed(fresh))).toBe(true);
    }
    const anthropic = provider({ effort: 'high' });
    expect(needsTest({ ...formOf(anthropic, kinds), effort: 'low' }, anthropic, kinds, null)).toBe(false);
    const fresh = form({ kind: 'anthropic', apiKey: 'k' });
    expect(needsTest({ ...fresh, effort: 'medium' }, null, kinds, passed(fresh))).toBe(false);
  });
});

describe('modelPlaceholder', () => {
  it('shows the kind\'s default, else asks for a pick from the list, else gives examples of the kind', () => {
    expect(modelPlaceholder('anthropic', kinds, false)).toBe('claude-opus-5-5');
    expect(modelPlaceholder('gemini', kinds, true)).toBe('Pick a model…');
    expect(modelPlaceholder('gemini', kinds, false)).toBe('e.g. gemini-3.5-flash…');
    expect(modelPlaceholder('openai_compatible', kinds, false)).toBe('e.g. gpt-4.1, llama3.1:70b…');
  });
});

describe('matchModels', () => {
  const models = ['gpt-4.1', 'gpt-4.1-mini', 'gpt-4o-mini', 'o4-mini'];

  it('offers everything while the field is empty or holds one of them', () => {
    expect(matchModels(models, '')).toEqual(models);
    expect(matchModels(models, ' GPT-4.1 ')).toEqual(models);
  });

  it('narrows to what contains the text, names starting with it first', () => {
    expect(matchModels(models, 'mini')).toEqual(['gpt-4.1-mini', 'gpt-4o-mini', 'o4-mini']);
    expect(matchModels(models, 'o4')).toEqual(['o4-mini']);
    expect(matchModels(models, '4')).toEqual(['gpt-4.1', 'gpt-4.1-mini', 'gpt-4o-mini', 'o4-mini']);
    expect(matchModels(['x-o3', 'o3', 'o3-pro'], 'o3-')).toEqual(['o3-pro']);
    expect(matchModels(['x-o1', 'o1-pro'], 'o1')).toEqual(['o1-pro', 'x-o1']);
  });

  it('offers nothing for a name the service does not list', () => {
    expect(matchModels(models, 'my-finetune')).toEqual([]);
  });
});
