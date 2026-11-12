import { useId, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { api } from '../../api/client';
import { useLimits, useMeta, useSolutions } from '../../api/queries';
import type { Item, Solution } from '../../api/types';
import { plural } from '../../lib/format';
import { charCount, fieldMessage } from '../../lib/itemForm';
import { languageLabel } from '../../lib/languages';
import { Button } from '../../ui/Button';
import { Dialog } from '../../ui/Dialog';
import { Checkbox, TextAreaField, TextField } from '../../ui/Field';
import { Callout } from '../../ui/misc';
import { useToast } from '../../ui/Toast';
import { WriteProblems } from './parts';
import { defaultSolutionName, lineCount, serverFieldErrors, touchesReference, useSolutionWrite, validateSolution } from './solutionWrites';

export interface SaveSolutionDialogProps {
  item: Item;
  open: boolean;
  onClose: () => void;
  /** The code to save. `name` overrides the suggested name. */
  initial: { language: string; source: string; name?: string };
  onSaved?: (solution: Solution) => void;
}

/**
 * Save a piece of code — what is in the editor, or a past submission — as
 * one of the problem's solutions. The code itself is taken as given; the
 * dialog asks for a name, optional notes, and whether it becomes the
 * reference solution.
 */
export function SaveSolutionDialog(props: SaveSolutionDialogProps) {
  // Mounted per opening, so that every opening starts from `initial`.
  if (!props.open) return null;
  return <SaveSolution {...props} />;
}

function SaveSolution({ item, onClose, initial, onSaved }: SaveSolutionDialogProps) {
  const toast = useToast();
  const navigate = useNavigate();
  const meta = useMeta().data;
  const limits = useLimits();
  const solutionsQuery = useSolutions(item.id);
  const write = useSolutionWrite(item);
  const formId = useId();

  const hasReference = (item.problem?.referenceSolution ?? null) !== null;
  // Until the user types, the name follows the suggestion, which waits for
  // the list of solutions to avoid proposing a name already in use.
  const [typedName, setTypedName] = useState<string | null>(initial.name ?? null);
  const name = typedName ?? defaultSolutionName(initial.language, solutionsQuery.data ?? []);
  const [notes, setNotes] = useState('');
  const [isReference, setIsReference] = useState(!hasReference);
  const [attempted, setAttempted] = useState(false);

  const count = solutionsQuery.data?.length ?? item.solutionCount;
  const atLimit = limits !== undefined && count >= limits.maxSolutionsPerItem;
  const local = validateSolution({ name, source: initial.source, notes }, limits);
  const server = serverFieldErrors(write.error);
  const nameError = local.name && (attempted || name.trim() !== '') ? local.name : server.fields.name ? fieldMessage(server.fields.name) : null;
  const notesError = local.notes ?? (server.fields.notes ? fieldMessage(server.fields.notes) : null);
  // The code cannot be changed here, so a problem with it is stated outright.
  const sourceError = local.source ?? (server.fields.source ? fieldMessage(server.fields.source) : null);
  const reference = solutionsQuery.data?.find((s) => s.isReference) ?? null;
  const notesLimit = limits?.maxSolutionNotesChars;

  const save = async () => {
    setAttempted(true);
    if (atLimit || local.name || local.source || local.notes) return;
    const values = { name: name.trim(), language: initial.language, source: initial.source, notes, isReference };
    await write.run({
      write: (expectedRevision) => api.solutions.create(item.id, { ...values, ...(expectedRevision !== undefined ? { expectedRevision } : {}) }),
      checked: touchesReference(null, values),
      done: (saved) => {
        toast.success('Saved as a solution', { label: 'Open solutions', onClick: () => navigate(`/items/${item.id}/solutions`) });
        onSaved?.(saved);
        onClose();
      },
    });
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title="Save as a solution"
      locked={write.busy}
      footer={
        <>
          <Button onClick={onClose} disabled={write.busy}>
            Cancel
          </Button>
          <Button type="submit" form={formId} variant="primary" busy={write.busy} disabled={atLimit || !!sourceError}>
            Save solution
          </Button>
        </>
      }
    >
      <form
        id={formId}
        className="stack save-solution"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <p className="save-solution-code">
          <span className="save-solution-language">{languageLabel(initial.language, meta?.judge.languages)}</span>
          <span className="muted">{plural(lineCount(initial.source), 'line')} of code, saved as it is</span>
        </p>
        {atLimit ? (
          <Callout tone="warn" title={`This problem already has the maximum of ${limits.maxSolutionsPerItem.toLocaleString()} saved solutions`}>
            Delete one you no longer need on the{' '}
            <Link to={`/items/${item.id}/solutions`} onClick={onClose}>
              Solutions page
            </Link>{' '}
            to save another.
          </Callout>
        ) : sourceError ? (
          <Callout tone="danger" role="alert" title="This code cannot be saved as a solution">
            {sourceError}
          </Callout>
        ) : null}
        <TextField
          label="Name"
          value={name}
          onChange={setTypedName}
          error={nameError}
          maxLength={limits?.maxSolutionNameChars}
          autoComplete="off"
          data-autofocus
          onFocus={(e) => e.currentTarget.select()}
        />
        <TextAreaField
          label="Notes (optional)"
          value={notes}
          onChange={setNotes}
          rows={3}
          error={notesError}
          hint={
            <>
              Markdown. The idea, the complexity, what to remember next time.
              {notesLimit !== undefined && charCount(notes) > notesLimit * 0.8 && ` ${charCount(notes).toLocaleString()} of ${notesLimit.toLocaleString()} characters.`}
            </>
          }
        />
        <Checkbox
          checked={isReference}
          onChange={setIsReference}
          label="Use as the reference solution"
          hint={
            <>
              The reference solution is the one run to verify the expected outputs of test cases.
              {isReference && hasReference && <> It replaces {reference ? `“${reference.name}”` : 'the current one'} as the reference; that solution stays saved.</>}
            </>
          }
        />
        <WriteProblems write={write} limits={limits} hideError={(!server.rest && write.error != null) || !!server.fields.source} />
      </form>
    </Dialog>
  );
}
