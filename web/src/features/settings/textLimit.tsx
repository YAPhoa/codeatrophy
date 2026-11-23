// The length of a long text a setting keeps (a writing style's instructions,
// a system prompt) against its limit, which is never cut to fit.

import { cx } from '../../ui/Button';

/** "1,234 / 16,384", marked once the text is over. */
export function CharCount({ count, max }: { count: number; max: number }) {
  return (
    <span className={cx('style-count', count > max && 'is-over')}>
      {count.toLocaleString()} / {max.toLocaleString()}
    </span>
  );
}

/** What a text `count` characters long says when it is over `max`. */
export const overLimitMessage = (count: number, max: number): string => `${(count - max).toLocaleString()} over the limit. Shorten it; nothing is cut off automatically.`;
