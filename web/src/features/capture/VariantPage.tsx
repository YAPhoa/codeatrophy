import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { PenLine, Sparkles, Trash2 } from 'lucide-react';
import { api, jobError } from '../../api/client';
import { invalidateJobs, qk, useItem, useLargeTestCaseCount, useMeta, usePreferences, useStyles } from '../../api/queries';
import type { Item, VariantRequest } from '../../api/types';
import { useDocumentTitle } from '../../app/useDocumentTitle';
import { relativeTime } from '../../lib/format';
import { emptyForm, type ItemFormState } from '../../lib/itemForm';
import { Button, cx } from '../../ui/Button';
import { useConfirm } from '../../ui/Dialog';
import { TextAreaField } from '../../ui/Field';
import { Callout, EmptyState, ErrorCallout, ErrorState, PageLoading } from '../../ui/misc';
import { emptyContent, type DraftContent, type VariantInput } from '../drafts/draftContent';
import { DraftReview } from '../drafts/DraftReview';
import type { ServerDraft } from '../drafts/useServerDraft';
import { ModelPicker, useProviderChoice, type ProviderChoice } from './ModelPicker';
import { GeneratingPanel, Steps } from './parts';
import { StylePicker, resolveStyleChoice, type StyleChoice } from './StylePicker';
import { VARIANT_MODES, isVariantMode } from './variantModes';

const STEPS = ['Choose', 'Review', 'Save'] as const;

/** The original's tags and collections are a sensible starting point for the new item. */
export const inheritedFrom = (original: Item | null): Partial<ItemFormState> => (original ? { tags: original.tags, collectionIds: original.collectionIds } : {});

/** A variant written by hand starts with the original's interface, as a drafted one does. */
function handForm(original: Item): ItemFormState {
  return { ...emptyForm(original.type), ...inheritedFrom(original), difficulty: original.difficulty, interface: original.problem?.interface ?? 'program' };
}

function variantRequest(choice: VariantInput, styleId: StyleChoice, largeTestCases: number, provider: { providerId?: string | null }): VariantRequest {
  return { mode: choice.mode, instruction: choice.instruction.trim() || null, styleId, largeTestCases, ...provider };
}

export default function VariantPage() {
  const { id = '' } = useParams();
  const item = useItem(id);
  if (item.isPending) return <PageLoading />;
  if (item.isError) {
    return (
      <div className="page">
        <ErrorState page error={item.error} onRetry={() => void item.refetch()} title={undefined} />
      </div>
    );
  }
  return <NewVariant key={item.data.id} original={item.data} />;
}

function Crumbs({ original }: { original: Item | null }) {
  return (
    <nav className="crumbs" aria-label="Breadcrumb">
      {original ? (
        <Link to={`/items/${original.id}`} className="truncate" title={original.title}>
          {original.title}
        </Link>
      ) : (
        <Link to="/drafts">Drafts</Link>
      )}
      <span aria-hidden="true">/</span>
      <span>Variant</span>
    </nav>
  );
}

interface ChooseProps {
  original: Item;
  choice: VariantInput;
  onChoice: (change: Partial<VariantInput>) => void;
  styleChoice: StyleChoice | undefined;
  onStyleChange: (choice: StyleChoice) => void;
  providerChoice: ProviderChoice;
  onProviderChange: (id: string) => void;
  running: { startedAt: number | null; onCancel: () => void } | null;
  starting: boolean;
  error: unknown;
  onGenerate: () => void;
  onWriteByHand: () => void;
  onDiscard?: () => void;
  footer?: ReactNode;
}

