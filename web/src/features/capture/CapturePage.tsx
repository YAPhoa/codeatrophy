import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { PenLine, Sparkles } from 'lucide-react';
import { ApiError, api } from '../../api/client';
import { useCollections, useLargeTestCaseCount, useMeta, usePreferences, useStyles, useTags } from '../../api/queries';
import type { AppliedStyle, DraftCheck, GenerationUsage, InterfaceHint, ItemType } from '../../api/types';
import { useDocumentTitle } from '../../app/useDocumentTitle';
import { finePointer } from '../../lib/pointer';
import { MOD, useHotkeys } from '../../lib/hotkeys';
import { charCount, checkedState, draftFromForm, emptyForm, formFromDraft, revisionProblem, upgradeForm, type ItemFormState } from '../../lib/itemForm';
import { useUrlMirror } from '../../lib/urlState';
import { useStoredState } from '../../lib/useStoredState';
import { Button } from '../../ui/Button';
import { useConfirm } from '../../ui/Dialog';
import { Segmented } from '../../ui/Field';
import { Callout, ErrorCallout, Kbd } from '../../ui/misc';
import { useCollectionActions } from '../collections/CollectionActions';
import { ModelPicker, useProviderChoice, type ProviderChoice } from './ModelPicker';
import { GeneratingPanel, Steps } from './parts';
import { ReviewScreen } from './ReviewScreen';
import { StylePicker, resolveStyleChoice, type StyleChoice } from './StylePicker';
import { useGeneration } from './useGeneration';
import { useDraftCheck } from './draftChecks';
import { useSaveDraft } from './useSaveDraft';

interface CaptureSession {
  stage: 'input' | 'review';
  text: string;
  typeHint: 'auto' | ItemType;
  /** What a drafted problem should have the solver write. Absent in a session stored before the choice existed. */
  interfaceHint?: InterfaceHint;
  /** `undefined` until the user picks one; then a preset id or `null` for none. */
  styleChoice?: StyleChoice;
  /** `undefined` until the user picks one: the default provider. Kept for the revisions of this draft. */
  providerChoice?: ProviderChoice;
  form: ItemFormState | null;
  assumptions: string[];
  aiDrafted: boolean;
  appliedStyle: AppliedStyle | null;
  /** What running the draft's reference solution found, and the state of the form it was run on. */
  check?: DraftCheck | null;
  usage?: GenerationUsage | null;
  checked?: string;
}

const fresh = (): CaptureSession => ({ stage: 'input', text: '', typeHint: 'auto', form: null, assumptions: [], aiDrafted: false, appliedStyle: null });

const STEPS = ['Capture', 'Review', 'Save'] as const;

/** Where the capture flow keeps its work in progress. */
const SESSION_KEY = 'capture:new';

/**
 * The capture flow: paste or type anything → the AI drafts a complete item →
 * review and edit → save. Works as a plain authoring form when AI is off.
 * Work in progress is kept in localStorage, so a reload or a detour to
 * Settings does not lose it.
 */
