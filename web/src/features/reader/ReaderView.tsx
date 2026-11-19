import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { ArrowLeft, ExternalLink, MoreHorizontal, NotebookPen, X } from 'lucide-react';
import { useCollections } from '../../api/queries';
import type { Item } from '../../api/types';
import { absoluteTime, plural, readingMinutes, relativeTime } from '../../lib/format';
import { slideFrom, useChangeCount, usePresence, useSlidingIndicator } from '../../lib/motion';
import { readJson, writeJson } from '../../lib/storage';
import { Button, IconButton, cx } from '../../ui/Button';
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

  // The heading last chosen in the outline. It stays marked until the reader
  // scrolls by hand: near the end of the page a heading cannot scroll up to
  // the top, so the scroll position alone would mark an earlier one.
  const chosen = useRef<string | null>(null);

  useEffect(() => {
    const scroller = containerRef.current?.closest<HTMLElement>('.reader-scroll');
    if (!scroller || headings.length === 0) return;
    let frame = 0;
    const update = () => {
      frame = 0;
      const nodes = headings.map((h) => document.getElementById(h.id)).filter((n): n is HTMLElement => n !== null);
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      if (!first || !last) return;
      if (chosen.current && nodes.some((n) => n.id === chosen.current)) {
        setActive(chosen.current);
        return;
      }
      if (scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2) {
        setActive(last.id);
        return;
      }
      const box = scroller.getBoundingClientRect();
      // The last heading in the top third of the pane is the one being read.
      const read = nodes.filter((n) => n.getBoundingClientRect().top - box.top <= box.height * 0.3);
      setActive((read[read.length - 1] ?? first).id);
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    const byHand = () => {
      chosen.current = null;
    };
    const hand = ['wheel', 'touchstart', 'keydown', 'pointerdown'] as const;
    update();
    scroller.addEventListener('scroll', schedule, { passive: true });
    for (const t of hand) scroller.addEventListener(t, byHand, { passive: true });
    window.addEventListener('resize', schedule);
    return () => {
      cancelAnimationFrame(frame);
      scroller.removeEventListener('scroll', schedule);
      for (const t of hand) scroller.removeEventListener(t, byHand);
      window.removeEventListener('resize', schedule);
    };
  }, [containerRef, headings]);

  const choose = (id: string) => {
    chosen.current = id;
    setActive(id);
  };

  return { headings, active, choose };
}

/** A reading: long-form text in a comfortable column, with an outline and private notes alongside. */
export function ReaderView({ item }: { item: Item }) {
  const { data: collections = [] } = useCollections();
  const actions = useItemActions(item);
  const collectionActions = useCollectionActions();
  const articleRef = useRef<HTMLElement>(null);
  const { headings, active, choose } = useOutline(articleRef, item.body);
  const [notesOpen, setNotesOpenState] = useState(() => readJson('reader:notes', false) || item.notes.trim() !== '');
  // Where the text column was drawn before the notes opened or closed, so it
  // can ease from there to its new place instead of jumping.
  const columnWas = useRef<DOMRect | null>(null);
  const setNotesOpen = (v: boolean) => {
    columnWas.current = articleRef.current?.getBoundingClientRect() ?? null;
    setNotesOpenState(v);
    writeJson('reader:notes', v);
  };
  const notes = usePresence(notesOpen, '--duration-medium');
  const notesToggled = useChangeCount(notesOpen) > 0;
  useLayoutEffect(() => {
    const from = columnWas.current;
    columnWas.current = null;
    if (from && articleRef.current) slideFrom(articleRef.current, from);
  }, [notesOpen]);

  return (
    <div className={cx('reader', notesOpen && 'has-notes', notesToggled && !notesOpen && 'notes-closed')}>
      <header className="reader-bar">
        <Link to={libraryHref()} className="btn btn-ghost btn-icon" aria-label="Back to the library" title="Back to the library">
          <ArrowLeft size={16} />
        </Link>
        <span className="reader-bar-title truncate">{item.title}</span>
        <span className="spacer" />
        <StatusControl item={item} size="sm" />
        <FavoriteButton item={item} size="sm" labelled />
        <span className="itembar-wide">
          <CollectionPicker
            size="sm"
            collections={collections}
            selected={item.collectionIds}
            onToggle={actions.toggleCollection}
            onCreate={() => collectionActions.create(null, (c) => actions.toggleCollection(c.id, true))}
          />
        </span>
        <Button size="sm" icon={<NotebookPen size={14} />} aria-pressed={notesOpen} className={cx(notesOpen && 'is-active')} onClick={() => setNotesOpen(!notesOpen)}>
          Notes
        </Button>
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

            {headings.length > 2 && <Outline headings={headings} active={active} onChoose={choose} />}
          </div>
        </div>

        {notes.mounted && (
          <aside
            className={cx('reader-notes', notesToggled && notesOpen && 'is-opening', notes.closing && 'is-closing')}
            aria-label="Private notes"
            inert={notes.closing}
          >
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

/** The outline's marker slides to the heading being read (see `useSlidingIndicator`). */
const OUTLINE_ACTIVE = 'a.is-active';
const OUTLINE_MARKER = { pseudo: '::before', axis: 'y' } as const;

function Outline({ headings, active, onChoose }: { headings: Heading[]; active: string | null; onChoose: (id: string) => void }) {
  const ref = useSlidingIndicator<HTMLElement>(OUTLINE_ACTIVE, OUTLINE_MARKER);
  const minTop = Math.min(...headings.map((h) => h.level), 3);
  return (
    <nav ref={ref} className="reader-outline" aria-label="On this page">
      <h2>On this page</h2>
      <ul>
        {headings.map((h) => (
          <li key={h.id} style={{ paddingLeft: (h.level - minTop) * 12 }}>
            <a href={`#${h.id}`} onClick={() => onChoose(h.id)} className={cx(active === h.id && 'is-active')} aria-current={active === h.id ? 'location' : undefined}>
              {h.text}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}

function hostOf(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, '');
  } catch {
    return 'Source';
  }
}
