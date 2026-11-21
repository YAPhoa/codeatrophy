import { useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { Link } from 'react-router';
import { CornerLeftUp, X } from 'lucide-react';
import { useItemLinks, useItemQuery, useLimits, useLinkItem, useMeta, useUnlinkItem } from '../../api/queries';
import type { Item, LinkedItem } from '../../api/types';
import { useLoadingShown } from '../../lib/motion';
import { readJson, writeJson } from '../../lib/storage';
import { useDebounced } from '../../lib/useDebounced';
import { IconButton, cx } from '../../ui/Button';
import { Collapse, ExpandChevron } from '../../ui/Collapse';
import { Popover } from '../../ui/Popover';
import { useToast } from '../../ui/Toast';
import { VariantCard } from '../capture/VariantCard';
import { DifficultyBadge, StatusIcon, TypeIcon } from './controls';

/** Whether the Related items section is open; one choice for readings and problems alike. */
const OPEN_KEY = 'related:open';

/** What a dead link is called when the library never knew its title. */
const MISSING = 'Missing item';

/** How many of an item's variants are listed. */
const VARIANT_LIMIT = 50;

/** A row's place in the Related items list, in place of an icon. */
function RowNumber({ n }: { n: number }) {
  return (
    <span className="related-num" aria-hidden="true">
      {n}.
    </span>
  );
}

/** The title of an item a link points at: a link while it is in the library, red once it is gone. */
function LinkedTitle({ linked }: { linked: LinkedItem }) {
  if (linked.available) {
    return (
      <Link to={`/items/${linked.id}`} className="truncate">
        {linked.title}
      </Link>
    );
  }
  return (
    <span className="link-dead truncate" title="No longer in your library">
      {linked.title ?? MISSING}
      <span className="sr-only"> (no longer in your library)</span>
    </span>
  );
}

/** What the item was derived from, when it is a variant, even once that is gone. */
function Origin({ item }: { item: Item }) {
  const origin = item.variantOrigin;
  if (!origin) return null;
  return (
    <p className="related-origin">
      <CornerLeftUp size={14} aria-hidden="true" />
      A variant of <LinkedTitle linked={origin} />
    </p>
  );
}

/**
 * The items derived from this one, oldest first: numbered under Related items,
 * with their status in a problem's Variants tab.
 */
function Derived({ item, numbered = false }: { item: Item; numbered?: boolean }) {
  const variants = useItemQuery({ variantOf: item.id, sort: 'created', limit: VARIANT_LIMIT }, item.variantCount > 0);
  const loadingShown = useLoadingShown(variants.isPending);
  if (item.variantCount === 0) return null;
  const List = numbered ? 'ol' : 'ul';
  return (
    <List className="related-list" aria-label="Variants">
      {(variants.data?.items ?? []).map((v, i) => (
        <li key={v.id}>
          {numbered ? <RowNumber n={i + 1} /> : <StatusIcon status={v.status} size={14} />}
          <Link to={`/items/${v.id}`} className="truncate">
            {v.title}
          </Link>
          <DifficultyBadge difficulty={v.difficulty} />
        </li>
      ))}
      {variants.isPending && <li className={cx('muted', 'loading-delay', !loadingShown && 'is-pending')}>Loading…</li>}
    </List>
  );
}

/**
 * The items linked to this one by hand, numbered on from `start`, each with a
 * way to unlink it. One that is gone shows its title in red.
 */
function Links({ item, links, pending, start }: { item: Item; links: LinkedItem[]; pending: boolean; start: number }) {
  const unlink = useUnlinkItem(item.id);
  const toast = useToast();
  const loadingShown = useLoadingShown(pending);
  if (links.length === 0 && !pending) return null;
  return (
    <ol className="related-list" aria-label="Linked items" start={start}>
      {links.map((l, i) => (
        <li key={l.id} className={cx(!l.available && 'is-dead')}>
          <RowNumber n={start + i} />
          <LinkedTitle linked={l} />
          <DifficultyBadge difficulty={l.difficulty} />
          <IconButton
            size="sm"
            className="related-unlink"
            label={`Unlink ${l.title ?? MISSING}`}
            icon={<X size={14} />}
            onClick={() => unlink.mutate(l.id, { onError: (e) => toast.error(e) })}
          />
        </li>
      ))}
      {pending && <li className={cx('muted', 'loading-delay', !loadingShown && 'is-pending')}>Loading…</li>}
    </ol>
  );
}

/** Find an item in the library by title and link it. */
function LinkSearch({ item, linked }: { item: Item; linked: readonly LinkedItem[] }) {
  const [text, setText] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const wrapRef = useRef<HTMLDivElement>(null);
  const listId = useId();
  const q = useDebounced(text.trim(), 160);
  const results = useItemQuery({ q, sort: 'relevance', limit: 12 }, q !== '');
  const link = useLinkItem(item.id);
  const toast = useToast();

  const matches = useMemo(() => {
    if (q === '') return [];
    const taken = new Set([item.id, ...linked.map((l) => l.id)]);
    return (results.data?.items ?? []).filter((r) => !taken.has(r.id)).slice(0, 8);
  }, [q, results.data, item.id, linked]);

  const showList = open && text.trim() !== '' && q !== '' && !results.isPending;
  const current = Math.min(active, matches.length - 1);

  const choose = (id: string) => {
    link.mutate(id, {
      onSuccess: () => {
        setText('');
        setActive(0);
      },
      onError: (e) => toast.error(e),
    });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown' && matches.length > 0) {
      e.preventDefault();
      setOpen(true);
      setActive(Math.min(matches.length - 1, current + 1));
    } else if (e.key === 'ArrowUp' && matches.length > 0) {
      e.preventDefault();
      setActive(Math.max(0, current - 1));
    } else if (e.key === 'Enter') {
      const picked = showList ? matches[current] : undefined;
      if (picked) {
        e.preventDefault();
        choose(picked.id);
      }
    } else if (e.key === 'Escape' && (showList || text !== '')) {
      e.stopPropagation();
      if (showList) setOpen(false);
      else setText('');
    }
  };

  return (
    <div ref={wrapRef} className="related-search">
      <input
        className="input"
        type="search"
        name="link-item"
        value={text}
        placeholder="Link an item…"
        aria-label="Link an item"
        role="combobox"
        aria-expanded={showList}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={showList && matches.length > 0 ? `${listId}-${current}` : undefined}
        aria-busy={link.isPending || undefined}
        autoComplete="off"
        spellCheck={false}
        onChange={(e) => {
          setText(e.target.value);
          setOpen(true);
          setActive(0);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={onKeyDown}
      />
      <Popover anchorRef={wrapRef} open={showList} onClose={() => setOpen(false)} matchWidth noAutoFocus className="menu">
        {matches.length > 0 ? (
          <ul id={listId} role="listbox" aria-label="Items to link">
            {matches.map((m, i) => (
              <li
                key={m.id}
                id={`${listId}-${i}`}
                role="option"
                aria-selected={i === current}
                className={cx('menu-item', i === current && 'is-active')}
                onMouseDown={(e) => {
                  e.preventDefault();
                  choose(m.id);
                }}
                onMouseMove={() => setActive(i)}
              >
                <TypeIcon type={m.type} size={14} />
                <span className="truncate">{m.title}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p id={listId} className="related-search-none">
            No matching items
          </p>
        )}
      </Popover>
    </div>
  );
}

/** What the open section holds: for a reading its family too; a problem has a tab for that. */
function RelatedBody({ item, id }: { item: Item; id: string }) {
  const links = useItemLinks(item.id, item.linkCount > 0);
  const list = links.data ?? [];
  const reading = item.type === 'reading';
  const max = useLimits()?.maxLinksPerItem;
  const full = max !== undefined && item.linkCount >= max;
  return (
    <div id={id} className="related-body">
      {reading && <Origin item={item} />}
      {reading && <Derived item={item} numbered />}
      <Links
        item={item}
        links={list}
        pending={item.linkCount > 0 && links.isPending}
        start={reading ? Math.min(item.variantCount, VARIANT_LIMIT) + 1 : 1}
      />
      {full ? <p className="related-full">At most {max} links.</p> : <LinkSearch item={item} linked={list} />}
    </div>
  );
}

/**
 * Under an item's text: the items linked to it by hand, and the search that
 * links another. A reading's variants and origin show here too. Open or
 * closed is remembered in the browser.
 */
export function Related({ item }: { item: Item }) {
  const [open, setOpen] = useState(() => readJson<unknown>(OPEN_KEY, true) !== false);
  const bodyId = useId();
  const count = item.linkCount + (item.type === 'reading' ? item.variantCount + (item.variantOf ? 1 : 0) : 0);
  const toggle = () => {
    setOpen(!open);
    writeJson(OPEN_KEY, !open);
  };
  return (
    <section className="related" aria-labelledby="related-title">
      <div className="related-head">
        <h2 id="related-title" className="related-title">
          <button type="button" className="related-toggle" aria-expanded={open} aria-controls={open ? bodyId : undefined} onClick={toggle}>
            <ExpandChevron open={open} />
            Related items
          </button>
        </h2>
        {!open && count > 0 && <span className="related-count">{count}</span>}
      </div>
      <Collapse open={open}>
        <RelatedBody item={item} id={bodyId} />
      </Collapse>
    </section>
  );
}

/**
 * A problem's family, in a tab of its own: what it is a variant of, its own
 * variants, and the offer of another one.
 */
export function Variants({ item }: { item: Item }) {
  const aiEnabled = useMeta().data?.ai.enabled ?? false;
  return (
    <div className="variants">
      <Origin item={item} />
      <Derived item={item} />
      <VariantCard item={item} aiEnabled={aiEnabled} heading="h2" />
    </div>
  );
}
