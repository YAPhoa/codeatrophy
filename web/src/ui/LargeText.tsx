import { useMemo } from 'react';
import { Download, EyeOff, X } from 'lucide-react';
import { saveBlob } from '../lib/download';
import { describeTextSize, isLargeText, textStats } from '../lib/largeText';
import { Button, cx } from './Button';
import { Field } from './Field';

/** Hand the browser a text to save. */
export const saveText = (text: string, filename: string): void => saveBlob(new Blob([text], { type: 'text/plain;charset=utf-8' }), filename);

interface LargeTextProps {
  text: string;
  /** Name of the downloaded file. */
  filename: string;
  /** Offered where the field is otherwise editable: empty it, so it can be typed again. */
  onClear?: () => void;
  /** Names the block for assistive technology, e.g. "Input (stdin)". */
  label?: string;
  className?: string;
}

/**
 * Test data too large to put on the page: kept out of sight, with its size
 * and the whole of it as a download. Callers decide with `isLargeText` and
 * keep their usual view for anything smaller.
 */
export function LargeText({ text, filename, onClear, label, className }: LargeTextProps) {
  const size = useMemo(() => describeTextSize(textStats(text)), [text]);
  return (
    <div className={cx('concealed large-text', className)} role="group" aria-label={label}>
      <EyeOff size={15} aria-hidden="true" />
      <span className="grow">
        {onClear ? 'Too large to show or edit' : 'Too large to show'} <span className="large-text-size">· {size}</span>
      </span>
      <span className="large-text-actions">
        {onClear && (
          <Button size="sm" variant="ghost" icon={<X size={13} />} onClick={onClear}>
            Clear
          </Button>
        )}
        <Button size="sm" icon={<Download size={13} />} onClick={() => saveText(text, filename)}>
          Download
        </Button>
      </span>
    </div>
  );
}

interface TestDataFieldProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  rows: number;
  /** Name of the file a large value downloads as. */
  filename: string;
  error?: string | null;
}

/**
 * An input or expected output of a test case: a textarea, or — for a value
 * too large to edit in place — a block that offers it as a download, or to
 * clear it.
 */
export function TestDataField({ label, value, onChange, rows, filename, error }: TestDataFieldProps) {
  if (!isLargeText(value)) {
    return (
      <Field label={label} error={error}>
        {(a) => <textarea {...a} className="input textarea mono" rows={rows} spellCheck={false} translate="no" value={value} onChange={(e) => onChange(e.target.value)} />}
      </Field>
    );
  }
  return (
    <div className="field">
      <span className="field-label">{label}</span>
      <LargeText text={value} filename={filename} onClear={() => onChange('')} label={label} />
      {error && (
        <div className="field-error" role="alert">
          {error}
        </div>
      )}
    </div>
  );
}
