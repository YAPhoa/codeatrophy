import { useEffect } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import { PenLine, Sparkles } from 'lucide-react';
import { ApiError, api } from '../../api/client';
import { useCollections, useItem, useMeta, useStyles, useTags } from '../../api/queries';
import type { AppliedStyle, Item, VariantMode } from '../../api/types';
import { useDocumentTitle } from '../../app/useDocumentTitle';
import { useHotkeys } from '../../lib/hotkeys';
import { draftFromForm, emptyForm, formFromDraft, revisionProblem, type ItemFormState } from '../../lib/itemForm';
import { useStoredState } from '../../lib/useStoredState';
import { Button, cx } from '../../ui/Button';
import { useConfirm } from '../../ui/Dialog';
import { TextAreaField } from '../../ui/Field';
import { Callout, ErrorCallout, ErrorState, PageLoading } from '../../ui/misc';
import { useCollectionActions } from '../collections/CollectionActions';
import { GeneratingPanel, Steps } from './parts';
import { ReviewScreen } from './ReviewScreen';
import { StylePicker, resolveStyleChoice, type StyleChoice } from './StylePicker';
import { useGeneration } from './useGeneration';
import { useSaveDraft } from './useSaveDraft';
import { VARIANT_MODES, isVariantMode } from './variantModes';

interface VariantSession {
  stage: 'choose' | 'review';
  mode: VariantMode;
  instruction: string;
  styleChoice?: StyleChoice;
  form: ItemFormState | null;
  assumptions: string[];
  aiDrafted: boolean;
  appliedStyle: AppliedStyle | null;
}

const STEPS = ['Choose', 'Review', 'Save'] as const;

export default function VariantPage() {
  const { id = '' } = useParams();
  const item = useItem(id);
  if (item.isPending) return <PageLoading />;
  if (item.isError) {
    return (
      <div className="page">
        <ErrorState error={item.error} onRetry={() => void item.refetch()} title={undefined} />
      </div>
    );
  }
  return <VariantFlow key={item.data.id} original={item.data} />;
}

/**
 * Derive a new item from an existing one — another problem to practise the
 * same idea on. The draft goes through the same review as a captured item
 * and is saved with `variantOf` pointing at the original.
 */
