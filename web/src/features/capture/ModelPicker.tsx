import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Cpu } from 'lucide-react';
import { isApiError } from '../../api/client';
import { qk, useAiSettings } from '../../api/queries';
import type { AiSettings } from '../../api/types';
import { providerIdToSend, providerLabel, readyProviders, resolveProviderChoice, type ProviderChoice } from '../../lib/providerChoice';
import { Select } from '../../ui/Select';

export type { ProviderChoice } from '../../lib/providerChoice';

/**
 * The provider a page's AI requests use. `request` is what to spread into a
 * request: a `providerId` only for an explicit choice other than the
 * default. When a request is turned down because the provider it named is
 * gone or not ready, the providers are loaded again so the picker corrects
 * itself; pass the page's last request error as `error`.
 */
export function useProviderChoice(choice: ProviderChoice, error: unknown) {
  const qc = useQueryClient();
  const { data: settings } = useAiSettings();
  const rejected = isApiError(error) && error.status === 422 && error.fields.providerId != null;
  useEffect(() => {
    if (rejected) void qc.invalidateQueries({ queryKey: qk.aiSettings });
  }, [rejected, error, qc]);
  return { settings, value: resolveProviderChoice(choice, settings), request: providerIdToSend(choice, settings) };
}

/** One option per ready provider, default first: its name and model, and which one is the default. */
export function modelOptions(settings: AiSettings | undefined): { value: string; label: string }[] {
  if (!settings) return [];
  return readyProviders(settings).map((p) => ({ value: p.id, label: `${providerLabel(p, settings)}${p.isDefault ? ' (default)' : ''}` }));
}

interface ModelPickerProps {
  settings: AiSettings | undefined;
  /** The resolved choice, from `useProviderChoice`. */
  value: string | null;
  onChange: (providerId: string) => void;
  disabled?: boolean;
  id?: string;
}

/** Compact chooser of the provider, and so the model, a generation uses. Absent when there is nothing to choose. */
export function ModelPicker({ settings, value, onChange, disabled, id = 'model-picker' }: ModelPickerProps) {
  const options = modelOptions(settings);
  if (options.length < 2) return null;
  return (
    <span className="style-picker model-picker">
      <label htmlFor={id} className="style-picker-label">
        <Cpu size={13} aria-hidden="true" />
        Model
      </label>
      <Select name="model" id={id} className="input-sm" value={value ?? ''} disabled={disabled} onChange={onChange} options={options} />
    </span>
  );
}