/** What kind of variant to draft, with anything specific to ask for. */
function Choose(props: ChooseProps) {
  const { original } = props;
  const isProblem = original.type === 'problem';
  const meta = useMeta();
  const limits = meta.data?.limits;
  const aiEnabled = meta.data?.ai.enabled ?? false;
  const stylesQuery = useStyles();
  const styles = stylesQuery.data ?? [];
  const styleChoice = resolveStyleChoice(props.styleChoice, styles);
  const provider = useProviderChoice(props.providerChoice, props.error);
  const busy = props.running !== null || props.starting;

  return (
    <div className="page page-narrow capture">
      <Crumbs original={original} />
      <Steps current={0} labels={STEPS} />
      <h1 className="page-title">{isProblem ? 'Practise from a new angle' : 'Rework this reading'}</h1>
      <p className="page-sub">
        {isProblem ? (
          <>
            Make a new problem based on <strong>{original.title}</strong>, so you practise the technique instead of recalling the answer. It is saved as a new item linked to this one, and the
            original stays as it is.
          </>
        ) : (
          <>
            Draft a new reading that covers the material in <strong>{original.title}</strong> from a different angle. Say what you want below.
          </>
        )}
      </p>

      {!aiEnabled && (
        <Callout tone="info" title="Variants are drafted by the AI" className="capture-callout" actions={<Link to="/settings/ai">AI settings</Link>}>
          AI features are off. You can still write a variant by hand; it will be linked to the original.
        </Callout>
      )}

      {isProblem && (
        <fieldset className="mode-cards" disabled={busy || !aiEnabled}>
          <legend className="sr-only">What kind of variant</legend>
          {VARIANT_MODES.map((m) => (
            <label key={m.mode} className={cx('mode-card', props.choice.mode === m.mode && 'is-selected')}>
              <input type="radio" name="variant-mode" className="sr-only" checked={props.choice.mode === m.mode} onChange={() => props.onChoice({ mode: m.mode })} />
              <span className="mode-card-title">{m.label}</span>
              <span className="mode-card-text">{m.description}</span>
            </label>
          ))}
        </fieldset>
      )}

      <TextAreaField
        label={isProblem ? 'Anything specific? (optional)' : 'What should be different?'}
        value={props.choice.instruction}
        onChange={(v) => props.onChoice({ instruction: v })}
        rows={2}
        maxLength={limits?.maxInstructionChars}
        placeholder={isProblem ? 'e.g. set it on a grid · require O(1) extra space · use strings instead of numbers…' : 'e.g. focus on the failure modes · rewrite as a checklist for an on-call engineer…'}
        disabled={busy || !aiEnabled}
        fieldClassName="capture-instruction"
      />

      {aiEnabled && (
        <div className="variant-options">
          {stylesQuery.isSuccess && <StylePicker styles={styles} value={styleChoice} onChange={props.onStyleChange} disabled={busy} />}
          <ModelPicker settings={provider.settings} value={provider.value} onChange={props.onProviderChange} disabled={busy} />
        </div>
      )}

      {props.running ? (
        <GeneratingPanel title="Drafting the variant…" startedAt={props.running.startedAt} onCancel={props.running.onCancel}>
          This usually takes a few seconds. You can leave this page.
        </GeneratingPanel>
      ) : (
        <>
          {props.error != null && <ErrorCallout error={props.error} title="Drafting failed" onRetry={props.onGenerate} />}
          <div className="capture-actions">
            <Button variant={aiEnabled ? 'ghost' : 'primary'} icon={<PenLine size={14} />} onClick={props.onWriteByHand} disabled={props.starting}>
              Write one by hand
            </Button>
            {props.onDiscard && (
              <Button variant="ghost" icon={<Trash2 size={14} />} onClick={props.onDiscard} disabled={props.starting}>
                Discard
              </Button>
            )}
            <span className="spacer" />
            {aiEnabled && (
              <Button variant="primary" icon={<Sparkles size={16} />} onClick={props.onGenerate} busy={props.starting} disabled={stylesQuery.isPending}>
                {isProblem ? 'Draft another problem' : 'Draft the reading'}
              </Button>
            )}
          </div>
        </>
      )}
      {props.footer}
    </div>
  );
}

/**
 * Derive a new item from an existing one — another problem to practise the
 * same idea on. Drafting it, or writing it by hand, makes a draft on the
 * server, reviewed like a captured item and saved with `variantOf`.
 */
