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
    description: 'The same technique at the same difficulty, in a different story with different data. Checks that you learned the idea rather than the answer.',
  },
  {
    mode: 'easier',
    label: 'Easier',
    short: 'A gentler warm-up',
    description: 'A simplified version — smaller limits or a relaxed requirement. A stepping stone if the original felt out of reach.',
  },
  {
    mode: 'harder',
    label: 'Harder',
    short: 'Raise the bar',
    description: 'Tighter limits or an added requirement. For when the original has become comfortable.',
  },
  {
    mode: 'twist',
    label: 'Twist',
    short: 'Change one rule',
    description: 'One rule changes so that the approach you know no longer works as it is. Practise adapting, not recalling.',
  },
];

export function isVariantMode(value: string | null): value is VariantMode {
  return value === 'similar' || value === 'easier' || value === 'harder' || value === 'twist';
}
