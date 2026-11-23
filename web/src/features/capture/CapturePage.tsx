import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { PenLine, Sparkles, Trash2 } from 'lucide-react';
import { api, jobError } from '../../api/client';
import { invalidateJobs, qk, useLargeTestCaseCount, useMeta, usePreferences, useStyles } from '../../api/queries';
import { useDocumentTitle } from '../../app/useDocumentTitle';
import { finePointer } from '../../lib/pointer';
import { emptyForm, type ItemFormState } from '../../lib/itemForm';
import { charCount } from '../../lib/text';
import { remove } from '../../lib/storage';
import { useStoredState } from '../../lib/useStoredState';
import { Button } from '../../ui/Button';
import { useConfirm } from '../../ui/Dialog';
import { Segmented } from '../../ui/Field';
import { Callout, ErrorCallout } from '../../ui/misc';
import { emptyContent, type CaptureInput, type DraftContent } from '../drafts/draftContent';
import { DraftReview } from '../drafts/DraftReview';
import type { ServerDraft } from '../drafts/useServerDraft';
import { ModelPicker, useProviderChoice, type ProviderChoice } from './ModelPicker';
import { GeneratingPanel, Steps } from './parts';
import { draftRequest } from './requests';
import { StylePicker, resolveStyleChoice, type StyleChoice } from './StylePicker';
import { TestCountPicker, useTestCaseCount } from './TestCountPicker';

const STEPS = ['Capture', 'Review', 'Save'] as const;

const freshInput = (): CaptureInput => ({ text: '', typeHint: 'auto', interfaceHint: 'auto' });

/** What the capture page holds before a draft exists: kept in this browser, so a reload or a detour does not lose it. */
interface Unsent extends CaptureInput {
  styleChoice?: StyleChoice;
  providerChoice?: ProviderChoice;
  testCaseCount?: number;
}

const UNSENT_KEY = 'capture:input';

/** A form written by hand from the input: what was typed becomes the statement. */
function handForm(input: CaptureInput, collectionIds: string[]): ItemFormState {
  const type = input.typeHint === 'reading' ? 'reading' : 'problem';
  return { ...emptyForm(type), collectionIds, body: input.text, interface: input.interfaceHint === 'function' ? 'function' : 'program' };
}

interface CaptureFormProps {
  input: CaptureInput;
  onInput: (change: Partial<CaptureInput>) => void;
  styleChoice: StyleChoice | undefined;
  onStyleChange: (choice: StyleChoice) => void;
  providerChoice: ProviderChoice;
  onProviderChange: (id: string) => void;
  testCaseCount: number | undefined;
  onTestCaseCountChange: (count: number) => void;
  /** A generation under way: when it started, and how to stop it. */
  running: { startedAt: number | null; onCancel: () => void } | null;
  /** The request is on its way. */
  starting: boolean;
  error: unknown;
  onDraft: () => void;
  onWriteByHand: () => void;
  onDiscard?: () => void;
  /** Shown under the actions. */
  footer?: ReactNode;
}

