import { useCallback, useEffect, useRef, useState } from 'react';
import { useQueryClient, type QueryKey, type UseQueryResult } from '@tanstack/react-query';
import { Lock, Pencil, RotateCcw } from 'lucide-react';
import { api, validationFields } from '../../api/client';
import { qk, useLimits, useSystemPrompt, useTestCasePrompt } from '../../api/queries';
import type { SystemPrompt, TestCasePrompt } from '../../api/types';
import { focusFirstInvalid } from '../../lib/focusInvalid';
import { Button, cx } from '../../ui/Button';
import { useConfirm } from '../../ui/Dialog';
import { Field } from '../../ui/Field';
import { useLeaveGuard } from '../../ui/LeaveGuard';
import { Badge, ErrorCallout, ErrorState, PageLoading } from '../../ui/misc';
import { useToast } from '../../ui/Toast';

/** The id the "Built-in conventions" style links to. */
export const SYSTEM_PROMPT_ID = 'system-prompt';

/** Length as the server counts it: Unicode code points after trimming. */
const length = (s: string) => Array.from(s.trim()).length;

// Control characters other than newline and tab are rejected by the server.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/;

const normalise = (s: string) => s.replace(/\r\n?/g, '\n').trim();

/** What both editable prompts have in common. */
type PromptText = Pick<SystemPrompt, 'builtIn' | 'custom' | 'isCustom' | 'fixed'>;

/** One editable prompt: where it lives and how the card talks about it. */
interface PromptKind<T extends PromptText> {
  id: string;
  title: string;
  /** The heading of the editable section. */
  section: string;
  hint: string;
  queryKey: QueryKey;
  useQuery: () => UseQueryResult<T>;
  put: (custom: string) => Promise<T>;
  reset: () => Promise<void>;
  /** The read-only text under "Fixed rules". */
  fixedText: (data: T) => string;
  confirmTitle: string;
  confirmBody: string;
  resetTitle: string;
  customTitle: string;
  emptyError: string;
  discardBody: string;
  saved: string;
  backToBuiltIn: string;
  /** What has unsaved changes, for the leave guard: "the …". */
  unsaved: string;
}

const SYSTEM_PROMPT: PromptKind<SystemPrompt> = {
  id: SYSTEM_PROMPT_ID,
  title: 'System prompt',
  section: 'Authoring conventions',
  hint: 'Baseline conventions for every draft and variant. The selected writing style is added after.',
  queryKey: qk.systemPrompt,
  useQuery: useSystemPrompt,
  put: (custom) => api.settings.putSystemPrompt(custom),
  reset: () => api.settings.resetSystemPrompt(),
  fixedText: (d) => `${d.fixed}\n\n${d.draftRules}\n\n${d.variantRules}`,
  confirmTitle: 'Edit the system prompt?',
  confirmBody: 'Editing the system prompt changes every draft. A bad edit can make drafts worse.',
  resetTitle: 'Reset to the built-in prompt?',
  customTitle: 'Your own text replaces the built-in conventions',
  emptyError: 'Write the conventions, or cancel to keep the current ones.',
  discardBody: 'The system prompt stays as it was.',
  saved: 'System prompt saved',
  backToBuiltIn: 'Back to the built-in system prompt',
  unsaved: 'the system prompt',
};

const TEST_CASE_PROMPT: PromptKind<TestCasePrompt> = {
  id: 'testcase-prompt',
  title: 'Test case prompt',
  section: 'Test guidance',
  hint: 'Used when generating test cases.',
  queryKey: qk.testCasePrompt,
  useQuery: useTestCasePrompt,
  put: (custom) => api.settings.putTestCasePrompt(custom),
  reset: () => api.settings.resetTestCasePrompt(),
  fixedText: (d) => d.fixed,
  confirmTitle: 'Edit the test case prompt?',
  confirmBody: 'Editing this prompt changes every generated test set. A bad edit can make tests worse.',
  resetTitle: 'Reset to the built-in prompt?',
  customTitle: 'Your own text replaces the built-in guidance',
  emptyError: 'Write the prompt, or cancel to keep the current one.',
  discardBody: 'The test case prompt stays as it was.',
  saved: 'Test case prompt saved',
  backToBuiltIn: 'Back to the built-in test case prompt',
  unsaved: 'the test case prompt',
};

