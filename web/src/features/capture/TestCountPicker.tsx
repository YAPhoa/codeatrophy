import { FlaskConical } from 'lucide-react';
import { useMeta, usePreferences } from '../../api/queries';
import { NumberStepper } from '../../ui/Field';

/**
 * How many test cases a draft is asked for: the choice made, else the
 * "Test cases to generate" preference, within the server's bounds.
 */
export function useTestCaseCount(choice: number | undefined): { count: number; max: number } {
  const max = useMeta().data?.limits.maxGeneratedTestCases ?? 30;
  const preferred = usePreferences().generatedTestCases;
  return { count: Math.min(max, Math.max(1, choice || preferred)), max };
}

interface TestCountPickerProps {
  /** The resolved count, from `useTestCaseCount`. */
  value: number;
  max: number;
  onChange: (count: number) => void;
  disabled?: boolean;
  id?: string;
}

/** Compact stepper for the number of test cases a generation writes, beside the style and model. */
export function TestCountPicker({ value, max, onChange, disabled, id = 'test-count' }: TestCountPickerProps) {
  return (
    <span className="style-picker test-count-picker">
      <label htmlFor={id} className="style-picker-label">
        <FlaskConical size={13} aria-hidden="true" />
        Test cases
      </label>
      <NumberStepper size="sm" id={id} value={value} onChange={onChange} min={1} max={max} decreaseLabel="Fewer test cases" increaseLabel="More test cases" disabled={disabled} />
    </span>
  );
}
