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
