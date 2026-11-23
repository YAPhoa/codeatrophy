// Text measured as the server measures it.

/** Length as the server counts it: in Unicode code points. */
export const charCount = (s: string): number => {
  let n = 0;
  for (const _ of s) n++;
  return n;
};

const encoder = new TextEncoder();
/** Size in bytes once encoded as UTF-8. */
export const byteLength = (s: string): number => encoder.encode(s).length;

// The control characters (Unicode category Cc, what Go's unicode.IsControl
// reports): C0, DEL and C1.
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const CONTROL_EXCEPT_TAB_NEWLINE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/;
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const NOT_SINGLE_LINE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

/** Whether `s` holds a control character other than newline and tab: the server's `domain.HasDisallowedControl`. */
export const hasDisallowedControl = (s: string): boolean => CONTROL_EXCEPT_TAB_NEWLINE.test(s);

/**
 * Whether `s` holds no control character, tab and newline included, and no
 * Unicode line or paragraph separator (U+2028, U+2029): the server's
 * `domain.IsSingleLine`.
 */
export const isSingleLine = (s: string): boolean => !NOT_SINGLE_LINE.test(s);
