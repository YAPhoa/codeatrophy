import { useEffect, useState, type ReactNode } from 'react';
import { ArrowLeft, RefreshCw, Save, ShieldCheck, Square, Trash2, X } from 'lucide-react';
import type { AppliedStyle, Collection, DraftCheck, GenerationUsage, StylePreset } from '../../api/types';
import { useLimits, useMeta } from '../../api/queries';
import { describeDraftCheck } from '../../lib/checks';
import { plural } from '../../lib/format';
import { MOD } from '../../lib/hotkeys';
import { discardableCases, type FormErrors, type ItemFormState } from '../../lib/itemForm';
import { Button } from '../../ui/Button';
import { ErrorCallout, Kbd, Spinner } from '../../ui/misc';
import { ItemEditor } from '../item/ItemEditor';
import type { DraftCheckControl } from './draftChecks';
import { AssumptionsPanel, GeneratingPanel } from './parts';
import { StylePicker, type StyleChoice } from './StylePicker';

interface ReviewScreenProps {
  form: ItemFormState;
  onFormChange: (form: ItemFormState) => void;
  errors: FormErrors;
  collections: readonly Collection[];
  tagSuggestions: readonly string[];
  judgeLanguages: readonly string[];
  onCreateCollection: () => void;

  /** The draft came from the AI (shows assumptions and the revise bar). */
  aiDrafted: boolean;
  kind: 'draft' | 'variant';
  assumptions: readonly string[];
  appliedStyle: AppliedStyle | null;
  /** What running the draft's reference solution found, and whether the form was edited since. */
  check: DraftCheck | null;
  checkStale: boolean;
  /** What the last generation of this draft cost. */
  usage: GenerationUsage | null;
  /** Running the reference solution on the test cases again, as they stand. */
  verify: DraftCheckControl;
  /** The user's original text, shown for comparison. */
  originalText?: string;
  originalLabel?: string;

  aiEnabled: boolean;
  styles: readonly StylePreset[];
  styleChoice: StyleChoice;
  onStyleChange: (choice: StyleChoice) => void;
  onRevise: (instruction: string) => void;
  revising: boolean;
  reviseStartedAt: number | null;
  reviseError: unknown;
  onCancelRevise: () => void;

  onSave: () => void;
  saving: boolean;
  saveError: unknown;
  saveLabel: string;
  onBack: () => void;
  backLabel: string;
  onDiscard: () => void;
  header: ReactNode;
}

/** A check under way: how many cases, for how long, and a way to stop it. */
function CheckProgress({ total, startedAt, onCancel }: { total: number; startedAt: number | null; onCancel: () => void }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, []);
  const seconds = startedAt ? Math.max(0, Math.floor((now - startedAt) / 1000)) : 0;
  return (
    <div className="check-progress">
      <Spinner size={13} />
      {/* The counter stays outside the live region, or it would be read out every second. */}
      <span role="status">Verifying {plural(total, 'test case')}…</span>
      <span className="check-progress-time">{seconds}&nbsp;s</span>
      <span className="muted">You can leave this page.</span>
      <span className="spacer" />
      <Button size="sm" variant="ghost" icon={<Square size={12} />} onClick={onCancel}>
        Cancel
      </Button>
    </div>
  );
}

