import { useId, useRef, type ReactNode } from 'react';
import { Check } from 'lucide-react';
import { toggleIn } from '../../lib/filters';
import { cx } from '../../ui/Button';

export interface FacetOption<V extends string> {
  value: V;
  /** What the row shows; `text` names its checkbox. */
  label: ReactNode;
  text: string;
  /** Items the view shows with this value picked; `undefined` until the counts first load. */
  count: number | undefined;
}

interface FacetListProps<V extends string> {
  options: readonly FacetOption<V>[];
  selected: readonly V[];
  onChange: (next: V[]) => void;
  /** The header's words while nothing is picked: "Any status". */
  noneText: string;
  /** Between the header and the rows: the tags' filter field. */
  before?: ReactNode;
  /** Under the rows, in place of them when there are none: "No match." */
  empty?: ReactNode;
  /** Focus the first row when the popover opens. */
  autoFocus?: boolean;
}

/**
 * The rows of a filter menu: a header that counts the picked values and
 * clears them, then one row per value with its label, its count in the view
 * and a round checkbox. Ticking a row leaves the menu open.
 */
export function FacetList<V extends string>({ options, selected, onChange, noneText, before, empty, autoFocus }: FacetListProps<V>) {
  const listRef = useRef<HTMLDivElement>(null);
  const id = useId();
  const picked = selected.length;
  return (
    <>
      <div className="facet-head">
        <span className="facet-picked">
          {picked > 0 ? `${picked} selected` : noneText}
        </span>
        {/* Hidden rather than removed, so the header keeps its height and nothing moves. */}
        <button
          type="button"
          className={cx('link-btn facet-clear', picked === 0 && 'is-idle')}
          tabIndex={picked > 0 ? undefined : -1}
          aria-hidden={picked > 0 ? undefined : true}
          onClick={() => {
            onChange([]);
            // The button hides; the first row takes the focus it had.
            listRef.current?.querySelector('input')?.focus();
          }}
        >
          Clear
        </button>
      </div>
      {before}
      <div className="facet-list" ref={listRef}>
        {options.map((o, i) => {
          const checked = selected.includes(o.value);
          return (
            <label key={o.value} className={cx('facet-row', checked && 'is-selected', o.count === 0 && !checked && 'is-empty')}>
              <span className="facet-label">{o.label}</span>
              <span className="facet-count" id={`${id}-${i}`}>
                {o.count === undefined ? <span className="skel facet-skel" /> : o.count}
              </span>
              <span className="facet-mark">
                <input
                  type="checkbox"
                  aria-label={o.text}
                  aria-describedby={o.count === undefined ? undefined : `${id}-${i}`}
                  checked={checked}
                  onChange={() => onChange(toggleIn(selected, o.value))}
                  data-autofocus={autoFocus && i === 0 ? true : undefined}
                />
                <Check size={10} strokeWidth={3.5} aria-hidden="true" />
              </span>
            </label>
          );
        })}
        {empty}
      </div>
    </>
  );
}
