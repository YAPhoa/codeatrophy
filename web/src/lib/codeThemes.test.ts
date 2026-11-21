import { describe, expect, it } from 'vitest';
import tokensCss from '../styles/tokens.css?raw';
import { CHROME_ROLES, CODE_ROLES, CODE_THEMES, codeatrophyTheme, codeThemeCss, roleColor, roleProperty, SYNTAX_ROLES, type CodeColours, type CodeRole } from './codeThemes';

type Mode = 'light' | 'dark';

/** The custom properties a block of tokens.css sets. */
function block(selector: string): Map<string, string> {
  const start = tokensCss.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`no ${selector} in tokens.css`);
  const body = tokensCss.slice(start, tokensCss.indexOf('\n}', start));
  return new Map([...body.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map(([, name = '', value = '']) => [name, value.trim()]));
}

const light = block(':root');
const tokens: Record<Mode, Map<string, string>> = { light, dark: new Map([...light, ...block(":root[data-theme='dark']")]) };

/** A theme's value for a role in one mode, with the app tokens it names looked up in tokens.css. */
function resolve(value: string, mode: Mode, colours: CodeColours, seen: string[] = []): string {
  const name = /^var\((--[\w-]+)\)$/.exec(value.trim())?.[1];
  if (!name) return value.trim();
  if (seen.includes(name)) throw new Error(`a cycle through ${name}`);
  const role = CODE_ROLES.find((r) => roleProperty(r) === name);
  const next = role ? colours[role] : tokens[mode].get(name);
  if (next === undefined) throw new Error(`${name} is not defined for ${mode}`);
  return resolve(next, mode, colours, [...seen, name]);
}

function rgb(color: string): [number, number, number] {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color)?.[1];
  if (!hex) throw new Error(`not a colour the contrast check reads: ${color}`);
  const h = hex.length === 3 ? [...hex].map((c) => c + c).join('') : hex;
  const channel = (i: number) => parseInt(h.slice(i, i + 2), 16);
  return [channel(0), channel(2), channel(4)];
}

function luminance(color: string): number {
  const linear = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  const [r, g, b] = rgb(color);
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

/** The WCAG contrast ratio of two colours. */
function contrast(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

it('the contrast ratio is the one WCAG defines', () => {
  expect(contrast('#000000', '#ffffff')).toBeCloseTo(21, 5);
  expect(contrast('#fff', '#fff')).toBe(1);
  expect(contrast('#767676', '#ffffff')).toBeCloseTo(4.54, 2);
});

/** Each text role with the backgrounds it is drawn on. */
const PAIRS: [CodeRole, CodeRole][] = [
  ...SYNTAX_ROLES.flatMap((role): [CodeRole, CodeRole][] => [
    [role, 'background'],
    [role, 'activeLine'],
    [role, 'blockBackground'],
  ]),
  ['gutterText', 'gutterBackground'],
  ['activeLineGutterText', 'activeLineGutter'],
  ['activeLineGutterText', 'activeLine'],
  ['foldPlaceholderText', 'foldPlaceholder'],
  ['placeholder', 'background'],
  ['cursor', 'background'],
];

describe.each(CODE_THEMES.map((theme) => [theme.name, theme] as const))('code theme %s', (_, theme) => {
  it.each(['light', 'dark'] as const)('defines every role, and nothing else, in %s', (mode) => {
    const colours = theme[mode];
    expect(Object.keys(colours).sort()).toEqual([...CODE_ROLES].sort());
    for (const role of CODE_ROLES) expect(colours[role].trim(), role).not.toBe('');
  });

  it.each(['light', 'dark'] as const)('keeps every text role at 4.5:1 or more on its backgrounds in %s', (mode) => {
    const colours = theme[mode];
    const low = PAIRS.map(([fg, bg]) => ({ fg, bg, ratio: contrast(resolve(colours[fg], mode, colours), resolve(colours[bg], mode, colours)) }))
      .filter(({ ratio }) => ratio < 4.5)
      .map(({ fg, bg, ratio }) => `${fg} on ${bg}: ${ratio.toFixed(2)}`);
    expect(low).toEqual([]);
  });
});

it('a theme becomes one custom property per role, for light and for dark', () => {
  const theme = codeatrophyTheme;
  const css = codeThemeCss(theme);
  const [lightPart = '', darkPart = ''] = css.split(":root[data-theme='dark']");
  expect(lightPart.startsWith(':root {')).toBe(true);
  for (const role of CODE_ROLES) {
    expect(lightPart).toContain(`${roleProperty(role)}: ${theme.light[role]};`);
    expect(darkPart).toContain(`${roleProperty(role)}: ${theme.dark[role]};`);
  }
  expect(roleProperty('operatorWord')).toBe('--code-operator-word');
  expect(roleColor('gutterText')).toBe('var(--code-gutter-text)');
  expect(CHROME_ROLES).toContain('background');
});
