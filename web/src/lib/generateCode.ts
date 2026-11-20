// "Generate code" in the problem editor: what to ask for, from the form as
// it stands, what it would replace, how the answer goes into the form, and
// which runner checks still describe the code in it.

import type { AiCodeRequest, AiCodeResponse, CodeSample, HarnessCode, ProblemInterface, RunnerCheck } from '../api/types';
import { formLanguages, type ItemFormState } from './itemForm';
import { sortLanguages } from './languages';
import { isGenericStarter } from './starterTemplates';

type CodeForm = Pick<ItemFormState, 'title' | 'body' | 'interface' | 'starterCode' | 'harness'>;

/** The languages a generation writes: those the form's code section lists, in tab order. */
export const codeLanguages = (form: CodeForm): string[] => sortLanguages(formLanguages(form));

const hasRunner = (h: HarnessCode | undefined): boolean => h !== undefined && (h.prefix.trim() !== '' || h.suffix.trim() !== '');

/**
 * The listed languages whose code a generation would replace: starter code
 * that is more than the generic skeleton, and for a "solution only" problem
 * a runner that is not empty.
 */
export function codeToReplace(form: CodeForm): string[] {
  return codeLanguages(form).filter(
    (l) => !isGenericStarter(l, form.starterCode[l] ?? '') || (form.interface === 'function' && hasRunner(form.harness[l])),
  );
}

/** Body of `POST /ai/code` for the form as it stands, with the problem's sample cases. */
export function codeRequestFromForm(form: CodeForm, samples: readonly CodeSample[], itemId: string | null): AiCodeRequest {
  return {
    ...(itemId ? { itemId } : {}),
    title: form.title.trim(),
    body: form.body,
    interface: form.interface,
    languages: codeLanguages(form),
    samples: samples.map((s) => ({ stdin: s.stdin, expectedStdout: s.expectedStdout })),
  };
}

/**
 * Put generated code into the form as it is now: the starter code of each
 * language that came back, and for a "solution only" generation its runner.
 * Other languages, and the runners of a full-program generation, are left
 * as they are.
 */
export function withGeneratedCode<T extends Pick<ItemFormState, 'starterCode' | 'harness'>>(form: T, res: Pick<AiCodeResponse, 'starterCode' | 'harness'>, face: ProblemInterface): T {
  return {
    ...form,
    starterCode: { ...form.starterCode, ...res.starterCode },
    harness: face === 'function' ? { ...form.harness, ...res.harness } : form.harness,
  };
}

/** What a generation's runner check ran: each language's stub and runner, as generated. */
export interface CheckedCode {
  runners: readonly RunnerCheck[];
  code: Record<string, { starter: string; runner: HarnessCode }>;
}

export function checkedCode(res: Pick<AiCodeResponse, 'starterCode' | 'harness' | 'check'>): CheckedCode {
  const code: CheckedCode['code'] = {};
  for (const [l, starter] of Object.entries(res.starterCode)) code[l] = { starter, runner: res.harness[l] ?? { prefix: '', suffix: '' } };
  return { runners: res.check?.runners ?? [], code };
}

/**
 * The runner checks that still describe the form, by language: each one
 * that was tried, while the form is "solution only" and that language's
 * stub and runner are as they were checked.
 */
export function currentRunnerChecks(form: Pick<ItemFormState, 'interface' | 'starterCode' | 'harness'>, checked: CheckedCode | null): ReadonlyMap<string, RunnerCheck> {
  const out = new Map<string, RunnerCheck>();
  if (!checked || form.interface !== 'function') return out;
  for (const r of checked.runners) {
    const was = checked.code[r.language];
    const runner = form.harness[r.language];
    if (r.status === 'skipped' || !was || !runner) continue;
    if (form.starterCode[r.language] === was.starter && runner.prefix === was.runner.prefix && runner.suffix === was.runner.suffix) out.set(r.language, r);
  }
  return out;
}
