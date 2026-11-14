import { useEffect, useId, useMemo, useState } from 'react';
import { useParams, useSearchParams } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { CircleSlash, Code2, Eye, EyeOff, Lightbulb, MoreHorizontal, Pencil, Plus, ShieldCheck } from 'lucide-react';
import { api, isApiError } from '../../api/client';
import { useItem, useLimits, useMeta, useSolutions } from '../../api/queries';
import type { Item, Solution } from '../../api/types';
import { useDocumentTitle } from '../../app/useDocumentTitle';
import { absoluteTime, plural, relativeTime } from '../../lib/format';
import { fieldMessage } from '../../lib/itemForm';
import { languageLabel } from '../../lib/languages';
import { Button, LinkButton, cx } from '../../ui/Button';
import { CodeEditor } from '../../ui/CodeEditor';
import { Dialog, useConfirm } from '../../ui/Dialog';
import { useLeaveGuard } from '../../ui/LeaveGuard';
import { TextField } from '../../ui/Field';
import { Markdown } from '../../ui/Markdown';
import { CopyButton, EmptyState, ErrorCallout, ErrorState, PageLoading } from '../../ui/misc';
import { MenuButton } from '../../ui/Popover';
import { useToast } from '../../ui/Toast';
import { ItemBar } from '../item/ItemBar';
import { ItemMissing } from '../item/ItemPage';
import { ReferenceBadge, WriteProblems } from './parts';
import { SolutionForm } from './SolutionForm';
import { TestButton, TestOutcome, useSolutionTest } from './SolutionTest';
import { lineCount, refreshSolutions, serverFieldErrors, useOpenInEditor, useSolutionWrite, validateSolution } from './solutionWrites';

export default function SolutionsPage() {
  const { id = '' } = useParams();
  const item = useItem(id);
  useDocumentTitle(item.data ? `Solutions: ${item.data.title}` : 'Solutions');
  if (item.isPending) return <PageLoading />;
  if (item.isError) {
    if (isApiError(item.error) && item.error.code === 'not_found') return <ItemMissing />;
    return (
      <div className="page">
        <ErrorState page error={item.error} onRetry={() => void item.refetch()} />
      </div>
    );
  }
  if (item.data.type !== 'problem') {
    return (
      <div className="page">
        <EmptyState icon={<CircleSlash size={20} />} page title="Readings have no solutions" actions={<LinkButton to={`/items/${item.data.id}`}>Open the reading</LinkButton>}>
          Solutions belong to problems.
        </EmptyState>
      </div>
    );
  }
  return <SolutionsManager key={item.data.id} item={item.data} />;
}

const NEW = '__new__';

/**
 * A problem's saved solutions. They are spoilers, so a solution's code stays
 * out of the page until the user asks for it; names, languages and notes are
 * shown. One solution can be marked as the reference, the one that is run to
 * verify the expected outputs of test cases.
 */