/** The capture's input: the text, what kind of item it is, and how to write it. */
function CaptureForm(props: CaptureFormProps) {
  const meta = useMeta();
  const aiEnabled = meta.data?.ai.enabled ?? false;
  const stylesQuery = useStyles();
  const styles = stylesQuery.data ?? [];
  const styleChoice = resolveStyleChoice(props.styleChoice, styles);
  const provider = useProviderChoice(props.providerChoice, props.error);
  const testCases = useTestCaseCount(props.testCaseCount);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const { input, running } = props;
  const busy = running !== null || props.starting;

  useEffect(() => {
    if (finePointer()) textRef.current?.focus();
  }, []);

  const interfaceHint = input.interfaceHint;
  // Without AI there is nothing to detect: the choices are the two interfaces.
  const kind = !aiEnabled && input.typeHint === 'auto' ? 'problem' : input.typeHint;
  const writes = !aiEnabled && interfaceHint === 'auto' ? 'program' : interfaceHint;
  const text = input.text;
  const maxText = meta.data?.limits.maxDraftTextChars ?? Infinity;
  const textLength = charCount(text);
  const tooLong = textLength > maxText;
  const canDraft = aiEnabled && text.trim().length > 0 && !tooLong && !busy && !stylesQuery.isPending;
  // Asked to draft from nothing: say so by the text, until something is typed.
  const [askedEmpty, setAskedEmpty] = useState(false);
  const needsText = askedEmpty && text.trim() === '';

  const draft = () => {
    if (!canDraft) {
      if (aiEnabled && !busy && !stylesQuery.isPending) {
        setAskedEmpty(true);
        textRef.current?.focus();
      }
      return;
    }
    props.onDraft();
  };

  return (
    <>
      {!aiEnabled && (
        <Callout tone="info" title="AI drafting is off" className="capture-callout" actions={<Link to="/settings/ai">AI settings</Link>}>
          Items are written by hand. Note down what you have and continue to the editor.
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
          readOnly={busy}
          onChange={(e) => props.onInput({ text: e.target.value })}
          placeholder={'e.g. “that interview question: array of ints and a target, return the two indices that add up to it, should be O(n)”…'}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              if (aiEnabled) draft();
              else props.onWriteByHand();
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
            onChange={(v) => props.onInput({ typeHint: v })}
            options={[
              ...(aiEnabled ? [{ value: 'auto' as const, label: 'Auto-detect' }] : []),
              { value: 'problem' as const, label: 'Problem' },
              { value: 'reading' as const, label: 'Reading' },
            ]}
          />
          {/* Disabled rather than removed for a reading, so the controls after it do not move. */}
          <Segmented
            size="sm"
            label="What you write"
            value={writes}
            onChange={(v) => props.onInput({ interfaceHint: v })}
            options={[
              ...(aiEnabled ? [{ value: 'auto' as const, label: 'Auto', title: 'Let the AI choose' }] : []),
              { value: 'function' as const, label: 'Solution only', title: 'You write a function or class; a hidden runner does the rest' },
              { value: 'program' as const, label: 'Full program', title: 'You write the whole program, input and output included' },
            ].map((o) => (kind === 'reading' ? { ...o, title: 'Only for problems', disabled: true } : o))}
          />
          {aiEnabled && stylesQuery.isSuccess && <StylePicker styles={styles} value={styleChoice} onChange={props.onStyleChange} disabled={busy} />}
          {aiEnabled && <ModelPicker settings={provider.settings} value={provider.value} onChange={props.onProviderChange} disabled={busy} />}
          {aiEnabled && kind !== 'reading' && <TestCountPicker value={testCases.count} max={testCases.max} onChange={props.onTestCaseCountChange} disabled={busy} />}
          <span className="spacer" />
          {/* An alert only while something is wrong, so the running count is not read out on every keystroke. */}
          <span id="capture-count" className={tooLong || needsText ? 'field-error' : 'muted capture-count'} role={tooLong || needsText ? 'alert' : undefined}>
            {tooLong
              ? `${textLength.toLocaleString()} / ${maxText.toLocaleString()} characters, too long to draft from`
              : needsText
                ? 'Type or paste something to draft from.'
                : textLength > 0
                  ? `${textLength.toLocaleString()} characters`
                  : ''}
          </span>
        </div>
      </div>

      {running ? (
        <GeneratingPanel title="Drafting…" startedAt={running.startedAt} onCancel={running.onCancel}>
          This usually takes a few seconds. You can leave this page.
        </GeneratingPanel>
      ) : (
        <>
          {props.error != null && <ErrorCallout error={props.error} title="Drafting failed" onRetry={draft} />}
          <div className="capture-actions">
            {aiEnabled ? (
              <>
                <Button variant="ghost" icon={<PenLine size={14} />} onClick={props.onWriteByHand} disabled={props.starting}>
                  Write it by hand
                </Button>
                {props.onDiscard && (
                  <Button variant="ghost" icon={<Trash2 size={14} />} onClick={props.onDiscard} disabled={props.starting}>
                    Discard
                  </Button>
                )}
                <span className="spacer" />
                <Button variant="primary" icon={<Sparkles size={16} />} onClick={draft} busy={props.starting} disabled={stylesQuery.isPending}>
                  Draft with AI
                </Button>
              </>
            ) : (
              <Button variant="primary" icon={<PenLine size={16} />} onClick={props.onWriteByHand} busy={props.starting}>
                Continue to the editor
              </Button>
            )}
          </div>
        </>
      )}
      {props.footer}
    </>
  );
}

function CaptureIntro() {
  const aiEnabled = useMeta().data?.ai.enabled ?? false;
  return (
    <>
      <Steps current={0} labels={STEPS} />
      <h1 className="page-title">Capture</h1>
      <p className="page-sub">
        Paste or type what you have: part of a problem statement, a few lines from memory, or an article.
        {aiEnabled ? ' The AI turns it into a complete entry and tells you what it had to assume. Nothing is saved until you have reviewed it.' : ''}
      </p>
    </>
  );
}

/**
 * The capture flow's start: paste or type anything, then the AI drafts a
 * complete item, or it is written by hand. Either way it becomes a draft on
 * the server, which the review continues from.
 */
export default function CapturePage() {
  useDocumentTitle('Capture');
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [unsent, setUnsent, clearUnsent] = useStoredState<Unsent>(UNSENT_KEY, freshInput);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const styles = useStyles().data ?? [];
  const provider = useProviderChoice(unsent.providerChoice, error);
  const largeCount = useLargeTestCaseCount();
  const largeTestCases = usePreferences().largeTestCase ? largeCount : 0;
  const testCaseCount = useTestCaseCount(unsent.testCaseCount).count;
  const presetCollection = searchParams.get('collection');
  const collectionIds = presetCollection ? [presetCollection] : [];

  // The capture session of earlier versions was kept whole in this browser; drafts now live on the server.
  useEffect(() => remove('capture:new'), []);

  // Arriving from a library view filtered to one type starts the new item as
  // that type. The parameter is used once and then dropped, so the choice
  // stays the user's to change and a reload does not undo it.
  const presetType = searchParams.get('type');
  useEffect(() => {
    if (presetType == null) return;
    if (presetType === 'problem' || presetType === 'reading') setUnsent((s) => ({ ...s, typeHint: presetType }));
    setSearchParams(
      (current) => {
        const next = new URLSearchParams(current);
        next.delete('type');
        return next;
      },
      { replace: true },
    );
  }, [presetType, setUnsent, setSearchParams]);

  const input: CaptureInput = { text: unsent.text, typeHint: unsent.typeHint, interfaceHint: unsent.interfaceHint ?? 'auto' };
  const content = (form: ItemFormState | null): DraftContent => ({
    ...emptyContent(),
    form,
    input,
    styleChoice: unsent.styleChoice,
    providerChoice: unsent.providerChoice,
    testCaseCount: unsent.testCaseCount,
    ...(collectionIds.length > 0 ? { collectionIds } : {}),
  });

  const start = async (create: () => Promise<{ id: string }>) => {
    setStarting(true);
    setError(null);
    try {
      const created = await create();
      void invalidateJobs(qc);
      clearUnsent();
      navigate(`/drafts/${created.id}`, { replace: true });
    } catch (e) {
      setError(e);
      setStarting(false);
    }
  };

  const draft = () =>
    void start(async () => {
      const created = await api.drafts.create({ kind: 'capture', content: { ...content(null) }, generate: draftRequest(input, resolveStyleChoice(unsent.styleChoice, styles), largeTestCases, testCaseCount, provider.request) });
      qc.setQueryData(qk.draft(created.id), created);
      return created;
    });

  const writeByHand = () => void start(() => api.drafts.create({ kind: 'capture', content: { ...content(handForm(input, collectionIds)) } }));

  return (
    <div className="page page-narrow capture">
      <CaptureIntro />
      <CaptureForm
        input={input}
        onInput={(change) => setUnsent((s) => ({ ...s, ...change }))}
        styleChoice={unsent.styleChoice}
        onStyleChange={(c) => setUnsent((s) => ({ ...s, styleChoice: c }))}
        providerChoice={unsent.providerChoice}
        onProviderChange={(id) => setUnsent((s) => ({ ...s, providerChoice: id }))}
        testCaseCount={unsent.testCaseCount}
        onTestCaseCountChange={(n) => setUnsent((s) => ({ ...s, testCaseCount: n }))}
        running={null}
        starting={starting}
        error={error}
        onDraft={draft}
        onWriteByHand={writeByHand}
      />
    </div>
  );
}

/** A capture draft: its input until there is a form (or the user goes back to it), then the review. */
export function CaptureDraft({ sd, content }: { sd: ServerDraft; content: DraftContent }) {
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
  const backToInput = searchParams.get('step') === 'input';
  const requested = draft.request && 'text' in draft.request ? draft.request : null;
  const testCaseChoice = content.testCaseCount ?? (requested?.testCaseCount || undefined);
  const testCaseCount = useTestCaseCount(testCaseChoice).count;
  const input: CaptureInput = content.input ?? { ...freshInput(), text: requested?.text ?? '', typeHint: requested?.typeHint ?? 'auto', interfaceHint: requested?.interfaceHint ?? 'auto' };
  useDocumentTitle(form ? (form.title.trim() ? `Draft: ${form.title}` : 'Draft') : 'Capture');

  // A new generation taken in leads back to the review.
  const seq = draft.generationSeq;
  const seenSeq = useRef(seq);
  useEffect(() => {
    if (seq === seenSeq.current) return;
    seenSeq.current = seq;
    if (backToInput) setSearchParams({}, { replace: true });
  }, [seq, backToInput, setSearchParams]);

  const goToInput = () => setSearchParams({ step: 'input' });
  const toReview = () => setSearchParams({}, { replace: true });

  if (form && !backToInput) {
    return (
      <div className="page page-wide">
        <DraftReview
          sd={sd}
          content={{ ...content, form }}
          kind="draft"
          header={
            <div>
              <Steps current={1} labels={STEPS} />
              <h1 className="page-title">{content.aiDrafted ? 'Review the draft' : `New ${form.type}`}</h1>
            </div>
          }
          originalText={content.aiDrafted ? input.text : undefined}
          revision={(ask) => ({
            text: input.text,
            typeHint: ask.form.type,
            // The form's own choice of interface is the one a revision keeps.
            ...(ask.form.type === 'problem' ? { interfaceHint: ask.form.interface, testCaseCount: ask.testCaseCount } : {}),
            instruction: ask.instruction,
            previousDraft: ask.previousDraft,
            styleId: ask.styleId,
            largeTestCases: ask.largeTestCases,
            ...ask.provider,
          })}
          extras={{ rawInput: content.aiDrafted ? input.text : null }}
          saveLabel="Save to library"
          backLabel="Back to input"
          onBack={goToInput}
          discardTitle="Discard this draft?"
          discardBody="The draft and your original input are thrown away. Nothing has been saved to the library."
          discardLabel="Discard draft"
          afterDiscard="/new"
        />
      </div>
    );
  }

  const running = draft.state === 'drafting' ? { startedAt: draft.job ? Date.parse(draft.job.startedAt ?? draft.job.createdAt) : null, onCancel: () => void sd.cancel() } : null;
  const failed = draft.state === 'failed' && draft.error && !form ? jobError(draft.error) : null;
  const error = askError ?? failed;

  const draftAgain = async () => {
    setAskError(null);
    try {
      await sd.generate(draftRequest(input, resolveStyleChoice(content.styleChoice, styles), largeTestCases, testCaseCount, provider.request));
    } catch (e) {
      setAskError(e);
    }
  };

  const writeByHand = () => {
    sd.update((c) => ({ ...c, form: handForm(input, c.form?.collectionIds ?? c.collectionIds ?? []), assumptions: [], aiDrafted: false, appliedStyle: null, check: null, checked: undefined, usage: null }));
    if (backToInput) toReview();
  };

  const discard = async () => {
    const ok = await confirm({ title: 'Discard this draft?', body: 'Your input is thrown away. Nothing has been saved to the library.', confirmLabel: 'Discard draft', danger: true });
    if (!ok) return;
    sd.forget();
    await api.drafts.remove(draft.id).catch(() => undefined);
    if (draft.job) await api.ai.dismiss(draft.job.id).catch(() => undefined);
    qc.removeQueries({ queryKey: qk.draft(draft.id) });
    void invalidateJobs(qc);
    navigate('/new', { replace: true });
  };

  return (
    <div className="page page-narrow capture">
      <CaptureIntro />
      <CaptureForm
        input={input}
        onInput={(change) => sd.update((c) => ({ ...c, input: { ...input, ...change } }))}
        styleChoice={content.styleChoice}
        onStyleChange={(choice) => sd.update((c) => ({ ...c, styleChoice: choice }))}
        providerChoice={content.providerChoice}
        onProviderChange={(id) => sd.update((c) => ({ ...c, providerChoice: id }))}
        testCaseCount={testCaseChoice}
        onTestCaseCountChange={(n) => sd.update((c) => ({ ...c, testCaseCount: n }))}
        running={running}
        starting={false}
        error={error}
        onDraft={() => void draftAgain()}
        onWriteByHand={writeByHand}
        onDiscard={form ? undefined : () => void discard()}
        footer={
          form &&
          !running && (
            <p className="capture-resume">
              You have a draft in review.{' '}
              <button type="button" className="link-btn" onClick={toReview}>
                Return to it
              </button>{' '}
              or draft again to replace it.
            </p>
          )
        }
      />
    </div>
  );
}
