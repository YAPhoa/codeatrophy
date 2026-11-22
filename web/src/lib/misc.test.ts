import { describe, expect, it } from 'vitest';
import { ApiError, KNOWN_CODES } from '../api/client';
import type { ErrorCode } from '../api/types';
import { withFakeLocalStorage } from '../test/fakeStorage';
import type { StylePreset } from '../api/types';
import { headingSlugs, slugify } from '../ui/markdownPlugins';
import { MAX_STORED_INPUT_BYTES, clearLegacy, clearUnsaved, codeFor, loadCustomInput, openingLanguage, openWorkspace, pickLanguage, readLegacy, readUnsaved, rememberedLanguage, rememberLanguage, saveCustomInput, sendOrder, writeUnsaved } from './codeStore';
import { describeError, errorLine, sentence } from './errors';
import { languageLabel, sortLanguages } from './languages';
import { mcpConnection, mcpUrl } from './mcp';
import { resolveStyleChoice } from './styleChoice';

describe('codeStore', () => {
  withFakeLocalStorage();

  it('keeps unsaved edits per item and language, with the time of the server copy they are based on', () => {
    writeUnsaved('i1', 'python', 'print(1)', '2026-11-22T09:30:00Z');
    writeUnsaved('i1', 'go', '', null);
    writeUnsaved('i1', 'cpp', 'x', undefined);
    writeUnsaved('i10', 'python', 'print(10)', null);
    expect(readUnsaved('i1')).toEqual({ python: { source: 'print(1)', base: '2026-11-22T09:30:00Z' }, go: { source: '', base: null }, cpp: { source: 'x' } });
    expect(globalThis.localStorage.getItem('codeatrophy:unsaved:i1:python')).toBe('{"source":"print(1)","base":"2026-11-22T09:30:00Z"}');
    expect(globalThis.localStorage.getItem('codeatrophy:unsaved:i1:cpp')).toBe('{"source":"x"}');
    clearUnsaved('i1', 'python');
    clearUnsaved('i1', 'cpp');
    expect(readUnsaved('i1')).toEqual({ go: { source: '', base: null } });
    expect(readUnsaved('i10')).toEqual({ python: { source: 'print(10)', base: null } });
    // With the code of a save that was under way as it was made.
    writeUnsaved('i1', 'rust', 'v2', null, 'v1');
    expect(globalThis.localStorage.getItem('codeatrophy:unsaved:i1:rust')).toBe('{"source":"v2","base":null,"sending":"v1"}');
    expect(readUnsaved('i1').rust).toEqual({ source: 'v2', base: null, sending: 'v1' });
  });

  it('ignores unsaved entries of another shape', () => {
    globalThis.localStorage.setItem('codeatrophy:unsaved:i1:python', 'print(1)');
    globalThis.localStorage.setItem('codeatrophy:unsaved:i1:go', '{"base":null}');
    globalThis.localStorage.setItem('codeatrophy:unsaved:i1:cpp', '{"source":"x","base":7}');
    expect(readUnsaved('i1')).toEqual({ cpp: { source: 'x' } });
    globalThis.localStorage.setItem('codeatrophy:unsaved:i1:cpp', '{"source":"x","base":null,"sending":7}');
    expect(readUnsaved('i1')).toEqual({ cpp: { source: 'x', base: null } });
  });

  it('reads and clears the code older versions kept, per item', () => {
    globalThis.localStorage.setItem('codeatrophy:code:i1:python', 'old');
    globalThis.localStorage.setItem('codeatrophy:code:i1:cpp', '');
    globalThis.localStorage.setItem('codeatrophy:code:i2:python', 'other');
    expect(readLegacy('i1')).toEqual({ python: 'old', cpp: '' });
    clearLegacy('i1', 'python');
    clearLegacy('i1', 'cpp');
    expect(readLegacy('i1')).toEqual({});
    expect(readLegacy('i2')).toEqual({ python: 'other' });
  });

  it('shows a language its own code, else its starter, and keeps deliberately emptied code', () => {
    const starter = { python: '# starter' };
    expect(codeFor({}, starter, 'python')).toBe('# starter');
    expect(codeFor({}, starter, 'rust')).toBe('');
    expect(codeFor({ python: '' }, starter, 'python')).toBe('');
  });

  it('remembers the language last chosen on an item', () => {
    expect(rememberedLanguage('i1')).toBeNull();
    rememberLanguage('i1', 'go');
    expect(rememberedLanguage('i1')).toBe('go');
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

  it('opens with the newest working copy if the judge offers it, else as pickLanguage chooses', () => {
    rememberLanguage('i1', 'go');
    expect(openingLanguage('i1', ['python', 'go', 'cpp'], ['cpp', 'python'], {})).toBe('cpp');
    // The newest is not offered: not the next newest, but the usual choice.
    expect(openingLanguage('i1', ['python', 'go'], ['cpp', 'python'], {})).toBe('go');
    expect(openingLanguage('i1', ['python', 'go'], [], {})).toBe('go');
    expect(openingLanguage('i1', [], ['cpp'], {})).toBeNull();
  });

  it('sends the language the editor opens with last', () => {
    expect(sendOrder({ python: 'a', cpp: 'b', go: 'c' }, 'cpp')).toEqual(['go', 'python', 'cpp']);
    expect(sendOrder({ python: 'a', go: 'c' }, 'cpp')).toEqual(['go', 'python']);
    expect(sendOrder({}, null)).toEqual([]);
  });

  it('keeps the custom input per item, unless it is empty or too large', () => {
    expect(loadCustomInput('i1')).toBe('');
    saveCustomInput('i1', '3\n1 2 3\n');
    saveCustomInput('i2', 'other');
    expect(loadCustomInput('i1')).toBe('3\n1 2 3\n');
    expect(loadCustomInput('i2')).toBe('other');
    // Too large to keep: the older input does not come back in its place.
    saveCustomInput('i1', 'é'.repeat(MAX_STORED_INPUT_BYTES / 2 + 1));
    expect(loadCustomInput('i1')).toBe('');
    saveCustomInput('i2', '');
    expect(globalThis.localStorage.length).toBe(0);
  });
});

const copy = (language: string, source: string) => ({ language, source, updatedAt: '2026-11-22T09:30:00Z' });

describe('openWorkspace', () => {
  const THEN = '2026-11-22T09:30:00Z';
  const LATER = '2026-11-22T10:30:00Z';
  /** An unsaved edit based on the copy written at `base`. */
  const edit = (source: string, base?: string | null) => (base === undefined ? { source } : { source, base });
  const at = (language: string, source: string, updatedAt: string) => ({ language, source, updatedAt });

  it('opens on the server copies, in their order, with nothing to send', () => {
    const opened = openWorkspace([copy('cpp', 'b'), copy('python', 'a')], {}, {});
    expect(opened).toEqual({ sources: { cpp: 'b', python: 'a' }, recent: ['cpp', 'python'], send: {}, drop: [] });
  });

  it('drops an unsaved edit the server already holds as it is', () => {
    // As after a last save sent while the page went away: it arrived, but the page could not hear so.
    const opened = openWorkspace([at('python', 'mine', LATER)], { python: edit('mine', THEN) }, {});
    expect(opened).toEqual({ sources: { python: 'mine' }, recent: ['python'], send: {}, drop: ['python'] });
  });

  it('lets an unsaved edit win, as the newest, and sends it, while the server copy is the one it was based on', () => {
    const opened = openWorkspace([at('cpp', 'b', THEN), at('python', 'a', THEN)], { python: edit('mine', THEN) }, {});
    expect(opened).toEqual({ sources: { cpp: 'b', python: 'mine' }, recent: ['python', 'cpp'], send: { python: 'mine' }, drop: [] });
    // Based on no copy, and there is still none; emptied on purpose.
    expect(openWorkspace([], { go: edit('', null) }, {})).toEqual({ sources: { go: '' }, recent: ['go'], send: { go: '' }, drop: [] });
  });

  it('lets the server copy win when it was written after the copy an unsaved edit was based on, and drops the edit', () => {
    // Written since, from another device.
    const opened = openWorkspace([at('python', 'desktop', LATER)], { python: edit('laptop', THEN) }, {});
    expect(opened).toEqual({ sources: { python: 'desktop' }, recent: ['python'], send: {}, drop: ['python'] });
    // Written where there was none.
    expect(openWorkspace([at('python', 'desktop', LATER)], { python: edit('laptop', null) }, {}).drop).toEqual(['python']);
    // Deleted since: a reset elsewhere.
    expect(openWorkspace([], { python: edit('laptop', THEN) }, {})).toEqual({ sources: {}, recent: [], send: {}, drop: ['python'] });
  });

  it('lets an unsaved edit win over the copy of the save that was under way as it was made', () => {
    // The tab closed with v1 in flight and v2 waiting; v1 landed after.
    const opened = openWorkspace([at('python', 'v1', LATER)], { python: { source: 'v2', base: THEN, sending: 'v1' } }, {});
    expect(opened).toEqual({ sources: { python: 'v2' }, recent: ['python'], send: { python: 'v2' }, drop: [] });
    // It did not land: the copy is still the one the edit was based on.
    expect(openWorkspace([at('python', 'v0', THEN)], { python: { source: 'v2', base: THEN, sending: 'v1' } }, {}).send).toEqual({ python: 'v2' });
    // Written since, from elsewhere: that copy wins.
    expect(openWorkspace([at('python', 'desktop', LATER)], { python: { source: 'v2', base: THEN, sending: 'v1' } }, {}).drop).toEqual(['python']);
  });

  it('lets an unsaved edit win when what it was based on is not known', () => {
    expect(openWorkspace([at('python', 'server', LATER)], { python: edit('mine') }, {}).send).toEqual({ python: 'mine' });
  });

  it('ranks several unsaved edits that win with the language last chosen here first', () => {
    const unsaved = { python: edit('p', null), cpp: edit('c', null), go: edit('g', null), rust: edit('r', THEN) };
    expect(openWorkspace([copy('java', 'j')], unsaved, {}, 'go').recent).toEqual(['go', 'cpp', 'python', 'java']);
    expect(openWorkspace([], { python: edit('p', null), cpp: edit('c', null) }, {}, null).recent).toEqual(['cpp', 'python']);
  });

  it('uploads code an older version kept only where the server has none and nothing is unsaved', () => {
    const opened = openWorkspace([copy('python', 'server')], { go: edit('unsaved', null) }, { python: 'old', go: 'old', cpp: 'old' });
    expect(opened.sources).toEqual({ python: 'server', go: 'unsaved', cpp: 'old' });
    expect(opened.send).toEqual({ go: 'unsaved', cpp: 'old' });
    // It has no time, so it is not ranked.
    expect(opened.recent).toEqual(['go', 'python']);
  });
});

describe('describeError', () => {
  it('has a presentation for every code in the contract', () => {
    expect(KNOWN_CODES.size).toBeGreaterThan(0);
    for (const code of KNOWN_CODES) {
      const view = describeError(new ApiError(400, code as ErrorCode, 'server message'));
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

describe('mcpConnection', () => {
  it('builds the endpoint and commands', () => {
    const c = mcpConnection(mcpUrl({ path: '/mcp', url: null }, 'http://localhost:8080/'), false);
    expect(c.url).toBe('http://localhost:8080/mcp');
    expect(c.claudeCommand).toBe('claude mcp add --transport http codeatrophy http://localhost:8080/mcp');
    expect(c.stdioCommand).toBe('npx mcp-remote http://localhost:8080/mcp');
  });

  it('adds a bearer header with a placeholder for the token when one is required', () => {
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