function SolutionsManager({ item }: { item: Item }) {
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const meta = useMeta().data;
  const limits = useLimits();
  const solutionsQuery = useSolutions(item.id);
  const solutions = useMemo(() => solutionsQuery.data ?? [], [solutionsQuery.data]);
  const reference = solutions.find((s) => s.isReference) ?? null;
  const openInEditor = useOpenInEditor(item);
  const referenceWrite = useSolutionWrite(item);

  // `?add` opens the form for a new solution; links from other pages use it.
  const [params, setParams] = useSearchParams();
  const [editing, setEditing] = useState<string | null>(() => (params.has('add') ? NEW : null));
  useEffect(() => {
    if (params.has('add')) setParams({}, { replace: true });
  }, [params, setParams]);

  // Solutions whose code was asked for. Kept for this visit only.
  const [shown, setShown] = useState<ReadonlySet<string>>(new Set());
  const [renaming, setRenaming] = useState<Solution | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  // Whether the open form holds changes that closing it would lose.
  const [formDirty, setFormDirty] = useState(false);
  const leaveGuard = useLeaveGuard({ when: editing !== null && formDirty, body: 'A solution is open for editing, and its changes have not been saved.' });

  const maxSolutions = limits?.maxSolutionsPerItem;
  const atLimit = maxSolutions !== undefined && solutions.length >= maxSolutions;
  const adding = editing === NEW && !(atLimit && solutionsQuery.isSuccess);

  const show = (id: string, visible: boolean) =>
    setShown((prev) => {
      const next = new Set(prev);
      if (visible) next.add(id);
      else next.delete(id);
      return next;
    });

  const closeForm = () => {
    setEditing(null);
    setFormDirty(false);
  };

  const startEditing = async (id: string) => {
    if (editing !== null && editing !== id && formDirty) {
      const ok = await confirm({ title: 'Discard the changes you have not saved?', body: 'Another solution is open for editing, and its changes were not saved.', confirmLabel: 'Discard changes', danger: true });
      if (!ok) return;
    }
    referenceWrite.reset();
    setFormDirty(false);
    setEditing(id);
    // Editing a solution puts its code on screen, so it counts as shown from here on.
    if (id !== NEW) show(id, true);
  };

  const saved = (solution: Solution) => {
    closeForm();
    show(solution.id, true);
  };

  const setReference = (solution: Solution, isReference: boolean) =>
    referenceWrite.run({
      write: (expectedRevision) => api.solutions.update(solution.id, { isReference, ...(expectedRevision !== undefined ? { expectedRevision } : {}) }),
      checked: true,
      done: () => toast.success(isReference ? `“${solution.name}” is now the reference solution` : 'This problem no longer has a reference solution'),
    });

  const remove = async (solution: Solution) => {
    const ok = await confirm({
      title: `Delete “${solution.name}”?`,
      body: solution.isReference
        ? 'Its code and notes are deleted. It is the reference solution, so the problem will have none until you choose another. Submissions are not affected.'
        : 'Its code and notes are deleted. Submissions are not affected.',
      confirmLabel: 'Delete solution',
      danger: true,
    });
    if (!ok) return;
    setDeleting(solution.id);
    try {
      await api.solutions.remove(solution.id);
      if (editing === solution.id) closeForm();
      await refreshSolutions(qc, item.id);
      toast.success('Solution deleted');
    } catch (e) {
      toast.error(e);
    } finally {
      setDeleting(null);
    }
  };

  const addButton = (
    <Button
      icon={<Plus size={14} />}
      onClick={() => void startEditing(NEW)}
      disabled={atLimit || adding}
      title={atLimit ? `A problem can have at most ${maxSolutions?.toLocaleString()} saved solutions` : undefined}
    >
      Add solution
    </Button>
  );

  return (
    <div className="workspace">
      <ItemBar item={item} />
      <div className="workspace-scroll">
        <div className="page solutions">
          <div className="section-head">
            <h2 className="section-title">Solutions</h2>
            {solutionsQuery.isSuccess && (
              <span className="muted">
                {solutions.length === 0 ? 'none saved' : `${solutions.length} saved`}
                {atLimit && ' — the most a problem can have'}
                {solutions.length > 0 && !reference && ' · no reference solution'}
              </span>
            )}
            <span className="spacer" />
            {addButton}
          </div>

          {solutionsQuery.isPending ? (
            <PageLoading />
          ) : solutionsQuery.isError ? (
            <ErrorState compact error={solutionsQuery.error} onRetry={() => void solutionsQuery.refetch()} />
          ) : (
            <>
              {solutions.length > 0 && (
                <p className="solutions-intro muted">
                  Code stays hidden until you ask for it, so the page does not spoil a problem you are about to solve again.{' '}
                  {reference ? 'The reference solution is the one run to verify expected outputs of test cases.' : 'Mark one as the reference to verify the expected outputs of test cases with it.'}
                </p>
              )}

              <WriteProblems write={referenceWrite} limits={limits} title="Could not change the reference solution" consequence="Saving anyway changes the reference solution as you asked." />

              {adding && <SolutionForm item={item} reference={reference} onCancel={closeForm} onSaved={saved} onDirty={setFormDirty} />}

              {solutions.length === 0 && !adding ? (
                <div className="card">
                  <EmptyState
                    icon={<Lightbulb size={20} />}
                    title="No saved solutions yet"
                    actions={
                      <>
                        <Button variant="primary" icon={<Plus size={14} />} onClick={() => void startEditing(NEW)}>
                          Add a solution
                        </Button>
                        <LinkButton to={`/items/${item.id}`}>Solve the problem</LinkButton>
                      </>
                    }
                  >
                    <p>
                      Keep the solutions worth coming back to: different approaches, the same idea in another language, a brute force next to the intended one — each with your notes. You can also
                      save the code you are working on from the Solve page.
                    </p>
                    <p>One solution can be marked as the reference. The reference solution is run on the test cases to verify their expected outputs, or to compute them.</p>
                  </EmptyState>
                </div>
              ) : (
                <ol className="solutions-list" aria-label="Saved solutions">
                  {solutions.map((s) =>
                    editing === s.id ? (
                      <li key={s.id}>
                        <SolutionForm item={item} solution={s} reference={reference} onCancel={closeForm} onSaved={saved} onDirty={setFormDirty} />
                      </li>
                    ) : (
                      <li key={s.id}>
                        <SolutionCard
                          item={item}
                          solution={s}
                          languageName={languageLabel(s.language, meta?.judge.languages)}
                          revealed={shown.has(s.id)}
                          busy={deleting === s.id || referenceWrite.busy}
                          onReveal={(visible) => show(s.id, visible)}
                          onOpen={() => void openInEditor(s)}
                          onEdit={() => void startEditing(s.id)}
                          onRename={() => setRenaming(s)}
                          onReference={(isReference) => void setReference(s, isReference)}
                          onDelete={() => void remove(s)}
                        />
                      </li>
                    ),
                  )}
                </ol>
              )}
            </>
          )}
        </div>
      </div>
      {renaming && <RenameDialog key={renaming.id} item={item} solution={renaming} onClose={() => setRenaming(null)} />}
      {leaveGuard.dialog}
    </div>
  );
}

