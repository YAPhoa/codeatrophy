import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { Merge, Pencil, Tags, Trash2 } from 'lucide-react';
import { api } from '../../api/client';
import { invalidateLibrary, useLimits, useTags } from '../../api/queries';
import type { Tag } from '../../api/types';
import { useDocumentTitle } from '../../app/useDocumentTitle';
import { focusFirstInvalid } from '../../lib/focusInvalid';
import { tagProblem } from '../../lib/itemForm';
import { plural } from '../../lib/format';
import { useUrlText } from '../../lib/urlState';
import { Button, IconButton, LinkButton } from '../../ui/Button';
import { Dialog, useConfirm } from '../../ui/Dialog';
import { SelectField, TextField } from '../../ui/Field';
import { Callout, EmptyState, ErrorCallout, ErrorState, PageLoading } from '../../ui/misc';
import { useToast } from '../../ui/Toast';

type Editing = { kind: 'rename'; tag: Tag } | { kind: 'merge'; tag: Tag } | null;

const normalize = (s: string) => s.trim().toLowerCase().replace(/\s+/g, '-');

/** Every tag with its item count; rename, merge into another tag, or delete. */
export default function TagsPage() {
  useDocumentTitle('Tags');
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const tags = useTags();
  const limits = useLimits();
  const [filter, setFilter] = useUrlText('q');
  const [editing, setEditing] = useState<Editing>(null);
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  // What is wrong with an empty or unchanged name is said once the user has tried to save it.
  const [attempted, setAttempted] = useState(false);

  const list = useMemo(() => tags.data ?? [], [tags.data]);
  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return q ? list.filter((t) => t.name.includes(q)) : list;
  }, [list, filter]);

  const open = (next: NonNullable<Editing>) => {
    setEditing(next);
    setError(null);
    setAttempted(false);
    setValue(next.kind === 'rename' ? next.tag.name : (list.find((t) => t.name !== next.tag.name)?.name ?? ''));
  };

  const target = normalize(value);
  const existing = editing ? list.find((t) => t.name === target && t.name !== editing.tag.name) : undefined;
  const unchanged = editing !== null && target === editing.tag.name;
  const problem = target ? tagProblem(target, limits) : null;
  const shownProblem = problem ?? (attempted ? (!target ? 'Enter a name for the tag.' : unchanged ? 'That is the name it has now.' : null) : null);

  const apply = async () => {
    if (!editing) return;
    setAttempted(true);
    if (!target || unchanged || problem) {
      focusFirstInvalid();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await api.tags.rename(editing.tag.name, target);
      await invalidateLibrary(qc);
      toast.success(existing ? `Merged “${editing.tag.name}” into “${res.name}” (${plural(res.count, 'item')})` : `Renamed to “${res.name}”`);
      setEditing(null);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (tag: Tag) => {
    const ok = await confirm({
      title: `Delete the tag “${tag.name}”?`,
      body: `It is removed from ${plural(tag.count, 'item')}. The items themselves are not touched.`,
      confirmLabel: 'Delete tag',
      danger: true,
    });
    if (!ok) return;
    try {
      await api.tags.remove(tag.name);
      await invalidateLibrary(qc);
      toast.success(`Deleted the tag “${tag.name}”`);
    } catch (e) {
      toast.error(e);
    }
  };

  return (
    <div className="page page-narrow">
      <header className="page-header">
        <div className="grow">
          <h1 className="page-title">Tags</h1>
          <p className="page-sub">Tags are free-form labels that cut across collections. A tag exists for as long as at least one item carries it.</p>
        </div>
      </header>

      {tags.isPending ? (
        <PageLoading />
      ) : tags.isError ? (
        <ErrorState error={tags.error} onRetry={() => void tags.refetch()} />
      ) : list.length === 0 ? (
        <EmptyState icon={<Tags size={24} />} title="No tags yet" actions={<LinkButton to="/">Go to the library</LinkButton>}>
          Add tags while capturing or editing an item, or select several items in the library and use “Tags”.
        </EmptyState>
      ) : (
        <>
          {list.length > 10 && (
            <input className="input tags-filter" type="search" name="q" autoComplete="off" placeholder="Filter tags…" aria-label="Filter tags" value={filter} onChange={(e) => setFilter(e.target.value)} />
          )}
          <div className="card">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Tag</th>
                  <th scope="col" className="num">
                    Items
                  </th>
                  <th scope="col">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {shown.map((t) => (
                  <tr key={t.name}>
                    <td>
                      <Link to={`/?tag=${encodeURIComponent(t.name)}`} className="chip chip-tag">
                        {t.name}
                      </Link>
                    </td>
                    <td className="num">{t.count}</td>
                    <td className="table-actions">
                      <IconButton size="sm" label={`Rename ${t.name}`} icon={<Pencil size={14} />} onClick={() => open({ kind: 'rename', tag: t })} />
                      <IconButton size="sm" label={`Merge ${t.name} into another tag`} icon={<Merge size={14} />} disabled={list.length < 2} onClick={() => open({ kind: 'merge', tag: t })} />
                      <IconButton size="sm" label={`Delete ${t.name}`} icon={<Trash2 size={14} />} onClick={() => void remove(t)} />
                    </td>
                  </tr>
                ))}
                {shown.length === 0 && (
                  <tr>
                    <td colSpan={3} className="muted">
                      No tag matches “{filter}”.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}

      <Dialog
        open={editing !== null}
        onClose={() => setEditing(null)}
        guard
        title={editing?.kind === 'merge' ? `Merge “${editing.tag.name}” into…` : `Rename “${editing?.tag.name ?? ''}”`}
        size="sm"
        locked={busy}
        footer={
          <>
            <Button onClick={() => setEditing(null)} disabled={busy}>
              Cancel
            </Button>
            <Button variant="primary" type="submit" form="tag-form" busy={busy}>
              {existing || editing?.kind === 'merge' ? 'Merge' : 'Rename'}
            </Button>
          </>
        }
      >
        <form
          id="tag-form"
          className="stack"
          onSubmit={(e) => {
            e.preventDefault();
            void apply();
          }}
        >
          {editing?.kind === 'merge' ? (
            <SelectField
              label="Target tag"
              value={value}
              onChange={setValue}
              options={list.filter((t) => t.name !== editing.tag.name).map((t) => ({ value: t.name, label: `${t.name} (${t.count})` }))}
              hint={`Every item tagged “${editing.tag.name}” gets the target tag instead, and “${editing.tag.name}” disappears.`}
            />
          ) : (
            <TextField
              label="New name"
              value={value}
              onChange={setValue}
              data-autofocus
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              error={shownProblem}
              hint={target && target !== value ? `Will be saved as “${target}”.` : 'Applies to every item that has this tag.'}
            />
          )}
          {existing && editing?.kind === 'rename' && (
            <Callout tone="warn" title={`“${existing.name}” already exists`}>
              Renaming will merge the two: the {plural(editing.tag.count, 'item')} tagged “{editing.tag.name}” join the {existing.count} already tagged “{existing.name}”. This cannot be undone.
            </Callout>
          )}
          {error != null && <ErrorCallout error={error} />}
        </form>
      </Dialog>
    </div>
  );
}
