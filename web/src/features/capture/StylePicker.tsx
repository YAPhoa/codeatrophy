import { Link } from 'react-router';
import { PenLine } from 'lucide-react';
import type { StylePreset } from '../../api/types';
import type { StyleChoice } from '../../lib/styleChoice';
import { Select } from '../../ui/Select';

export { resolveStyleChoice, type StyleChoice } from '../../lib/styleChoice';

interface StylePickerProps {
  styles: readonly StylePreset[];
  value: StyleChoice;
  onChange: (value: StyleChoice) => void;
  disabled?: boolean;
  id?: string;
}

const NONE = '__none__';

/**
 * Compact chooser for the style preset a generation is written in. With no
 * presets it steps out of the way and offers a quiet link to create one.
 */
export function StylePicker({ styles, value, onChange, disabled, id = 'style-picker' }: StylePickerProps) {
  if (styles.length === 0) {
    return (
      <Link to="/settings/styles" className="style-link" title="Save your own standing instructions for how drafts are written">
        <PenLine size={14} aria-hidden="true" />
        Add a writing style
      </Link>
    );
  }
  return (
    <span className="style-picker">
      <label htmlFor={id} className="style-picker-label">
        <PenLine size={14} aria-hidden="true" />
        Style
      </label>
      <Select
        name="style"
        id={id}
        className="input-sm"
        value={value ?? NONE}
        disabled={disabled}
        onChange={(v) => onChange(v === NONE ? null : v)}
        title={styles.find((s) => s.id === value)?.instructions ?? 'Only the built-in authoring conventions'}
        options={[{ value: NONE, label: 'No style (built-in)' }, ...styles.map((s) => ({ value: s.id, label: `${s.name}${s.isDefault ? ' (default)' : ''}` }))]}
      />
    </span>
  );
}
