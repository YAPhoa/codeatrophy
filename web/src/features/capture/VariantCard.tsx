import { Link } from 'react-router';
import { GitBranch } from 'lucide-react';
import type { Item } from '../../api/types';
import { LinkButton } from '../../ui/Button';
import { VARIANT_MODES } from './variantModes';

/**
 * The offer of a variant of a problem: a direction to pick, each leading to
 * the variant page with that choice made. Without an AI provider it leads to
 * writing one by hand.
 */
export function VariantCard({ item, aiEnabled, heading: Heading = 'h3' }: { item: Item; aiEnabled: boolean; heading?: 'h2' | 'h3' }) {
  return (
    <section className="next-card" aria-labelledby="next-variant">
      <div className="next-card-icon" aria-hidden="true">
        <GitBranch size={18} />
      </div>
      <Heading id="next-variant">Want another one like it?</Heading>
      {aiEnabled ? (
        <>
          <p>Get a fresh problem built on the same idea, so you practise the technique rather than remember this answer. Pick a direction:</p>
          <div className="variant-quick">
            {VARIANT_MODES.map((m) => (
              <Link key={m.mode} to={`/items/${item.id}/variant?mode=${m.mode}`} className="variant-quick-item">
                <strong>{m.label}</strong>
                <span>{m.short}</span>
              </Link>
            ))}
          </div>
        </>
      ) : (
        <>
          <p>A variant is a related problem — the same technique in a new setting, easier, harder, or with a twist — saved alongside this one. With AI set up, one is drafted for you.</p>
          <div className="next-card-actions">
            <LinkButton to={`/items/${item.id}/variant`}>Write a variant by hand</LinkButton>
            <Link to="/settings/ai">Set up AI</Link>
          </div>
        </>
      )}
    </section>
  );
}
