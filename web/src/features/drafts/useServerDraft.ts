import { useCallback, useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, isApiError } from '../../api/client';
import { invalidateJobs, qk } from '../../api/queries';
import type { Draft, DraftRequest, VariantRequest } from '../../api/types';
import type { ItemFormState } from '../../lib/itemForm';
import { contentFromGeneration, hasNewGeneration, readContent, titleOf, type DraftContent } from './draftContent';

/** How long after the last change a draft is saved. */
const AUTOSAVE_MS = 600;
/** A save as the tab closes may only carry this much (browsers drop larger keepalive bodies). */
const KEEPALIVE_LIMIT = 60_000;

/** One short line for a draft reloaded because it changed elsewhere. */
export const RELOADED_NOTICE = 'This draft changed elsewhere, so it was reloaded.';

/** How a draft is loaded: polled while it is being drafted. */
export function draftQuery(id: string) {
  return {
    queryKey: qk.draft(id),
    queryFn: ({ signal }: { signal: AbortSignal }) => api.drafts.get(id, signal),
    refetchInterval: (query: { state: { data?: Draft } }) => (query.state.data?.state === 'drafting' ? 1500 : false),
  };
}

/**
 * A draft on the server, edited here. The page works on a local copy of its
 * content, saved shortly after each change with the revision it was based
 * on; a save refused because the draft changed elsewhere reloads it and says
 * so in `notice`. A generation that arrives is turned into the form at once
 * and saved as the content (`basedOn`), which collects its job.
 * `inherited` is what a first generated form starts with besides the
 * generation (a variant's original's tags and collections).
 */
