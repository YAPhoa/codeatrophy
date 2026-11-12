import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { ArrowLeft, ExternalLink, MoreHorizontal, NotebookPen, Pencil, X } from 'lucide-react';
import { useCollections } from '../../api/queries';
import type { Item } from '../../api/types';
import { absoluteTime, plural, readingMinutes, relativeTime } from '../../lib/format';
import { readJson, writeJson } from '../../lib/storage';
import { Button, IconButton, LinkButton, cx } from '../../ui/Button';
import { Markdown } from '../../ui/Markdown';
import { MenuButton } from '../../ui/Popover';
import { Callout } from '../../ui/misc';
import { useCollectionActions } from '../collections/CollectionActions';
import { CollectionPicker, DifficultyBadge, FavoriteButton, StatusControl, TagChips } from '../item/controls';
import { libraryHref, useItemActions } from '../item/itemActions';
import { Notes } from '../item/Notes';
import { Related } from '../item/Related';

interface Heading {
  id: string;
  text: string;
  level: number;
}

/** Collect the rendered headings for the table of contents, and track the one being read. */
function useOutline(containerRef: React.RefObject<HTMLElement | null>, source: string) {
  const [headings, setHeadings] = useState<Heading[]>([]);
  const [active, setActive] = useState<string | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const collect = () => {
      const nodes = Array.from(el.querySelectorAll<HTMLElement>('h1[id], h2[id], h3[id]'));
      setHeadings(nodes.map((n) => ({ id: n.id, text: n.textContent ?? '', level: Number(n.tagName.slice(1)) })));
    };
    collect();
    // The Markdown renderer loads lazily; pick the headings up when they appear.
    const mo = new MutationObserver(collect);
    mo.observe(el, { childList: true, subtree: true });
    return () => mo.disconnect();
  }, [containerRef, source]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el || headings.length === 0) return;
    const io = new IntersectionObserver(
      (entries) => {
        const visible = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible[0]) setActive(visible[0].target.id);
      },
      { rootMargin: '0px 0px -70% 0px' },
    );
    for (const h of headings) {
      const node = document.getElementById(h.id);
      if (node) io.observe(node);
    }
    return () => io.disconnect();
  }, [containerRef, headings]);

  return { headings, active };
}

/** A reading: long-form text in a comfortable column, with an outline and private notes alongside. */
export function ReaderView({ item }: { item: Item }) {
  const { data: collections = [] } = useCollections();
  const actions = useItemActions(item);
  const collectionActions = useCollectionActions();
  const articleRef = useRef<HTMLElement>(null);
  const { headings, active } = useOutline(articleRef, item.body);
  const [notesOpen, setNotesOpenState] = useState(() => readJson('reader:notes', false) || item.notes.trim() !== '');
  const setNotesOpen = (v: boolean) => {
    setNotesOpenState(v);
    writeJson('reader:notes', v);
  };
  const minTop = Math.min(...headings.map((h) => h.level), 3);

  return (
    <div className={cx('reader', notesOpen && 'has-notes')}>
      <header className="reader-bar">
        <Link to={libraryHref()} className="btn btn-ghost btn-icon" aria-label="Back to the library" title="Back to the library">
          <ArrowLeft size={16} />
        </Link>
        <span className="reader-bar-title truncate">{item.title}</span>
        <span className="spacer" />
        <StatusControl item={item} size="sm" />
        <FavoriteButton item={item} size="sm" />
        <span className="itembar-wide">
          <CollectionPicker
            size="sm"
            collections={collections}
            selected={item.collectionIds}
            onToggle={actions.toggleCollection}
            onCreate={() => collectionActions.create(null, (c) => actions.toggleCollection(c.id, true))}
          />
        </span>
        <Button size="sm" icon={<NotebookPen size={13} />} aria-pressed={notesOpen} className={cx(notesOpen && 'is-active')} onClick={() => setNotesOpen(!notesOpen)}>
          Notes
        </Button>
        <span className="itembar-wide">
          <LinkButton to={`/items/${item.id}/edit`} size="sm" icon={<Pencil size={13} />}>
            Edit
          </LinkButton>
        </span>
        <MenuButton size="sm" variant="ghost" label="More actions" align="end" icon={<MoreHorizontal size={16} />} items={actions.menu} />
      </header>

      <div className="reader-body">
        <div className="reader-scroll" role="region" aria-label="Reading" tabIndex={0}>
          <div className="reader-layout">
            <article className="reader-article" ref={articleRef}>
              <header className="reader-head">
                <h1>{item.title}</h1>
                {item.summary && <p className="reader-summary">{item.summary}</p>}
                <div className="reader-meta">
                  <span>{plural(readingMinutes(item.body), 'min', 'min')} read</span>
                  <span title={absoluteTime(item.updatedAt)}>Updated {relativeTime(item.updatedAt)}</span>
                  <DifficultyBadge difficulty={item.difficulty} />
                  {item.source.url && (
                    <a href={item.source.url} target="_blank" rel="noopener noreferrer">
                      <ExternalLink size={12} aria-hidden="true" /> {hostOf(item.source.url)}
                    </a>
                  )}
                  {item.source.note && <span>{item.source.note}</span>}
                </div>
                {item.tags.length > 0 && <TagChips tags={item.tags} />}
              </header>
              {item.body.trim() === '' ? (
                <Callout tone="info" title="Nothing written yet" actions={<Link to={`/items/${item.id}/edit`}>Write the text</Link>}>
                  This reading is still a placeholder.
                </Callout>
              ) : (
                <Markdown source={item.body} longform />
              )}
              <Related item={item} />
            </article>

            {headings.length > 2 && (
              <nav className="reader-outline" aria-label="On this page">
                <h2>On this page</h2>
                <ul>
                  {headings.map((h) => (
                    <li key={h.id} style={{ paddingLeft: (h.level - minTop) * 12 }}>
                      <a href={`#${h.id}`} className={cx(active === h.id && 'is-active')} aria-current={active === h.id ? 'location' : undefined}>
                        {h.text}
                      </a>
                    </li>
                  ))}
                </ul>
              </nav>
            )}
          </div>
        </div>

        {notesOpen && (
          <aside className="reader-notes" aria-label="Private notes">
            <div className="reader-notes-head">
              <h2>Notes</h2>
              <IconButton size="sm" label="Close notes" icon={<X size={14} />} onClick={() => setNotesOpen(false)} />
            </div>
            <Notes item={item} />
          </aside>
        )}
      </div>
    </div>
  );
}

function hostOf(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, '');
  } catch {
    return 'Source';
  }
}
