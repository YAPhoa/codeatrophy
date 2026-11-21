import { createContext, useContext, useId, useState, type CSSProperties, type ReactNode } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { Button, cx } from './Button';

/**
 * A block of text or code shown up to `lines` lines when it has more
 * (`total`), with "Show more" for the rest and "Show less" to fold it again.
 * The block inside is cut to that height (`.clamped` in ui.css); a code
 * block (`.code-block`) or a code editor (`.code-editor`) is.
 */
export function Clamped({ lines, total, children, className }: { lines: number; total: number; children: ReactNode; className?: string }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  if (total <= lines) return <div className={className}>{children}</div>;
  return (
    <div className={cx('clamped', !open && 'is-clamped', className)} style={{ '--clamp-lines': lines } as CSSProperties}>
      <div id={id} className="clamped-body">
        {children}
      </div>
      <Button size="sm" variant="ghost" className="clamped-toggle" icon={open ? <ChevronUp size={14} /> : <ChevronDown size={14} />} aria-expanded={open} aria-controls={id} onClick={() => setOpen((o) => !o)}>
        {open ? 'Show less' : 'Show more'}
      </Button>
    </div>
  );
}

/**
 * How many lines the outputs below show before "Show more"; `null`, the
 * default, shows them whole. Set where space is short.
 */
export const OutputClamp = createContext<number | null>(null);

/** A block of output, clamped where `OutputClamp` says. */
export function ClampedOutput({ text, children }: { text: string; children: ReactNode }) {
  const lines = useContext(OutputClamp);
  if (lines === null) return <>{children}</>;
  return (
    <Clamped lines={lines} total={text === '' ? 0 : text.replace(/\n$/, '').split('\n').length}>
      {children}
    </Clamped>
  );
}
