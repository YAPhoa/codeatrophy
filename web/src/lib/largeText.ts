// Test data can run to megabytes: a generated large test case holds up to
// `limits.maxLargeInputBytes` of input, and a stored case up to
// `limits.maxTestDataBytes`. Text that size is never put into an editor, a
// textarea or the page; it is kept out of sight, with its size and a way to
// download it.

import { formatBytes } from './format';

/**
 * From this size on, test data is not shown and cannot be edited in place. Well above anything typed by hand, below the 64 KiB at which the
 * server cuts the streams of a submission result.
 */
export const LARGE_TEXT_BYTES = 32 * 1024;

const encoder = new TextEncoder();

/** Size in bytes once encoded as UTF-8, without encoding a text that is clearly small or clearly large. */
export function isLargeText(text: string, threshold = LARGE_TEXT_BYTES): boolean {
  // A UTF-16 code unit takes one to three bytes in UTF-8.
  if (text.length >= threshold) return true;
  if (text.length * 3 < threshold) return false;
  return encoder.encode(text).length >= threshold;
}

export interface TextStats {
  bytes: number;
  lines: number;
}

/** Size and number of lines of a text; a final newline does not start another line. */
export function textStats(text: string): TextStats {
  let lines = 0;
  let at = text.indexOf('\n');
  while (at !== -1) {
    lines++;
    at = text.indexOf('\n', at + 1);
  }
  if (text !== '' && !text.endsWith('\n')) lines++;
  return { bytes: encoder.encode(text).length, lines };
}

/** "179 KB · 30,001 lines". */
export function describeTextSize(stats: TextStats): string {
  return `${formatBytes(stats.bytes)} · ${stats.lines.toLocaleString('en')} ${stats.lines === 1 ? 'line' : 'lines'}`;
}

/** A file name for downloaded test data: "two-sum-large-case-input.txt". */
export function textFilename(...parts: string[]): string {
  const slug = parts
    .join(' ')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
    .replace(/-+$/, '');
  return `${slug || 'test-data'}.txt`;
}
