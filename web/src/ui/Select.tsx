import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Check, ChevronsUpDown } from 'lucide-react';
import { Popover } from './Popover';
import { cx } from './Button';

export interface SelectOption<T extends string = string> {
  value: T;
  label: string;
  disabled?: boolean;
  /** How deep in a tree the option sits (a nested collection, say): its row is indented by as many steps. */
  depth?: number;
}

/** Where a select's list stands: open or not, and the option the arrow keys reached. */
export interface SelectState {
  open: boolean;
  active: number;
}

/** The first option at or past `from`, going `step` at a time, that can be chosen; -1 when there is none. */
export function enabledFrom(options: readonly SelectOption[], from: number, step: 1 | -1): number {
  for (let i = from; i >= 0 && i < options.length; i += step) if (!options[i]!.disabled) return i;
  return -1;
}

/** The option to start from: the chosen one, or else the first that can be chosen. */
export function startAt(options: readonly SelectOption[], chosen: number): number {
  return chosen >= 0 && !options[chosen]?.disabled ? chosen : enabledFrom(options, 0, 1);
}

const PAGE = 10;

/**
 * What a key does to a select, by the WAI-ARIA select-only combobox pattern:
 * the state after it and the option it picks, or null when the key is not
 * the select's (it then does what it would anyway). Type-ahead is apart, in `typeAhead`.
 */
export function selectKey(
  key: string,
  { open, active }: SelectState,
  options: readonly SelectOption[],
  chosen: number,
  { alt = false, searching = false }: { alt?: boolean; searching?: boolean } = {},
): { state: SelectState; pick: number | null } | null {
  const first = enabledFrom(options, 0, 1);
  const last = enabledFrom(options, options.length - 1, -1);
  const to = (i: number) => ({ state: { open: true, active: i === -1 ? active : i }, pick: null });
  if (!open) {
    if (key === 'ArrowDown' || key === 'ArrowUp' || key === 'Enter' || key === ' ') return { state: { open: true, active: startAt(options, chosen) }, pick: null };
    if (key === 'Home') return { state: { open: true, active: first }, pick: null };
    if (key === 'End') return { state: { open: true, active: last }, pick: null };
    return null;
  }
  switch (key) {
    case 'ArrowDown':
      return to(enabledFrom(options, active + 1, 1));
    case 'ArrowUp':
      // Alt+ArrowUp takes the option reached and closes, as on a native select.
      if (alt) return { state: { open: false, active }, pick: options[active]?.disabled ? null : active };
      return to(active === -1 ? last : enabledFrom(options, active - 1, -1));
    case 'Home':
      return to(first);
    case 'End':
      return to(last);
    case 'PageDown':
      return to(enabledFrom(options, Math.min(options.length - 1, active + PAGE), -1));
    case 'PageUp':
      return to(enabledFrom(options, Math.max(0, active - PAGE), 1));
    case ' ':
    case 'Enter':
      // A space in the middle of a typed name is part of it.
      if (key === ' ' && searching) return null;
      return { state: { open: false, active }, pick: active >= 0 && !options[active]?.disabled ? active : null };
    case 'Escape':
    case 'Tab':
      return { state: { open: false, active }, pick: null };
    default:
      return null;
  }
}

/**
 * The option typed letters lead to, starting from `from`; -1 when none
 * matches. One letter, or the same letter again and again, steps through the
 * options that start with it; more letters find the first that starts with them all.
 */
export function typeAhead(options: readonly SelectOption[], from: number, typed: string): number {
  const q = typed.toLowerCase();
  if (q === '') return -1;
  const repeated = [...q].every((c) => c === q[0]);
  const prefix = repeated ? q[0]! : q;
  const start = repeated ? from + 1 : Math.max(0, from);
  const n = options.length;
  for (let k = 0; k < n; k++) {
    const i = (((start + k) % n) + n) % n;
    const o = options[i]!;
    if (!o.disabled && o.label.trim().toLowerCase().startsWith(prefix)) return i;
  }
  return -1;
}

/** How long a pause in typing starts a new search. */
const TYPE_AHEAD_MS = 500;

