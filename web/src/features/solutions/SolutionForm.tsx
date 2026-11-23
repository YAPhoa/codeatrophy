import { useEffect, useId, useMemo, useState } from 'react';
import { Save } from 'lucide-react';
import { api } from '../../api/client';
import { useLimits, useMeta } from '../../api/queries';
import type { Item, Solution, SolutionPatch } from '../../api/types';
import { finePointer } from '../../lib/pointer';
import { pickLanguage } from '../../lib/codeStore';
import { focusFirstInvalid } from '../../lib/focusInvalid';
import { formatBytes, plural } from '../../lib/format';
import { fieldMessage } from '../../lib/itemForm';
import { byteLength } from '../../lib/text';
import { Button } from '../../ui/Button';
import { CodeEditor } from '../../ui/CodeEditor';
import { useConfirm } from '../../ui/Dialog';
import { Checkbox, SelectField, TextAreaField, TextField } from '../../ui/Field';
import { useToast } from '../../ui/Toast';
import { NotesHint, WriteProblems } from './parts';
import { lineCount, serverFieldErrors, solutionLanguageOptions, touchesReference, useSolutionWrite, validateSolution } from './solutionWrites';

interface SolutionFormProps {
  item: Item;
  /** The solution being edited; absent when adding one. */
  solution?: Solution;
  /** The current reference solution, if any, to say what ticking "reference" replaces. */
  reference: Solution | null;
  onSaved: (saved: Solution) => void;
  onCancel: () => void;
  /** Told whenever the form starts or stops holding unsaved changes. */
  onDirty?: (dirty: boolean) => void;
}