interface SolutionCardProps {
  item: Item;
  solution: Solution;
  /** The language with its toolchain version. */
  languageName: string;
  revealed: boolean;
  busy: boolean;
  onReveal: (visible: boolean) => void;
  onOpen: () => void;
  onEdit: () => void;
  onRename: () => void;
  onReference: (isReference: boolean) => void;
  onDelete: () => void;
}

function SolutionCard({ item, solution, languageName, revealed, busy, onReveal, onOpen, onEdit, onRename, onReference, onDelete }: SolutionCardProps) {
  const titleId = useId();
  const sourceId = useId();
  const lines = lineCount(solution.source);
  const test = useSolutionTest(item, solution);
  return (
    <article className={cx('card solution-item', solution.isReference && 'is-reference')} aria-labelledby={titleId}>
      <header className="solution-head">
        <h3 id={titleId} className="solution-name">
          {solution.name}
        </h3>
        {solution.isReference && <ReferenceBadge />}
      </header>
      <p className="solution-meta">
        <span>{languageName}</span>
        <span>{plural(lines, 'line')}</span>
        <time dateTime={solution.updatedAt} title={absoluteTime(solution.updatedAt)}>
          Updated {relativeTime(solution.updatedAt)}
        </time>
      </p>
      {solution.notes.trim() !== '' && <Markdown source={solution.notes} className="solution-notes" />}
      <TestOutcome item={item} test={test} className="solution-outcome" />
      <div className="solution-actions">
        <Button size="sm" icon={revealed ? <EyeOff size={14} /> : <Eye size={14} />} aria-expanded={revealed} aria-controls={revealed ? sourceId : undefined} onClick={() => onReveal(!revealed)}>
          {revealed ? 'Hide solution' : 'Show solution'}
        </Button>
        <TestButton test={test} />
        <Button size="sm" icon={<Code2 size={14} />} onClick={onOpen} title="Put this code into the Solve editor">
          Open in the editor
        </Button>
        <Button size="sm" icon={<Pencil size={14} />} onClick={onEdit}>
          Edit
        </Button>
        {!solution.isReference && (
          <Button size="sm" icon={<ShieldCheck size={14} />} onClick={() => onReference(true)} disabled={busy}>
            Use as reference
          </Button>
        )}
        <span className="spacer" />
        <MenuButton
          size="sm"
          variant="ghost"
          align="end"
          label={`More actions for ${solution.name}`}
          icon={<MoreHorizontal size={16} />}
          disabled={busy}
          items={[
            { label: 'Rename', onSelect: onRename },
            ...(solution.isReference ? [{ label: 'Stop using as reference', onSelect: () => onReference(false) }] : []),
            'separator',
            { label: 'Delete', onSelect: onDelete, danger: true },
          ]}
        />
      </div>
      {revealed && (
        <div id={sourceId} className="solution-source">
          <div className="editor-toolbar">
            <span className="muted">Read-only. “Edit” changes the code; “Open in the editor” runs it.</span>
            <span className="spacer" />
            <CopyButton text={solution.source} />
          </div>
          <div className="solution-editor solution-editor-ro">
            <CodeEditor value={solution.source} language={solution.language} readOnly ariaLabel={`Code of ${solution.name} (read-only)`} />
          </div>
        </div>
      )}
    </article>
  );
}

function RenameDialog({ item, solution, onClose }: { item: Item; solution: Solution; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const limits = useLimits();
  const formId = useId();
  const [name, setName] = useState(solution.name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const local = validateSolution({ name, source: solution.source, notes: '' }, limits).name ?? null;
  const server = serverFieldErrors(error);
  const unchanged = name.trim() === solution.name;

  const save = async () => {
    if (local) return;
    if (unchanged) {
      onClose();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      // A name is not part of the problem's reference solution, so the item's revision is not involved.
      await api.solutions.update(solution.id, { name: name.trim() });
      await refreshSolutions(qc, item.id);
      toast.success('Solution renamed');
      onClose();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      onClose={onClose}
      guard
      title="Rename solution"
      size="sm"
      locked={busy}
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button type="submit" form={formId} variant="primary" busy={busy} disabled={!!local}>
            Rename
          </Button>
        </>
      }
    >
      <form
        id={formId}
        className="stack"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <TextField
          label="Name"
          value={name}
          onChange={setName}
          error={local ?? (server.fields.name ? fieldMessage(server.fields.name) : null)}
          maxLength={limits?.maxSolutionNameChars}
          autoComplete="off"
          data-autofocus
          onFocus={(e) => e.currentTarget.select()}
        />
        {error != null && server.rest && <ErrorCallout error={error} title="Could not rename the solution" />}
      </form>
    </Dialog>
  );
}
