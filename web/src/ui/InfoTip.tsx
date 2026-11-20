import { useId, useRef, useState, type ReactNode } from 'react';
import { Info } from 'lucide-react';
import { Popover } from './Popover';

/**
 * A small "i" beside a label. What it explains shows above it, clear of the
 * control, while the pointer is on it or it has focus, and Escape puts it away.
 * It describes the "i" as soon as it opens; only its showing waits a moment
 * (ui.css, `.info-tip-text`), and it goes quicker than a popover.
 */
export function InfoTip({ label, children }: { label: string; children: ReactNode }) {
  const ref = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <>
      <button
        ref={ref}
        type="button"
        className="info-tip"
        aria-label={label}
        aria-describedby={open ? id : undefined}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && open) {
            e.stopPropagation();
            setOpen(false);
          }
        }}
      >
        <Info size={14} aria-hidden="true" />
      </button>
      <Popover anchorRef={ref} open={open} onClose={() => setOpen(false)} role="tooltip" id={id} side="above" noAutoFocus exitToken="--duration-instant" className="info-tip-text">
        {children}
      </Popover>
    </>
  );
}
