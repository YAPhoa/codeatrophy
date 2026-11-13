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
  modelProblem,
  nameProblem,
  needsOf,
  outlookOf,
  patchBody,
  suggestName,
  testBody,
  type ProviderForm,
} from './aiProviders';

const kinds: AiSettings['kinds'] = {
  anthropic: { defaultModel: 'claude-opus-5-5', defaultBaseUrl: 'https://api.anthropic.com', keyRequired: true },
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
  source: 'settings',
  isDefault: false,
  ready: true,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  ...over,
});

const form = (over: Partial<ProviderForm> = {}): ProviderForm => ({ name: 'New', kind: 'openai_compatible', model: '', baseUrl: '', apiKey: '', removeKey: false, ...over });

describe('what a provider uses', () => {
  it('falls back to the default model of its kind', () => {
    expect(modelInEffect(provider(), kinds)).toBe('claude-opus-5-5');
    expect(modelInEffect(provider({ model: 'claude-sonnet-5-5' }), kinds)).toBe('claude-sonnet-5-5');
    expect(modelInEffect(provider({ kind: 'openai_compatible' }), kinds)).toBeNull();
  });

  it('names the host only when it is not the default server', () => {
    expect(customHost(provider(), kinds)).toBeNull();
    expect(customHost(provider({ baseUrl: 'https://api.anthropic.com/v2' }), kinds)).toBeNull();
    expect(customHost(provider({ kind: 'openai_compatible', baseUrl: 'http://localhost:11434/v1' }), kinds)).toBe('localhost:11434');
  });

  it('requires a key for Anthropic anywhere, and for OpenAI-compatible only on the default server', () => {
    expect(keyRequiredAt('anthropic', 'https://gateway.example.org', kinds)).toBe(true);
    expect(keyRequiredAt('openai_compatible', 'https://api.openai.com/v1', kinds)).toBe(true);
    expect(keyRequiredAt('openai_compatible', 'http://localhost:11434/v1', kinds)).toBe(false);
    expect(keyRequiredAt('openai_compatible', 'not a url', kinds)).toBe(false);
  });

  it('says what a provider that is not ready still needs', () => {
    expect(needsOf(provider(), kinds)).toEqual([]);
    expect(needsOf(provider({ ready: false, apiKeySet: false, apiKeyHint: null }), kinds)).toEqual(['an API key']);
    expect(needsOf(provider({ kind: 'openai_compatible', ready: false, apiKeySet: false }), kinds)).toEqual(['a model', 'an API key']);
    expect(needsOf(provider({ kind: 'openai_compatible', ready: false, apiKeySet: false, baseUrl: 'http://localhost:11434/v1' }), kinds)).toEqual(['a model']);
  });
});

describe('suggestName', () => {
  it('names a new provider after where it connects', () => {
    expect(suggestName('anthropic', '', [], kinds)).toBe('Anthropic');
    expect(suggestName('openai_compatible', '', [], kinds)).toBe('OpenAI');
    expect(suggestName('openai_compatible', 'http://localhost:11434/v1', [], kinds)).toBe('localhost:11434');
    expect(suggestName('openai_compatible', 'https://api.openai.com/v2', [], kinds)).toBe('OpenAI');
    // A URL still being typed does not count yet.
    expect(suggestName('openai_compatible', 'localhost', [], kinds)).toBe('OpenAI');
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
    expect(baseUrlProblem('')).toBeNull();
    expect(baseUrlProblem('http://localhost:11434/v1')).toBeNull();
    expect(baseUrlProblem('localhost:11434')).toMatch(/http/);
  });
});

describe('outlookOf', () => {
  it('lets a new provider on a server of its own do without a key', () => {
    expect(outlookOf(form(), null, kinds)).toMatchObject({ keyRequired: true, keyWillBeSet: false, missing: ['a model', 'an API key'], serverChanges: false });
    expect(outlookOf(form({ baseUrl: 'http://localhost:11434/v1', model: 'llama3.1:8b' }), null, kinds)).toMatchObject({ keyRequired: false, missing: [] });
    expect(outlookOf(form({ kind: 'anthropic', apiKey: 'sk-ant-1' }), null, kinds).missing).toEqual([]);
  });

  it('keeps the saved key while the server stays the same', () => {
    const saved = provider();
    expect(outlookOf(formOf(saved), saved, kinds)).toMatchObject({ keyWillBeSet: true, savedKeyDropped: false, missing: [] });
    expect(outlookOf({ ...formOf(saved), baseUrl: 'https://api.anthropic.com/v2' }, saved, kinds)).toMatchObject({ serverChanges: false, keyWillBeSet: true });
    expect(outlookOf({ ...formOf(saved), removeKey: true }, saved, kinds)).toMatchObject({ keyWillBeSet: false, missing: ['an API key'] });
  });

  it('drops the saved key when the base URL moves to another server', () => {
    const saved = provider();
    const moved = { ...formOf(saved), baseUrl: 'https://gateway.example.org/anthropic' };
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
  });

  it('patches only what changed, and never touches the key unasked', () => {
    const saved = provider({ model: 'claude-sonnet-5-5', baseUrl: 'https://gateway.example.org' });
    expect(patchBody(formOf(saved), saved)).toEqual({});
    expect(patchBody({ ...formOf(saved), name: 'Work key ' }, saved)).toEqual({ name: 'Work key' });
    expect(patchBody({ ...formOf(saved), model: '', baseUrl: '' }, saved)).toEqual({ model: null, baseUrl: null });
    expect(patchBody({ ...formOf(saved), apiKey: 'sk-new' }, saved)).toEqual({ apiKey: 'sk-new' });
    expect(patchBody({ ...formOf(saved), removeKey: true }, saved)).toEqual({ apiKey: null });
    // A typed key wins over a pending deletion; there is nothing to delete without a saved key.
    expect(patchBody({ ...formOf(saved), removeKey: true, apiKey: 'sk-new' }, saved)).toEqual({ apiKey: 'sk-new' });
    expect(patchBody({ ...formOf(saved), removeKey: true }, { ...saved, apiKeySet: false })).toEqual({});
  });

  it('tests an unsaved configuration by kind', () => {
    expect(testBody(form(), null, kinds)).toEqual({ kind: 'openai_compatible', model: null, baseUrl: null, apiKey: null });
    expect(testBody(form({ model: 'gpt-4.1', apiKey: 'sk-1' }), null, kinds)).toEqual({ kind: 'openai_compatible', model: 'gpt-4.1', baseUrl: null, apiKey: 'sk-1' });
  });

  it('tests a saved provider with the form as overrides, an emptied field meaning the default', () => {
    const saved = provider({ model: 'claude-sonnet-5-5', baseUrl: 'https://gateway.example.org' });
    expect(testBody(formOf(saved), saved, kinds)).toEqual({ providerId: 'p1', model: 'claude-sonnet-5-5', baseUrl: 'https://gateway.example.org', apiKey: null });
    expect(testBody({ ...formOf(saved), model: '', baseUrl: '', apiKey: 'sk-typed' }, saved, kinds)).toEqual({
      providerId: 'p1',
      model: 'claude-opus-5-5',
      baseUrl: 'https://api.anthropic.com',
      apiKey: 'sk-typed',
    });
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
