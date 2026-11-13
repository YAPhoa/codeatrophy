import { describe, expect, it } from 'vitest';
import { SETTINGS_PAGES, findSettingsPage, movedSettingsPage, settingsLanding } from './pages';

describe('settingsLanding', () => {
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