function NewVariant({ original }: { original: Item }) {
  useDocumentTitle(`Variant of ${original.title}`);
  const [searchParams] = useSearchParams();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const requested = searchParams.get('mode');
  const isProblem = original.type === 'problem';
  const [choice, setChoice] = useState<VariantInput>({ mode: isProblem && isVariantMode(requested) ? requested : 'similar', instruction: '' });
  const [styleChoice, setStyleChoice] = useState<StyleChoice | undefined>(undefined);
  const [providerChoice, setProviderChoice] = useState<ProviderChoice>(undefined);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const styles = useStyles().data ?? [];
  const provider = useProviderChoice(providerChoice, error);
  const largeCount = useLargeTestCaseCount();
  const largeTestCases = usePreferences().largeTestCase ? largeCount : 0;
  // Variants of this item already in progress.
  const pending = useQuery({ queryKey: [...qk.drafts, { variantOf: original.id }], queryFn: ({ signal }) => api.drafts.list({ kind: 'variant', variantOf: original.id }, signal), select: (d) => d.items });
  const latest = pending.data?.[0];

  // A link that names a mode ("Harder" on the saved screen) wins.
  useEffect(() => {
    if (isProblem && isVariantMode(requested)) setChoice((c) => (c.mode !== requested ? { ...c, mode: requested } : c));
  }, [requested, isProblem]);

  const content = (form: ItemFormState | null): DraftContent => ({ ...emptyContent(), form, variant: choice, styleChoice, providerChoice });

  const start = async (generate: boolean) => {
    setStarting(true);
    setError(null);
    try {
      const created = await api.drafts.create({
        kind: 'variant',
        variantOf: original.id,
        content: { ...content(generate ? null : handForm(original)) },
        ...(generate ? { generate: variantRequest(choice, resolveStyleChoice(styleChoice, styles), largeTestCases, provider.request) } : {}),
      });
      qc.setQueryData(qk.draft(created.id), created);
      void invalidateJobs(qc);
      navigate(`/drafts/${created.id}`, { replace: true });
    } catch (e) {
      setError(e);
      setStarting(false);
    }
  };

  return (
    <Choose
      original={original}
      choice={choice}
      onChoice={(change) => setChoice((c) => ({ ...c, ...change }))}
      styleChoice={styleChoice}
      onStyleChange={setStyleChoice}
      providerChoice={providerChoice}
      onProviderChange={setProviderChoice}
      running={null}
      starting={starting}
      error={error}
      onGenerate={() => void start(true)}
      onWriteByHand={() => void start(false)}
      footer={
        latest && (
          <p className="capture-resume">
            You have {pending.data!.length === 1 ? 'a variant' : `${pending.data!.length} variants`} of this item in progress.{' '}
            <Link to={`/drafts/${latest.id}`}>Open the latest</Link> <span className="muted">({relativeTime(latest.updatedAt)})</span>
          </p>
        )
      }
    />
  );
}

