import type { AiJob, AiJobKind, DraftSummary } from '../../api/types';
import type { Tone } from '../../lib/format';

/** Where a draft stands, in a word or two, and the tone it is shown in. */
export function draftStateLabel(draft: Pick<DraftSummary, 'state' | 'edited'>): { text: string; tone: Tone } {
  switch (draft.state) {
    case 'drafting':
      return { text: 'Drafting…', tone: 'neutral' };
    case 'ready':
      return { text: 'Ready to review', tone: 'ok' };
    case 'failed':
      return { text: 'Failed', tone: 'danger' };
    case 'edited':
      // Content without a form of the user's: the first generation was cancelled.
      return draft.edited ? { text: 'Edited', tone: 'neutral' } : { text: 'Not drafted', tone: 'neutral' };
    case 'new':
      return { text: 'Not drafted', tone: 'neutral' };
  }
}

const KIND_LABEL: Record<AiJobKind, string> = { draft: 'Draft', variant: 'Variant', testcases: 'Test cases', code: 'Code' };

/** The kind of a job in a word or two. */
export const jobKindLabel = (kind: AiJobKind): string => KIND_LABEL[kind];

/** Where a job's outcome is looked at: its draft, or the screen it was started from. */
export function jobTarget(job: Pick<AiJob, 'draftId' | 'origin'>): string | null {
  if (job.draftId) return `/drafts/${job.draftId}`;
  return job.origin;
}

/**
 * Where a job in the AI jobs list leads: the screen that collects it, or else
 * the nearest page that is still there, its item or the Drafts list. A draft
 * missing from `drafts` (the ids of those that exist, once known) is gone, so
 * its job leads to the list.
 */
export function jobLink(job: Pick<AiJob, 'kind' | 'itemId' | 'draftId' | 'origin'>, drafts?: ReadonlySet<string> | null): string {
  if (job.draftId) return drafts && !drafts.has(job.draftId) ? '/drafts' : `/drafts/${job.draftId}`;
  if (job.origin) return job.origin;
  if (job.itemId) return `/items/${job.itemId}`;
  return job.kind === 'draft' || job.kind === 'variant' ? '/drafts' : '/';
}

/** Whether a job's outcome is collected on the screen at `pathname`, so the AI jobs list leaves it to that screen. */
export function jobBelongsTo(job: Pick<AiJob, 'draftId' | 'origin'>, pathname: string): boolean {
  const target = jobTarget(job);
  if (!target) return false;
  return target.split(/[?#]/)[0] === pathname;
}

/** Seconds as the AI jobs list shows them: "8 s", "1:05". */
export function elapsedLabel(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}\u00a0s`;
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}