function VariantFlow({ original }: { original: Item }) {
  const [searchParams] = useSearchParams();
  const isProblem = original.type === 'problem';
  useDocumentTitle(`Variant of ${original.title}`);
  const meta = useMeta();
  const limits = meta.data?.limits;
  const aiEnabled = meta.data?.ai.enabled ?? false;
  const { data: collections = [] } = useCollections();
  const { data: tags = [] } = useTags();
  const stylesQuery = useStyles();
  const styles = stylesQuery.data ?? [];
  const collectionActions = useCollectionActions();
  const confirm = useConfirm();
  const generation = useGeneration();

  const requested = searchParams.get('mode');
  const [session, setSession, clearSession] = useStoredState<VariantSession>(`capture:variant:${original.id}`, () => ({
    stage: 'choose',
    mode: isProblem && isVariantMode(requested) ? requested : 'similar',
    instruction: '',
    form: null,
    assumptions: [],
    aiDrafted: false,
    appliedStyle: null,
  }));
  const saver = useSaveDraft(clearSession);
  const patch = (change: Partial<VariantSession>) => setSession((s) => ({ ...s, ...change }));

  // A link that names a mode ("Harder" on the saved screen) wins over a
  // remembered choice, as long as no draft is under review.
  useEffect(() => {
    if (isProblem && isVariantMode(requested)) setSession((s) => (s.stage === 'choose' && s.mode !== requested ? { ...s, mode: requested } : s));
  }, [requested, isProblem, setSession]);
  const styleChoice = resolveStyleChoice(session.styleChoice, styles);

  // The original's tags and collections are a sensible starting point for the new item.
  const inherited: Partial<ItemFormState> = { tags: original.tags, collectionIds: original.collectionIds };

  const generate = async () => {
    const res = await generation.run((signal) =>
      api.ai.variant(original.id, { mode: session.mode, instruction: session.instruction.trim() || null, styleId: styleChoice }, signal),
    );
    if (!res) return;
    patch({
      stage: 'review',
      form: formFromDraft(res.draft, inherited),
      assumptions: res.draft.assumptions,
      aiDrafted: true,
      appliedStyle: res.style,
      styleChoice: res.style?.id ?? null,
    });
  };

  const revise = async (instruction: string) => {
    const current = session.form;
    if (!current) return;
    // The draft as edited goes back as `previousDraft`, so the user's own changes are revised, not discarded.
    const previousDraft = draftFromForm(current, session.assumptions);
    const res = await generation.run((signal) => {
      const problem = revisionProblem(previousDraft, limits);
      if (problem) throw new ApiError(413, 'too_large', problem);
      return api.ai.variant(original.id, { mode: session.mode, instruction, previousDraft, styleId: styleChoice }, signal);
    });
    if (!res) return;
    patch({
      form: { ...formFromDraft(res.draft, { collectionIds: current.collectionIds }), sourceUrl: current.sourceUrl, sourceNote: current.sourceNote },
      assumptions: res.draft.assumptions,
      appliedStyle: res.style,
      styleChoice: res.style?.id ?? null,
    });
  };

  const writeByHand = () =>
    patch({ stage: 'review', form: { ...emptyForm(original.type), ...inherited, difficulty: original.difficulty }, assumptions: [], aiDrafted: false, appliedStyle: null });

  const save = () => {
    if (session.form) void saver.save(session.form, { variantOf: original.id, rawInput: null });
  };

  const discard = async () => {
    const ok = await confirm({ title: 'Discard this variant?', body: 'The draft is thrown away. The original item is not affected.', confirmLabel: 'Discard', danger: true });
    if (ok) {
      generation.cancel();
      clearSession();
    }
  };

  useHotkeys(
    {
      'mod+s': (e) => {
        e.preventDefault();
        save();
      },
    },
    { enabled: session.stage === 'review' },
  );

  const crumbs = (
    <nav className="crumbs" aria-label="Breadcrumb">
      <Link to={`/items/${original.id}`}>{original.title}</Link>
      <span aria-hidden="true">/</span>
      <span>Variant</span>
    </nav>
  );

  if (session.stage === 'review' && session.form) {
    return (
      <div className="page page-wide">
        <ReviewScreen
          header={
            <div>
              {crumbs}
              <h1 className="page-title">Review the variant</h1>
            </div>
          }
          form={session.form}
          onFormChange={(form) => patch({ form })}
          errors={saver.errors}
          collections={collections}
          tagSuggestions={tags.map((t) => t.name)}
          judgeLanguages={meta.data?.judge.languages.map((l) => l.id) ?? []}
          onCreateCollection={() => collectionActions.create(null, (c) => setSession((s) => (s.form ? { ...s, form: { ...s.form, collectionIds: [...s.form.collectionIds, c.id] } } : s)))}
          aiDrafted={session.aiDrafted}
          kind="variant"
          assumptions={session.assumptions}
          appliedStyle={session.appliedStyle}
          originalText={original.body}
          originalLabel={`The original: ${original.title}`}
          aiEnabled={aiEnabled}
          styles={styles}
          styleChoice={styleChoice}
          onStyleChange={(c) => patch({ styleChoice: c })}
          onRevise={(instruction) => void revise(instruction)}
          revising={generation.running}
          reviseStartedAt={generation.startedAt}
          reviseError={generation.error}
          onCancelRevise={generation.cancel}
          onSave={save}
          saving={saver.saving}
          saveError={saver.error}
          saveLabel="Save as a new item"
          onBack={() => {
            generation.cancel();
            patch({ stage: 'choose' });
          }}
          backLabel="Back to options"
          onDiscard={() => void discard()}
        />
      </div>
    );
  }

  return (
    <div className="page page-narrow capture">
      {crumbs}
      <Steps current={0} labels={STEPS} />
      <h1 className="page-title">{isProblem ? 'Practise it again, differently' : 'Rework this reading'}</h1>
      <p className="page-sub">
        {isProblem ? (
          <>
            Get a fresh problem built on <strong>{original.title}</strong>, so you practise the technique instead of remembering the answer. It is saved as a new item linked to this one; the original
            is not changed.
          </>
        ) : (
          <>
            Draft a new reading derived from <strong>{original.title}</strong> — the same material from a different angle. Say what you want below.
          </>
        )}
      </p>

      {!aiEnabled && (
        <Callout tone="info" title="Variants are drafted by the AI" className="capture-callout" actions={<Link to="/settings#ai">Set up an AI provider</Link>}>
          No AI provider is configured. You can still write a variant by hand; it will be linked to the original.
        </Callout>
      )}

      {isProblem && (
        <fieldset className="mode-cards" disabled={generation.running || !aiEnabled}>
          <legend className="sr-only">What kind of variant</legend>
          {VARIANT_MODES.map((m) => (
            <label key={m.mode} className={cx('mode-card', session.mode === m.mode && 'is-selected')}>
              <input type="radio" name="variant-mode" className="sr-only" checked={session.mode === m.mode} onChange={() => patch({ mode: m.mode })} />
              <span className="mode-card-title">{m.label}</span>
              <span className="mode-card-text">{m.description}</span>
            </label>
          ))}
        </fieldset>
      )}

      <TextAreaField
        label={isProblem ? 'Anything specific? (optional)' : 'What should be different?'}
        value={session.instruction}
        onChange={(v) => patch({ instruction: v })}
        rows={2}
        maxLength={limits?.maxInstructionChars}
        placeholder={isProblem ? 'e.g. set it on a grid · require O(1) extra space · use strings instead of numbers' : 'e.g. focus on the failure modes · rewrite as a checklist for an on-call engineer'}
        disabled={generation.running || !aiEnabled}
        fieldClassName="capture-instruction"
      />

      {generation.running ? (
        <GeneratingPanel title="Drafting the variant…" startedAt={generation.startedAt} onCancel={generation.cancel} />
      ) : (
        <>
          {generation.error != null && <ErrorCallout error={generation.error} title="Drafting failed — your choices are kept" onRetry={() => void generate()} />}
          <div className="capture-actions">
            {aiEnabled && (
              <Button variant="primary" icon={<Sparkles size={15} />} onClick={() => void generate()} disabled={stylesQuery.isPending}>
                {isProblem ? 'Draft another problem' : 'Draft the reading'}
              </Button>
            )}
            {aiEnabled && stylesQuery.isSuccess && <StylePicker styles={styles} value={styleChoice} onChange={(c) => patch({ styleChoice: c })} />}
            <span className="spacer" />
            <Button variant={aiEnabled ? 'ghost' : 'primary'} icon={<PenLine size={14} />} onClick={writeByHand}>
              Write one by hand
            </Button>
          </div>
        </>
      )}

      {session.form && !generation.running && (
        <p className="capture-resume">
          You have a variant in review.{' '}
          <button type="button" className="link-btn" onClick={() => patch({ stage: 'review' })}>
            Return to it
          </button>{' '}
          or draft again to replace it.
        </p>
      )}
    </div>
  );
}
