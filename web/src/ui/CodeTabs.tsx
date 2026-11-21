import { Children, isValidElement, useId, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { languageName } from '../lib/languages';
import { readString, writeString } from '../lib/storage';
import { cx } from './Button';

// The same code in several languages, one tab each (`codeTabs` in
// markdownPlugins.ts). The language picked in one group is picked in every
// group on the page that has it, and remembered for the next visit.

const STORAGE_KEY = 'code-tab-language';

/** Picked on this page; it holds even where storage does not. */
let picked: string | null = null;
const listeners = new Set<() => void>();

const preferredLanguage = (): string | null => picked ?? readString(STORAGE_KEY);

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

function pickLanguage(language: string): void {
  picked = language;
  writeString(STORAGE_KEY, language);
  for (const listener of listeners) listener();
}

/** A label per tab: the language's name, with repeats numbered ("Python", "Python 2"). */
export function tabLabels(languages: readonly string[]): string[] {
  const seen = new Map<string, number>();
  return languages.map((language) => {
    const n = (seen.get(language) ?? 0) + 1;
    seen.set(language, n);
    return n === 1 ? languageName(language) : `${languageName(language)} ${n}`;
  });
}

/**
 * The tab shown: the one picked in this group, unless the language picked
 * last on the page is another one this group has; then its first tab of it.
 */
export function selectedTab(languages: readonly string[], own: number | null, preferred: string | null): number {
  const mine = own !== null && own >= 0 && own < languages.length ? own : 0;
  if (preferred === null || languages[mine] === preferred) return mine;
  const i = languages.indexOf(preferred);
  return i === -1 ? mine : i;
}

/** The tab a key moves to (the arrows wrap around), or null for a key the tabs leave alone. */
export function tabKey(key: string, current: number, count: number): number | null {
  if (count === 0) return null;
  switch (key) {
    case 'ArrowRight':
      return (current + 1) % count;
    case 'ArrowLeft':
      return (current - 1 + count) % count;
    case 'Home':
      return 0;
    case 'End':
      return count - 1;
    default:
      return null;
  }
}

export function CodeTabs({ languages, children }: { languages: readonly string[]; children: ReactNode }) {
  const panels = Children.toArray(children).filter(isValidElement);
  const ids = panels.map((_, i) => languages[i] ?? '');
  const base = useId();
  const preferred = useSyncExternalStore(subscribe, preferredLanguage, preferredLanguage);
  const [own, setOwn] = useState<number | null>(null);
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);
  const selected = selectedTab(ids, own, preferred);
  const labels = tabLabels(ids);

  const pick = (i: number) => {
    setOwn(i);
    const language = ids[i];
    if (language) pickLanguage(language);
  };

  return (
    <div className={cx('md-code-tabs', selected === 0 && 'is-first')}>
      <div
        role="tablist"
        aria-label="Language"
        className="md-code-tabs-list"
        onKeyDown={(e) => {
          const next = tabKey(e.key, selected, panels.length);
          if (next === null) return;
          e.preventDefault();
          pick(next);
          tabs.current[next]?.focus();
        }}
      >
        {labels.map((label, i) => (
          <button
            key={i}
            ref={(el) => {
              tabs.current[i] = el;
            }}
            type="button"
            role="tab"
            id={`${base}-tab-${i}`}
            aria-selected={i === selected}
            aria-controls={`${base}-panel-${i}`}
            tabIndex={i === selected ? 0 : -1}
            className={cx('md-code-tab', i === selected && 'is-selected')}
            onClick={() => pick(i)}
          >
            {label}
          </button>
        ))}
      </div>
      {panels.map((panel, i) => (
        <div key={i} role="tabpanel" id={`${base}-panel-${i}`} aria-labelledby={`${base}-tab-${i}`} tabIndex={0} hidden={i !== selected} className="md-code-tabs-panel">
          {panel}
        </div>
      ))}
    </div>
  );
}
