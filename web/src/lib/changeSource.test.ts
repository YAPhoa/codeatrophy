import { describe, expect, it } from 'vitest';
import type { ChangeSource } from '../api/types';
import { changeSourceLine, changeSourceText } from './changeSource';

const http = (model: string | null = null): ChangeSource => ({ via: 'http', client: null, model });
const mcp = (client: string | null, model: string | null): ChangeSource => ({ via: 'mcp', client, model });
const imported: ChangeSource = { via: 'import', client: null, model: null };

describe('changeSourceText', () => {
  it('says nothing when neither is known', () => {
    expect(changeSourceText(null, null)).toBe('');
    expect(changeSourceText(undefined, undefined)).toBe('');
    expect(changeSourceLine(null, null)).toEqual([]);
  });

  it('says nothing for an item written and changed by hand', () => {
    expect(changeSourceText(http(), http())).toBe('');
    expect(changeSourceText(http(), null)).toBe('');
  });

  it('names the model of an AI draft saved in the UI, without "via web"', () => {
    expect(changeSourceText(http('gpt-5'), http('gpt-5'))).toBe('Created by gpt-5');
  });

  it('names the model and the client of an item created over MCP', () => {
    expect(changeSourceText(mcp('claude-code', 'claude-opus-5-5'), null)).toBe('Created by claude-opus-5-5 via claude-code');
    expect(changeSourceText(mcp('claude-code', null), null)).toBe('Created via claude-code');
    expect(changeSourceText(mcp(null, 'claude-opus-5-5'), null)).toBe('Created by claude-opus-5-5 via MCP');
    expect(changeSourceText(mcp(null, null), null)).toBe('Created via MCP');
  });

  it('says an imported item was imported', () => {
    expect(changeSourceText(imported, imported)).toBe('Imported');
  });

  it('adds the last change when it says something new', () => {
    expect(changeSourceText(mcp('claude-code', 'claude-opus-5-5'), http())).toBe('Created by claude-opus-5-5 via claude-code · updated by you');
    expect(changeSourceText(imported, http('gpt-5'))).toBe('Imported · updated by gpt-5');
    expect(changeSourceText(http('gpt-5'), mcp('cursor', null))).toBe('Created by gpt-5 · updated via cursor');
    expect(changeSourceText(imported, mcp(null, 'm'))).toBe('Imported · updated by m via MCP');
    expect(changeSourceText(mcp('claude-code', 'a'), mcp('claude-code', 'b'))).toBe('Created by a via claude-code · updated by b via claude-code');
    expect(changeSourceText(http('gpt-5'), imported)).toBe('Created by gpt-5 · updated by import');
  });

  it('skips the last change when it is the creation again', () => {
    expect(changeSourceText(mcp('claude-code', 'claude-opus-5-5'), mcp('claude-code', 'claude-opus-5-5'))).toBe('Created by claude-opus-5-5 via claude-code');
  });

  it('says an edit by hand only after an AI or an import', () => {
    expect(changeSourceText(imported, http())).toBe('Imported · updated by you');
    expect(changeSourceText(http('claude-opus-5-5'), http())).toBe('Created by claude-opus-5-5 · updated by you');
    expect(changeSourceText(http(), http())).toBe('');
  });

  it('capitalises the last change when the creation says nothing', () => {
    expect(changeSourceText(http(), mcp('claude-code', 'claude-opus-5-5'))).toBe('Updated by claude-opus-5-5 via claude-code');
    expect(changeSourceText(null, http())).toBe('');
    expect(changeSourceText(http(), imported)).toBe('Updated by import');
    expect(changeSourceText(null, http('gpt-5'))).toBe('Updated by gpt-5');
  });

  it('treats blank strings as missing and ignores what is not a change source', () => {
    expect(changeSourceText(mcp(' ', ''), null)).toBe('Created via MCP');
    expect(changeSourceText({ via: 'fax' } as unknown as ChangeSource, http('gpt-5'))).toBe('Updated by gpt-5');
    expect(changeSourceText('x' as unknown as ChangeSource, null)).toBe('');
  });
});

describe('changeSourceLine', () => {
  it('marks the model and the client as values, the wording as text', () => {
    expect(changeSourceLine(mcp('claude-code', 'claude-opus-5-5'), http())).toEqual([
      { text: 'Created by ' },
      { text: 'claude-opus-5-5', value: true },
      { text: ' via ' },
      { text: 'claude-code', value: true },
      { text: ' · ' },
      { text: 'updated by you' },
    ]);
  });

  it('keeps a value that looks like markup as it is', () => {
    expect(changeSourceLine(http('<b>x</b>'), null)).toEqual([{ text: 'Created by ' }, { text: '<b>x</b>', value: true }]);
  });
});
