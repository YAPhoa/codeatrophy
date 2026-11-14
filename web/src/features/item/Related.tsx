import { Link } from 'react-router';
import { CornerLeftUp, GitBranch } from 'lucide-react';
import { useItem, useItemQuery } from '../../api/queries';
import type { Item } from '../../api/types';
import { LinkButton } from '../../ui/Button';
import { DifficultyBadge, StatusIcon } from './controls';

/**
 * The item's family: what it was derived from, and what was derived from it,
 * with the entry point for drafting another variant.
 */
export function Related({ item }: { item: Item }) {
  const origin = useItem(item.variantOf ?? undefined);
  const variants = useItemQuery({ variantOf: item.id, sort: 'created', limit: 50 }, item.variantCount > 0);
  const isProblem = item.type === 'problem';
  const list = variants.data?.items ?? [];

  return (
    <section className="related" aria-labelledby="related-title">
      <div className="row">
        <h2 id="related-title" className="related-title">
          <GitBranch size={14} aria-hidden="true" />
          {isProblem ? 'Variants' : 'Related readings'}
        </h2>
        <span className="spacer" />
        <LinkButton to={`/items/${item.id}/variant`} size="sm" icon={<GitBranch size={14} />}>
          {isProblem ? 'Practise a variant' : 'Rework this reading'}
        </LinkButton>
      </div>

      {item.variantOf && (
        <p className="related-origin">
          <CornerLeftUp size={14} aria-hidden="true" />
          A variant of{' '}
          {origin.data ? <Link to={`/items/${origin.data.id}`}>{origin.data.title}</Link> : origin.isError ? <span className="muted">an item that is no longer available</span> : <span className="muted">…</span>}
        </p>
      )}

      {item.variantCount > 0 ? (
        <ul className="related-list">
          {list.map((v) => (
            <li key={v.id}>
              <StatusIcon status={v.status} size={14} />
              <Link to={`/items/${v.id}`} className="truncate">
                {v.title}
              </Link>
              <DifficultyBadge difficulty={v.difficulty} />
            </li>
          ))}
          {variants.isPending && <li className="muted">Loading…</li>}
        </ul>
      ) : (
        !item.variantOf && (
          <p className="related-empty">
            {isProblem
              ? 'Solved it? Get another problem built on the same idea — similar, easier, harder, or with a twist — and practise the technique, not the answer.'
              : 'Derive a new reading from this one, written from a different angle.'}
          </p>
        )
      )}
    </section>
  );
}
