import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ApiError } from '../api/client';
import type { StylePreset } from '../api/types';
import { headingSlugs, slugify } from '../ui/markdownPlugins';
import { clearCode, initialCode, loadCode, pickLanguage, rememberLanguage, saveCode } from './codeStore';
import { describeError, errorLine, sentence } from './errors';
import { describeChanges, formatBytes, formatMemoryKb, formatMs, plural, readingMinutes, relativeTime } from './format';
import { languageLabel, sortLanguages } from './languages';
import { mcpConnection, mcpUrl } from './mcp';
import { resolveStyleChoice } from './styleChoice';

/** A minimal in-memory Storage for the node test environment. */
function fakeStorage(): Storage {
  const data = new Map<string, string>();
  return {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (k) => data.get(k) ?? null,
    key: (i) => [...data.keys()][i] ?? null,
    removeItem: (k) => void data.delete(k),
    setItem: (k, v) => void data.set(k, String(v)),
  };
}

describe('codeStore', () => {
  beforeEach(() => {
    (globalThis as { localStorage?: Storage }).localStorage = fakeStorage();
  });
  afterEach(() => {
    delete (globalThis as { localStorage?: Storage }).localStorage;
  });

  it('keeps code per item and language', () => {
    saveCode('i1', 'python', 'print(1)');
    saveCode('i1', 'go', 'package main');
    saveCode('i2', 'python', 'print(2)');
    expect(loadCode('i1', 'python')).toBe('print(1)');
    expect(loadCode('i1', 'go')).toBe('package main');
    expect(loadCode('i2', 'python')).toBe('print(2)');
    clearCode('i1', 'python');
    expect(loadCode('i1', 'python')).toBeNull();
    expect(loadCode('i1', 'go')).toBe('package main');
  });

  it('prefers saved work over starter code, and keeps deliberately emptied code', () => {
    const starter = { python: '# starter' };
    expect(initialCode('i1', 'python', starter)).toBe('# starter');
    expect(initialCode('i1', 'rust', starter)).toBe('');
    saveCode('i1', 'python', '');
    expect(initialCode('i1', 'python', starter)).toBe('');
  });

  it('picks the item language, then the last used, then one with starter code, then the first offered', () => {
    const offered = ['python', 'cpp', 'go'];
    expect(pickLanguage('i1', offered, {})).toBe('python');
    expect(pickLanguage('i1', offered, { go: 'x' })).toBe('go');
    rememberLanguage('i2', 'cpp');
    expect(pickLanguage('i1', offered, { go: 'x' })).toBe('cpp');
    rememberLanguage('i1', 'go');
    expect(pickLanguage('i1', offered, {})).toBe('go');
    expect(pickLanguage('i2', offered, {})).toBe('cpp');
  });

  it('ignores a remembered language the judge no longer offers', () => {
    rememberLanguage('i1', 'ruby');
    expect(pickLanguage('i1', ['python'], {})).toBe('python');
    expect(pickLanguage('i1', [], {})).toBeNull();
  });

  it('does not throw when storage is unavailable', () => {
    delete (globalThis as { localStorage?: Storage }).localStorage;
    expect(() => saveCode('i', 'python', 'x')).not.toThrow();
    expect(loadCode('i', 'python')).toBeNull();
  });
});

