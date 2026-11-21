import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { ApiError, api, isApiError, jobError } from '../../api/client';
import { invalidateJobs, qk, useCollections, useLargeTestCaseCount, useMeta, usePreferences, useStyles, useTags } from '../../api/queries';
import type { DraftRequest, ItemDraft, ItemInput, VariantRequest } from '../../api/types';
import { errorLine } from '../../lib/errors';
import { useHotkeys } from '../../lib/hotkeys';
import { checkedState, draftFromForm, revisionProblem, type CreateExtras, type ItemFormState } from '../../lib/itemForm';
import { useConfirm } from '../../ui/Dialog';
import { useCollectionActions } from '../collections/CollectionActions';
import { useDraftCheck } from '../capture/draftChecks';
import { revisionTestCaseCount } from '../capture/requests';
import { useProviderChoice } from '../capture/ModelPicker';
import { ReviewScreen } from '../capture/ReviewScreen';
import { resolveStyleChoice, type StyleChoice } from '../capture/StylePicker';
import { useSaveDraft } from '../capture/useSaveDraft';
import type { DraftContent } from './draftContent';
import type { ServerDraft } from './useServerDraft';

/** What a revision request is built from; the page adds what its kind of draft asks for. */
export interface RevisionAsk {
  form: ItemFormState;
  instruction: string;
  previousDraft: ItemDraft;
  styleId: StyleChoice;
  largeTestCases: number;
  /** Ordinary test cases to ask for; the page sends it for a problem only. */
  testCaseCount: number;
  provider: { providerId?: string | null };
}

interface DraftReviewProps {
  sd: ServerDraft;
  content: DraftContent & { form: ItemFormState };
  kind: 'draft' | 'variant';
  header: ReactNode;
  originalText?: string;
  originalLabel?: string;
  /** The request a revision sends, for this kind of draft. */
  revision: (ask: RevisionAsk) => DraftRequest | VariantRequest;
  extras: CreateExtras;
  saveLabel: string;
  backLabel: string;
  onBack: () => void;
  discardTitle: string;
  discardBody: string;
  discardLabel: string;
  /** Where to go once the draft is discarded. */
  afterDiscard: string;
}

/**
 * The review of a draft kept on the server: every field editable and saved
 * as it changes, a revision asked of the AI (the form waits while it runs),
 * and the draft saved to the library or discarded.
 */