export function useServerDraft(id: string, inherited: Partial<ItemFormState> = {}) {
  const qc = useQueryClient();
  const query = useQuery(draftQuery(id));
  const [content, setContent] = useState<DraftContent | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<unknown>(null);

  // What the server has: the revision the local copy was last in step with.
  const synced = useRef<number | null>(null);
  const local = useRef<DraftContent | null>(null);
  // Edits are counted, so a save that was overtaken by another edit leaves the draft unsaved.
  const edits = useRef(0);
  const saved = useRef(0);
  const timer = useRef<number | undefined>(undefined);
  const inflight = useRef<Promise<void> | null>(null);
  const adopting = useRef<number | null>(null);
  const inheritedRef = useRef(inherited);
  inheritedRef.current = inherited;

  const dirty = () => edits.current !== saved.current;

  const take = useCallback(
    (draft: Draft) => {
      synced.current = Math.max(synced.current ?? 0, draft.revision);
      // A poll under way would bring back an older copy over this one.
      void qc.cancelQueries({ queryKey: qk.draft(id) });
      qc.setQueryData(qk.draft(id), draft);
    },
    [qc, id],
  );

  const show = useCallback((next: DraftContent) => {
    local.current = next;
    setContent(next);
  }, []);

  /** Load the draft again, dropping what is local: it changed elsewhere. */
  const reload = useCallback(async () => {
    window.clearTimeout(timer.current);
    const latest = await api.drafts.get(id);
    saved.current = edits.current;
    take(latest);
    show(readContent(latest));
    setNotice(RELOADED_NOTICE);
  }, [id, take, show]);

  const send = useCallback(async (): Promise<void> => {
    const current = local.current;
    if (!current || synced.current === null || !dirty()) return;
    const sending = edits.current;
    try {
      const res = await api.drafts.update(id, { content: { ...current }, ...(current.form ? { edited: true } : {}), title: titleOf(current), expectedRevision: synced.current });
      saved.current = sending;
      take(res);
      setSaveError(null);
    } catch (e) {
      if (isApiError(e) && e.isRevisionConflict) await reload();
      else setSaveError(e);
    }
  }, [id, take, reload]);

  /** Save what is unsaved now, after a save under way. */
  const flush = useCallback(async (): Promise<void> => {
    window.clearTimeout(timer.current);
    while (inflight.current) await inflight.current;
    if (!dirty()) return;
    const p = send().finally(() => {
      inflight.current = null;
    });
    inflight.current = p;
    await p;
  }, [send]);

  /** Change the content; it is saved shortly after. */
  const update = useCallback(
    (change: (current: DraftContent) => DraftContent) => {
      const current = local.current;
      if (!current) return;
      show(change(current));
      edits.current++;
      setNotice(null);
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => void flush(), AUTOSAVE_MS);
    },
    [show, flush],
  );

  /** Take a generation in: build the form from it and save that as the content. */
  const adopt = useCallback(
    async (draft: Draft) => {
      if (!draft.generation || adopting.current === draft.generationSeq) return;
      adopting.current = draft.generationSeq;
      while (inflight.current) await inflight.current;
      const next = contentFromGeneration(local.current ?? readContent(draft), draft.generation, inheritedRef.current);
      show(next);
      saved.current = edits.current;
      // Saves of edits made meanwhile wait for this one, so they are made against its revision.
      const p = (async () => {
        try {
          take(await api.drafts.update(id, { content: { ...next }, basedOn: draft.generationSeq, edited: false, title: titleOf(next), expectedRevision: synced.current ?? draft.revision }));
          void invalidateJobs(qc);
        } catch (e) {
          adopting.current = null;
          // Changed meanwhile: read it again, and take the generation from there.
          if (isApiError(e) && e.isRevisionConflict) void query.refetch();
          else setSaveError(e);
        }
      })().finally(() => {
        inflight.current = null;
      });
      inflight.current = p;
      await p;
    },
    [id, qc, take, show, query],
  );

  const draft = query.data;
  useEffect(() => {
    if (!draft) return;
    // An older copy than the one in hand (a poll that crossed a save) says nothing new.
    if (synced.current !== null && draft.revision < synced.current) return;
    // First load, or the server moved on while nothing here is unsaved.
    if (synced.current === null || (!dirty() && draft.revision !== synced.current)) {
      synced.current = draft.revision;
      show(readContent(draft));
    }
    if (hasNewGeneration(draft) && draft.state !== 'drafting') void adopt(draft);
  }, [draft, show, adopt]);

  // A failed or cancelled generation shown here is collected, so it is not offered again elsewhere.
  const job = draft?.job;
  useEffect(() => {
    if (job && !job.pickedUp && (job.status === 'failed' || job.status === 'cancelled')) {
      void api.ai.pickup(job.id).then(() => invalidateJobs(qc), () => undefined);
    }
  }, [job, qc]);

  // Leaving saves what is unsaved; so does closing the tab, when it is small enough to go along.
  useEffect(() => {
    const onHide = () => {
      const current = local.current;
      if (!current || synced.current === null || !dirty()) return;
      const patch = { content: { ...current }, ...(current.form ? { edited: true } : {}), title: titleOf(current), expectedRevision: synced.current };
      if (JSON.stringify(patch).length < KEEPALIVE_LIMIT) void api.drafts.update(id, patch, { keepalive: true }).catch(() => undefined);
    };
    window.addEventListener('pagehide', onHide);
    return () => {
      window.removeEventListener('pagehide', onHide);
      if (dirty()) void flush().then(() => invalidateJobs(qc));
    };
  }, [id, flush, qc]);

  /** Start a generation of the draft, after saving what is unsaved. */
  const generate = useCallback(
    async (body: DraftRequest | VariantRequest) => {
      await flush();
      take(await api.drafts.generate(id, body));
      void invalidateJobs(qc);
    },
    [id, flush, take, qc],
  );

  const retry = useCallback(async () => {
    take(await api.drafts.retry(id));
    void invalidateJobs(qc);
  }, [id, take, qc]);

  /** Stop the generation under way; the draft keeps what it had. */
  const cancel = useCallback(async () => {
    const running = query.data?.job;
    if (!running) return;
    await api.ai.cancel(running.id);
    await api.ai.pickup(running.id).catch(() => undefined);
    take(await api.drafts.get(id));
    void invalidateJobs(qc);
  }, [id, query.data, take, qc]);

  /** Stop saving: the draft is about to go (saved to the library, or discarded). */
  const forget = useCallback(() => {
    window.clearTimeout(timer.current);
    saved.current = edits.current;
  }, []);

  /** The revision a save to the library is made against, after saving what is unsaved. */
  const settle = useCallback(async (): Promise<number | null> => {
    await flush();
    return synced.current;
  }, [flush]);

  return { query, draft, content, update, flush, settle, forget, generate, retry, cancel, reload, notice, clearNotice: () => setNotice(null), saveError };
}

export type ServerDraft = ReturnType<typeof useServerDraft>;
