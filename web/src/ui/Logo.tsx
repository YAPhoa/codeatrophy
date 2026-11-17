import logo24 from './logo/logo-24.svg?raw';
import logo32 from './logo/logo-32.svg?raw';
import logo64 from './logo/logo-64.svg?raw';
import { cx } from './Button';

const SOURCES = { 24: logo24, 32: logo32, 64: logo64 } as const;

/**
 * The pixel-art mark. Each size is drawn on its own pixel grid, so use it only
 * at that size. It is inline rather than an <img> so its colours follow the
 * theme's --logo-* tokens. It is decorative: give the name in text beside it.
 */
export function Logo({ size = 24, className }: { size?: keyof typeof SOURCES; className?: string }) {
  return <span className={cx('logo', className)} aria-hidden="true" dangerouslySetInnerHTML={{ __html: SOURCES[size] }} />;
}
