import type { StylePreset } from '../api/types';

/** What a style picker holds: a preset id, or `null` for the built-in conventions only. */
export type StyleChoice = string | null;

/**
 * The choice to show in a picker. `undefined` means the user has not chosen
 * yet, which resolves to the default preset (or none). A remembered preset
 * that has since been deleted falls back the same way; an explicit `null`
 * ("no style") is always respected.
 */
export function resolveStyleChoice(choice: StyleChoice | undefined, styles: readonly StylePreset[]): StyleChoice {
  if (choice === null) return null;
  if (choice !== undefined && styles.some((s) => s.id === choice)) return choice;
  return styles.find((s) => s.isDefault)?.id ?? null;
}
