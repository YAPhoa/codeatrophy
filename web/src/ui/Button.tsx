import type { ButtonHTMLAttributes, ReactNode, Ref } from 'react';
import { Link, type LinkProps } from 'react-router';

export type ButtonVariant = 'default' | 'primary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md';

interface CommonProps {
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: ReactNode;
  /** Shows a spinner in place of the icon and disables the button. */
  busy?: boolean;
}

export type ButtonProps = CommonProps & ButtonHTMLAttributes<HTMLButtonElement> & { ref?: Ref<HTMLButtonElement> };

export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}

function classes(variant: ButtonVariant, size: ButtonSize, iconOnly: boolean, extra?: string): string {
  return cx('btn', `btn-${variant}`, size === 'sm' && 'btn-sm', iconOnly && 'btn-icon', extra);
}

export function Button({ variant = 'default', size = 'md', icon, busy, children, className, disabled, ref, ...rest }: ButtonProps) {
  return (
    <button
      ref={ref}
      type="button"
      {...rest}
      className={classes(variant, size, children == null, className)}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
    >
      {busy ? <span className="spinner" aria-hidden="true" /> : icon}
      {children != null && <span className="btn-label">{children}</span>}
    </button>
  );
}

/** A button that shows only an icon. `label` is required: it is the accessible name and the tooltip. */
export function IconButton({ label, ...rest }: Omit<ButtonProps, 'children' | 'aria-label'> & { label: string }) {
  return <Button variant="ghost" {...rest} aria-label={label} title={rest.title ?? label} />;
}

export function LinkButton({
  variant = 'default',
  size = 'md',
  icon,
  children,
  className,
  ...rest
}: CommonProps & LinkProps) {
  return (
    <Link {...rest} className={classes(variant, size, children == null, className)}>
      {icon}
      {children != null && <span className="btn-label">{children}</span>}
    </Link>
  );
}
