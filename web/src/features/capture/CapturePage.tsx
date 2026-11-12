import { useEffect, useRef } from 'react';
import { Link, useSearchParams } from 'react-router';
import { PenLine, Sparkles } from 'lucide-react';
import { ApiError, api } from '../../api/client';
import { useCollections, useMeta, useStyles, useTags } from '../../api/queries';
import type { AppliedStyle, ItemType } from '../../api/types';
import { useDocumentTitle } from '../../app/useDocumentTitle';
import { MOD, useHotkeys } from '../../lib/hotkeys';
import { charCount, draftFromForm, emptyForm, formFromDraft, revisionProblem, type ItemFormState } from '../../lib/itemForm';
import { useStoredState } from '../../lib/useStoredState';
import { Button } from '../../ui/Button';
import { useConfirm } from '../../ui/Dialog';
import { Segmented } from '../../ui/Field';
import { Callout, ErrorCallout, Kbd } from '../../ui/misc';
import { useCollectionActions } from '../collections/CollectionActions';
import { GeneratingPanel, Steps } from './parts';
import { ReviewScreen } from './ReviewScreen';
import { StylePicker, resolveStyleChoice, type StyleChoice } from './StylePicker';
import { useGeneration } from './useGeneration';
import { useSaveDraft } from './useSaveDraft';

interface CaptureSession {
  stage: 'input' | 'review';
  text: string;
  typeHint: 'auto' | ItemType;
  /** `undefined` until the user picks one; then a preset id or `null` for none. */
  styleChoice?: StyleChoice;
  form: ItemFormState | null;
  assumptions: string[];
  aiDrafted: boolean;
  appliedStyle: AppliedStyle | null;
}

const fresh = (): CaptureSession => ({ stage: 'input', text: '', typeHint: 'auto', form: null, assumptions: [], aiDrafted: false, appliedStyle: null });

const STEPS = ['Capture', 'Review', 'Save'] as const;

/**
 * The capture flow: paste or type anything → the AI drafts a complete item →
 * review and edit → save. Works as a plain authoring form when AI is off.
 * Work in progress is kept in localStorage, so a reload or a detour to
 * Settings does not lose it.
 */
