import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import { createPortal } from 'react-dom';
import { Check } from 'lucide-react';
import { Button, cx, type ButtonProps } from './Button';

interface PopoverProps {
  anchorRef: RefObject<HTMLElement | null>;
  open: boolean;
  onClose: () => void;
  align?: 'start' | 'end';
  /** Make the popover at least as wide as its anchor. */
  matchWidth?: boolean;
  className?: string;
  role?: string;
  label?: string;
  id?: string;
  children: ReactNode;
  /** Keep focus where it is (for comboboxes whose input stays focused). */
  noAutoFocus?: boolean;
}

/**
 * A floating panel positioned under (or, when there is no room, above) its
 * anchor. Closes on Escape, on a click outside, and when focus leaves it.
 */
export function Popover({ anchorRef, open, onClose, align = 'start', matchWidth, className, role, label, id, children, noAutoFocus }: PopoverProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number; minWidth?: number; maxHeight: number } | null>(null);

  const place = useCallback(() => {
    const anchor = anchorRef.current;
    const el = ref.current;
    if (!anchor || !el) return;
    const a = anchor.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const gap = 4;
    const margin = 8;
    const width = Math.max(el.offsetWidth, matchWidth ? a.width : 0);
    const below = vh - a.bottom - gap - margin;
    const above = a.top - gap - margin;
    const natural = el.scrollHeight;
    const openUp = natural > below && above > below;
    const maxHeight = Math.max(120, openUp ? above : below);
    const height = Math.min(natural, maxHeight);
    let left = align === 'end' ? a.right - width : a.left;
    left = Math.max(margin, Math.min(left, vw - width - margin));
    const top = openUp ? a.top - gap - height : a.bottom + gap;
    setPos({ top, left, minWidth: matchWidth ? a.width : undefined, maxHeight });
  }, [anchorRef, align, matchWidth]);

  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open, place, children]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (ref.current?.contains(t) || anchorRef.current?.contains(t)) return;
      onClose();
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => document.removeEventListener('pointerdown', onPointerDown, true);
  }, [open, onClose, anchorRef]);

  useEffect(() => {
    if (!open || noAutoFocus || !pos) return;
    const el = ref.current;
    if (!el || el.contains(document.activeElement)) return;
    const target = el.querySelector<HTMLElement>('[data-autofocus], [role="menuitem"], [role="menuitemcheckbox"], input, button, [tabindex]');
    (target ?? el).focus({ preventScroll: true });
  }, [open, pos, noAutoFocus]);

  if (!open) return null;

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      onClose();
      anchorRef.current?.focus();
    }
  };

  return createPortal(
    <div
      ref={ref}
      id={id}
      role={role}
      aria-label={label}
      tabIndex={-1}
      className={cx('popover', className)}
      style={{
        top: pos?.top ?? 0,
        left: pos?.left ?? 0,
        minWidth: pos?.minWidth,
        maxHeight: pos?.maxHeight,
        visibility: pos ? 'visible' : 'hidden',
      }}
      onKeyDown={onKeyDown}
    >
      {children}
    </div>,
    document.body,
  );
}

export type MenuEntry =
  | {
      label: string;
      icon?: ReactNode;
      onSelect: () => void;
      danger?: boolean;
      disabled?: boolean;
      /** Render as a checkable item; the menu stays open when it is toggled. */
      checked?: boolean;
      hint?: string;
    }
  | 'separator'
  | { heading: string };

interface MenuButtonProps extends Omit<ButtonProps, 'onClick' | 'onSelect'> {
  items: MenuEntry[];
  align?: 'start' | 'end';
  /** Accessible name for icon-only triggers. */
  label?: string;
  menuLabel?: string;
}

function moveFocus(container: HTMLElement, delta: number | 'first' | 'last') {
  const items = Array.from(container.querySelectorAll<HTMLElement>('[role^="menuitem"]:not([aria-disabled="true"])'));
  if (items.length === 0) return;
  const current = items.indexOf(document.activeElement as HTMLElement);
  let next: number;
  if (delta === 'first') next = 0;
  else if (delta === 'last') next = items.length - 1;
  else next = current === -1 ? 0 : (current + delta + items.length) % items.length;
  items[next]?.focus();
}

/** A button that opens a menu of actions. Arrow keys move, Enter/Space selects, Escape closes. */
export function MenuButton({ items, align = 'start', label, menuLabel, children, ...buttonProps }: MenuButtonProps) {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  const close = useCallback(() => setOpen(false), []);

  const onMenuKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      moveFocus(el, 1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      moveFocus(el, -1);
    } else if (e.key === 'Home') {
      e.preventDefault();
      moveFocus(el, 'first');
    } else if (e.key === 'End') {
      e.preventDefault();
      moveFocus(el, 'last');
    } else if (e.key === 'Tab') {
      setOpen(false);
    }
  };

  return (
    <>
      <Button
        {...buttonProps}
        ref={anchorRef}
        aria-label={label}
        title={buttonProps.title ?? label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' && !open) {
            e.preventDefault();
            setOpen(true);
          }
        }}
      >
        {children}
      </Button>
      <Popover anchorRef={anchorRef} open={open} onClose={close} align={align} role="menu" label={menuLabel ?? label} id={menuId} className="menu">
        <div onKeyDown={onMenuKeyDown}>
          {items.map((item, i) => {
            if (item === 'separator') return <div key={i} role="separator" className="menu-sep" />;
            if ('heading' in item) {
              return (
                <div key={i} className="menu-heading" role="presentation">
                  {item.heading}
                </div>
              );
            }
            const checkable = item.checked !== undefined;
            return (
              <button
                key={i}
                type="button"
                role={checkable ? 'menuitemcheckbox' : 'menuitem'}
                aria-checked={checkable ? item.checked : undefined}
                aria-disabled={item.disabled || undefined}
                tabIndex={-1}
                className={cx('menu-item', item.danger && 'menu-item-danger')}
                onClick={() => {
                  if (item.disabled) return;
                  item.onSelect();
                  if (!checkable) {
                    setOpen(false);
                    anchorRef.current?.focus();
                  }
                }}
              >
                <span className="menu-item-icon" aria-hidden="true">
                  {checkable ? item.checked ? <Check size={14} /> : null : item.icon}
                </span>
                <span className="grow">{item.label}</span>
                {item.hint && <span className="menu-item-hint">{item.hint}</span>}
              </button>
            );
          })}
        </div>
      </Popover>
    </>
  );
}
