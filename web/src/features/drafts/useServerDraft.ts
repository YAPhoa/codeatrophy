import { useCallback, useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, api } from '../../api/client';
import { invalidateJobs, qk } from '../../api/queries';
import type { Draft, DraftRequest, VariantRequest } from '../../api/types';
import type { ItemFormState } from '../../lib/itemForm';
import type { DraftContent } from './draftContent';
import { DraftSaver } from './draftSaver';

/** A save as the tab closes may only carry this much (browsers drop larger keepalive bodies). */
const KEEPALIVE_LIMIT = 60_000;

/** One short line for a draft reloaded because it changed elsewhere. */
export const RELOADED_NOTICE = 'This draft changed elsewhere, so it was reloaded.';

/** Why what was asked for was not sent: the draft was reloaded on the way. `then` says what to do. */
export const changedElsewhere = (then: string) => new ApiError(409, 'conflict', `The draft changed elsewhere and was reloaded. ${then}`);

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
 * The bookkeeping is `DraftSaver`'s; this binds it to the API and the page.
 */
export function useServerDraft(id: string, inherited: Partial<ItemFormState> = {}) {
  const qc = useQueryClient();
  const query = useQuery(draftQuery(id));
  const [content, setContent] = useState<DraftContent | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<unknown>(null);
  const queryRef = useRef(query);
  queryRef.current = query;

  const [saver] = useState(
    () =>
      new DraftSaver(
        { get: () => api.drafts.get(id), update: (patch) => api.drafts.update(id, patch) },
        {
          took: (draft) => {
            // A poll under way would bring back an older copy over this one.
            void qc.cancelQueries({ queryKey: qk.draft(id) });
            qc.setQueryData(qk.draft(id), draft);
          },
          shown: setContent,
          reloaded: () => setNotice(RELOADED_NOTICE),
          saveError: setSaveError,
          collected: () => void invalidateJobs(qc),
          refetch: () => void queryRef.current.refetch(),
        },
      ),
  );
  saver.inherited = inherited;

  const take = useCallback((draft: Draft) => saver.take(draft), [saver]);
  const reload = useCallback(() => saver.reload(), [saver]);
  const flush = useCallback(() => saver.flush(), [saver]);
  const settle = useCallback(() => saver.settle(), [saver]);
  const forget = useCallback(() => saver.forget(), [saver]);

  /** Change the content; it is saved shortly after. */
  const update = useCallback(
    (change: (current: DraftContent) => DraftContent) => {
      if (saver.update(change)) setNotice(null);
    },
    [saver],
  );

  const draft = query.data;
  useEffect(() => {
    if (draft) saver.received(draft);
  }, [draft, saver]);

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
      const patch = saver.parting();
      if (patch && JSON.stringify(patch).length < KEEPALIVE_LIMIT) void api.drafts.update(id, patch, { keepalive: true }).catch(() => undefined);
    };
    window.addEventListener('pagehide', onHide);
    return () => {
      window.removeEventListener('pagehide', onHide);
      if (saver.dirty) void saver.flush().then(() => invalidateJobs(qc));
    };
  }, [id, saver, qc]);

  /**
   * Start a generation of the draft, after saving what is unsaved. When that
   * save finds the draft changed elsewhere, `body` was built from what was
   * here before, so nothing is started.
   */
  const generate = useCallback(
    async (body: DraftRequest | VariantRequest) => {
      if ((await settle()).reloaded) throw changedElsewhere('Check it, then ask again.');
      take(await api.drafts.generate(id, body));
      void invalidateJobs(qc);
    },
    [id, settle, take, qc],
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

  return { query, draft, content, update, flush, settle, forget, generate, retry, cancel, reload, notice, clearNotice: () => setNotice(null), saveError };
}

export type ServerDraft = ReturnType<typeof useServerDraft>;