export default function CapturePage() {
  useDocumentTitle('Capture');
  const [searchParams] = useSearchParams();
  const meta = useMeta();
  const aiEnabled = meta.data?.ai.enabled ?? false;
  const { data: collections = [] } = useCollections();
  const { data: tags = [] } = useTags();
  const stylesQuery = useStyles();
  const styles = stylesQuery.data ?? [];
  const collectionActions = useCollectionActions();
  const confirm = useConfirm();
  const [session, setSession, clearSession] = useStoredState<CaptureSession>('capture:new', fresh);
  const generation = useGeneration();
  const saver = useSaveDraft(clearSession);
  const textRef = useRef<HTMLTextAreaElement>(null);

  const presetCollection = searchParams.get('collection');
  const defaults = (): Partial<ItemFormState> => ({ collectionIds: presetCollection ? [presetCollection] : [] });
  const styleChoice = resolveStyleChoice(session.styleChoice, styles);
  const patch = (change: Partial<CaptureSession>) => setSession((s) => ({ ...s, ...change }));

  useEffect(() => {
    if (session.stage === 'input') textRef.current?.focus();
  }, [session.stage]);

  const text = session.text;
  const maxText = meta.data?.limits.maxDraftTextChars ?? Infinity;
  const textLength = charCount(text);
  const tooLong = textLength > maxText;
  const canDraft = aiEnabled && text.trim().length > 0 && !tooLong && !generation.running && !stylesQuery.isPending;

  const draft = async () => {
    if (!canDraft) return;
    const res = await generation.run((signal) => api.ai.draft({ text, typeHint: session.typeHint, styleId: styleChoice }, signal));
    if (!res) return;
    patch({
      stage: 'review',
      form: formFromDraft(res.draft, defaults()),
      assumptions: res.draft.assumptions,
      aiDrafted: true,
      appliedStyle: res.style,
      styleChoice: res.style?.id ?? null,
    });
  };

  const revise = async (instruction: string) => {
    if (!session.form) return;
    const current = session.form;
    const previousDraft = draftFromForm(current, session.assumptions);
    const res = await generation.run((signal) => {
      const problem = revisionProblem(previousDraft, meta.data?.limits);
      if (problem) throw new ApiError(413, 'too_large', problem);
      return api.ai.draft({ text, typeHint: current.type, instruction, previousDraft, styleId: styleChoice }, signal);
    });
    if (!res) return;
    patch({
      // Keep what the model does not produce: where the item is filed and where it came from.
      form: {
        ...formFromDraft(res.draft, { collectionIds: current.collectionIds }),
        sourceUrl: current.sourceUrl,
        sourceNote: current.sourceNote,
      },
      assumptions: res.draft.assumptions,
      appliedStyle: res.style,
      styleChoice: res.style?.id ?? null,
    });
  };

  const writeByHand = () => {
    const type: ItemType = session.typeHint === 'reading' ? 'reading' : 'problem';
    patch({ stage: 'review', form: { ...emptyForm(type), ...defaults(), body: text }, assumptions: [], aiDrafted: false, appliedStyle: null });
  };

  const discard = async () => {
    const ok = await confirm({
      title: 'Discard this draft?',
      body: 'The draft and your original input are thrown away. Nothing has been saved to the library.',
      confirmLabel: 'Discard',
      danger: true,
    });
    if (ok) {
      generation.cancel();
      clearSession();
    }
  };

  const save = () => {
    if (session.form) void saver.save(session.form, { rawInput: session.aiDrafted ? text : null });
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

  if (session.stage === 'review' && session.form) {
    return (
      <div className="page page-wide">
        <ReviewScreen
          header={
            <div>
              <Steps current={1} labels={STEPS} />
              <h1 className="page-title">{session.aiDrafted ? 'Review the draft' : `New ${session.form.type}`}</h1>
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
          kind="draft"
          assumptions={session.assumptions}
          appliedStyle={session.appliedStyle}
          originalText={session.aiDrafted ? text : undefined}
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
          actions={<Link to="/settings#ai">Set up an AI provider</Link>}
        >
          No AI provider is configured, so entries are written by hand: put down what you have and continue to the editor.
        </Callout>
      )}

      <div className="capture-box">
        <label htmlFor="capture-text" className="sr-only">
          What you have
        </label>
        <textarea
          id="capture-text"
          ref={textRef}
          className="capture-text"
          value={text}
          readOnly={generation.running}
          onChange={(e) => patch({ text: e.target.value })}
          placeholder={'e.g. “that interview question: array of ints and a target, return the two indices that add up to it, should be O(n)”'}
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
            value={!aiEnabled && session.typeHint === 'auto' ? 'problem' : session.typeHint}
            onChange={(v) => patch({ typeHint: v })}
            options={[
              ...(aiEnabled ? [{ value: 'auto' as const, label: 'Auto-detect' }] : []),
              { value: 'problem' as const, label: 'Problem' },
              { value: 'reading' as const, label: 'Reading' },
            ]}
          />
          {aiEnabled && stylesQuery.isSuccess && <StylePicker styles={styles} value={styleChoice} onChange={(c) => patch({ styleChoice: c })} disabled={generation.running} />}
          <span className="spacer" />
          <span id="capture-count" className={tooLong ? 'field-error' : 'muted capture-count'}>
            {tooLong
              ? `${textLength.toLocaleString()} / ${maxText.toLocaleString()} characters — too long to draft from`
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
          {generation.error != null && <ErrorCallout error={generation.error} title="Drafting failed — your input is untouched" onRetry={() => void draft()} />}
          <div className="capture-actions">
            {aiEnabled ? (
              <>
                <Button variant="primary" icon={<Sparkles size={15} />} onClick={() => void draft()} disabled={!canDraft}>
                  Draft with AI
                </Button>
                <span className="muted capture-kbd">
                  <Kbd>{MOD}</Kbd> <Kbd>Enter</Kbd>
                </span>
                <span className="spacer" />
                <Button variant="ghost" icon={<PenLine size={14} />} onClick={writeByHand}>
                  Write it by hand
                </Button>
              </>
            ) : (
              <Button variant="primary" icon={<PenLine size={15} />} onClick={writeByHand}>
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
