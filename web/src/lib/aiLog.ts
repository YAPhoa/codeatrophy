// The AI activity log: how an entry is named and broken down, and how its
// raw request and response are laid out for reading.

import type { AiLogDetail, AiLogEntry, AiLogFilters, AiLogStatus, AiOperation, AiProvider, TokenUsage } from '../api/types';
import { formatDuration } from './format';

export const OPERATION_LABEL: Record<AiOperation, string> = {
  draft: 'Draft',
  variant: 'Variant',
  testcases: 'Test cases',
  code: 'Code',
  test: 'Connection test',
};

export const OPERATIONS = Object.keys(OPERATION_LABEL) as AiOperation[];

const STATUSES: readonly AiLogStatus[] = ['ok', 'failed', 'cancelled'];

/** The filters as the address carries them; the server applies them. */
export function filterParams(filters: AiLogFilters): Record<string, string> {
  return {
    ...(filters.providerId ? { provider: filters.providerId } : {}),
    ...(filters.operation ? { operation: filters.operation } : {}),
    ...(filters.status ? { status: filters.status } : {}),
  };
}

/** The filters in an address; a value that is none of the known ones is ignored. */
export function filtersFrom(params: URLSearchParams): AiLogFilters {
  const operation = params.get('operation') as AiOperation | null;
  const status = params.get('status') as AiLogStatus | null;
  return {
    ...(params.get('provider') ? { providerId: params.get('provider')! } : {}),
    ...(operation && OPERATIONS.includes(operation) ? { operation } : {}),
    ...(status && STATUSES.includes(status) ? { status } : {}),
  };
}

/** Where the log is, optionally narrowed to a provider or opened at an entry. */
export function aiLogPath(to: { providerId?: string; entryId?: string } = {}): string {
  const query = new URLSearchParams(filterParams({ providerId: to.providerId }));
  if (to.entryId) query.set('entry', to.entryId);
  const s = query.toString();
  return `/settings/ai-activity${s ? `?${s}` : ''}`;
}

/** The moment 30 days before `now`, as the timestamp a partial clear takes. */
export function thirtyDaysBefore(now: number = Date.now()): string {
  return new Date(now - 30 * 24 * 3600 * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * The token counts of an entry as label and value, exact and in the order
 * they are read; counts the provider did not report are left out.
 */
export function usageBreakdown(usage: TokenUsage): [label: string, value: string][] {
  const rows: [string, number | null | undefined][] = [
    ['Input', usage.inputTokens],
    ['Output', usage.outputTokens],
    ['Reasoning', usage.reasoningTokens],
    ['Cache read', usage.cacheReadTokens],
    ['Cache write', usage.cacheWriteTokens],
  ];
  return rows.flatMap(([label, n]) => (n == null ? [] : [[label, n.toLocaleString()] as [string, string]]));
}

/** Everything about an entry that fits a label and a value. */
export function entryFacts(entry: AiLogEntry, time: string): [label: string, value: string][] {
  return [['Provider', entry.providerName], ['Model', entry.model], ...usageBreakdown(entry.usage), ['Duration', formatDuration(entry.durationMs)], ['Time', time]];
}

export interface RawText {
  text: string;
  /** How to colour it: JSON, or `null` for plain text. */
  language: 'json' | null;
}

/** The request as it was sent, as indented JSON. */
export function rawRequest(request: unknown): RawText {
  return { text: JSON.stringify(request, null, 2) ?? '', language: 'json' };
}

/** The response: indented when it is JSON, otherwise the text as it came. */
export function rawResponse(response: string): RawText {
  const trimmed = response.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      return { text: JSON.stringify(JSON.parse(trimmed), null, 2), language: 'json' };
    } catch {
      // Not JSON after all, or cut off: shown as it is.
    }
  }
  return { text: response, language: null };
}

/**
 * The providers to offer as a filter: those configured and those seen in the
 * entries loaded so far (an entry outlives its provider), by name.
 */
export function logProviders(providers: readonly Pick<AiProvider, 'id' | 'name'>[], entries: readonly AiLogEntry[], selected: string | null = null): { value: string; label: string }[] {
  const names = new Map<string, string>();
  for (const p of providers) names.set(p.id, p.name);
  for (const e of entries) if (!names.has(e.providerId)) names.set(e.providerId, e.providerName);
  if (selected !== null && !names.has(selected)) names.set(selected, 'A deleted provider');
  return [...names].map(([value, label]) => ({ value, label })).sort((a, b) => a.label.localeCompare(b.label, 'en', { sensitivity: 'base' }));
}

/** A file name for an exported entry: what it was and when, safe on any system. */
export function exportName(entry: Pick<AiLogDetail, 'operation' | 'createdAt' | 'id'>): string {
  const when = entry.createdAt.replace(/[^0-9TZ]/g, '').replace(/Z$/, '');
  return `ai-${entry.operation}-${when || entry.id}.json`;
}
