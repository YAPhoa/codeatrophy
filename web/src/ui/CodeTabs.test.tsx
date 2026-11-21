import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { installLocalStorage, withFakeLocalStorage } from '../test/fakeStorage';
import { CodeTabs, selectedTab, tabKey, tabLabels } from './CodeTabs';

// Unit tests run without a DOM, so clicks and keys are tested on the pure
// functions the tabs run on; e2e/markdown.spec.ts drives the tabs themselves.

describe('tabLabels', () => {
  it('names each language and numbers its repeats', () => {
    expect(tabLabels(['cpp', 'python', 'csharp', 'python', 'python', 'sql'])).toEqual(['C++', 'Python', 'C#', 'Python 2', 'Python 3', 'sql']);
  });
});

describe('selectedTab', () => {
  const group = ['cpp', 'java', 'python', 'java'];

  it('starts on the first tab, or on the language picked last if the group has it', () => {
    expect(selectedTab(group, null, null)).toBe(0);
    expect(selectedTab(group, null, 'python')).toBe(2);
    expect(selectedTab(group, null, 'java')).toBe(1);
    expect(selectedTab(group, null, 'rust')).toBe(0);
  });

  it('keeps its own pick until another language it has is picked elsewhere', () => {
    expect(selectedTab(group, 3, 'java')).toBe(3);
    expect(selectedTab(group, 3, 'rust')).toBe(3);
    expect(selectedTab(group, 3, 'cpp')).toBe(0);
    expect(selectedTab(group, 9, null)).toBe(0);
  });
});

describe('tabKey', () => {
  it('moves with the arrows, wrapping round, and to either end with Home and End', () => {
    expect(tabKey('ArrowRight', 0, 3)).toBe(1);
    expect(tabKey('ArrowRight', 2, 3)).toBe(0);
    expect(tabKey('ArrowLeft', 0, 3)).toBe(2);
    expect(tabKey('Home', 2, 3)).toBe(0);
    expect(tabKey('End', 0, 3)).toBe(2);
  });

  it('leaves other keys alone', () => {
    for (const key of ['ArrowDown', 'ArrowUp', 'Enter', ' ', 'Tab']) expect(tabKey(key, 1, 3)).toBeNull();
  });
});

describe('CodeTabs', () => {
  const draw = () =>
    renderToStaticMarkup(
      <CodeTabs languages={['cpp', 'python']}>
        <pre>a</pre>
        <pre>b</pre>
      </CodeTabs>,
    );
  const shown = (html: string) => html.match(/aria-selected="true"[^>]*>([^<]*)</)?.[1];

  describe('with storage', () => {
    withFakeLocalStorage();

    it('opens on the language remembered from an earlier visit', () => {
      localStorage.setItem('codeatrophy:code-tab-language', 'python');
      expect(shown(draw())).toBe('Python');
      localStorage.setItem('codeatrophy:code-tab-language', 'rust');
      expect(shown(draw())).toBe('C++');
    });
  });

  it('draws without storage, on the first tab', () => {
    expect(shown(draw())).toBe('C++');
    const broken = installLocalStorage();
    broken.getItem = () => {
      throw new Error('denied');
    };
    expect(shown(draw())).toBe('C++');
  });
});
