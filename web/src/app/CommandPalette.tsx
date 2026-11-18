import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Link, useNavigate } from 'react-router';
import { Download, Folder, Library, Moon, Plus, Search, Settings, Sun, Tags, Upload } from 'lucide-react';
import { useCollections, useItemQuery } from '../api/queries';
import { TypeIcon } from '../features/item/controls';
import { useNewItemHref } from '../lib/newItem';
import { resolveTheme, setThemePreference, getThemePreference } from '../lib/theme';
import { cx } from '../ui/Button';
import { Spinner } from '../ui/misc';
import { exitOnRemove } from '../lib/motion';

interface Entry {
  key: string;
  icon: ReactNode;
  label: string;
  hint?: string;
  /** Other words a command is found by, besides its label. */
  keywords?: string;
  run: () => void;
  /** Where the entry goes, when it is a destination: lets it be opened in a new tab. */
  to?: string;
}

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = window.setTimeout(() => setV(value), ms);
    return () => window.clearTimeout(t);
  }, [value, ms]);
  return v;
}

/** A run of entries, under a label when it has one. */
interface Section {
  key: string;
  label?: string;
  entries: Entry[];
}

/** Quick switcher: type to find items and collections, or run a command. */
export function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  if (!open) return null;
  return <PaletteBody onClose={onClose} />;
}

