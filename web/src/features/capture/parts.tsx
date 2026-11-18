import { useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import { Link } from 'react-router';
import { Check, PenLine, Sparkles, Square } from 'lucide-react';
import type { AppliedStyle, GenerationUsage } from '../../api/types';
import { aiLogPath } from '../../lib/aiLog';
import { describeUsage, plural } from '../../lib/format';
import { Button, cx } from '../../ui/Button';

/**
 * The lines of the generating mark. Each token is [width, tick]: its width in
 * pixels and the tick (0 to 9) of its line's step on which it arrives. The
 * caret's keyframes in features.css follow these numbers.
 */
const MARK_LINES: [number, number][][] = [
  [[5, 1], [3, 2], [8, 4], [4, 6]],
  [[7, 1], [4, 3], [6, 6]],
  [[3, 1], [9, 2], [5, 5], [3, 6]],
  [[6, 2], [6, 4], [4, 7]],
  [[4, 1], [8, 3], [3, 4], [5, 7]],
];

/** Each token with its x position: tokens sit 2px apart. */
const MARK_ROWS = MARK_LINES.map((tokens) => {
  let x = 0;
  return tokens.map(([width, tick]) => {
    const token = { x, width, tick };
    x += width + 2;
    return token;
  });
});

/** The mark of a generation in progress: tokens streaming in behind a caret. */
function GeneratingMark() {
  return (
    <svg className="generating-mark" viewBox="0 0 32 32" width="32" height="32" aria-hidden="true">
      <g transform="translate(1 25)">
        {MARK_ROWS.map((tokens, i) => (
          <g key={i} className="generating-row" style={{ '--i': i } as CSSProperties}>
            {tokens.map((t) => (
              <rect key={t.x} className="generating-token" x={t.x} width={t.width} height="3" style={{ '--k': t.tick } as CSSProperties} />
            ))}
          </g>
        ))}
      </g>
      <rect className="generating-caret" width="3" height="7" />
    </svg>
  );
}

/** In-progress state of a long AI call: what is happening, for how long, and a way out. */
export function GeneratingPanel({ title, startedAt, onCancel, children }: { title: string; startedAt: number | null; onCancel: () => void; children?: ReactNode }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, []);
  const seconds = startedAt ? Math.max(0, Math.floor((now - startedAt) / 1000)) : 0;
  return (
    <div className="generating">
      <GeneratingMark />
      <div className="grow">
        {/* Only the title is a live region: the counter beside it changes every second and would be read out each time. */}
        <div className="generating-title">
          <span role="status">{title}</span> <span className="generating-time">{seconds}&nbsp;s</span>
        </div>
        <div className="generating-text">{children ?? 'This usually takes a few seconds, occasionally up to a couple of minutes.'}</div>
      </div>
      <Button icon={<Square size={12} />} onClick={onCancel}>
        Cancel
      </Button>
    </div>
  );
}

/**
 * What a generation cost, small and out of the way; it leads to the request
 * in the AI activity log when there is one. `newTab` keeps a page whose
 * state would be lost by leaving it.
 */
export function UsageLine({ usage, className, newTab }: { usage: GenerationUsage | null | undefined; className?: string; newTab?: boolean }) {
  const text = usage ? describeUsage(usage) : '';
  if (!usage || text === '') return null;
  if (!usage.logId) {
    return (
      <span className={cx('usage-line', className)} title="What this generation used">
        {text}
      </span>
    );
  }
  return (
    <Link to={aiLogPath({ entryId: usage.logId })} className={cx('usage-line', className)} title="Open the request in AI activity" {...(newTab ? { target: '_blank', rel: 'noreferrer' } : {})}>
      {text}
    </Link>
  );
}

interface AssumptionsPanelProps {
  assumptions: readonly string[];
  /** `draft`: gaps the model filled in. `variant`: how the new item differs from its origin. */
  kind: 'draft' | 'variant';
  style: AppliedStyle | null;
  /** Whether a style could have been applied at all (hides the "built-in" note otherwise). */
  showStyle: boolean;
  /** What the generation cost, when the draft came with it. */
  usage?: GenerationUsage | null;
}

/**
 * The model's own list of what it inferred or invented. Shown prominently
 * during review so the user can tell their input from the model's guesses;
 * each line can be ticked off once checked.
 */
export function AssumptionsPanel({ assumptions, kind, style, showStyle, usage }: AssumptionsPanelProps) {
  const [checked, setChecked] = useState<Set<number>>(new Set());
  useEffect(() => setChecked(new Set()), [assumptions]);
  const toggle = (i: number) =>
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });

  return (
    <section className="assumptions" aria-labelledby="assumptions-title">
      <div className="assumptions-head">
        <Sparkles size={16} aria-hidden="true" />
        <h2 id="assumptions-title">
          {kind === 'draft'
            ? assumptions.length === 0
              ? 'The AI reports no assumptions'
              : `The AI filled in ${plural(assumptions.length, 'gap')}`
            : 'How this differs from the original'}
        </h2>
        {assumptions.length > 0 && (
          <span className="assumptions-progress">
            {checked.size}/{assumptions.length} checked
          </span>
        )}
      </div>
      <p className="assumptions-lead">
        {kind === 'draft'
          ? assumptions.length === 0
            ? 'It says everything below came from your input. Read the draft before saving it.'
            : 'None of these were in what you wrote. Check each one against what you remember and fix anything the AI guessed wrong.'
          : 'The AI made these changes to the original problem. You can edit everything below.'}
      </p>
      {assumptions.length > 0 && (
        <ul className="assumptions-list">
          {assumptions.map((a, i) => (
            <li key={i} className={cx(checked.has(i) && 'is-checked')}>
              {/* A checkbox named by the assumption itself, so the whole line is the target and the name never changes. */}
              <label className="assumption">
                <input type="checkbox" className="sr-only" name={`assumption-${i + 1}`} checked={checked.has(i)} onChange={() => toggle(i)} />
                <span className="assumption-check" aria-hidden="true">
                  {checked.has(i) && <Check size={12} />}
                </span>
                <span>{a}</span>
              </label>
            </li>
          ))}
        </ul>
      )}
      {(showStyle || usage) && (
        <div className="assumptions-foot">
        {showStyle && (
          <p className="assumptions-style">
            <PenLine size={14} aria-hidden="true" />
            {style ? (
              <>
                Written in your style <strong>{style.name}</strong>.
              </>
            ) : (
              <>Written with the built-in conventions only (no style preset).</>
            )}{' '}
            <Link to="/settings/styles">Manage styles</Link>
          </p>
        )}
          <UsageLine usage={usage} />
        </div>
      )}
    </section>
  );
}

export function Steps({ current, labels }: { current: number; labels: readonly string[] }) {
  return (
    <ol className="steps" aria-label="Progress">
      {labels.map((label, i) => (
        <li key={label} className={cx(i === current && 'is-current', i < current && 'is-done')} aria-current={i === current ? 'step' : undefined}>
          <span className="step-no">{i < current ? <Check size={14} aria-hidden="true" /> : i + 1}</span>
          {label}
        </li>
      ))}
    </ol>
  );
}
