import { Link } from 'react-router';
import { CornerLeftUp, GitBranch } from 'lucide-react';
import { useItem, useItemQuery, useMeta } from '../../api/queries';
import type { Item } from '../../api/types';
import { useLoadingShown } from '../../lib/motion';
import { LinkButton, cx } from '../../ui/Button';
import { VariantCard } from '../capture/VariantCard';
import { DifficultyBadge, StatusIcon } from './controls';

/** What the item was derived from, when it is a variant. */
function Origin({ item }: { item: Item }) {
  const origin = useItem(item.variantOf ?? undefined);
  if (!item.variantOf) return null;
  return (
    <p className="related-origin">
      <CornerLeftUp size={14} aria-hidden="true" />
      A variant of{' '}
      {origin.data ? <Link to={`/items/${origin.data.id}`}>{origin.data.title}</Link> : origin.isError ? <span className="muted">an item that is no longer available</span> : <span className="muted">…</span>}
    </p>
  );
}

/** The items derived from this one, oldest first. */
function Derived({ item }: { item: Item }) {
  const variants = useItemQuery({ variantOf: item.id, sort: 'created', limit: 50 }, item.variantCount > 0);
  const loadingShown = useLoadingShown(variants.isPending);
  if (item.variantCount === 0) return null;
  return (
    <ul className="related-list">
      {(variants.data?.items ?? []).map((v) => (
        <li key={v.id}>
          <StatusIcon status={v.status} size={14} />
          <Link to={`/items/${v.id}`} className="truncate">
            {v.title}
          </Link>
          <DifficultyBadge difficulty={v.difficulty} />
        </li>
      ))}
      {variants.isPending && <li className={cx('muted', 'loading-delay', !loadingShown && 'is-pending')}>Loading…</li>}
    </ul>
  );
}

/**
 * A reading's family, under its text: what it was derived from, and what was
 * derived from it, with the entry point for deriving another.
 */
export function Related({ item }: { item: Item }) {
  return (
    <section className="related" aria-labelledby="related-title">
      <div className="row">
        <h2 id="related-title" className="related-title">
          <GitBranch size={14} aria-hidden="true" />
          Related readings
        </h2>
        <span className="spacer" />
        <LinkButton to={`/items/${item.id}/variant`} size="sm" icon={<GitBranch size={14} />}>
          Rework this reading
        </LinkButton>
      </div>
      <Origin item={item} />
      <Derived item={item} />
      {item.variantCount === 0 && !item.variantOf && <p className="related-empty">Derive a new reading from this one, written from a different angle.</p>}
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