/** Scroll `list` so `row` shows: in the middle when the list opens, by as little as can be as the arrow keys move. */
function reveal(list: HTMLElement, row: HTMLElement, center: boolean) {
  const top = row.offsetTop;
  const bottom = top + row.offsetHeight;
  if (center) list.scrollTop = top - (list.clientHeight - row.offsetHeight) / 2;
  else if (top < list.scrollTop) list.scrollTop = top;
  else if (bottom > list.scrollTop + list.clientHeight) list.scrollTop = bottom - list.clientHeight;
}

// A <label> for a button clicks it, where a label for a native select only
// moves focus to it. One listener for every select's labels does the latter.
let labelsWired = false;
function wireLabels() {
  if (labelsWired) return;
  labelsWired = true;
  document.addEventListener(
    'click',
    (e) => {
      const target = e.target instanceof Element ? e.target : null;
      const control = target?.closest('label')?.control;
      if (!(control instanceof HTMLElement) || !control.classList.contains('select-trigger') || control.contains(target)) return;
      e.preventDefault();
      control.focus();
    },
    true,
  );
}

export interface SelectProps<T extends string> {
  value: T;
  onChange: (value: T) => void;
  options: readonly SelectOption<T>[];
  id?: string;
  name?: string;
  className?: string;
  disabled?: boolean;
  title?: string;
  autoFocus?: boolean;
  'aria-label'?: string;
  'aria-describedby'?: string;
  'aria-invalid'?: boolean;
  /** `combo` draws it like the combo box of a model (settings/ModelField): up-down chevrons, options in the code font with the check after them. */
  look?: 'menu' | 'combo';
}

/**
 * A single choice from a list, drawn by the app rather than the browser: a
 * button showing the choice, and the options in a popover in the app's menu
 * style, the choice in effect checked. It works as a native select does from
 * the keyboard: arrows, Home and End move, Enter or Space picks, Escape puts
 * the list away, and typing jumps to an option, the list open or not.
 */
