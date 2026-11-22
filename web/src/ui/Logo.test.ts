import { describe, expect, it } from 'vitest';
import readmeDark from '../../../docs/images/logo-dark.svg?raw';
import readmeLight from '../../../docs/images/logo-light.svg?raw';
import tokensCss from '../styles/tokens.css?raw';
import logo64 from './logo/logo-64.svg?raw';

/** The custom properties a block of tokens.css sets. */
function block(selector: string): Map<string, string> {
  const start = tokensCss.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`no ${selector} in tokens.css`);
  const body = tokensCss.slice(start, tokensCss.indexOf('\n}', start));
  return new Map([...body.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map(([, name = '', value = '']) => [name, value.trim()]));
}

/** The logo as a file of its own: each colour it takes from the theme, written out. */
function standalone(tokens: Map<string, string>): string {
  return logo64.replace(/var\((--[\w-]+)(?:,(?:[^()]|\([^()]*\))*)?\)/g, (_, name: string) => {
    let value = tokens.get(name);
    for (let ref; value !== undefined && (ref = /^var\((--[\w-]+)\)$/.exec(value)); ) value = tokens.get(ref[1] ?? '');
    if (value === undefined) throw new Error(`${name} is not defined`);
    return value;
  });
}

describe('the logo in README.md', () => {
  // GitHub shows an image file, where the theme's tokens do not reach, so
  // docs/images holds the 64px logo with each theme's colours written out.
  const light = block(':root');
  const dark = new Map([...light, ...block(":root[data-theme='dark']")]);

  it('is the app’s logo in the light theme’s colours', () => {
    expect(readmeLight).toBe(standalone(light));
  });

  it('is the app’s logo in the dark theme’s colours', () => {
    expect(readmeDark).toBe(standalone(dark));
  });
});
