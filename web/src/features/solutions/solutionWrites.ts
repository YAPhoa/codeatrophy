// What every screen that writes saved solutions shares: refreshing what a
// write changes, and the check against the item's revision for the writes
// that change which code is the problem's reference solution.

import { useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { api, isApiError } from '../../api/client';
import { qk } from '../../api/queries';
import type { Item, Limits, Solution, SolutionPatch } from '../../api/types';
import { loadCode, rememberLanguage, saveCode } from '../../lib/codeStore';
import { formatBytes } from '../../lib/format';
import { byteLength, charCount } from '../../lib/itemForm';
import { LANGUAGES, languageLabel, languageName } from '../../lib/languages';
import { useConfirm } from '../../ui/Dialog';
import { useToast } from '../../ui/Toast';

/**
 * Refresh what a solution write can change: the list itself, the item (its
 * solution count, its reference solution and with it the revision) and the
 * item lists that show the count.
 */
export function refreshSolutions(qc: QueryClient, itemId: string): Promise<unknown> {
  return Promise.all([
    qc.invalidateQueries({ queryKey: qk.solutions(itemId) }),
    qc.invalidateQueries({ queryKey: qk.item(itemId) }),
    qc.invalidateQueries({ queryKey: qk.itemLists }),
  ]);
}

/**
 * True when a write changes `problem.referenceSolution` — a new reference, a
 * removed one, or different code in the current one. Those writes change the
 * item's revision and are checked against it; nothing else is.
 */
export function touchesReference(before: Solution | null, change: SolutionPatch): boolean {
  if (before === null) return change.isReference === true;
  if (change.isReference !== undefined && change.isReference !== before.isReference) return true;
  if (!before.isReference) return false;
  return (change.language !== undefined && change.language !== before.language) || (change.source !== undefined && change.source !== before.source);
}

interface WriteRequest {
  /** Performs the request; `expectedRevision` is set when the write is checked. */
  write: (expectedRevision: number | undefined) => Promise<Solution>;
  /** Whether the write changes the reference solution and so must be checked. */
  checked: boolean;
  /** Called once the write went through, on the first attempt or on "Save anyway". */
  done?: (saved: Solution) => void;
}

export interface SolutionWrite {
  busy: boolean;
  /** A failure other than a revision conflict. */
  error: unknown;
  /** Set after a revision conflict: nothing was written, and the item has been reloaded. */
  conflict: boolean;
  run: (request: WriteRequest) => Promise<void>;
  /** Repeat the conflicting write against the item's current revision. */
  saveAnyway: () => Promise<void>;
  reset: () => void;
}

/**
 * Runs a solution write for `item`. A write that changes the reference
 * solution carries the item's revision; if the item was changed elsewhere in
 * the meantime the server refuses it, and instead of overwriting silently the
 * item and its solutions are reloaded and `conflict` is raised so that the
 * user can look and then decide to save anyway.
 */
export function useSolutionWrite(item: Item): SolutionWrite {
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [conflict, setConflict] = useState(false);
  const pending = useRef<{ request: WriteRequest; revision: number } | null>(null);

  const attempt = async (request: WriteRequest, revision: number): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const saved = await request.write(request.checked ? revision : undefined);
      pending.current = null;
      setConflict(false);
      await refreshSolutions(qc, item.id);
      request.done?.(saved);
    } catch (e) {
      if (isApiError(e) && e.isRevisionConflict) {
        try {
          const latest = await api.items.get(item.id);
          qc.setQueryData(qk.item(item.id), latest);
          await qc.invalidateQueries({ queryKey: qk.solutions(item.id) });
          pending.current = { request, revision: latest.revision };
          setConflict(true);
        } catch (inner) {
          setError(inner);
        }
      } else {
        setError(e);
      }
    } finally {
      setBusy(false);
    }
  };

  return {
    busy,
    error,
    conflict,
    run: (request) => attempt(request, item.revision),
    saveAnyway: async () => {
      if (pending.current) await attempt(pending.current.request, pending.current.revision);
    },
    reset: () => {
      pending.current = null;
      setConflict(false);
      setError(null);
    },
  };
}