export function Select<T extends string>({
  value,
  onChange,
  options,
  id,
  name,
  className,
  disabled,
  title,
  look = 'menu',
  autoFocus,
  'aria-label': ariaLabel,
  'aria-describedby': describedBy,
  'aria-invalid': invalid,
}: SelectProps<T>) {
  const [state, setState] = useState<SelectState>({ open: false, active: -1 });
  // The reached option shows its ring only while the keyboard moves; under the pointer, the row's hover does.
  const [keyed, setKeyed] = useState(false);
  // Measured as the list opens: its name, from the button's labels, and how wide it may grow.
  const [measured, setMeasured] = useState<{ label?: string; maxWidth?: number }>({});
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const typed = useRef({ text: '', at: 0 });
  const listId = useId();
  const optionId = (i: number) => `${listId}-${i}`;
  // As a native select does, an unknown value shows the first option.
  const matched = options.findIndex((o) => o.value === value);
  const chosen = matched >= 0 ? matched : startAt(options, -1);
  const { open, active } = state;

  useEffect(wireLabels, []);

  const close = useCallback(() => setState((s) => (s.open ? { ...s, open: false } : s)), []);

  const show = (next: SelectState) => {
    const trigger = triggerRef.current;
    if (next.open && !open && trigger) {
      // Wider than the button for long labels, but only as far as the window's edge, so it never shifts off the button's left.
      const { left, width } = trigger.getBoundingClientRect();
      setMeasured({
        label: ariaLabel ?? (Array.from(trigger.labels ?? [], (l) => l.textContent?.trim()).filter(Boolean).join(' ') || undefined),
        maxWidth: Math.max(width, window.innerWidth - left - 8) - 2,
      });
    }
    setState(next);
  };

  const pick = (i: number) => {
    const o = options[i];
    if (o && !o.disabled && i !== matched) onChange(o.value);
  };

  // The list opens with the choice in its middle, and follows the arrow keys from there.
  const opened = useRef(false);
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!open || !list) {
      opened.current = false;
      return;
    }
    const row = list.children[active];
    if (row instanceof HTMLElement) reveal(list, row, !opened.current);
    opened.current = true;
  }, [open, active]);

  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.ctrlKey || e.metaKey) return;
    const now = Date.now();
    const searching = typed.current.text !== '' && now - typed.current.at < TYPE_AHEAD_MS;
    if (e.key.length === 1 && !e.altKey && (e.key !== ' ' || searching)) {
      // Type-ahead: open, it moves through the list; closed, it changes the choice, as a native select's does.
      e.preventDefault();
      const text = searching ? typed.current.text + e.key : e.key;
      typed.current = { text, at: now };
      const i = typeAhead(options, open ? active : chosen, text);
      if (i === -1) return;
      if (open) {
        setState({ open, active: i });
        setKeyed(true);
      } else pick(i);
      return;
    }
    // Any other key ends what was being typed.
    typed.current = { text: '', at: 0 };
    const result = selectKey(e.key, state, options, chosen, { alt: e.altKey, searching });
    if (!result) return;
    if (e.key === 'Escape') e.stopPropagation(); // Only the list closes, not a dialog it is in.
    if (e.key !== 'Tab') e.preventDefault();
    if (result.pick !== null) pick(result.pick);
    setKeyed(true);
    show(result.state);
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        id={id}
        name={name}
        value={value}
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        aria-activedescendant={open && active >= 0 ? optionId(active) : undefined}
        aria-label={ariaLabel}
        aria-describedby={describedBy}
        aria-invalid={invalid}
        disabled={disabled}
        title={title}
        autoFocus={autoFocus}
        className={cx('input select select-trigger', look === 'combo' && 'select-combo', className)}
        onClick={() => {
          setKeyed(false);
          if (open) close();
          else show({ open: true, active: startAt(options, chosen) });
        }}
        onKeyDown={onKeyDown}
        // Space would click the button as it comes up, opening the list again.
        onKeyUp={(e) => e.key === ' ' && e.preventDefault()}
        onBlur={close}
      >
        <span className="select-value">{options[chosen]?.label}</span>
        {look === 'combo' && <ChevronsUpDown size={14} className="select-chevrons" aria-hidden="true" />}
        {/* Every option's label, unseen, so that the button is as wide as the longest, like a native select. */}
        <span className="select-sizer" aria-hidden="true">
          {options.map((o) => (
            <span key={o.value} data-label={o.label} />
          ))}
        </span>
      </button>
      <Popover anchorRef={triggerRef} open={open} onClose={close} matchWidth noAutoFocus className="select-pop">
        <ul
          ref={listRef}
          id={listId}
          role="listbox"
          aria-label={measured.label}
          className="select-list"
          style={{ maxWidth: measured.maxWidth }}
          // Focus stays on the button while the list is used with the pointer.
          onMouseDown={(e) => e.preventDefault()}
        >
          {options.map((o, i) => (
            <li
              key={o.value}
              id={optionId(i)}
              role="option"
              aria-selected={i === chosen}
              aria-disabled={o.disabled || undefined}
              className={cx('menu-item select-option', keyed && i === active && 'is-active')}
              style={o.depth ? { paddingLeft: `calc(var(--space-2) + ${o.depth * 16}px)` } : undefined}
              onMouseMove={() => {
                if (o.disabled || (i === active && !keyed)) return;
                setState({ open, active: i });
                setKeyed(false);
              }}
              onClick={() => {
                if (o.disabled) return;
                pick(i);
                close();
              }}
            >
              {/* aria-selected already says which is chosen; the check mark is for the eye. */}
              {look === 'menu' && (
                <span className="menu-item-icon" aria-hidden="true">
                  {i === chosen && <Check size={14} className="menu-item-check" />}
                </span>
              )}
              <span className={cx('select-option-label', look === 'combo' && 'grow mono')}>{o.label}</span>
              {look === 'combo' && (
                <span className="menu-item-icon" aria-hidden="true">
                  {i === chosen && <Check size={14} />}
                </span>
              )}
            </li>
          ))}
        </ul>
      </Popover>
    </>
  );
}
