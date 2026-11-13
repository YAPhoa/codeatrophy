import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react';
import { api, isAbort } from '../../api/client';
import type { ItemCheckResponse } from '../../api/types';
import { checkedState, checkRequestFromForm, withCheck, withoutCases, type CheckedDraft, type ItemFormState } from '../../lib/itemForm';
import { readJson, writeJson } from '../../lib/storage';

// "Verify all" on a draft under review: its reference solution is run on
// every test case by `POST /items/check`, which can take minutes. The check
// belongs to the stored draft, not to the page, so it keeps running when the
// page is left: its answer goes to the page if it is open, and otherwise
// into the draft kept in localStorage, where the page finds it on return.

export interface DraftCheckState {
  running: boolean;
  /** When the running check started (ms since epoch). */
  startedAt: number | null;
  /** How many test cases it runs. */
  total: number;
  error: unknown;
  /** The answer came back for a draft that had been changed since, and was not applied. */
  outdated: boolean;
}

const IDLE: DraftCheckState = { running: false, startedAt: null, total: 0, error: null, outdated: false };

const states = new Map<string, DraftCheckState>();
const controllers = new Map<string, AbortController>();
/** Pages that are open, by storage key: they take the answer themselves. */
const receivers = new Map<string, (sent: string, answer: ItemCheckResponse) => boolean>();
const listeners = new Set<() => void>();

function set(key: string, state: DraftCheckState): void {
  states.set(key, state);
  listeners.forEach((fn) => fn());
}

function deliver(key: string, sent: string, answer: ItemCheckResponse): boolean {
  const receive = receivers.get(key);
  if (receive) return receive(sent, answer);
  const stored = readJson<CheckedDraft | null>(key, null);
  const next = stored && withCheck(stored, sent, answer);
  if (next) writeJson(key, next);
  return next !== null;
}

/** Check a draft's form; a check already running for the same draft is cancelled. */
export function startDraftCheck(key: string, form: ItemFormState): void {
  controllers.get(key)?.abort();
  const controller = new AbortController();
  controllers.set(key, controller);
  const sent = checkedState(form);
  set(key, { running: true, startedAt: Date.now(), total: form.testCases.length, error: null, outdated: false });
  api.items.check(checkRequestFromForm(form), controller.signal).then(
    (answer) => {
      if (controllers.get(key) !== controller) return;
      controllers.delete(key);
      set(key, { ...IDLE, outdated: !deliver(key, sent, answer) });
    },
    (error: unknown) => {
      if (controllers.get(key) !== controller) return;
      controllers.delete(key);
      set(key, isAbort(error) ? IDLE : { ...IDLE, error });
    },
  );
}

/** Where the check of a draft stands. */
export const getDraftCheck = (key: string): DraftCheckState => states.get(key) ?? IDLE;

/** Stop a running check, and forget what the last one left to say. */
export function cancelDraftCheck(key: string): void {
  controllers.get(key)?.abort();
  controllers.delete(key);
  set(key, IDLE);
}

const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
};

/**
 * The check of the draft stored under `key`, for its page. While the page is
 * open, an answer is applied through `setDraft`; one for a draft that has
 * changed since is dropped and reported as `outdated`.
 */
export function useDraftCheck<S extends CheckedDraft>(key: string, draft: S, setDraft: (next: S) => void) {
  const latest = useRef({ draft, setDraft });
  useEffect(() => {
    latest.current = { draft, setDraft };
  });
  useEffect(() => {
    receivers.set(key, (sent, answer) => {
      const next = withCheck(latest.current.draft, sent, answer);
      if (next) latest.current.setDraft(next);
      return next !== null;
    });
    return () => {
      receivers.delete(key);
    };
  }, [key]);

  const state = useSyncExternalStore(subscribe, () => getDraftCheck(key));
  const start = useCallback((form: ItemFormState) => startDraftCheck(key, form), [key]);
  const cancel = useCallback(() => cancelDraftCheck(key), [key]);
  /** Drop test cases from the draft, keeping its check up to date. */
  const discard = useCallback((keys: readonly string[]) => latest.current.setDraft(withoutCases(latest.current.draft, keys)), []);
  return { ...state, start, cancel, discard };
}

export type DraftCheckControl = ReturnType<typeof useDraftCheck>;
