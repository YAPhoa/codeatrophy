import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { Merge, Pencil, Tags, Trash2 } from 'lucide-react';
import { api } from '../../api/client';
import { invalidateLibrary, useLimits, useTags } from '../../api/queries';
import type { SortOrder, Tag } from '../../api/types';
import { useDocumentTitle } from '../../app/useDocumentTitle';
import { focusFirstInvalid } from '../../lib/focusInvalid';
import { tagProblem } from '../../lib/itemForm';
import { plural } from '../../lib/format';
import { rememberTagSort, useRememberedTagSort } from '../../lib/sortStore';
import { naturalTagOrder, nextTagOrder, setHideEmptyTags, shownTagOrder, sortTags, tagDirectionText, tagSortChange, TAG_SORTS, useHideEmptyTags, type TagSort } from '../../lib/tagList';
import { useUrlState, useUrlText } from '../../lib/urlState';
import { Button, cx, IconButton, LinkButton } from '../../ui/Button';
import { Dialog, useConfirm } from '../../ui/Dialog';
import { Checkbox, SelectField, TextField } from '../../ui/Field';
import { Callout, EmptyState, ErrorCallout, ErrorState, PageLoading } from '../../ui/misc';
import { SortButton } from '../../ui/SortButton';
import { useToast } from '../../ui/Toast';

type Editing = { kind: 'rename'; tag: Tag } | { kind: 'merge'; tag: Tag } | null;

const normalize = (s: string) => s.trim().toLowerCase().replace(/\s+/g, '-');

// `sort=` and `order=` as the URL has them, `null` when left out: a URL
// that names either shows its own sort rather than the remembered one.
const parseSortParam = (raw: string | null): TagSort | null => ((TAG_SORTS as readonly string[]).includes(raw ?? '') ? (raw as TagSort) : null);
const parseOrderParam = (raw: string | null): SortOrder | null => (raw === 'asc' || raw === 'desc' ? raw : null);
const formatParam = (value: string | null): string | null => value;

const COLUMN_LABEL: Record<TagSort, string> = { name: 'Tag', items: 'Items' };

/**
 * Every tag with its item count, sorted from the column heads; rename,
 * merge into another tag, or delete. Empty tags, which no item carries, are
 * hidden unless the user asks for them.
 */
