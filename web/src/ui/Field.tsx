import { useId, useState, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';
import { Minus, Plus } from 'lucide-react';
import { IconButton, cx } from './Button';
import { InfoTip } from './InfoTip';
import { useSlidingIndicator } from '../lib/motion';

interface FieldProps {
  label: string;
  hint?: ReactNode;
  /** An explanation kept behind an "i" beside the label, for what would be too much as a hint. */
  info?: ReactNode;
  error?: string | null;
  /** Hide the label visually (it stays available to assistive technology). */
  hideLabel?: boolean;
  /** Show an error at the end of the label's line, not under the control, so that it moves nothing as it comes and goes. */
  inlineError?: boolean;
  /** Keep one line under the control for the hint, so that one coming or going does not move what follows. */
  reserve?: boolean;
  className?: string;
  /** The control's `name`. Defaults to one made from the label: "Time limit (ms)" is `time-limit-ms`. */
  name?: string;
  children: (props: { id: string; name: string; 'aria-describedby'?: string; 'aria-invalid'?: boolean }) => ReactNode;
}

/** A form control's `name` from its label: lower case, words joined by hyphens. */
export function fieldName(label: string): string {
  return (
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || 'field'
  );
}

/** Label, control, hint and error message wired together for accessibility. */
export function Field({ label, hint, info, error, hideLabel, inlineError, reserve, className, name, children }: FieldProps) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const describedBy = [hint ? hintId : null, error ? errorId : null].filter(Boolean).join(' ') || undefined;
  const labelOnly = (
    <label htmlFor={id} className={cx('field-label', hideLabel && 'sr-only')}>
      {label}
    </label>
  );
  const labelEl = info ? (
    <div className="field-label-row">
      {labelOnly}
      <InfoTip label={`About ${label.toLowerCase()}`}>{info}</InfoTip>
    </div>
  ) : (
    labelOnly
  );
  const errorEl = error && (
    <div id={errorId} className="field-error" role="alert">
      {error}
    </div>
  );
  const message = (
    <>
      {hint && (
        <div id={hintId} className="field-hint">
          {hint}
        </div>
      )}
      {!inlineError && errorEl}
    </>
  );
  return (
    <div className={cx('field', className)}>
      {inlineError ? (
        <div className="field-head">
          {labelEl}
          {errorEl}
        </div>
      ) : (
        labelEl
      )}
      {children({ id, name: name ?? fieldName(label), 'aria-describedby': describedBy, 'aria-invalid': error ? true : undefined })}
      {reserve ? <div className="field-message">{message}</div> : message}
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
  inlineError?: boolean;
  fieldClassName?: string;
};

export function TextField({ label, value, onChange, hint, error, hideLabel, inlineError, fieldClassName, className, ...rest }: TextFieldProps) {
  return (
    <Field label={label} hint={hint} error={error} hideLabel={hideLabel} inlineError={inlineError} className={fieldClassName}>
      {/* These fields hold titles, names and settings, never personal details: no autofill unless a caller asks for it. */}
      {(a) => <input autoComplete="off" {...rest} {...a} name={rest.name ?? a.name} className={cx('input', className)} value={value} onChange={(e) => onChange(e.target.value)} />}
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
          translate={mono ? 'no' : undefined}
          autoComplete="off"
          {...rest}
          {...a}
          name={rest.name ?? a.name}
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
  info?: ReactNode;
  error?: string | null;
  hideLabel?: boolean;
  fieldClassName?: string;
};

export function SelectField<T extends string>({ label, value, onChange, options, hint, info, error, hideLabel, fieldClassName, className, ...rest }: SelectFieldProps<T>) {
  return (
    <Field label={label} hint={hint} info={info} error={error} hideLabel={hideLabel} className={fieldClassName}>
      {(a) => (
        <select {...rest} {...a} name={rest.name ?? a.name} className={cx('input select', className)} value={value} onChange={(e) => onChange(e.target.value as T)}>
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
        name={typeof label === 'string' ? fieldName(label) : undefined}
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        aria-describedby={hint ? `${id}-hint` : undefined}
      />
      <div>
        <label htmlFor={id} className="check-label">
          {label}
        </label>
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
  const ref = useSlidingIndicator<HTMLDivElement>('.segmented-option.is-selected', { pseudo: '::before' });
  return (
    <div ref={ref} role="radiogroup" aria-label={label} className={cx('segmented', size === 'sm' && 'segmented-sm', className)}>
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

/** Read a whole number typed into a field. Returns null unless it is inside the range, so that a half-typed value is not acted on. */
export function parseWholeNumber(text: string, min: number, max: number): number | null {
  if (!/^\s*\d+\s*$/.test(text)) return null;
  const n = Number(text);
  return n >= min && n <= max ? n : null;
}

interface NumberStepperProps {
  value: number;
  onChange: (value: number) => void;
  min: number;
  max: number;
  /** Names of the two buttons, e.g. "Smaller font" and "Larger font". */
  decreaseLabel: string;
  increaseLabel: string;
  /** Shown after the number, e.g. "px". */
  unit?: string;
  disabled?: boolean;
  id?: string;
  'aria-describedby'?: string;
}

/**
 * A whole number with a step button on either side. A typed value in range
 * is passed on as it is typed; anything else waits until the field is left,
 * and is then brought into range or dropped.
 */
export function NumberStepper({ value, onChange, min, max, decreaseLabel, increaseLabel, unit, disabled, id, 'aria-describedby': describedBy }: NumberStepperProps) {
  // What is being typed, while it differs from the value.
  const [draft, setDraft] = useState<string | null>(null);
  const clamp = (n: number) => Math.min(max, Math.max(min, Math.round(n)));
  const commit = (next: number) => {
    setDraft(null);
    if (next !== value) onChange(next);
  };

  return (
    <div className="stepper">
      <IconButton label={decreaseLabel} icon={<Minus size={14} aria-hidden="true" />} disabled={disabled || value <= min} onClick={() => commit(clamp(value - 1))} />
      <input
        id={id}
        className="input stepper-input"
        type="number"
        inputMode="numeric"
        autoComplete="off"
        min={min}
        max={max}
        step={1}
        value={draft ?? String(value)}
        disabled={disabled}
        aria-describedby={describedBy}
        aria-invalid={draft != null && parseWholeNumber(draft, min, max) == null ? true : undefined}
        onChange={(e) => {
          const text = e.target.value;
          const typed = parseWholeNumber(text, min, max);
          if (typed == null) setDraft(text);
          else commit(typed);
        }}
        onBlur={() => {
          if (draft == null) return;
          const typed = Number(draft);
          commit(draft.trim() === '' || Number.isNaN(typed) ? value : clamp(typed));
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur();
        }}
      />
      {unit && (
        <span className="stepper-unit" aria-hidden="true">
          {unit}
        </span>
      )}
      <IconButton label={increaseLabel} icon={<Plus size={14} aria-hidden="true" />} disabled={disabled || value >= max} onClick={() => commit(clamp(value + 1))} />
    </div>
  );
}
