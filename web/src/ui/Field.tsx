import { useId, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';
import { cx } from './Button';

interface FieldProps {
  label: string;
  hint?: ReactNode;
  error?: string | null;
  /** Hide the label visually (it stays available to assistive technology). */
  hideLabel?: boolean;
  className?: string;
  children: (props: { id: string; 'aria-describedby'?: string; 'aria-invalid'?: boolean }) => ReactNode;
}

/** Label, control, hint and error message wired together for accessibility. */
export function Field({ label, hint, error, hideLabel, className, children }: FieldProps) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const describedBy = [hint ? hintId : null, error ? errorId : null].filter(Boolean).join(' ') || undefined;
  return (
    <div className={cx('field', className)}>
      <label htmlFor={id} className={cx('field-label', hideLabel && 'sr-only')}>
        {label}
      </label>
      {children({ id, 'aria-describedby': describedBy, 'aria-invalid': error ? true : undefined })}
      {hint && (
        <div id={hintId} className="field-hint">
          {hint}
        </div>
      )}
      {error && (
        <div id={errorId} className="field-error" role="alert">
          {error}
        </div>
      )}
    </div>
  );
}

type TextFieldProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'onChange' | 'value' | 'children'> & {
  label: string;
  value: string;
  onChange: (value: string) => void;
  hint?: ReactNode;
  error?: string | null;
  hideLabel?: boolean;
  fieldClassName?: string;
};

export function TextField({ label, value, onChange, hint, error, hideLabel, fieldClassName, className, ...rest }: TextFieldProps) {
  return (
    <Field label={label} hint={hint} error={error} hideLabel={hideLabel} className={fieldClassName}>
      {(a) => <input {...rest} {...a} className={cx('input', className)} value={value} onChange={(e) => onChange(e.target.value)} />}
    </Field>
  );
}

type TextAreaFieldProps = Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'onChange' | 'value' | 'children'> & {
  label: string;
  value: string;
  onChange: (value: string) => void;
  hint?: ReactNode;
  error?: string | null;
  hideLabel?: boolean;
  mono?: boolean;
  fieldClassName?: string;
};

export function TextAreaField({ label, value, onChange, hint, error, hideLabel, mono, fieldClassName, className, ...rest }: TextAreaFieldProps) {
  return (
    <Field label={label} hint={hint} error={error} hideLabel={hideLabel} className={fieldClassName}>
      {(a) => (
        <textarea
          spellCheck={mono ? false : undefined}
          {...rest}
          {...a}
          className={cx('input textarea', mono && 'mono', className)}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
    </Field>
  );
}

type SelectFieldProps<T extends string> = Omit<SelectHTMLAttributes<HTMLSelectElement>, 'onChange' | 'value' | 'children'> & {
  label: string;
  value: T;
  onChange: (value: T) => void;
  options: readonly { value: T; label: string; disabled?: boolean }[];
  hint?: ReactNode;
  error?: string | null;
  hideLabel?: boolean;
  fieldClassName?: string;
};

export function SelectField<T extends string>({ label, value, onChange, options, hint, error, hideLabel, fieldClassName, className, ...rest }: SelectFieldProps<T>) {
  return (
    <Field label={label} hint={hint} error={error} hideLabel={hideLabel} className={fieldClassName}>
      {(a) => (
        <select {...rest} {...a} className={cx('input select', className)} value={value} onChange={(e) => onChange(e.target.value as T)}>
          {options.map((o) => (
            <option key={o.value} value={o.value} disabled={o.disabled}>
              {o.label}
            </option>
          ))}
        </select>
      )}
    </Field>
  );
}

interface CheckboxProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: ReactNode;
  hint?: ReactNode;
  disabled?: boolean;
  className?: string;
}

export function Checkbox({ checked, onChange, label, hint, disabled, className }: CheckboxProps) {
  const id = useId();
  return (
    <div className={cx('check', className)}>
      <input
        id={id}
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        aria-describedby={hint ? `${id}-hint` : undefined}
      />
      <div>
        <label htmlFor={id}>{label}</label>
        {hint && (
          <div id={`${id}-hint`} className="field-hint">
            {hint}
          </div>
        )}
      </div>
    </div>
  );
}

interface SegmentedProps<T extends string> {
  label: string;
  value: T;
  onChange: (value: T) => void;
  options: readonly { value: T; label: ReactNode; title?: string; disabled?: boolean }[];
  size?: 'sm' | 'md';
  className?: string;
}

/** A compact single-choice control, exposed as a radio group. */
export function Segmented<T extends string>({ label, value, onChange, options, size = 'md', className }: SegmentedProps<T>) {
  const name = useId();
  return (
    <div role="radiogroup" aria-label={label} className={cx('segmented', size === 'sm' && 'segmented-sm', className)}>
      {options.map((o) => (
        <label key={o.value} className={cx('segmented-option', value === o.value && 'is-selected', o.disabled && 'is-disabled')} title={o.title}>
          <input
            type="radio"
            className="sr-only"
            name={name}
            value={o.value}
            checked={value === o.value}
            disabled={o.disabled}
            onChange={() => onChange(o.value)}
          />
          <span>{o.label}</span>
        </label>
      ))}
    </div>
  );
}
