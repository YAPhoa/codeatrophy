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
import { Link } from 'react-router';
import { Check } from 'lucide-react';
import { Button, cx, type ButtonProps } from './Button';
import { exitOnRemove } from '../lib/motion';

interface PopoverProps {
  anchorRef: RefObject<HTMLElement | null>;
  /** What it is placed against, when that is not its anchor (a bar the anchor sits in). */
  placeRef?: RefObject<HTMLElement | null>;
  open: boolean;
  onClose: () => void;
  align?: 'start' | 'end';
  /** Where it goes when there is room on both sides of the anchor. Under it unless told otherwise. */
  side?: 'below' | 'above';
  /** Make the popover at least as wide as its anchor. */
  matchWidth?: boolean;
  className?: string;
  role?: string;
  label?: string;
  id?: string;
  children: ReactNode;
  /** Keep focus where it is (for comboboxes whose input stays focused). */
  noAutoFocus?: boolean;
  /** The duration token its exit lasts, when it closes quicker than a popover does (a tooltip). */
  exitToken?: string;
}

/**
 * A floating panel positioned under (or, when there is no room, above) its
 * anchor, or the other way round with `side="above"`. Closes on Escape, on a click outside, and when focus leaves it.
 */
export function Popover({ anchorRef, placeRef, open, onClose, align = 'start', side = 'below', matchWidth, className, role, label, id, children, noAutoFocus, exitToken }: PopoverProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number; minWidth?: number; maxHeight: number; origin: string } | null>(null);
  const attach = useCallback(
    (node: HTMLDivElement | null) => {
      ref.current = node;
      const exit = exitOnRemove(node, exitToken);
      return () => {
        ref.current = null;
        exit?.();
      };
    },
    [exitToken],
  );

  const place = useCallback(() => {
    const anchor = placeRef?.current ?? anchorRef.current;
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
    const openUp = side === 'above' ? natural <= above || above > below : natural > below && above > below;
    const maxHeight = Math.max(120, openUp ? above : below);
    const height = Math.min(natural, maxHeight);
    let left = align === 'end' ? a.right - width : a.left;
    left = Math.max(margin, Math.min(left, vw - width - margin));
    const top = openUp ? a.top - gap - height : a.bottom + gap;
    // It grows out of the corner nearest its anchor.
    const origin = `${align === 'end' ? 'right' : 'left'} ${openUp ? 'bottom' : 'top'}`;
    setPos({ top, left, minWidth: matchWidth ? a.width : undefined, maxHeight, origin });
  }, [anchorRef, placeRef, align, side, matchWidth]);

  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    place();
    // Scrolling anywhere (a capture listener) and resizing can move the
    // anchor; measure at most once a frame for them. The popover changing size
    // (a combobox list filtering down) is caught by the ResizeObserver, so a
    // re-render alone measures nothing.
    let frame = 0;
    const schedule = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        place();
      });
    };
    window.addEventListener('resize', schedule);
    window.addEventListener('scroll', schedule, true);
    const el = ref.current;
    const ro = el && typeof ResizeObserver !== 'undefined' ? new ResizeObserver(schedule) : null;
    if (el) ro?.observe(el);
    return () => {
      cancelAnimationFrame(frame);
      ro?.disconnect();
      window.removeEventListener('resize', schedule);
      window.removeEventListener('scroll', schedule, true);
    };
  }, [open, place]);

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
    // A menu of choices opens on the one in effect.
    const target =
      el.querySelector<HTMLElement>('[data-autofocus], [role="menuitemradio"][aria-checked="true"]') ??
      el.querySelector<HTMLElement>('[role^="menuitem"], input, button, [tabindex]');
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
      ref={attach}
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
        transformOrigin: pos?.origin,
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
  | ({
      label: string;
      icon?: ReactNode;
      danger?: boolean;
      disabled?: boolean;
      /** Render as a checkable item; the menu stays open when it is toggled. */
      checked?: boolean;
      /**
       * Render as one choice of several (a radio item): `true` on the choice
       * in effect, `false` on the others. It is marked with a check, in the
       * icon's place or, when the choices carry icons, at the end; choosing
       * closes the menu.
       */
      selected?: boolean;
      hint?: string;
    } & (
      | { onSelect: () => void; to?: undefined }
      /** An item that goes to another page is a link, so it can be opened in a new tab. */
      | { to: string; onSelect?: undefined }
    ))
  | 'separator'
  | { heading: string };

interface MenuButtonProps extends Omit<ButtonProps, 'onClick' | 'onSelect'> {
  items: MenuEntry[];
  align?: 'start' | 'end';
  /** Accessible name for icon-only triggers, and their tooltip unless `noTitle`. */
  label?: string;
  menuLabel?: string;
  /** No native tooltip: something else shows the label (the navigation rail's). */
  noTitle?: boolean;
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
export function MenuButton({ items, align = 'start', label, menuLabel, noTitle, children, ...buttonProps }: MenuButtonProps) {
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

  // The gutter lines the labels up past icons and marks; a menu with neither leaves it out.
  const gutter = items.some((e) => typeof e === 'object' && !('heading' in e) && (e.icon !== undefined || e.checked !== undefined || e.selected !== undefined));

  return (
    <>
      <Button
        {...buttonProps}
        ref={anchorRef}
        aria-label={label}
        title={noTitle ? undefined : (buttonProps.title ?? label)}
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
            const choice = item.selected !== undefined;
            // aria-checked already says what is on; the check mark is for the eye.
            const mark = <Check size={14} className="menu-item-check" aria-hidden="true" />;
            const markInGutter = checkable || (choice && !item.icon);
            const content = (
              <>
                {gutter && (
                  <span className="menu-item-icon" aria-hidden="true">
                    {markInGutter ? (item.checked || item.selected ? mark : null) : item.icon}
                  </span>
                )}
                <span className="grow">{item.label}</span>
                {choice && !markInGutter ? (
                  <span className="menu-item-end" aria-hidden="true">
                    {item.selected && mark}
                  </span>
                ) : (
                  item.hint && <span className="menu-item-hint">{item.hint}</span>
                )}
              </>
            );
            if (item.to !== undefined && !item.disabled) {
              return (
                <Link
                  key={i}
                  to={item.to}
                  role="menuitem"
                  tabIndex={-1}
                  className={cx('menu-item', item.danger && 'menu-item-danger')}
                  onClick={() => setOpen(false)}
                  onKeyDown={(e) => {
                    // A menu item answers to Space as well as Enter.
                    if (e.key === ' ') {
                      e.preventDefault();
                      e.currentTarget.click();
                    }
                  }}
                >
                  {content}
                </Link>
              );
            }
            return (
              <button
                key={i}
                type="button"
                role={checkable ? 'menuitemcheckbox' : choice ? 'menuitemradio' : 'menuitem'}
                aria-checked={checkable ? item.checked : choice ? item.selected : undefined}
                aria-disabled={item.disabled || undefined}
                tabIndex={-1}
                className={cx('menu-item', item.danger && 'menu-item-danger')}
                onClick={() => {
                  if (item.disabled) return;
                  item.onSelect?.();
                  if (!checkable) {
                    setOpen(false);
                    anchorRef.current?.focus();
                  }
                }}
              >
                {content}
              </button>
            );
          })}
        </div>
      </Popover>
    </>
  );
}
