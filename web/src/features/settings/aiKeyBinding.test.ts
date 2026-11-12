import { describe, expect, it } from 'vitest';
import { hostOf, movesToAnotherServer, originOf } from './aiKeyBinding';

describe('originOf', () => {
  it('reads scheme, host and port', () => {
    expect(originOf('https://api.openai.com/v1')).toBe('https://api.openai.com');
    expect(originOf(' http://localhost:11434/v1 ')).toBe('http://localhost:11434');
    expect(originOf('HTTPS://API.OpenAI.com/v1/')).toBe('https://api.openai.com');
  });

  it('is null for anything that is not an absolute http(s) URL', () => {
    expect(originOf('')).toBeNull();
    expect(originOf(null)).toBeNull();
    expect(originOf('api.openai.com/v1')).toBeNull();
    expect(originOf('ftp://example.com')).toBeNull();
  });
});

describe('movesToAnotherServer', () => {
  it('is false for a different path on the same server', () => {
    expect(movesToAnotherServer('https://api.openai.com/v1', 'https://api.openai.com/v2')).toBe(false);
    expect(movesToAnotherServer('https://api.openai.com/v1', 'https://api.openai.com:443/v1')).toBe(false);
  });

  it('is true for another host, port or scheme', () => {
    expect(movesToAnotherServer('https://api.openai.com/v1', 'https://openrouter.ai/api/v1')).toBe(true);
    expect(movesToAnotherServer('http://localhost:11434/v1', 'http://localhost:1234/v1')).toBe(true);
    expect(movesToAnotherServer('http://gateway.example/v1', 'https://gateway.example/v1')).toBe(true);
  });

  it('does not react to text that is not a URL yet', () => {
    expect(movesToAnotherServer('https://api.openai.com/v1', 'openrouter')).toBe(false);
    expect(movesToAnotherServer('https://api.openai.com/v1', '')).toBe(false);
    expect(movesToAnotherServer(null, 'https://openrouter.ai/api/v1')).toBe(false);
  });
});

describe('hostOf', () => {
  it('shows the host and port', () => {
    expect(hostOf('http://localhost:11434/v1')).toBe('localhost:11434');
    expect(hostOf('https://api.openai.com/v1')).toBe('api.openai.com');
    expect(hostOf('not a url')).toBe('not a url');
  });
});