/** Review of a draft before anything is saved: assumptions, revision, every field editable. */
export function ReviewScreen(props: ReviewScreenProps) {
  const [instruction, setInstruction] = useState('');
  const busy = props.revising || props.saving;
  const limits = useLimits();
  const judgeOn = useMeta().data?.judge.enabled ?? false;
  const { verify, form } = props;
  const blocked = !judgeOn
    ? 'Needs a judge engine'
    : !form.referenceSolution || form.referenceSolution.source.trim() === ''
      ? 'Needs a reference solution'
      : form.testCases.length === 0
        ? 'No test cases yet'
        : null;
  const caseTools = (
    <>
      {blocked && <span className="muted verify-reason">{blocked}</span>}
      <Button size="sm" icon={<ShieldCheck size={13} />} onClick={() => verify.start(form)} busy={verify.running} disabled={blocked !== null}>
        Verify all
      </Button>
    </>
  );
  // What the last "Verify all" found, while the form is as it was checked; the cases it found wrong can go in one step.
  const checkedCases = !props.checkStale && form.testCases.some((t) => t.outcome);
  const discardable = checkedCases ? discardableCases(form) : [];
  const result = checkedCases ? describeDraftCheck(props.check, props.checkStale) : null;
  const caseNotice = verify.running ? (
    <CheckProgress total={verify.total} startedAt={verify.startedAt} onCancel={verify.cancel} />
  ) : verify.error != null ? (
    <ErrorCallout error={verify.error} title="The test cases could not be verified" onRetry={blocked ? undefined : () => verify.start(form)} />
  ) : verify.outdated ? (
    <p className="check-line tone-neutral" role="status">
      The draft changed while it was verified. Verify again.
    </p>
  ) : result ? (
    <div className="large-case-row">
      <p className={`check-line tone-${result.tone}`} role="status">
        {result.text}
      </p>
      <span className="spacer" />
      {discardable.length > 0 && (
        <Button size="sm" variant="ghost" icon={<X size={13} />} onClick={() => verify.discard(discardable)}>
          Discard {discardable.length} failed
        </Button>
      )}
    </div>
  ) : null;

  return (
    <div className="review">
      <div className="review-bar">
        {props.header}
        <span className="spacer" />
        <Button variant="ghost" icon={<ArrowLeft size={14} />} onClick={props.onBack} disabled={busy}>
          {props.backLabel}
        </Button>
        <Button variant="ghost" icon={<Trash2 size={14} />} onClick={props.onDiscard} disabled={busy}>
          Discard
        </Button>
        <Button variant="primary" icon={<Save size={14} />} onClick={props.onSave} busy={props.saving} disabled={props.revising} title={`${MOD}+S`}>
          {props.saveLabel}
        </Button>
      </div>

      {props.saveError != null && <ErrorCallout error={props.saveError} title="Could not save" onRetry={props.onSave} />}

      {props.aiDrafted && (
        <AssumptionsPanel assumptions={props.assumptions} kind={props.kind} style={props.appliedStyle} showStyle={props.styles.length > 0 || props.appliedStyle !== null} usage={props.usage} />
      )}

      {props.aiDrafted && props.aiEnabled && (
        <form
          className="revise"
          onSubmit={(e) => {
            e.preventDefault();
            const text = instruction.trim();
            if (!text || busy) return;
            props.onRevise(text);
          }}
        >
          <label htmlFor="revise-instruction" className="revise-label">
            <RefreshCw size={14} aria-hidden="true" />
            Ask for a revision
          </label>
          <input
            name="instruction"
            id="revise-instruction"
            className="input"
            value={instruction}
            onChange={(e) => setInstruction(e.target.value)}
            placeholder="e.g. use 1-based indices · make it harder · shorten the statement"
            maxLength={limits?.maxInstructionChars}
            disabled={busy}
            autoComplete="off"
          />
          <StylePicker id="revise-style" styles={props.styles} value={props.styleChoice} onChange={props.onStyleChange} disabled={busy} />
          <Button type="submit" disabled={busy || instruction.trim() === ''}>
            Revise draft
          </Button>
          <p className="revise-hint">The AI reworks the draft as it stands now, including your edits, and returns a new version to review.</p>
        </form>
      )}

      {props.revising && (
        <GeneratingPanel title="Revising the draft…" startedAt={props.reviseStartedAt} onCancel={props.onCancelRevise}>
          The current draft stays as it is until the new version arrives.
        </GeneratingPanel>
      )}
      {props.reviseError != null && <ErrorCallout error={props.reviseError} title="The revision failed — your draft is unchanged" />}

      {props.originalText && (
        <details className="original">
          <summary>{props.originalLabel ?? 'Your original input'}</summary>
          <pre>{props.originalText}</pre>
        </details>
      )}

      <ItemEditor
        form={props.form}
        onChange={props.onFormChange}
        mode="create"
        errors={props.errors}
        collections={props.collections}
        tagSuggestions={props.tagSuggestions}
        judgeLanguages={props.judgeLanguages}
        onCreateCollection={props.onCreateCollection}
        disabled={busy}
        check={props.check}
        checkStale={props.checkStale}
        caseTools={caseTools}
        caseNotice={caseNotice}
      />

      <div className="review-foot">
        <span className="muted">
          Nothing is in your library until you save. <Kbd>{MOD}</Kbd> <Kbd>S</Kbd>
        </span>
        <span className="spacer" />
        <Button variant="primary" icon={<Save size={14} />} onClick={props.onSave} busy={props.saving} disabled={props.revising}>
          {props.saveLabel}
        </Button>
      </div>
    </div>
  );
}