/** A variant draft: its options until there is a form (or the user goes back to them), then the review. */
export function VariantDraft({ sd, content, original }: { sd: ServerDraft; content: DraftContent; original: Item | null }) {
  const draft = sd.draft!;
  const navigate = useNavigate();
  const confirm = useConfirm();
  const qc = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const styles = useStyles().data ?? [];
  const largeCount = useLargeTestCaseCount();
  const largeTestCases = usePreferences().largeTestCase ? largeCount : 0;
  const [askError, setAskError] = useState<unknown>(null);
  const provider = useProviderChoice(content.providerChoice, askError);
  const form = content.form;
  const backToOptions = searchParams.get('step') === 'input' && original !== null;
  const requested = draft.request && !('text' in draft.request) ? draft.request : null;
  const choice: VariantInput = content.variant ?? { mode: requested?.mode ?? 'similar', instruction: requested?.instruction ?? '' };
  useDocumentTitle(original ? `Variant of ${original.title}` : 'Variant');

  const seq = draft.generationSeq;
  const seenSeq = useRef(seq);
  useEffect(() => {
    if (seq === seenSeq.current) return;
    seenSeq.current = seq;
    if (backToOptions) setSearchParams({}, { replace: true });
  }, [seq, backToOptions, setSearchParams]);

  const afterDiscard = original ? `/items/${original.id}/variant` : '/drafts';

  const discard = async () => {
    const ok = await confirm({ title: 'Discard this variant?', body: 'The draft is thrown away. The original item is not affected.', confirmLabel: 'Discard variant', danger: true });
    if (!ok) return;
    sd.forget();
    await api.drafts.remove(draft.id).catch(() => undefined);
    if (draft.job) await api.ai.dismiss(draft.job.id).catch(() => undefined);
    qc.removeQueries({ queryKey: qk.draft(draft.id) });
    void invalidateJobs(qc);
    navigate(afterDiscard, { replace: true });
  };


  if (form && !backToOptions) {
    return (
      <div className="page page-wide">
        <DraftReview
          sd={sd}
          content={{ ...content, form }}
          kind="variant"
          header={
            <div>
              <Crumbs original={original} />
              <h1 className="page-title">Review the variant</h1>
            </div>
          }
          originalText={original?.body}
          originalLabel={original ? `The original: ${original.title}` : undefined}
          revision={(ask) => ({
            mode: choice.mode,
            instruction: ask.instruction,
            previousDraft: ask.previousDraft,
            styleId: ask.styleId,
            // The form's own choice of interface is the one a revision keeps.
            ...(ask.form.type === 'problem' ? { interfaceHint: ask.form.interface } : {}),
            largeTestCases: ask.largeTestCases,
            ...ask.provider,
          })}
          extras={{ variantOf: draft.variantOf, rawInput: null }}
          saveLabel="Save as a new item"
          backLabel="Back to options"
          onBack={() => setSearchParams({ step: 'input' })}
          discardTitle="Discard this variant?"
          discardBody="The draft is thrown away. The original item is not affected."
          discardLabel="Discard variant"
          afterDiscard={afterDiscard}
        />
      </div>
    );
  }

  if (!original) {
    return (
      <div className="page">
        <EmptyState page title="The original is gone" actions={<Button variant="danger" onClick={() => void discard()}>Discard variant</Button>}>
          The item this variant was based on has been deleted.
        </EmptyState>
      </div>
    );
  }

  const running = draft.state === 'drafting' ? { startedAt: draft.job ? Date.parse(draft.job.startedAt ?? draft.job.createdAt) : null, onCancel: () => void sd.cancel() } : null;
  const failed = draft.state === 'failed' && draft.error && !form ? jobError(draft.error) : null;

  const generate = async () => {
    setAskError(null);
    try {
      await sd.generate(variantRequest(choice, resolveStyleChoice(content.styleChoice, styles), largeTestCases, provider.request));
    } catch (e) {
      setAskError(e);
    }
  };

  return (
    <Choose
      original={original}
      choice={choice}
      onChoice={(change) => sd.update((c) => ({ ...c, variant: { ...choice, ...change } }))}
      styleChoice={content.styleChoice}
      onStyleChange={(s) => sd.update((c) => ({ ...c, styleChoice: s }))}
      providerChoice={content.providerChoice}
      onProviderChange={(id) => sd.update((c) => ({ ...c, providerChoice: id }))}
      running={running}
      starting={false}
      error={askError ?? failed}
      onGenerate={() => void generate()}
      onWriteByHand={() => {
        sd.update((c) => ({ ...c, form: handForm(original), assumptions: [], aiDrafted: false, appliedStyle: null, check: null, checked: undefined, usage: null }));
        if (backToOptions) setSearchParams({}, { replace: true });
      }}
      onDiscard={form ? undefined : () => void discard()}
      footer={
        form &&
        !running && (
          <p className="capture-resume">
            You have a variant in review.{' '}
            <button type="button" className="link-btn" onClick={() => setSearchParams({}, { replace: true })}>
              Return to it
            </button>{' '}
            or draft again to replace it.
          </p>
        )
      }
    />
  );
}

