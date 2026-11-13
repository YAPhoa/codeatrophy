import { describe, expect, it } from 'vitest';
import type { AiLogEntry } from '../api/types';
import { aiLogPath, entryFacts, exportName, filterParams, filtersFrom, logProviders, rawRequest, rawResponse, thirtyDaysBefore, usageBreakdown } from './aiLog';

const entry: AiLogEntry = {
  id: 'e1',
  createdAt: '2026-11-13T09:30:05Z',
  operation: 'testcases',
  itemId: 'item',
  title: 'Two Sum',
  providerId: 'p1',
  providerName: 'Personal key',
  kind: 'anthropic',
  model: 'claude-haiku-5-5',
  status: 'ok',
  error: null,
  durationMs: 21800,
  usage: { inputTokens: 3900, outputTokens: 1650, reasoningTokens: null, cacheReadTokens: 3100, cacheWriteTokens: 0 },
};

describe('usageBreakdown', () => {
  it('gives each count the provider reported, exactly', () => {
    expect(usageBreakdown(entry.usage)).toEqual([
      ['Input', '3,900'],
      ['Output', '1,650'],
      ['Cache read', '3,100'],
      ['Cache write', '0'],
    ]);
    expect(usageBreakdown({ inputTokens: null, outputTokens: null, reasoningTokens: null, cacheReadTokens: null, cacheWriteTokens: null })).toEqual([]);
  });

  it('sits between the provider and the time among the facts of an entry', () => {
    expect(entryFacts(entry, '13 Nov, 09:30').map(([label]) => label)).toEqual(['Provider', 'Model', 'Input', 'Output', 'Cache read', 'Cache write', 'Duration', 'Time']);
    expect(entryFacts(entry, '13 Nov, 09:30')).toContainEqual(['Duration', '22\u00a0s']);
  });
});

describe('raw texts', () => {
  it('indents the request', () => {
    expect(rawRequest({ system: 'x', messages: [] })).toEqual({ text: '{\n  "system": "x",\n  "messages": []\n}', language: 'json' });
  });

  it('indents a response that is JSON, and leaves any other as it came', () => {
    expect(rawResponse('{"title":"Two Sum"}')).toEqual({ text: '{\n  "title": "Two Sum"\n}', language: 'json' });
    expect(rawResponse(' [1,2] ')).toEqual({ text: '[\n  1,\n  2\n]', language: 'json' });
    expect(rawResponse('ok')).toEqual({ text: 'ok', language: null });
    // Cut off, it does not parse any more.
    expect(rawResponse('{"title":"Two S')).toEqual({ text: '{"title":"Two S', language: null });
    // Markup stays text.
    expect(rawResponse('<img src=x onerror=alert(1)>')).toEqual({ text: '<img src=x onerror=alert(1)>', language: null });
  });
});

describe('filters', () => {
  it('travel in the address, and unknown values are ignored', () => {
    const filters = { providerId: 'p1', operation: 'draft', status: 'failed' } as const;
    expect(filterParams(filters)).toEqual({ provider: 'p1', operation: 'draft', status: 'failed' });
    expect(filtersFrom(new URLSearchParams(filterParams(filters)))).toEqual(filters);
    expect(filterParams({})).toEqual({});
    expect(filtersFrom(new URLSearchParams('operation=poem&status=lost&entry=e1'))).toEqual({});
  });

  it('are part of a link to the log', () => {
    expect(aiLogPath()).toBe('/settings/ai-activity');
    expect(aiLogPath({ providerId: 'p1' })).toBe('/settings/ai-activity?provider=p1');
    expect(aiLogPath({ entryId: 'e1' })).toBe('/settings/ai-activity?entry=e1');
  });
});

describe('logProviders', () => {
  it('offers the configured providers and those only the log still knows, by name', () => {
    const options = logProviders([{ id: 'p1', name: 'Personal key' }, { id: 'p2', name: 'local' }], [entry, { ...entry, providerId: 'gone', providerName: 'Old gateway' }]);
    expect(options).toEqual([
      { value: 'p2', label: 'local' },
      { value: 'gone', label: 'Old gateway' },
      { value: 'p1', label: 'Personal key' },
    ]);
  });

  it('keeps a selected provider it knows nothing else about', () => {
    expect(logProviders([], [], 'px')).toEqual([{ value: 'px', label: 'A deleted provider' }]);
  });
});

describe('exporting and clearing', () => {
  it('names an exported entry after what it was and when', () => {
    expect(exportName(entry)).toBe('ai-testcases-20261113T093005.json');
  });

  it('clears from 30 days back', () => {
    expect(thirtyDaysBefore(Date.parse('2026-11-13T09:30:05Z'))).toBe('2026-10-14T09:30:05Z');
  });
});