export function DraftReview(props: DraftReviewProps) {
  const { sd, content } = props;
  const draft = sd.draft!;
  const id = draft.id;
  const form = content.form;
  const qc = useQueryClient();
  const navigate = useNavigate();
  const confirm = useConfirm();
  const meta = useMeta();
  const aiEnabled = meta.data?.ai.enabled ?? false;
  const { data: collections = [] } = useCollections();
  const { data: tags = [] } = useTags();
  const stylesQuery = useStyles();
  const styles = stylesQuery.data ?? [];
  const collectionActions = useCollectionActions();
  const largeCount = useLargeTestCaseCount();
  const preferences = usePreferences();
  const largeTestCases = preferences.largeTestCase ? largeCount : 0;
  // What the draft was asked for keeps being asked for.
  const testCaseCount = revisionTestCaseCount(draft.request?.testCaseCount, content.testCaseCount, preferences.generatedTestCases, meta.data?.limits.maxGeneratedTestCases ?? 30);

  // A revision that could not start; one that started and failed is the draft's own error.
  const [askError, setAskError] = useState<unknown>(null);
  // Asked for and not started yet: the form waits from the click, not from the server's answer.
  const [asking, setAsking] = useState(false);
  const revising = asking || draft.state === 'drafting';
  const failed = draft.state === 'failed' && draft.error ? jobError(draft.error) : null;
  const reviseError = askError ?? failed;
  const startedAt = draft.state === 'drafting' && draft.job ? Date.parse(draft.job.startedAt ?? draft.job.createdAt) : null;

  const setDraft = useCallback((next: DraftContent) => sd.update(() => next), [sd]);
  const verify = useDraftCheck(id, content, setDraft);
  const styleChoice = resolveStyleChoice(content.styleChoice, styles);
  const provider = useProviderChoice(content.providerChoice, reviseError);

  const create = useCallback(
    async (input: ItemInput) => {
      const expectedRevision = await sd.settle();
      try {
        const item = await api.drafts.save(id, { item: input, ...(expectedRevision !== null ? { expectedRevision } : {}) });
        sd.forget();
        return item;
      } catch (e) {
        if (isApiError(e) && e.isRevisionConflict) {
          await sd.reload();
          throw new ApiError(409, 'conflict', 'The draft changed elsewhere and was reloaded. Check it, then save again.');
        }
        throw e;
      }
    },
    [sd, id],
  );
  const saver = useSaveDraft(id, create);
  const save = () => void saver.save(form, props.extras);

  const revise = async (instruction: string) => {
    const previousDraft = draftFromForm(form, content.assumptions);
    const problem = revisionProblem(previousDraft, meta.data?.limits);
    setAskError(null);
    if (problem) {
      setAskError(new ApiError(413, 'too_large', problem));
      return;
    }
    verify.cancel();
    setAsking(true);
    try {
      await sd.generate(props.revision({ form, instruction, previousDraft, styleId: styleChoice, largeTestCases, testCaseCount, provider: provider.request }));
    } catch (e) {
      setAskError(e);
    } finally {
      setAsking(false);
    }
  };

  const retry = async () => {
    setAskError(null);
    setAsking(true);
    try {
      await sd.retry();
    } catch (e) {
      setAskError(e);
    } finally {
      setAsking(false);
    }
  };

  const discard = async () => {
    const ok = await confirm({ title: props.discardTitle, body: props.discardBody, confirmLabel: props.discardLabel, danger: true });
    if (!ok) return;
    verify.cancel();
    sd.forget();
    try {
      await api.drafts.remove(id);
      // Its generation goes with it, from the AI jobs list too.
      if (draft.job) await api.ai.dismiss(draft.job.id).catch(() => undefined);
    } catch (e) {
      if (!(isApiError(e) && e.code === 'not_found')) throw e;
    }
    qc.removeQueries({ queryKey: qk.draft(id) });
    void invalidateJobs(qc);
    navigate(props.afterDiscard, { replace: true });
  };

  useHotkeys(
    {
      'mod+s': (e) => {
        e.preventDefault();
        save();
      },
    },
    { enabled: true },
  );

  const notice = sd.notice ?? (sd.saveError != null ? `Not saved yet: ${errorLine(sd.saveError)}` : null);
  const checkStale = useMemo(() => content.checked !== undefined && content.checked !== checkedState(form), [content.checked, form]);

  return (
    <ReviewScreen
      header={props.header}
      form={form}
      onFormChange={(next) => sd.update((c) => ({ ...c, form: next }))}
      errors={saver.errors}
      collections={collections}
      tagSuggestions={tags.map((t) => t.name)}
      judgeLanguages={meta.data?.judge.languages.map((l) => l.id) ?? []}
      onCreateCollection={() => collectionActions.create(null, (c) => sd.update((cur) => (cur.form ? { ...cur, form: { ...cur.form, collectionIds: [...cur.form.collectionIds, c.id] } } : cur)))}
      aiDrafted={content.aiDrafted}
      kind={props.kind}
      assumptions={content.assumptions}
      appliedStyle={content.appliedStyle}
      check={content.check ?? null}
      usage={content.usage ?? null}
      verify={verify}
      checkStale={checkStale}
      originalText={props.originalText}
      originalLabel={props.originalLabel}
      aiEnabled={aiEnabled}
      styles={styles}
      styleChoice={styleChoice}
      onStyleChange={(c) => sd.update((cur) => ({ ...cur, styleChoice: c }))}
      aiSettings={provider.settings}
      providerChoice={provider.value}
      onProviderChange={(pid) => sd.update((cur) => ({ ...cur, providerChoice: pid }))}
      onRevise={(instruction) => void revise(instruction)}
      revising={revising}
      reviseStartedAt={startedAt}
      reviseError={revising ? null : reviseError}
      onRetryRevise={failed && !askError ? () => void retry() : undefined}
      onCancelRevise={() => void sd.cancel()}
      notice={notice}
      onSave={save}
      saving={saver.saving}
      saveError={saver.error}
      saveLabel={props.saveLabel}
      onBack={props.onBack}
      backLabel={props.backLabel}
      onDiscard={() => void discard()}
    />
  );
}