/**
 * The two prompts the user may rewrite: the system prompt (the authoring
 * conventions drafts and variants start from) and the test case prompt. The page holds one leave
 * guard for both, as the router supports a single blocker.
 */
export function SystemPromptCards() {
  const [dirty, setDirty] = useState<Record<string, boolean>>({});
  const onDirty = useCallback((id: string, d: boolean) => setDirty((cur) => (cur[id] === d ? cur : { ...cur, [id]: d })), []);
  const unsaved = [SYSTEM_PROMPT, TEST_CASE_PROMPT].filter((k) => dirty[k.id]).map((k) => k.unsaved);
  const leaveGuard = useLeaveGuard({
    when: unsaved.length > 0,
    body: `Your changes to ${unsaved.join(' and ')} have not been saved.`,
  });
  return (
    <>
      <SystemPromptCard kind={SYSTEM_PROMPT} onDirty={onDirty} />
      <SystemPromptCard kind={TEST_CASE_PROMPT} onDirty={onDirty} />
      {leaveGuard.dialog}
    </>
  );
}

/**
 * One prompt, read-only until the user confirms they want to edit it. The
 * editable part may be replaced with a text of their own; the rules the app
 * depends on are shown below it and cannot be changed.
 */
function SystemPromptCard<T extends PromptText>({ kind, onDirty }: { kind: PromptKind<T>; onDirty: (id: string, dirty: boolean) => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const prompt = kind.useQuery();
  const limits = useLimits();
  const max = limits?.maxSystemPromptChars ?? Infinity;
  // The text being edited, or null while the prompt is shown read-only.
  const [draft, setDraft] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [attempted, setAttempted] = useState(false);
  const editorRef = useRef<HTMLTextAreaElement>(null);
  const titleId = `${kind.id}-title`;
  const formId = `${kind.id}-form`;
  const sectionId = `${kind.id}-editable`;
  const fixedId = `${kind.id}-fixed`;

  const data = prompt.data;
  const current = data ? (data.custom ?? data.builtIn) : '';
  const dirty = draft !== null && normalise(draft) !== normalise(current);
  useEffect(() => onDirty(kind.id, dirty), [onDirty, kind.id, dirty]);
  useEffect(() => () => onDirty(kind.id, false), [onDirty, kind.id]);

  const textLen = draft === null ? 0 : length(draft);
  const textError =
    draft === null
      ? null
      : textLen > max
        ? `${(textLen - max).toLocaleString()} over the limit. Shorten it; nothing is cut off automatically.`
        : CONTROL.test(draft.replace(/\r\n?/g, '\n'))
          ? 'Contains a control character that cannot be saved.'
          : attempted && textLen === 0
            ? kind.emptyError
            : null;
  const serverProblem = validationFields(error).custom;
  const serverError = serverProblem != null ? String(serverProblem) : null;

  const set = (next: T) => qc.setQueryData(kind.queryKey, next);

  const edit = async () => {
    const ok = await confirm({ title: kind.confirmTitle, body: kind.confirmBody, confirmLabel: 'Edit' });
    if (!ok) return;
    setError(null);
    setAttempted(false);
    setDraft(current);
    requestAnimationFrame(() => editorRef.current?.focus());
  };

  const cancel = async () => {
    if (dirty) {
      const ok = await confirm({ title: 'Discard your changes?', body: kind.discardBody, confirmLabel: 'Discard', danger: true });
      if (!ok) return;
    }
    setDraft(null);
  };

  const save = async () => {
    if (draft === null) return;
    setAttempted(true);
    if (textLen === 0 || textError) {
      focusFirstInvalid();
      return;
    }
    if (!dirty) {
      setDraft(null);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const next = await kind.put(normalise(draft));
      set(next);
      setDraft(null);
      toast.success(next.isCustom ? kind.saved : kind.backToBuiltIn);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  const reset = async () => {
    if (!data) return;
    const ok = await confirm({ title: kind.resetTitle, body: 'Your custom text is deleted.', confirmLabel: 'Reset', danger: true });
    if (!ok) return;
    try {
      await kind.reset();
      set({ ...data, custom: null, isCustom: false });
      toast.success(kind.backToBuiltIn);
    } catch (e) {
      toast.error(e);
    }
  };

  return (
    <div id={kind.id} className="sysprompt" role="group" aria-labelledby={titleId}>
      <div className="styles-head">
        <div className="grow">
          <div className="row">
            <h2 id={titleId} className="prefs-group-title" tabIndex={-1}>
              {kind.title}
            </h2>
            {data?.isCustom && (
              <Badge tone="accent" title={kind.customTitle}>
                Custom
              </Badge>
            )}
          </div>
          <p className="field-hint">{kind.hint}</p>
        </div>
        {data?.isCustom && draft === null && (
          <Button size="sm" variant="ghost" icon={<RotateCcw size={14} />} onClick={() => void reset()}>
            Reset to built-in
          </Button>
        )}
        {draft !== null && (
          <>
            <Button size="sm" onClick={() => void cancel()} disabled={busy}>
              Cancel
            </Button>
            <Button size="sm" variant="primary" type="submit" form={formId} busy={busy}>
              Save
            </Button>
          </>
        )}
      </div>

      {prompt.isPending ? (
        <PageLoading />
      ) : prompt.isError ? (
        <ErrorState compact error={prompt.error} onRetry={() => void prompt.refetch()} />
      ) : (
        <div className="card card-pad sysprompt-body">
          <div className="sysprompt-section">
            <div className="sysprompt-section-head">
              <h3 id={sectionId} className="sysprompt-section-title">
                {kind.section}
              </h3>
              {draft === null && (
                <Button size="sm" icon={<Pencil size={14} />} onClick={() => void edit()}>
                  Edit
                </Button>
              )}
            </div>
            {draft === null ? (
              <pre className="sysprompt-text" tabIndex={0} aria-labelledby={sectionId} translate="no">
                {current}
              </pre>
            ) : (
              <form
                id={formId}
                className="stack"
                onSubmit={(e) => {
                  e.preventDefault();
                  void save();
                }}
              >
                <Field
                  label={kind.section}
                  hideLabel
                  error={textError ?? serverError}
                  hint={
                    <span className={cx('style-count', textLen > max && 'is-over')}>
                      {textLen.toLocaleString()} / {max.toLocaleString()}
                    </span>
                  }
                >
                  {(a) => (
                    <textarea
                      {...a}
                      ref={editorRef}
                      className="input textarea mono sysprompt-editor"
                      rows={20}
                      spellCheck={false}
                      autoComplete="off"
                      translate="no"
                      value={draft}
                      onChange={(e) => setDraft(e.target.value)}
                    />
                  )}
                </Field>
                {error != null && serverError == null && <ErrorCallout error={error} title={`Could not save ${kind.unsaved}`} />}
              </form>
            )}
          </div>

          {data && (
            <div className="sysprompt-section">
              <div className="sysprompt-section-head">
                <Lock size={13} aria-hidden="true" />
                <h3 id={fixedId} className="sysprompt-section-title">
                  Fixed rules
                </h3>
                <span className="muted">Read only. Required for the app to function</span>
              </div>
              <pre className="sysprompt-text is-fixed" tabIndex={0} aria-labelledby={fixedId} translate="no">
                {kind.fixedText(data)}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