/** True for the `409` a create gets when the item already holds the most solutions it may. */
export function isSolutionLimitError(err: unknown): boolean {
  return isApiError(err) && err.code === 'conflict' && !err.isRevisionConflict;
}

export interface SolutionFieldErrors {
  name?: string;
  language?: string;
  source?: string;
  notes?: string;
}

const FORM_FIELDS = ['name', 'language', 'source', 'notes'] as const;

/** Client-side checks of a solution's fields against the server's limits. */
export function validateSolution(fields: { name: string; source: string; notes: string }, limits: Limits | undefined): SolutionFieldErrors {
  const errors: SolutionFieldErrors = {};
  const name = fields.name.trim();
  if (name === '') errors.name = 'Give the solution a name.';
  else if (limits && charCount(name) > limits.maxSolutionNameChars) errors.name = `At most ${limits.maxSolutionNameChars.toLocaleString()} characters.`;
  if (fields.source.trim() === '') errors.source = 'The solution has no code.';
  else if (limits && byteLength(fields.source) > limits.maxSourceBytes) errors.source = `Larger than ${formatBytes(limits.maxSourceBytes)}.`;
  if (limits && charCount(fields.notes) > limits.maxSolutionNotesChars) {
    errors.notes = `At most ${limits.maxSolutionNotesChars.toLocaleString()} characters (now ${charCount(fields.notes).toLocaleString()}).`;
  }
  return errors;
}

/**
 * Split a failed write into messages for the form's fields and whether
 * anything is left that the fields do not show.
 */
export function serverFieldErrors(err: unknown): { fields: SolutionFieldErrors; rest: boolean } {
  if (!isApiError(err) || err.code !== 'validation_failed') return { fields: {}, rest: err != null };
  const fields: SolutionFieldErrors = {};
  let rest = false;
  for (const [key, value] of Object.entries(err.fields)) {
    const known = FORM_FIELDS.find((f) => f === key);
    if (known) fields[known] = String(value);
    else rest = true;
  }
  return { fields, rest: rest || Object.keys(fields).length === 0 };
}

/** The languages a solution can be written in, with toolchain versions where the judge reports them. */
export function solutionLanguageOptions(judgeLanguages: readonly { id: string; name: string; version: string }[] | undefined, current?: string): { value: string; label: string }[] {
  const judge = judgeLanguages?.map((l) => l.id) ?? [];
  const ids = judge.length > 0 ? judge : LANGUAGES.map((l) => l.id);
  // A solution may be in a language the judge no longer offers; keep it selectable.
  return Array.from(new Set(current ? [...ids, current] : ids)).map((id) => ({ value: id, label: languageLabel(id, judgeLanguages) }));
}

export function lineCount(source: string): number {
  return source === '' ? 0 : source.replace(/\n$/, '').split('\n').length;
}

/** "Python solution", or "Python solution 2" when that name is taken. */
export function defaultSolutionName(language: string, existing: readonly Solution[]): string {
  const base = `${languageName(language)} solution`;
  const taken = new Set(existing.map((s) => s.name));
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base} ${n}`)) n++;
  return `${base} ${n}`;
}

/**
 * Returns a function that puts a solution's code into the solve editor for
 * its language and goes there. Work in progress in that language is only
 * replaced after the user agrees.
 */
export function useOpenInEditor(item: Item): (code: { language: string; source: string }) => Promise<void> {
  const navigate = useNavigate();
  const confirm = useConfirm();
  const toast = useToast();
  return async ({ language, source }) => {
    const current = loadCode(item.id, language);
    const starter = item.problem?.starterCode[language] ?? '';
    const hasWork = current !== null && current.trim() !== '' && current !== source && current !== starter;
    if (hasWork) {
      const ok = await confirm({
        title: 'Replace the code in the editor?',
        body: `Your current ${languageName(language)} code for this problem will be replaced by the saved solution.`,
        confirmLabel: 'Replace',
        danger: true,
      });
      if (!ok) return;
    }
    saveCode(item.id, language, source);
    rememberLanguage(item.id, language);
    toast.info(`Solution loaded into the ${languageName(language)} editor`);
    navigate(`/items/${item.id}`);
  };
}
