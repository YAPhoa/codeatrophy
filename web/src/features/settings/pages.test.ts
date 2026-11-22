import { describe, expect, it } from 'vitest';
import { SETTINGS_PAGES, findSettingsPage, movedIntoSettings, movedSettingsPage, settingsLanding } from './pages';

describe('settingsLanding', () => {
  it('goes to the page last open, unless the address names one', () => {
    expect(settingsLanding('', 'account')).toBe('/settings/account');
    expect(settingsLanding('', 'appearance')).toBe('/settings/preferences');
    expect(settingsLanding('#judge', 'account')).toBe('/settings/judge');
    expect(settingsLanding('', 'nonesuch')).toBe('/settings/ai');
    expect(settingsLanding('', null)).toBe('/settings/ai');
  });

  it('opens the first page for /settings on its own', () => {
    expect(settingsLanding('')).toBe('/settings/ai');
    expect(settingsLanding('#')).toBe('/settings/ai');
  });

  it('sends the section links of the old single page to their pages', () => {
    for (const { slug } of SETTINGS_PAGES) expect(settingsLanding(`#${slug}`)).toBe(`/settings/${slug}`);
    expect(settingsLanding('#judge')).toBe('/settings/judge');
  });

  it('sends a section that moved to the page it moved to', () => {
    expect(settingsLanding('#appearance')).toBe('/settings/preferences');
  });

  it('falls back to the first page for an unknown section', () => {
    expect(settingsLanding('#nonesuch')).toBe('/settings/ai');
  });
});

describe('movedSettingsPage', () => {
  it('knows where a retired page went, and nothing about other slugs', () => {
    expect(movedSettingsPage('appearance')).toBe('preferences');
    expect(findSettingsPage('appearance')).toBeUndefined();
    expect(movedSettingsPage('ai')).toBeUndefined();
    expect(movedSettingsPage(undefined)).toBeUndefined();
  });
});

describe('findSettingsPage', () => {
  it('knows each page by its slug only', () => {
    expect(findSettingsPage('styles')?.label).toBe('Writing styles');
    expect(findSettingsPage('Styles')).toBeUndefined();
    expect(findSettingsPage(undefined)).toBeUndefined();
  });
});

describe('movedIntoSettings', () => {
  it('keeps the query string and fragment of the old address', () => {
    expect(movedIntoSettings('export', { search: '?collection=c1&solutions=0', hash: '' })).toBe('/settings/export?collection=c1&solutions=0');
    expect(movedIntoSettings('export', { search: '?item=a&item=b', hash: '#top' })).toBe('/settings/export?item=a&item=b#top');
    expect(movedIntoSettings('import', { search: '', hash: '' })).toBe('/settings/import');
  });
});
