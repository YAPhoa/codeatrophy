import type { VariantMode } from '../../api/types';

export interface VariantModeInfo {
  mode: VariantMode;
  label: string;
  /** One line for menus and compact buttons. */
  short: string;
  /** A sentence for the chooser. */
  description: string;
}

export const VARIANT_MODES: readonly VariantModeInfo[] = [
  {
    mode: 'similar',
    label: 'Similar',
    short: 'Same idea, new setting',
    description: 'The same technique at the same difficulty, with a different story and different data.',
  },
  {
    mode: 'easier',
    label: 'Easier',
    short: 'Gentler warm-up',
    description: 'A simpler version with smaller limits or a relaxed requirement, for when the original is too hard.',
  },
  {
    mode: 'harder',
    label: 'Harder',
    short: 'Higher bar',
    description: 'Tighter limits or an added requirement, for when the original feels too easy.',
  },
  {
    mode: 'twist',
    label: 'Twist',
    short: 'One changed rule',
    description: 'One rule changes, so your usual approach no longer works.',
  },
];

export function isVariantMode(value: string | null): value is VariantMode {
  return value === 'similar' || value === 'easier' || value === 'harder' || value === 'twist';
}
