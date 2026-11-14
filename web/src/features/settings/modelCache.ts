/*
 * The model names a connection test loaded, remembered per endpoint in
 * localStorage, so that the provider form can offer them the next time it
 * is opened without another test. Only names are kept, never a key.
 */

import type { AiProviderKind } from '../../api/types';
import { readJson, writeJson } from '../../lib/storage';

const KEY = 'ai-models';
/** The least recently loaded endpoints are forgotten beyond this many. */
export const MAX_ENDPOINTS = 20;
const MAX_MODELS = 500;

export interface RememberedModels {
  models: string[];
  /** When they were loaded, as an ISO timestamp. */
  at: string;
}

/**
 * What a list is remembered under: the kind and the base URL, without a
 * trailing slash. `null` while the text is not an http(s) URL. Two base
 * URLs on one host are two endpoints: a gateway can serve a different set
 * of models under each path.
 */
export function endpointKey(kind: AiProviderKind, baseUrl: string): string | null {
  try {
    const url = new URL(baseUrl.trim());
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return `${kind} ${url.origin}${url.pathname.replace(/\/+$/, '')}`;
  } catch {
    return null;
  }
}

const isEntry = (value: unknown): value is RememberedModels => {
  if (typeof value !== 'object' || value === null) return false;
  const { models, at } = value as Partial<RememberedModels>;
  return Array.isArray(models) && models.length > 0 && models.every((m) => typeof m === 'string') && typeof at === 'string' && !Number.isNaN(Date.parse(at));
};

/** What is stored, without anything that is not an entry: storage can hold an older or damaged shape. */
function readAll(): Record<string, RememberedModels> {
  const raw = readJson<unknown>(KEY, null);
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {};
  return Object.fromEntries(Object.entries(raw).filter(([, entry]) => isEntry(entry))) as Record<string, RememberedModels>;
}

/** The models last loaded from this endpoint, or `null` when none are remembered. */
export function rememberedModels(kind: AiProviderKind, baseUrl: string): RememberedModels | null {
  const key = endpointKey(kind, baseUrl);
  return key === null ? null : (readAll()[key] ?? null);
}

/** Keep the models an endpoint just listed. An empty list is not kept: it would only hide an older, useful one. */
export function rememberModels(kind: AiProviderKind, baseUrl: string, models: readonly string[], now: number = Date.now()): void {
  const key = endpointKey(kind, baseUrl);
  if (key === null || models.length === 0) return;
  const all = { ...readAll(), [key]: { models: models.slice(0, MAX_MODELS), at: new Date(now).toISOString() } };
  const newestFirst = Object.entries(all).sort(([, a], [, b]) => Date.parse(b.at) - Date.parse(a.at));
  writeJson(KEY, Object.fromEntries(newestFirst.slice(0, MAX_ENDPOINTS)));
}
