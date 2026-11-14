import { parseWholeNumber } from '../../ui/Field';

/** What was typed into the request timeout: a number of seconds to save, or why it cannot be. */
export type TimeoutEntry = { seconds: number; error?: undefined } | { seconds?: undefined; error: string };

/** Read a typed request timeout: a whole number of seconds from `min` to `max`. */
export function readTimeout(text: string, min: number, max: number): TimeoutEntry {
  const seconds = parseWholeNumber(text, min, max);
  return seconds == null ? { error: `Between ${min} and ${max}.` } : { seconds };
}
