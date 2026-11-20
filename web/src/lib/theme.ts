import { useSyncExternalStore } from 'react';
import { readString, writeString } from './storage';

export type ThemePreference = 'system' | 'light' | 'dark';

const KEY = 'theme';
const listeners = new Set<() => void>();

function systemDark(): boolean {
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)').matches === true;
}

export function getThemePreference(): ThemePreference {
  const v = readString(KEY);
  return v === 'light' || v === 'dark' ? v : 'system';
}

export function resolveTheme(pref: ThemePreference): 'light' | 'dark' {
  return pref === 'system' ? (systemDark() ? 'dark' : 'light') : pref;
}

/** The page background (`--bg`) of each theme, for the browser's own chrome. */
const THEME_COLOR = { light: '#f3f6f4', dark: '#0f141c' } as const;

function apply(): void {
  const theme = resolveTheme(getThemePreference());
  document.documentElement.dataset.theme = theme;
  // The tags in index.html follow the OS setting; a theme chosen in the app overrides it.
  document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]').forEach((meta) => {
    meta.content = THEME_COLOR[theme];
  });
}

export function setThemePreference(pref: ThemePreference): void {
  writeString(KEY, pref);
  apply();
  listeners.forEach((fn) => fn());
}

/** Apply the stored theme and keep following the OS setting while on "system". */
export function initTheme(): void {
  apply();
  window.matchMedia?.('(prefers-color-scheme: dark)').addEventListener('change', () => {
    apply();
    listeners.forEach((fn) => fn());
  });
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function useThemePreference(): ThemePreference {
  return useSyncExternalStore(subscribe, getThemePreference);
}

function appliedTheme(): 'light' | 'dark' {
  return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
}

/** The theme the page is drawn in now, for parts that cannot follow the CSS tokens by themselves. */
export function useAppliedTheme(): 'light' | 'dark' {
  return useSyncExternalStore(subscribe, appliedTheme, () => 'light');
}
