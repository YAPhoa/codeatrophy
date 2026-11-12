import { Link, NavLink } from 'react-router';
import { ArrowLeft, MoreHorizontal, Pencil } from 'lucide-react';
import { useCollections } from '../../api/queries';
import type { Item } from '../../api/types';
import { LinkButton, cx } from '../../ui/Button';
import { MenuButton } from '../../ui/Popover';
import { useCollectionActions } from '../collections/CollectionActions';
import { CollectionPicker, DifficultyBadge, FavoriteButton, StatusControl } from './controls';
import { libraryHref, useItemActions } from './itemActions';

/**
 * The compact header of a problem's pages: title, the Solve / Test cases /
 * Solutions switch, and the organising controls (status, favorite,
 * collections, more).
 */
export function ItemBar({ item }: { item: Item }) {
  const { data: collections = [] } = useCollections();
  const actions = useItemActions(item);
  const collectionActions = useCollectionActions();
  return (
    <header className="itembar">
      <Link to={libraryHref()} className="btn btn-ghost btn-icon" aria-label="Back to the library" title="Back to the library">
        <ArrowLeft size={16} />
      </Link>
      <h1 className="itembar-title truncate" title={item.title}>
        {item.title}
      </h1>
      <DifficultyBadge difficulty={item.difficulty} />
      <nav className="tabs itembar-tabs" aria-label="Problem sections">
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
      <span className="itembar-wide">
        <LinkButton to={`/items/${item.id}/edit`} size="sm" icon={<Pencil size={13} />}>
          Edit
        </LinkButton>
      </span>
      <MenuButton size="sm" variant="ghost" label="More actions" align="end" icon={<MoreHorizontal size={16} />} items={actions.menu} />
    </header>
  );
}
