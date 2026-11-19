import { useEffect, useState } from 'react';
import { Link, NavLink } from 'react-router';
import { ArrowLeft, MoreHorizontal } from 'lucide-react';
import { useCollections } from '../../api/queries';
import type { Item } from '../../api/types';
import { cx } from '../../ui/Button';
import { MenuButton } from '../../ui/Popover';
import { TAB_INDICATOR, TAB_SELECTED } from '../../ui/misc';
import { useSlidingIndicator } from '../../lib/motion';
import { useCollectionActions } from '../collections/CollectionActions';
import { CollectionPicker, DifficultyBadge, FavoriteButton, StatusControl } from './controls';
import { libraryHref, useItemActions } from './itemActions';

/** The items whose bar is on screen, with how many times (StrictMode mounts twice). */
const barsShown = new Map<string, number>();

/**
 * Whether this bar takes over from the same item's bar on another of its
 * tabs. A screen stays on screen until the next one has rendered, so the
 * outgoing bar is still mounted while this one first renders. A continued
 * bar does not fade in with its screen (layout.css): it was there already.
 */
function useContinuedBar(id: string): boolean {
  const [continued] = useState(() => (barsShown.get(id) ?? 0) > 0);
  useEffect(() => {
    barsShown.set(id, (barsShown.get(id) ?? 0) + 1);
    return () => {
      const n = (barsShown.get(id) ?? 1) - 1;
      if (n > 0) barsShown.set(id, n);
      else barsShown.delete(id);
    };
  }, [id]);
  return continued;
}

/**
 * The compact header of a problem's pages: title, the Solve / Test cases /
 * Solutions switch, and the organising controls (status, favorite,
 * collections, more).
 */
export function ItemBar({ item }: { item: Item }) {
  const { data: collections = [] } = useCollections();
  const actions = useItemActions(item);
  const collectionActions = useCollectionActions();
  const tabsRef = useSlidingIndicator<HTMLElement>(TAB_SELECTED, TAB_INDICATOR);
  const continued = useContinuedBar(item.id);
  return (
    <header className={cx('itembar', continued && 'is-continued')}>
      <Link to={libraryHref()} className="btn btn-ghost btn-icon" aria-label="Back to the library" title="Back to the library">
        <ArrowLeft size={16} />
      </Link>
      <h1 className="itembar-title truncate" title={item.title}>
        {item.title}
      </h1>
      <DifficultyBadge difficulty={item.difficulty} />
      <nav ref={tabsRef} className="tabs itembar-tabs" aria-label="Problem sections">
        <NavLink to={`/items/${item.id}`} end className={({ isActive }) => cx('tab', isActive && 'is-selected')}>
          Solve
        </NavLink>
        <NavLink to={`/items/${item.id}/tests`} className={({ isActive }) => cx('tab', isActive && 'is-selected')}>
          Test cases <span className="tab-count">{item.testCaseCount}</span>
        </NavLink>
        <NavLink to={`/items/${item.id}/solutions`} className={({ isActive }) => cx('tab', isActive && 'is-selected')}>
          Solutions <span className="tab-count">{item.solutionCount}</span>
        </NavLink>
      </nav>
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
      <MenuButton size="sm" variant="ghost" label="More actions" align="end" icon={<MoreHorizontal size={16} />} items={actions.menu} />
    </header>
  );
}
