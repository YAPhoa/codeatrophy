import { describe, expect, it } from 'vitest';
import type { AiProvider, AiSettings } from '../api/types';
import { providerIdToSend, providerLabel, readyProviders, resolveProviderChoice } from './providerChoice';

const provider = (id: string, extra: Partial<AiProvider> = {}): AiProvider => ({
  id,
  name: id.toUpperCase(),
  kind: 'anthropic',
  model: `${id}-model`,
  baseUrl: null,
  apiKeySet: true,
  apiKeyHint: '…abcd',
  source: 'settings',
  isDefault: false,
  ready: true,
  usage: { last30Days: { requests: 0, failed: 0, inputTokens: 0, outputTokens: 0 }, allTime: { requests: 0, failed: 0, inputTokens: 0, outputTokens: 0 }, lastUsedAt: null },
  createdAt: null,
  updatedAt: null,
  ...extra,
});

const settings = (...providers: AiProvider[]): AiSettings => ({
  defaultProviderId: providers.find((p) => p.isDefault)?.id ?? null,
  providers,
  kinds: {
    anthropic: { defaultModel: 'claude-opus-5-5', defaultBaseUrl: 'https://api.anthropic.com', keyRequired: true },
    gemini: { defaultModel: null, defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta', keyRequired: true },
    openai_compatible: { defaultModel: null, defaultBaseUrl: 'https://api.openai.com/v1', keyRequired: false },
  },
});

const library = settings(provider('a', { isDefault: true }), provider('b'), provider('c', { ready: false }), provider('d', { source: 'environment' }));

describe('readyProviders', () => {
  it('keeps the ready ones in the order the settings list them', () => {
    expect(readyProviders(library).map((p) => p.id)).toEqual(['a', 'b', 'd']);
    expect(readyProviders(undefined)).toEqual([]);
  });
});

describe('providerLabel', () => {
  it('names the provider and its model, the kind’s default when none is saved', () => {
    expect(providerLabel(provider('b'), library)).toBe('B · b-model');
    expect(providerLabel(provider('e', { model: null }), library)).toBe('E · claude-opus-5-5');
    expect(providerLabel(provider('g', { kind: 'gemini' }), library)).toBe('G · g-model');
    // A kind without a default model has none to show.
    expect(providerLabel(provider('h', { kind: 'gemini', model: null }), library)).toBe('H');
  });
});

describe('resolveProviderChoice', () => {
  it('is the default until something is chosen', () => {
    expect(resolveProviderChoice(undefined, library)).toBe('a');
  });

  it('keeps a choice that is still ready, environment providers included', () => {
    expect(resolveProviderChoice('b', library)).toBe('b');
    expect(resolveProviderChoice('d', library)).toBe('d');
    expect(resolveProviderChoice('a', library)).toBe('a');
  });

  it('falls back to the default for a provider that is gone or not ready', () => {
    expect(resolveProviderChoice('gone', library)).toBe('a');
    expect(resolveProviderChoice('c', library)).toBe('a');
  });

  it('is null with no ready default, or before the settings have loaded', () => {
    expect(resolveProviderChoice(undefined, settings(provider('a', { isDefault: true, ready: false }), provider('b')))).toBeNull();
    expect(resolveProviderChoice('b', undefined)).toBeNull();
  });
});

describe('providerIdToSend', () => {
  it('names only an explicit, valid choice that is not the default', () => {
    expect(providerIdToSend('b', library)).toEqual({ providerId: 'b' });
    expect(providerIdToSend('d', library)).toEqual({ providerId: 'd' });
  });

  it('leaves the field out otherwise, so the request is what it was without a picker', () => {
    expect(providerIdToSend(undefined, library)).toEqual({});
    expect(providerIdToSend('a', library)).toEqual({});
    expect(providerIdToSend('gone', library)).toEqual({});
    expect(providerIdToSend('c', library)).toEqual({});
    expect(providerIdToSend('b', undefined)).toEqual({});
  });

  it('names a chosen provider that has stopped being the default', () => {
    const moved = settings(provider('a'), provider('b', { isDefault: true }));
    expect(providerIdToSend('a', moved)).toEqual({ providerId: 'a' });
  });
});