function PaletteBody({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const newHref = useNewItemHref();
  const [text, setText] = useState('');
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLUListElement>(null);
  const q = useDebounced(text.trim(), 160);
  const items = useItemQuery({ q, sort: 'relevance', limit: 8 }, q.length > 0);
  const recent = useItemQuery({ sort: 'updated', limit: 6 }, q.length === 0);
  const collections = useCollections();

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    return () => opener?.focus?.();
  }, []);

  const sections = useMemo<Section[]>(() => {
    const go = (to: string) => ({ to, run: () => navigate(to) });
    const needle = text.trim().toLowerCase();
    const commands: Entry[] = [
      { key: 'new', icon: <Plus size={16} />, label: 'New item', hint: 'C', keywords: 'capture', ...go(newHref) },
      { key: 'lib', icon: <Library size={16} />, label: 'Go to library', ...go('/') },
      { key: 'tags', icon: <Tags size={16} />, label: 'Manage tags', ...go('/tags') },
      { key: 'import', icon: <Upload size={16} />, label: 'Import a bundle', ...go('/settings/import') },
      { key: 'export', icon: <Download size={16} />, label: 'Export', ...go('/settings/export') },
      { key: 'settings', icon: <Settings size={16} />, label: 'Settings', ...go('/settings') },
      {
        key: 'theme',
        icon: resolveTheme(getThemePreference()) === 'dark' ? <Sun size={16} /> : <Moon size={16} />,
        label: resolveTheme(getThemePreference()) === 'dark' ? 'Switch to light theme' : 'Switch to dark theme',
        keywords: 'theme light dark',
        run: () => setThemePreference(resolveTheme(getThemePreference()) === 'dark' ? 'light' : 'dark'),
      },
    ].filter((c) => `${c.label} ${c.keywords ?? ''}`.toLowerCase().includes(needle));

    const itemEntries: Entry[] = ((needle ? items.data : recent.data)?.items ?? []).map((it) => ({
      key: `item-${it.id}`,
      icon: <TypeIcon type={it.type} />,
      label: it.title,
      hint: it.tags.slice(0, 2).join(' · ') || undefined,
      ...go(`/items/${it.id}`),
    }));

    const collectionEntries: Entry[] = needle
      ? (collections.data ?? [])
          .filter((c) => c.name.toLowerCase().includes(needle))
          .slice(0, 5)
          .map((c) => ({ key: `col-${c.id}`, icon: <Folder size={16} />, label: c.name, hint: 'Collection', ...go(`/collections/${c.id}`) }))
      : [];

    const searchAll: Entry[] = needle
      ? [{ key: 'search-all', icon: <Search size={16} />, label: `Search the library for “${text.trim()}”`, ...go(`/?q=${encodeURIComponent(text.trim())}`) }]
      : [];

    // With nothing typed, only New item and the recent items; the other commands wait to be typed.
    if (!needle)
      return [
        { key: 'commands', entries: commands.filter((c) => c.key === 'new') },
        { key: 'recent', label: 'Recent', entries: itemEntries },
      ].filter((s) => s.entries.length > 0);
    return [{ key: 'results', entries: [...itemEntries, ...collectionEntries, ...searchAll, ...commands] }];
  }, [text, items.data, recent.data, collections.data, navigate, newHref]);

  const entries = useMemo(() => sections.flatMap((s) => s.entries), [sections]);

  useEffect(() => setActive(0), [text]);

  useEffect(() => {
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const run = (entry: Entry | undefined) => {
    if (!entry) return;
    onClose();
    entry.run();
  };

  const body = (entry: Entry) => (
    <>
      <span className="palette-icon" aria-hidden="true">
        {entry.icon}
      </span>
      <span className="grow truncate">{entry.label}</span>
      {entry.hint && <span className="palette-hint">{entry.hint}</span>}
    </>
  );

  const option = (entry: Entry) => {
    const i = entries.indexOf(entry);
    return (
      <li
        key={entry.key}
        id={`palette-${entry.key}`}
        role="option"
        aria-selected={i === active}
        className={cx('palette-item', i === active && 'is-active')}
        onMouseMove={() => setActive(i)}
        onClick={() => run(entry)}
      >
        {entry.to !== undefined ? (
          <Link
            to={entry.to}
            tabIndex={-1}
            className="palette-link"
            onClick={(e) => {
              // A plain click is the option's own; with a modifier the browser opens the link in a new tab.
              if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) e.stopPropagation();
              else e.preventDefault();
            }}
          >
            {body(entry)}
          </Link>
        ) : (
          body(entry)
        )}
      </li>
    );
  };

  return createPortal(
    <div
      ref={exitOnRemove}
      className="dialog-backdrop palette-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div role="dialog" aria-modal="true" aria-label="Search and commands" className="palette">
        <div className="palette-input">
          <Search size={16} aria-hidden="true" />
          <input
            name="palette-search"
            autoComplete="off"
            spellCheck={false}
            autoFocus
            role="combobox"
            aria-expanded="true"
            aria-controls="palette-list"
            aria-activedescendant={entries[active] ? `palette-${entries[active].key}` : undefined}
            aria-label="Search items, collections and commands"
            placeholder="Search items, collections, commands…"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setActive((i) => Math.min(entries.length - 1, i + 1));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setActive((i) => Math.max(0, i - 1));
              } else if (e.key === 'Enter') {
                e.preventDefault();
                run(entries[active]);
              } else if (e.key === 'Escape' || e.key === 'Tab') {
                e.preventDefault();
                onClose();
              }
            }}
          />
          {items.isFetching && q.length > 0 && <Spinner size={14} label="Searching…" />}
        </div>
        <ul id="palette-list" role="listbox" aria-label="Results" className="palette-list" ref={listRef}>
          {sections.map((section) =>
            section.label ? (
              <li key={section.key} role="group" aria-labelledby={`palette-group-${section.key}`} className="palette-group">
                <div id={`palette-group-${section.key}`} role="presentation" className="palette-group-label">
                  {section.label}
                </div>
                <ul role="none">{section.entries.map(option)}</ul>
              </li>
            ) : (
              section.entries.map(option)
            ),
          )}
          {entries.length === 0 && <li className="palette-empty">Nothing matches.</li>}
        </ul>
        {text.trim() === '' && <p className="palette-footer">Type to find items, collections and commands</p>}
      </div>
    </div>,
    document.body,
  );
}
