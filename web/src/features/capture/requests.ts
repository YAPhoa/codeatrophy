// The generation requests the capture and variant pages send.

import type { DraftRequest, Item, ProblemInterface, VariantRequest } from '../../api/types';
import type { StyleChoice } from '../../lib/styleChoice';
import type { CaptureInput, VariantInput } from '../drafts/draftContent';

/** The draft request for a capture's input. A reading has no interface or test cases to ask for. */
export function draftRequest(input: CaptureInput, styleId: StyleChoice, largeTestCases: number, testCaseCount: number, provider: { providerId?: string | null }): DraftRequest {
  return {
    text: input.text,
    typeHint: input.typeHint,
    ...(input.typeHint !== 'reading' ? { interfaceHint: input.interfaceHint, testCaseCount } : {}),
    styleId,
    largeTestCases,
    ...provider,
  };
}

/** What the solver writes in the variant: the choice made, or else the original's interface. */
export const variantInterface = (original: Item, choice: VariantInput): ProblemInterface => choice.interfaceHint ?? original.problem?.interface ?? 'program';

/** The variant request for an original and the choices made; a reading's variant has no interface or test cases. */
export function variantRequest(original: Item, choice: VariantInput, styleId: StyleChoice, largeTestCases: number, testCaseCount: number, provider: { providerId?: string | null }): VariantRequest {
  return {
    mode: choice.mode,
    instruction: choice.instruction.trim() || null,
    styleId,
    ...(original.type === 'problem' ? { interfaceHint: variantInterface(original, choice), testCaseCount } : {}),
    largeTestCases,
    ...provider,
  };
}

/**
 * The count a revision asks for: the one the draft was last generated with,
 * else the one chosen for it, else the preference's.
 */
export function revisionTestCaseCount(requested: number | undefined, chosen: number | undefined, preferred: number, max: number): number {
  return Math.min(max, Math.max(1, requested || chosen || preferred));
}
