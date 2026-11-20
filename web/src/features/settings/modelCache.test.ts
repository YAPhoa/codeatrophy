import { describe, expect, it } from 'vitest';
import { removeLocalStorage, withFakeLocalStorage } from '../../test/fakeStorage';
import { MAX_ENDPOINTS, endpointKey, rememberModels, rememberedModels } from './modelCache';

const OPENAI = 'https://api.openai.com/v1';

describe('endpointKey', () => {
  it('is the kind and the base URL, whatever the trailing slash or the case of the host', () => {
    expect(endpointKey('openai_compatible', OPENAI)).toBe('openai_compatible https://api.openai.com/v1');
    expect(endpointKey('openai_compatible', ' https://API.openai.com/v1/ ')).toBe(endpointKey('openai_compatible', OPENAI));
  });

  it('tells apart two kinds, two ports and two paths on one host', () => {
    const keys = [
      endpointKey('openai_compatible', 'https://gateway.example/openai'),
      endpointKey('openai_compatible', 'https://gateway.example/google'),
      endpointKey('openai_compatible', 'https://gateway.example:8443/openai'),
      endpointKey('anthropic', 'https://gateway.example/openai'),
    ];
    expect(new Set(keys).size).toBe(4);
  });

  it('is null for text that is not an http(s) URL', () => {
    expect(endpointKey('anthropic', '')).toBeNull();
    expect(endpointKey('anthropic', 'api.anthropic.com')).toBeNull();
    expect(endpointKey('anthropic', 'ftp://example.com')).toBeNull();
  });
});

describe('remembered models', () => {
  withFakeLocalStorage();

  it('are found again under the same endpoint, with when they were loaded', () => {
    rememberModels('openai_compatible', OPENAI, ['gpt-4.1', 'gpt-4.1-mini'], Date.parse('2026-01-02T03:04:05Z'));
    expect(rememberedModels('openai_compatible', `${OPENAI}/`)).toEqual({ models: ['gpt-4.1', 'gpt-4.1-mini'], at: '2026-01-02T03:04:05.000Z' });
    expect(rememberedModels('openai_compatible', 'http://localhost:11434/v1')).toBeNull();
    expect(rememberedModels('anthropic', OPENAI)).toBeNull();
  });

  it('are replaced by a newer list, and kept when the newer one is empty', () => {
    rememberModels('openai_compatible', OPENAI, ['a'], 1000);
    rememberModels('openai_compatible', OPENAI, ['b', 'c'], 2000);
    rememberModels('openai_compatible', OPENAI, [], 3000);
    expect(rememberedModels('openai_compatible', OPENAI)?.models).toEqual(['b', 'c']);
  });

  it('forget the endpoints loaded longest ago beyond the limit', () => {
    for (let i = 0; i <= MAX_ENDPOINTS; i++) rememberModels('openai_compatible', `http://host-${i}.example/v1`, ['m'], 1000 + i);
    expect(rememberedModels('openai_compatible', 'http://host-0.example/v1')).toBeNull();
    expect(rememberedModels('openai_compatible', 'http://host-1.example/v1')).not.toBeNull();
    expect(rememberedModels('openai_compatible', `http://host-${MAX_ENDPOINTS}.example/v1`)).not.toBeNull();
  });

  it('ignore stored data of another shape', () => {
    const key = endpointKey('openai_compatible', OPENAI)!;
    for (const stored of ['not json', '[]', JSON.stringify({ [key]: { models: 'gpt-4.1', at: 'x' } }), JSON.stringify({ [key]: { models: [1, 2], at: '2026-01-02T03:04:05Z' } })]) {
      localStorage.setItem('codeatrophy:ai-models', stored);
      expect(rememberedModels('openai_compatible', OPENAI)).toBeNull();
    }
  });

  it('do nothing without storage', () => {
    removeLocalStorage();
    rememberModels('openai_compatible', OPENAI, ['a']);
    expect(rememberedModels('openai_compatible', OPENAI)).toBeNull();
  });
});