describe('describeError', () => {
  it('has a presentation for every code in the contract', () => {
    const codes = ['bad_request', 'forbidden', 'not_found', 'conflict', 'too_large', 'validation_failed', 'upstream_error', 'ai_unavailable', 'judge_unavailable', 'internal'] as const;
    for (const code of codes) {
      const view = describeError(new ApiError(400, code, 'server message'));
      expect(view.title.length, code).toBeGreaterThan(0);
      expect(view.message.length, code).toBeGreaterThan(0);
    }
  });

  it('explains a refused cross-origin change in terms of the server configuration', () => {
    const err = new ApiError(403, 'forbidden', 'cross-origin requests are not allowed');
    expect(describeError(err).message).toMatch(/CODEATROPHY_PUBLIC_URL/);
    expect(describeError(err).message).toMatch(/CODEATROPHY_ALLOWED_ORIGINS/);
    expect(errorLine(err)).toMatch(/refused/);
  });

  it('explains a refused host name, which can stop the page from loading at all', () => {
    const plain = new ApiError(403, 'forbidden', 'host not allowed');
    expect(describeError(plain).title).toMatch(/does not answer at this address/);
    expect(describeError(plain).message).toMatch(/CODEATROPHY_ALLOWED_HOSTS/);
    expect(describeError(plain).message).toMatch(/CODEATROPHY_PUBLIC_URL/);
    expect(describeError(plain).action).toBe('retry');
    expect(errorLine(plain)).toMatch(/CODEATROPHY_ALLOWED_HOSTS/);
  });

  it('leads with the server’s own message when it names the setting to change', () => {
    const host = new ApiError(403, 'forbidden', 'host "library.example" is not allowed; add it to CODEATROPHY_ALLOWED_HOSTS or set CODEATROPHY_PUBLIC_URL');
    const view = describeError(host);
    expect(view.title).toMatch(/does not answer at this address/);
    expect(view.message.startsWith('Host "library.example" is not allowed')).toBe(true);
    expect(view.message.match(/CODEATROPHY_ALLOWED_HOSTS/g)).toHaveLength(1);
    expect(view.message).toMatch(/change that setting and restart/);
    expect(errorLine(host)).toMatch(/library\.example/);

    const origin = new ApiError(403, 'forbidden', 'origin https://library.example is not allowed; set CODEATROPHY_ALLOWED_ORIGINS');
    expect(describeError(origin).title).toMatch(/refused this change/);
    expect(describeError(origin).message).toMatch(/^Origin https:\/\/library\.example is not allowed/);
    expect(describeError(origin).message).toMatch(/Nothing was changed/);
  });

  it('points to the right place for unavailable services', () => {
    expect(describeError(new ApiError(503, 'ai_unavailable', '')).action).toBe('ai-settings');
    expect(describeError(new ApiError(503, 'judge_unavailable', '')).action).toBe('judge-settings');
  });

  it('distinguishes a revision conflict from other conflicts', () => {
    expect(describeError(new ApiError(409, 'conflict', 'x', { revision: 5 })).title).toMatch(/changed elsewhere/);
    expect(describeError(new ApiError(409, 'conflict', 'cannot move a collection under itself')).message).toMatch(/under itself/);
  });

  it('exposes validation fields as strings', () => {
    expect(describeError(new ApiError(422, 'validation_failed', 'bad', { title: 'is required', 'edits[1]': 2 })).fields).toEqual({ title: 'is required', 'edits[1]': '2' });
  });

  it('presents terse server messages as sentences', () => {
    expect(sentence('not a zip archive')).toBe('Not a zip archive.');
    expect(sentence('problem.timeLimitMs must be between 100 and 30000')).toBe('problem.timeLimitMs must be between 100 and 30000.');
    expect(sentence('Already a sentence.')).toBe('Already a sentence.');
    expect(sentence('')).toBe('');
    expect(describeError(new ApiError(422, 'validation_failed', 'not a zip archive', { file: 'not a zip archive' })).message).toBe('Not a zip archive.');
  });

  it('copes with values that are not ApiErrors', () => {
    expect(describeError(new Error('boom')).message).toBe('boom');
    expect(describeError('nope').title).toBe('Something went wrong');
  });

  it('uses the server message in one-line form for validation errors', () => {
    expect(errorLine(new ApiError(422, 'validation_failed', 'title is required'))).toBe('Title is required.');
    expect(errorLine(new ApiError(0, 'network', 'x'))).toMatch(/Cannot reach the server/);
  });
});

describe('format', () => {
  const now = Date.parse('2026-06-15T12:00:00Z');

  it('formats relative times', () => {
    expect(relativeTime('2026-06-15T11:59:40Z', now)).toBe('just now');
    expect(relativeTime('2026-06-15T09:00:00Z', now)).toMatch(/3 hr/);
    expect(relativeTime('2026-06-14T12:00:00Z', now)).toBe('yesterday');
    expect(relativeTime('2026-04-15T12:00:00Z', now)).toMatch(/2 mo/);
    expect(relativeTime('2024-01-01T00:00:00Z', now)).toMatch(/2024/);
    expect(relativeTime('not a date', now)).toBe('');
  });

  it('formats sizes and durations', () => {
    expect(formatBytes(512)).toBe('512\u00a0B');
    expect(formatBytes(52428800)).toBe('50\u00a0MB');
    expect(formatMemoryKb(262144)).toBe('256\u00a0MB');
    expect(formatMemoryKb(9120)).toBe('8.9\u00a0MB');
    expect(formatMs(48)).toBe('48\u00a0ms');
    expect(formatMs(2000)).toBe('2\u00a0s');
  });

  it('pluralises', () => {
    expect(plural(1, 'case')).toBe('1 case');
    expect(plural(0, 'case')).toBe('0 cases');
    expect(plural(2, 'min', 'min')).toBe('2 min');
  });

  it('estimates reading time with a floor of one minute', () => {
    expect(readingMinutes('')).toBe(1);
    expect(readingMinutes(Array.from({ length: 660 }, () => 'word').join(' '))).toBe(3);
  });
});

