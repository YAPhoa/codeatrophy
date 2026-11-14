import { describe, expect, it } from 'vitest';
import { readTimeout } from './aiTimeout';

describe('readTimeout', () => {
  it('takes a whole number of seconds inside the limits, ends included', () => {
    expect(readTimeout('120', 10, 300)).toEqual({ seconds: 120 });
    expect(readTimeout(' 10 ', 10, 300)).toEqual({ seconds: 10 });
    expect(readTimeout('300', 10, 300)).toEqual({ seconds: 300 });
  });

  it('names the limits for anything else', () => {
    for (const text of ['9', '301', '0', '-30', '60.5', '1e2', '', '  ', 'abc']) {
      expect(readTimeout(text, 10, 300)).toEqual({ error: 'Between 10 and 300.' });
    }
    expect(readTimeout('5', 30, 90)).toEqual({ error: 'Between 30 and 90.' });
  });
});
