import { useState, type ReactNode } from 'react';
import { ChevronRight } from 'lucide-react';
import { usePresence } from '../lib/motion';
import { cx } from './Button';

/**
 * Content that opens and closes in place: its height grows from nothing when
 * it opens and shrinks back when it closes. The content is only mounted while
 * open, and for the moment it takes to close. What is already open when the
 * page arrives is simply there.
 */
export function Collapse({ open, children }: { open: boolean; children: ReactNode }) {
  const { mounted, closing } = usePresence(open);
  // Whether it has been closed since it mounted: only then does opening play.
  const [toggled, setToggled] = useState(!open);
  if (!open && !toggled) setToggled(true);
  // Clipped only while the height moves, so focus rings and shadows inside are not cut off once open.
  const [moving, setMoving] = useState(true);
  if (!mounted) {
    if (!moving) setMoving(true);
    return null;
  }
  const entering = toggled && !closing;
  return (
    <div
      className={cx('collapse', entering && 'is-entering', closing && 'is-closing', ((entering && moving) || closing) && 'is-moving')}
      inert={closing}
      onAnimationEnd={(e) => {
        if (e.target === e.currentTarget) setMoving(false);
      }}
    >
      <div className="collapse-inner">{children}</div>
    </div>
  );
}

/** The chevron of a row that opens: points right when closed and turns down when open. */
export function ExpandChevron({ open, size = 14 }: { open: boolean; size?: number }) {
  return <ChevronRight size={size} aria-hidden="true" className={cx('expand-chevron', open && 'is-open')} />;
}