describe('mcpConnection', () => {
  it('builds the endpoint and commands', () => {
    const c = mcpConnection(mcpUrl({ path: '/mcp', url: null }, 'http://localhost:8080/'), false);
    expect(c.url).toBe('http://localhost:8080/mcp');
    expect(c.claudeCommand).toBe('claude mcp add --transport http codeatrophy http://localhost:8080/mcp');
    expect(c.stdioCommand).toBe('npx mcp-remote http://localhost:8080/mcp');
  });

  it('adds a bearer header placeholder when a token is required, never a real token', () => {
    const c = mcpConnection(mcpUrl({ path: 'mcp' }, 'https://lib.example'), true);
    expect(c.url).toBe('https://lib.example/mcp');
    expect(c.claudeCommand).toContain('--header "Authorization: Bearer <your-token>"');
    expect(c.stdioCommand).toContain('--header "Authorization: Bearer <your-token>"');
  });
});

describe('mcpUrl', () => {
  it('prefers the public URL the operator configured over the page origin', () => {
    expect(mcpUrl({ path: '/mcp', url: 'https://library.example.org/base/mcp' }, 'http://10.0.0.5:8080')).toBe('https://library.example.org/base/mcp');
    expect(mcpUrl({ path: '/mcp', url: null }, 'http://10.0.0.5:8080')).toBe('http://10.0.0.5:8080/mcp');
  });
});

describe('resolveStyleChoice', () => {
  const style = (id: string, isDefault = false): StylePreset => ({ id, name: id, instructions: 'x', isDefault, createdAt: '', updatedAt: '' });
  const styles = [style('a', true), style('b')];

  it('starts on the default preset', () => {
    expect(resolveStyleChoice(undefined, styles)).toBe('a');
    expect(resolveStyleChoice(undefined, [style('b')])).toBeNull();
    expect(resolveStyleChoice(undefined, [])).toBeNull();
  });

  it('respects an explicit choice, including "no style"', () => {
    expect(resolveStyleChoice('b', styles)).toBe('b');
    expect(resolveStyleChoice(null, styles)).toBeNull();
  });

  it('falls back when the chosen preset no longer exists', () => {
    expect(resolveStyleChoice('deleted', styles)).toBe('a');
    expect(resolveStyleChoice('deleted', [style('b')])).toBeNull();
  });
});

describe('languages and slugs', () => {
  it('sorts language ids canonically with unknown ids last', () => {
    expect(sortLanguages(['zig', 'go', 'python', 'ada'])).toEqual(['python', 'go', 'ada', 'zig']);
  });

  it('labels a language with the toolchain version the judge reports', () => {
    const judge = [
      { id: 'cpp', name: 'C++', version: 'GCC 9.2.0' },
      { id: 'go', name: 'Go', version: '1.13.5' },
    ];
    expect(languageLabel('cpp', judge)).toBe('C++ (GCC 9.2.0)');
    expect(languageLabel('go', judge)).toBe('Go (1.13.5)');
    expect(languageLabel('python', judge)).toBe('Python');
    expect(languageLabel('rust')).toBe('Rust');
  });

  it('describes what differs in an imported item', () => {
    expect(describeChanges(['title'], 'reading')).toBe('title');
    expect(describeChanges(['body', 'testCases'], 'problem')).toBe('statement and test cases');
    expect(describeChanges(['title', 'body', 'limits', 'somethingNew'], 'reading')).toBe('title, text, time and memory limits and somethingNew');
  });

  it('slugifies headings', () => {
    expect(slugify('  Why not a binary tree? ')).toBe('why-not-a-binary-tree');
    expect(slugify('Café — O(n²)')).toBe('cafe-on2');
  });

  it('assigns unique, prefixed heading ids', () => {
    const h = (text: string) => ({ type: 'element', tagName: 'h2', properties: {} as Record<string, unknown>, children: [{ type: 'text', value: text }] });
    const tree = { type: 'root', children: [h('Input'), h('Input'), h('!!!'), { type: 'element', tagName: 'p', children: [{ type: 'text', value: 'x' }] }] };
    headingSlugs()(tree);
    expect(tree.children.map((n) => ('properties' in n ? n.properties?.id : undefined))).toEqual(['h-input', 'h-input-1', 'h-section', undefined]);
  });
});
