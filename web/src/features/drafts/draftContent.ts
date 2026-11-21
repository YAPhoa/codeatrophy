// What the UI keeps in a draft's `content` (docs/api.md, "Drafts"): the
// review form and what is shown with it, the choices the draft was started
// with, and how a generation's result becomes a form.

import type { AppliedStyle, Draft, DraftCheck, DraftResponse, GenerationUsage, InterfaceHint, ItemType, ProblemInterface, VariantMode } from '../../api/types';
import { checkedState, formFromDraft, upgradeForm, type CheckedDraft, type ItemFormState } from '../../lib/itemForm';
import type { ProviderChoice } from '../../lib/providerChoice';
import type { StyleChoice } from '../../lib/styleChoice';

/** What a capture starts from. */
export interface CaptureInput {
  text: string;
  typeHint: 'auto' | ItemType;
  interfaceHint: InterfaceHint;
}

/** What a variant is asked for. */
export interface VariantInput {
  mode: VariantMode;
  instruction: string;
  /** What the solver writes in the new problem; unset keeps the original's interface. */
  interfaceHint?: ProblemInterface;
}

export interface DraftContent extends CheckedDraft {
  /** The shape of this document; a later one may read an earlier one. */
  v: 1;
  /** The review form; `null` until the first generation arrives, or the user writes it by hand. */
  form: ItemFormState | null;
  assumptions: string[];
  /** The form came from the AI (shows the assumptions and the revision bar). */
  aiDrafted: boolean;
  appliedStyle: AppliedStyle | null;
  /** What running the reference solution found, and the `checkedState` of the form it ran on. */
  check?: DraftCheck | null;
  checked?: string;
  usage?: GenerationUsage | null;
  /** `undefined` until the user picks one; then a preset id or `null` for none. */
  styleChoice?: StyleChoice;
  /** `undefined` until the user picks one: the default provider. */
  providerChoice?: ProviderChoice;
  /** How many test cases to ask for; `undefined` until the user picks a number: the preference. */
  testCaseCount?: number;
  input?: CaptureInput;
  variant?: VariantInput;
  /** What the first generated form is filed under: the collection the capture was started from. */
  collectionIds?: string[];
}

export const emptyContent = (): DraftContent => ({ v: 1, form: null, assumptions: [], aiDrafted: false, appliedStyle: null });

/** A draft's content as the UI uses it, whatever was stored (or nothing). */
export function readContent(draft: Pick<Draft, 'content'>): DraftContent {
  const raw = draft.content as Partial<DraftContent> | null;
  if (!raw || typeof raw !== 'object') return emptyContent();
  return {
    ...emptyContent(),
    ...raw,
    v: 1,
    form: raw.form ? upgradeForm(raw.form) : null,
    assumptions: Array.isArray(raw.assumptions) ? raw.assumptions : [],
  };
}

/** Whether the draft holds a generation its content was not built from yet. */
export const hasNewGeneration = (draft: Pick<Draft, 'generation' | 'generationSeq' | 'basedOn'>): boolean => draft.generation !== null && draft.generationSeq > draft.basedOn;

/**
 * The content built from a generation. A revision keeps what the model does
 * not produce — where the item is filed and where it came from — from the
 * form it revised; a first generation starts from `inherited` (a variant's
 * original's tags and collections) and the collections the capture began in.
 */
export function contentFromGeneration(previous: DraftContent, generation: DraftResponse, inherited: Partial<ItemFormState> = {}): DraftContent {
  const before = previous.form;
  const defaults: Partial<ItemFormState> = before
    ? { collectionIds: before.collectionIds }
    : { ...inherited, collectionIds: [...new Set([...(inherited.collectionIds ?? []), ...(previous.collectionIds ?? [])])] };
  const drafted = formFromDraft(generation.draft, defaults, generation.check?.largeCases);
  const form = before ? { ...drafted, sourceUrl: before.sourceUrl, sourceNote: before.sourceNote } : drafted;
  return {
    ...previous,
    form,
    assumptions: generation.draft.assumptions,
    aiDrafted: true,
    appliedStyle: generation.style,
    styleChoice: generation.style?.id ?? null,
    check: generation.check,
    checked: checkedState(form),
    usage: generation.usage,
  };
}

/** The title a draft is listed under: the form's, or the server's label when it has none. */
export const titleOf = (content: DraftContent): string | null => content.form?.title.trim() || null;
