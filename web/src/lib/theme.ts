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

function apply(): void {
  document.documentElement.dataset.theme = resolveTheme(getThemePreference());
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
