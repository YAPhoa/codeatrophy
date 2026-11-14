import type { AiProvider, AiSettings } from '../api/types';

/**
 * What a model picker holds: the id of the provider the user chose for this
 * session, or `undefined` while they have not chosen, which means the
 * default.
 */
export type ProviderChoice = string | undefined;

/** The providers a request can be sent to: the ready ones, default first, as the settings list them. */
export function readyProviders(settings: AiSettings | undefined): AiProvider[] {
  return settings?.providers.filter((p) => p.ready) ?? [];
}

/** What a picker shows for a provider: its name and the model it uses. */
export function providerLabel(provider: AiProvider, settings: AiSettings): string {
  const model = provider.model ?? settings.kinds[provider.kind]?.defaultModel ?? null;
  return model ? `${provider.name} · ${model}` : provider.name;
}

/**
 * The provider a request goes to. No choice, or a chosen provider that is
 * gone or no longer ready, means the default (`null` while there is none or
 * the settings have not loaded).
 */
export function resolveProviderChoice(choice: ProviderChoice, settings: AiSettings | undefined): string | null {
  const ready = readyProviders(settings);
  if (choice !== undefined && ready.some((p) => p.id === choice)) return choice;
  return ready.find((p) => p.isDefault)?.id ?? null;
}

/**
 * The `providerId` to put in a request: only an explicit, still valid choice
 * that is not the default. Otherwise the field is left out and the server
 * uses the default, as it would with no picker at all.
 */
export function providerIdToSend(choice: ProviderChoice, settings: AiSettings | undefined): { providerId?: string } {
  const resolved = resolveProviderChoice(choice, settings);
  if (choice === undefined || resolved !== choice) return {};
  return settings?.providers.find((p) => p.id === choice)?.isDefault ? {} : { providerId: choice };
}