export default function TagsPage() {
  useDocumentTitle('Tags');
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const tags = useTags();
  const limits = useLimits();
  const [filter, setFilter] = useUrlText('q');
  const [sortParam, setSortParam] = useUrlState('sort', parseSortParam, formatParam);
  const [orderParam, setOrderParam] = useUrlState('order', parseOrderParam, formatParam);
  const remembered = useRememberedTagSort();
  const order = useMemo(() => shownTagOrder({ sort: sortParam, order: orderParam }, remembered), [sortParam, orderParam, remembered]);
  const hideEmptyPref = useHideEmptyTags();
  const [editing, setEditing] = useState<Editing>(null);
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  // What is wrong with an empty or unchanged name is said once the user has tried to save it.
  const [attempted, setAttempted] = useState(false);

  const list = useMemo(() => tags.data ?? [], [tags.data]);
  const emptyCount = list.filter((t) => t.count === 0).length;
  const hideEmpty = hideEmptyPref && emptyCount > 0;
  const q = filter.trim().toLowerCase();
  const matching = useMemo(() => (q ? list.filter((t) => t.name.includes(q)) : list), [list, q]);
  const shown = useMemo(() => sortTags(hideEmpty ? matching.filter((t) => t.count > 0) : matching, order), [matching, hideEmpty, order]);

  const sortBy = (column: TagSort) => {
    const change = tagSortChange(nextTagOrder(order, column));
    rememberTagSort(change.remember);
    setSortParam(change.url.sort);
    setOrderParam(change.url.order);
  };
  const head = (column: TagSort) => {
    const active = order.sort === column;
    const shownOrder = active ? order.order : naturalTagOrder(column);
    const next = nextTagOrder(order, column);
    return (
      <SortButton
        label={COLUMN_LABEL[column]}
        active={active}
        order={shownOrder}
        direction={tagDirectionText(column, shownOrder)}
        title={`Sort by ${COLUMN_LABEL[next.sort].toLowerCase()}, ${tagDirectionText(next.sort, next.order)}`}
        className={cx(column === 'items' && 'is-end')}
        onClick={() => sortBy(column)}
      />
    );
  };
  const ariaSort = (column: TagSort) => (order.sort === column ? (order.order === 'asc' ? 'ascending' : 'descending') : undefined);

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
      body: tag.count === 0 ? 'This tag is currently not attached to any item.' : `This tag would be removed from ${plural(tag.count, 'item')} and deleted. The items themselves are not deleted.`,
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
          <p className="page-sub">Flexible labels for grouping items across collections.</p>
        </div>
      </header>

      {tags.isPending ? (
        <PageLoading />
      ) : tags.isError ? (
        <ErrorState error={tags.error} onRetry={() => void tags.refetch()} />
      ) : list.length === 0 ? (
        <EmptyState icon={<Tags size={20} />} title="No tags yet" actions={<LinkButton to="/">Go to the library</LinkButton>}>
          Add tags while capturing or editing an item, or select several items in the library and use “Tags”.
        </EmptyState>
      ) : (
        <>
          {(list.length > 10 || emptyCount > 0) && (
            <div className="tags-toolbar">
              {list.length > 10 && (
                <input className="input tags-filter" type="search" name="q" autoComplete="off" placeholder="Filter tags…" aria-label="Filter tags" value={filter} onChange={(e) => setFilter(e.target.value)} />
              )}
              {emptyCount > 0 && <Checkbox className="filter-check tags-hide-empty" label="Hide empty tags" checked={hideEmptyPref} onChange={setHideEmptyTags} />}
            </div>
          )}
          <div className="card">
            <table className="table tags-table">
              <thead>
                <tr>
                  <th scope="col" aria-sort={ariaSort('name')}>
                    {head('name')}
                  </th>
                  <th scope="col" className="num" aria-sort={ariaSort('items')}>
                    {head('items')}
                  </th>
                  <th scope="col" className="table-actions">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {shown.map((t) => (
                  <tr key={t.name} className={cx(t.count === 0 && 'is-empty')}>
                    <td>
                      {t.count === 0 ? (
                        // Nothing to list in the library for it.
                        <span className="chip chip-tag">{t.name}</span>
                      ) : (
                        <Link to={`/?tag=${encodeURIComponent(t.name)}`} className="chip chip-tag">
                          {t.name}
                        </Link>
                      )}
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
                      {matching.length > 0 ? (q ? `Only empty tags match “${filter}”.` : 'All tags are empty and hidden.') : `No tag matches “${filter}”.`}
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
              hint={
                editing.tag.count === 0
                  ? `No item carries “${editing.tag.name}”, so merging just removes it.`
                  : `Every item tagged “${editing.tag.name}” gets the target tag instead, and “${editing.tag.name}” disappears.`
              }
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
              {editing.tag.count === 0
                ? `Renaming will merge the two: no item carries “${editing.tag.name}”, so only “${existing.name}” remains.`
                : existing.count === 0
                  ? `Renaming will merge the two: the ${plural(editing.tag.count, 'item')} tagged “${editing.tag.name}” get “${existing.name}” instead.`
                  : `Renaming will merge the two: the ${plural(editing.tag.count, 'item')} tagged “${editing.tag.name}” join the ${existing.count} already tagged “${existing.name}”.`}{' '}
              This cannot be undone.
            </Callout>
          )}
          {error != null && <ErrorCallout error={error} />}
        </form>
      </Dialog>
    </div>
  );
}