/** Add a solution, or edit one: name, language, code, notes and whether it is the reference. */
export function SolutionForm({ item, solution, reference, onSaved, onCancel, onDirty }: SolutionFormProps) {
  const toast = useToast();
  const confirm = useConfirm();
  const meta = useMeta().data;
  const limits = useLimits();
  const write = useSolutionWrite(item);
  const sourceLabelId = useId();
  const sourceErrorId = useId();

  // The starting values are those of the moment the form opened.
  const [initial] = useState(() => {
    if (solution) return { name: solution.name, language: solution.language, source: solution.source, notes: solution.notes, isReference: solution.isReference };
    const offered = solutionLanguageOptions(meta?.judge.languages).map((o) => o.value);
    return {
      name: '',
      language: pickLanguage(item.id, offered, item.problem?.starterCode ?? {}) ?? 'python',
      source: '',
      notes: '',
      // The first solution of a problem is most useful as its reference.
      isReference: reference === null,
    };
  });

  const [name, setName] = useState(initial.name);
  const [language, setLanguage] = useState(initial.language);
  const [source, setSource] = useState(initial.source);
  const [notes, setNotes] = useState(initial.notes);
  const [isReference, setIsReference] = useState(initial.isReference);
  const [attempted, setAttempted] = useState(false);

  const languageOptions = useMemo(() => solutionLanguageOptions(meta?.judge.languages, language), [meta, language]);
  const dirty = name !== initial.name || language !== initial.language || source !== initial.source || notes !== initial.notes || isReference !== initial.isReference;
  useEffect(() => onDirty?.(dirty), [dirty, onDirty]);

  const local = validateSolution({ name, source, notes }, limits);
  const server = serverFieldErrors(write.error);
  // Size limits are reported as soon as they are exceeded; a missing name or
  // empty code only once the user has tried to save.
  const shown = {
    name: local.name && (attempted || name.trim() !== '') ? local.name : server.fields.name ? fieldMessage(server.fields.name) : null,
    language: server.fields.language ? fieldMessage(server.fields.language) : null,
    source: local.source && (attempted || source.trim() !== '') ? local.source : server.fields.source ? fieldMessage(server.fields.source) : null,
    notes: local.notes ?? (server.fields.notes ? fieldMessage(server.fields.notes) : null),
  };

  const submit = async () => {
    setAttempted(true);
    if (local.name || local.source || local.notes) {
      focusFirstInvalid();
      return;
    }
    const values = { name: name.trim(), language, source, notes, isReference };
    const done = (saved: Solution) => {
      toast.success(solution ? 'Solution saved' : 'Solution added');
      onSaved(saved);
    };
    if (!solution) {
      await write.run({
        write: (expectedRevision) => api.solutions.create(item.id, { ...values, ...(expectedRevision !== undefined ? { expectedRevision } : {}) }),
        checked: touchesReference(null, values),
        done,
      });
      return;
    }
    // Only what changed is sent, so that an edit made elsewhere to another
    // field of the same solution is not put back.
    const patch: SolutionPatch = {
      ...(values.name !== solution.name ? { name: values.name } : {}),
      ...(values.language !== solution.language ? { language: values.language } : {}),
      ...(values.source !== solution.source ? { source: values.source } : {}),
      ...(values.notes !== solution.notes ? { notes: values.notes } : {}),
      ...(values.isReference !== solution.isReference ? { isReference: values.isReference } : {}),
    };
    if (Object.keys(patch).length === 0) {
      onCancel();
      return;
    }
    await write.run({
      write: (expectedRevision) => api.solutions.update(solution.id, { ...patch, ...(expectedRevision !== undefined ? { expectedRevision } : {}) }),
      checked: touchesReference(solution, patch),
      done,
    });
  };

  const cancel = async () => {
    if (dirty && !(await confirm({ title: solution ? 'Discard changes to this solution?' : 'Discard this solution?', confirmLabel: solution ? 'Discard changes' : 'Discard solution', danger: true }))) return;
    onCancel();
  };

  const notesLimit = limits?.maxSolutionNotesChars;
  const replaces = reference && reference.id !== solution?.id ? reference : null;

  return (
    <form
      className="card card-pad solution-form"
      aria-label={solution ? `Edit ${solution.name}` : 'Add a solution'}
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <div className="solution-form-top">
        <TextField
          label="Name"
          value={name}
          onChange={setName}
          error={shown.name}
          maxLength={limits?.maxSolutionNameChars}
          autoComplete="off"
          placeholder="e.g. Hash map, one pass…"
          fieldClassName="grow"
          autoFocus={finePointer()}
        />
        <SelectField label="Language" value={language} onChange={setLanguage} options={languageOptions} error={shown.language} fieldClassName="solution-form-language" />
      </div>

      <div className="field">
        <div className="solution-form-label">
          <span id={sourceLabelId} className="field-label">
            Code
          </span>
          <span className="field-hint">
            {plural(lineCount(source), 'line')} · {formatBytes(byteLength(source))}
            {limits ? ` of ${formatBytes(limits.maxSourceBytes)}` : ''}
          </span>
        </div>
        <div className="editor-frame solution-form-editor" role="group" aria-labelledby={sourceLabelId} aria-describedby={shown.source ? sourceErrorId : undefined}>
          <CodeEditor
            key={language}
            value={source}
            onChange={setSource}
            language={language}
            // A "solution only" problem runs the code after its runner's prefix.
            runsAfter={item.problem?.interface === 'function' ? item.problem.harness[language]?.prefix : null}
            ariaLabel="Solution code"
            placeholder="Paste or write a complete program that reads stdin and writes stdout…"
          />
        </div>
        {shown.source && (
          <div id={sourceErrorId} className="field-error" role="alert">
            {shown.source}
          </div>
        )}
      </div>

      <TextAreaField
        label="Notes (optional)"
        value={notes}
        onChange={setNotes}
        rows={4}
        error={shown.notes}
        hint={<NotesHint notes={notes} limit={notesLimit} />}
        placeholder="e.g. O(n) time, O(n) space. Store each value’s index and look up the complement…"
      />

      <Checkbox
        checked={isReference}
        onChange={setIsReference}
        label="Use as the reference solution"
        hint={
          <>
            The reference solution is run to check the expected output of each test case.
            {isReference && replaces && <> It replaces “{replaces.name}” as the reference; that solution stays saved.</>}
            {!isReference && solution?.isReference && ' Unticking leaves the problem without a reference solution.'}
          </>
        }
      />

      <WriteProblems write={write} limits={limits} hideError={!server.rest && write.error != null} />

      <div className="form-actions">
        <Button type="submit" variant="primary" icon={<Save size={14} />} busy={write.busy}>
          {solution ? 'Save solution' : 'Add solution'}
        </Button>
        <Button variant="ghost" onClick={() => void cancel()} disabled={write.busy}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