export default function CapturePage() {
  useDocumentTitle('Capture');
  const [searchParams, setSearchParams] = useSearchParams();
  const meta = useMeta();
  const aiEnabled = meta.data?.ai.enabled ?? false;
  const { data: collections = [] } = useCollections();
  const { data: tags = [] } = useTags();
  const stylesQuery = useStyles();
  const styles = stylesQuery.data ?? [];
  const collectionActions = useCollectionActions();
  const confirm = useConfirm();
  const [session, setSession, clearSession] = useStoredState<CaptureSession>(SESSION_KEY, fresh);
  const verify = useDraftCheck(SESSION_KEY, session, setSession);
  const generation = useGeneration();
  const saver = useSaveDraft(clearSession);
  const textRef = useRef<HTMLTextAreaElement>(null);
  // Whether to ask for large test cases, and how many, is the user's standing choice; a revision asks again.
  const largeCount = useLargeTestCaseCount();
  const largeTestCases = usePreferences().largeTestCase ? largeCount : 0;

  const presetCollection = searchParams.get('collection');
  const defaults = (): Partial<ItemFormState> => ({ collectionIds: presetCollection ? [presetCollection] : [] });
  const styleChoice = resolveStyleChoice(session.styleChoice, styles);
  const provider = useProviderChoice(session.providerChoice, generation.error);
  const patch = (change: Partial<CaptureSession>) => setSession((s) => ({ ...s, ...change }));
  // The step is part of the address (`?step=review`) and of the history, so Back returns from the review to the input.
  useUrlMirror('step', session.stage === 'review' && session.form ? 'review' : null, (raw) => setSession((s) => ({ ...s, stage: raw === 'review' ? 'review' : 'input' })), true);
  const form = useMemo(() => (session.form ? upgradeForm(session.form) : null), [session.form]);
  const interfaceHint = session.interfaceHint ?? 'auto';
  // Without AI there is nothing to detect: the choices are the two interfaces.
  const kind = !aiEnabled && session.typeHint === 'auto' ? 'problem' : session.typeHint;
  const writes = !aiEnabled && interfaceHint === 'auto' ? 'program' : interfaceHint;

  // Arriving from a library view filtered to one type starts the new item as
  // that type. The parameter is used once and then dropped, so the choice
  // stays the user's to change and a reload does not undo it.
  const presetType = searchParams.get('type');
  useEffect(() => {
    if (presetType == null) return;
    if (presetType === 'problem' || presetType === 'reading') setSession((s) => ({ ...s, typeHint: presetType }));
    setSearchParams(
      (current) => {
        const next = new URLSearchParams(current);
        next.delete('type');
        return next;
      },
      { replace: true },
    );
  }, [presetType, setSession, setSearchParams]);

  useEffect(() => {
    if (session.stage === 'input' && finePointer()) textRef.current?.focus();
  }, [session.stage]);

  const text = session.text;
  const maxText = meta.data?.limits.maxDraftTextChars ?? Infinity;
  const textLength = charCount(text);
  const tooLong = textLength > maxText;
  const canDraft = aiEnabled && text.trim().length > 0 && !tooLong && !generation.running && !stylesQuery.isPending;
  // Asked to draft from nothing: say so by the text, until something is typed.
  const [askedEmpty, setAskedEmpty] = useState(false);
  const needsText = askedEmpty && text.trim() === '';

  const draft = async () => {
    if (!canDraft) {
      if (aiEnabled && !generation.running && !stylesQuery.isPending) {
        setAskedEmpty(true);
        textRef.current?.focus();
      }
      return;
    }
    verify.cancel();
    const res = await generation.run((signal) =>
      api.ai.draft({ text, typeHint: session.typeHint, ...(session.typeHint !== 'reading' ? { interfaceHint } : {}), styleId: styleChoice, largeTestCases, ...provider.request }, signal),
    );
    if (!res) return;
    const drafted = formFromDraft(res.draft, defaults(), res.check?.largeCases);
    patch({
      stage: 'review',
      form: drafted,
      assumptions: res.draft.assumptions,
      aiDrafted: true,
      appliedStyle: res.style,
      styleChoice: res.style?.id ?? null,
      check: res.check,
      usage: res.usage,
      checked: checkedState(drafted),
    });
  };

  const revise = async (instruction: string) => {
    if (!form) return;
    const current = form;
    const previousDraft = draftFromForm(current, session.assumptions);
    verify.cancel();
    const res = await generation.run((signal) => {
      const problem = revisionProblem(previousDraft, meta.data?.limits);
      if (problem) throw new ApiError(413, 'too_large', problem);
      // The form's own choice of interface is the one a revision keeps.
      const hint = current.type === 'problem' ? { interfaceHint: current.interface } : {};
      return api.ai.draft({ text, typeHint: current.type, ...hint, instruction, previousDraft, styleId: styleChoice, largeTestCases, ...provider.request }, signal);
    });
    if (!res) return;
    // Keep what the model does not produce: where the item is filed and where it came from.
    const revised = { ...formFromDraft(res.draft, { collectionIds: current.collectionIds }, res.check?.largeCases), sourceUrl: current.sourceUrl, sourceNote: current.sourceNote };
    patch({
      form: revised,
      assumptions: res.draft.assumptions,
      appliedStyle: res.style,
      styleChoice: res.style?.id ?? null,
      check: res.check,
      usage: res.usage,
      checked: checkedState(revised),
    });
  };

  const writeByHand = () => {
    verify.cancel();
    const type: ItemType = session.typeHint === 'reading' ? 'reading' : 'problem';
    patch({
      stage: 'review',
      form: { ...emptyForm(type), ...defaults(), body: text, interface: interfaceHint === 'function' ? 'function' : 'program' },
      assumptions: [],
      aiDrafted: false,
      appliedStyle: null,
      check: null,
      usage: null,
    });
  };

  const discard = async () => {
    const ok = await confirm({
      title: 'Discard this draft?',
      body: 'The draft and your original input are thrown away. Nothing has been saved to the library.',
      confirmLabel: 'Discard draft',
      danger: true,
    });
    if (ok) {
      generation.cancel();
      verify.cancel();
      clearSession();
    }
  };

  const save = () => {
    if (form) void saver.save(form, { rawInput: session.aiDrafted ? text : null });
  };

  useHotkeys(
    {
      'mod+s': (e) => {
        if (session.stage !== 'review') return;
        e.preventDefault();
        save();
      },
    },
    { enabled: session.stage === 'review' },
  );

  if (session.stage === 'review' && form) {
    return (
      <div className="page page-wide">
        <ReviewScreen
          header={
            <div>
              <Steps current={1} labels={STEPS} />
              <h1 className="page-title">{session.aiDrafted ? 'Review the draft' : `New ${form.type}`}</h1>
            </div>
          }
          form={form}
          onFormChange={(next) => patch({ form: next })}
          errors={saver.errors}
          collections={collections}
          tagSuggestions={tags.map((t) => t.name)}
          judgeLanguages={meta.data?.judge.languages.map((l) => l.id) ?? []}
          onCreateCollection={() => collectionActions.create(null, (c) => setSession((s) => (s.form ? { ...s, form: { ...s.form, collectionIds: [...s.form.collectionIds, c.id] } } : s)))}
          aiDrafted={session.aiDrafted}
          kind="draft"
          assumptions={session.assumptions}
          appliedStyle={session.appliedStyle}
          check={session.check ?? null}
          usage={session.usage ?? null}
          verify={verify}
          checkStale={session.checked !== undefined && session.checked !== checkedState(form)}
          originalText={session.aiDrafted ? text : undefined}
          aiEnabled={aiEnabled}
          styles={styles}
          styleChoice={styleChoice}
          onStyleChange={(c) => patch({ styleChoice: c })}
          aiSettings={provider.settings}
          providerChoice={provider.value}
          onProviderChange={(id) => patch({ providerChoice: id })}
          onRevise={(instruction) => void revise(instruction)}
          revising={generation.running}
          reviseStartedAt={generation.startedAt}
          reviseError={generation.error}
          onCancelRevise={generation.cancel}
          onSave={save}
          saving={saver.saving}
          saveError={saver.error}
          saveLabel="Save to library"
          onBack={() => {
            generation.cancel();
            patch({ stage: 'input' });
          }}
          backLabel="Back to input"
          onDiscard={() => void discard()}
        />
      </div>
    );
  }

  return (
    <div className="page page-narrow capture">
      <Steps current={0} labels={STEPS} />
      <h1 className="page-title">Capture</h1>
      <p className="page-sub">
        Paste or type whatever you have — a chunk of a problem statement, a few lines from memory, an article.
        {aiEnabled ? ' The AI turns it into a complete entry and tells you what it had to assume. Nothing is saved until you have reviewed it.' : ''}
      </p>

      {!aiEnabled && (
        <Callout
          tone="info"
          title="AI drafting is off"
          className="capture-callout"
          actions={<Link to="/settings/ai">Set up an AI provider</Link>}
        >
          No AI provider is configured, so entries are written by hand: put down what you have and continue to the editor.
        </Callout>
      )}

      <div className="capture-box">
        <label htmlFor="capture-text" className="sr-only">
          What you have
        </label>
        <textarea
          name="text"
          id="capture-text"
          ref={textRef}
          className="capture-text"
          autoComplete="off"
          value={text}
          readOnly={generation.running}
          onChange={(e) => patch({ text: e.target.value })}
          placeholder={'e.g. “that interview question: array of ints and a target, return the two indices that add up to it, should be O(n)”…'}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              if (aiEnabled) void draft();
              else writeByHand();
            }
          }}
          aria-describedby="capture-count"
          aria-invalid={tooLong || undefined}
        />
        <div className="capture-controls">
          <Segmented
            size="sm"
            label="Kind of item"
            value={kind}
            onChange={(v) => patch({ typeHint: v })}
            options={[
              ...(aiEnabled ? [{ value: 'auto' as const, label: 'Auto-detect' }] : []),
              { value: 'problem' as const, label: 'Problem' },
              { value: 'reading' as const, label: 'Reading' },
            ]}
          />
          {kind !== 'reading' && (
            <Segmented
              size="sm"
              label="What you write"
              value={writes}
              onChange={(v) => patch({ interfaceHint: v })}
              options={[
                ...(aiEnabled ? [{ value: 'auto' as const, label: 'Auto', title: 'Let the AI choose' }] : []),
                { value: 'function' as const, label: 'Solution only', title: 'You write a function or class; a hidden runner does the rest' },
                { value: 'program' as const, label: 'Full program', title: 'You write the whole program, input and output included' },
              ]}
            />
          )}
          {aiEnabled && stylesQuery.isSuccess && <StylePicker styles={styles} value={styleChoice} onChange={(c) => patch({ styleChoice: c })} disabled={generation.running} />}
          {aiEnabled && <ModelPicker settings={provider.settings} value={provider.value} onChange={(id) => patch({ providerChoice: id })} disabled={generation.running} />}
          <span className="spacer" />
          {/* An alert only while something is wrong, so the running count is not read out on every keystroke. */}
          <span id="capture-count" className={tooLong || needsText ? 'field-error' : 'muted capture-count'} role={tooLong || needsText ? 'alert' : undefined}>
            {tooLong
              ? `${textLength.toLocaleString()} / ${maxText.toLocaleString()} characters — too long to draft from`
              : needsText
                ? 'Type or paste something to draft from.'
                : textLength > 0
                ? `${textLength.toLocaleString()} characters`
                : ''}
          </span>
        </div>
      </div>

      {generation.running ? (
        <GeneratingPanel title="Drafting…" startedAt={generation.startedAt} onCancel={generation.cancel} />
      ) : (
        <>
          {generation.error != null && <ErrorCallout error={generation.error} title="Drafting failed" onRetry={() => void draft()} />}
          <div className="capture-actions">
            {aiEnabled ? (
              <>
                <Button variant="primary" icon={<Sparkles size={16} />} onClick={() => void draft()} disabled={generation.running || stylesQuery.isPending}>
                  Draft with AI
                </Button>
                <span className="muted capture-kbd">
                  <Kbd>{MOD}</Kbd>&nbsp;<Kbd>Enter</Kbd>
                </span>
                <span className="spacer" />
                <Button variant="ghost" icon={<PenLine size={14} />} onClick={writeByHand}>
                  Write it by hand
                </Button>
              </>
            ) : (
              <Button variant="primary" icon={<PenLine size={16} />} onClick={writeByHand}>
                Continue to the editor
              </Button>
            )}
          </div>
        </>
      )}

      {session.form && !generation.running && (
        <p className="capture-resume">
          You have a draft in review.{' '}
          <button type="button" className="link-btn" onClick={() => patch({ stage: 'review' })}>
            Return to it
          </button>{' '}
          or draft again to replace it.
        </p>
      )}
    </div>
  );
}
