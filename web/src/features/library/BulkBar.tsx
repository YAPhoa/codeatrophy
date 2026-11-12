import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { Download, FolderMinus, FolderPlus, Star, StarOff, Tag, Trash2, X } from 'lucide-react';
import { api } from '../../api/client';
import { invalidateLibrary, useCollections, useTags } from '../../api/queries';
import type { BulkAction, Collection, ItemSummary } from '../../api/types';
import { ITEM_STATUSES } from '../../api/types';
import { STATUS_LABEL, plural } from '../../lib/format';
import { buildTree, flattenTree } from '../../lib/tree';
import { Button, IconButton } from '../../ui/Button';
import { Dialog, useConfirm } from '../../ui/Dialog';
import { Field } from '../../ui/Field';
import { MenuButton } from '../../ui/Popover';
import { TagInput } from '../../ui/TagInput';
import { useToast } from '../../ui/Toast';
import { useCollectionActions } from '../collections/CollectionActions';
import { StatusIcon } from '../item/controls';

interface BulkBarProps {
  selected: ItemSummary[];
  /** The collection being viewed, if any (enables "remove from this collection"). */
  collection: Collection | null;
  onClear: () => void;
}

type DialogState = { kind: 'addTags' | 'removeTags' } | { kind: 'collection' } | null;

/** Actions on the current selection. Replaces the filter bar while items are selected. */
export function BulkBar({ selected, collection, onClear }: BulkBarProps) {
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const navigate = useNavigate();
  const { data: allTags = [] } = useTags();
  const { data: collections = [] } = useCollections();
  const collectionActions = useCollectionActions();
  const [dialog, setDialog] = useState<DialogState>(null);
  const [tags, setTags] = useState<string[]>([]);
  const [targetCollection, setTargetCollection] = useState('');
  const [busy, setBusy] = useState(false);

  const ids = useMemo(() => selected.map((s) => s.id), [selected]);
  const n = ids.length;
  const selectedTags = useMemo(() => Array.from(new Set(selected.flatMap((s) => s.tags))).sort(), [selected]);
  const collectionOptions = useMemo(() => flattenTree(buildTree(collections)), [collections]);
  const allFavorite = selected.every((s) => s.favorite);

  const run = async (action: BulkAction, done: string, clear = false) => {
    setBusy(true);
    try {
      const { affected } = await api.items.bulk({ ids, ...action });
      await invalidateLibrary(qc);
      toast.success(done.replace('{n}', plural(affected, 'item')));
      setDialog(null);
      if (clear) onClear();
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    const ok = await confirm({
      title: `Delete ${plural(n, 'item')}?`,
      body: 'Their test cases, submissions and notes are deleted too. This cannot be undone.',
      confirmLabel: `Delete ${plural(n, 'item')}`,
      danger: true,
    });
    if (ok) await run({ action: 'delete' }, 'Deleted {n}', true);
  };

  return (
    <div className="bulkbar" role="toolbar" aria-label="Actions for selected items">
      <IconButton size="sm" label="Clear selection" icon={<X size={14} />} onClick={onClear} />
      <strong className="bulk-count" aria-live="polite">
        {n} selected
      </strong>
      <MenuButton
        size="sm"
        menuLabel="Set status"
        disabled={busy}
        items={ITEM_STATUSES.map((s) => ({
          label: STATUS_LABEL[s],
          icon: <StatusIcon status={s} size={14} />,
          onSelect: () => void run({ action: 'setStatus', status: s }, `Marked {n} as ${STATUS_LABEL[s].toLowerCase()}`),
        }))}
      >
        Status
      </MenuButton>
      <Button
        size="sm"
        disabled={busy}
        icon={allFavorite ? <StarOff size={13} /> : <Star size={13} />}
        onClick={() => void run({ action: 'setFavorite', favorite: !allFavorite }, allFavorite ? 'Removed {n} from favorites' : 'Added {n} to favorites')}
      >
        {allFavorite ? 'Unfavorite' : 'Favorite'}
      </Button>
      <MenuButton
        size="sm"
        disabled={busy}
        icon={<Tag size={13} />}
        menuLabel="Tags"
        items={[
          {
            label: 'Add tags…',
            onSelect: () => {
              setTags([]);
              setDialog({ kind: 'addTags' });
            },
          },
          {
            label: 'Remove tags…',
            disabled: selectedTags.length === 0,
            onSelect: () => {
              setTags([]);
              setDialog({ kind: 'removeTags' });
            },
          },
        ]}
      >
        Tags
      </MenuButton>
      <Button
        size="sm"
        disabled={busy}
        icon={<FolderPlus size={13} />}
        onClick={() => {
          setTargetCollection('');
          setDialog({ kind: 'collection' });
        }}
      >
        Add to collection
      </Button>
      {collection && (
        <Button
          size="sm"
          disabled={busy}
          icon={<FolderMinus size={13} />}
          onClick={() => void run({ action: 'removeFromCollection', collectionId: collection.id }, `Removed {n} from “${collection.name}”`, true)}
        >
          Remove from this collection
        </Button>
      )}
      <Button size="sm" disabled={busy} icon={<Download size={13} />} onClick={() => navigate('/export', { state: { itemIds: ids } })}>
        Export
      </Button>
      <span className="spacer" />
      <Button size="sm" variant="ghost" className="bulk-delete" disabled={busy} icon={<Trash2 size={13} />} onClick={() => void remove()}>
        Delete
      </Button>

      <Dialog
        open={dialog?.kind === 'addTags' || dialog?.kind === 'removeTags'}
        onClose={() => setDialog(null)}
        title={dialog?.kind === 'removeTags' ? `Remove tags from ${plural(n, 'item')}` : `Add tags to ${plural(n, 'item')}`}
        size="sm"
        locked={busy}
        footer={
          <>
            <Button onClick={() => setDialog(null)} disabled={busy}>
              Cancel
            </Button>
            <Button
              variant="primary"
              busy={busy}
              disabled={tags.length === 0}
              onClick={() =>
                void run(
                  { action: dialog?.kind === 'removeTags' ? 'removeTags' : 'addTags', tags },
                  dialog?.kind === 'removeTags' ? 'Removed tags from {n}' : 'Tagged {n}',
                )
              }
            >
              {dialog?.kind === 'removeTags' ? 'Remove' : 'Add'}
            </Button>
          </>
        }
      >
        <Field
          label="Tags"
          hint={dialog?.kind === 'removeTags' ? 'Choose from the tags these items carry.' : 'Press Enter or comma after each tag.'}
        >
          {(a) => (
            <TagInput
              {...a}
              value={tags}
              onChange={setTags}
              suggestions={dialog?.kind === 'removeTags' ? selectedTags : allTags.map((t) => t.name)}
              autoFocus
            />
          )}
        </Field>
        {dialog?.kind === 'removeTags' && (
          <div className="row-wrap" style={{ marginTop: 10 }}>
            {selectedTags
              .filter((t) => !tags.includes(t))
              .map((t) => (
                <button key={t} type="button" className="chip chip-tag" onClick={() => setTags([...tags, t])}>
                  {t}
                </button>
              ))}
          </div>
        )}
      </Dialog>

      <Dialog
        open={dialog?.kind === 'collection'}
        onClose={() => setDialog(null)}
        title={`Add ${plural(n, 'item')} to a collection`}
        size="sm"
        locked={busy}
        footer={
          <>
            <Button
              variant="ghost"
              icon={<FolderPlus size={14} />}
              onClick={() => collectionActions.create(null, (c) => setTargetCollection(c.id))}
              style={{ marginRight: 'auto' }}
            >
              New collection…
            </Button>
            <Button onClick={() => setDialog(null)} disabled={busy}>
              Cancel
            </Button>
            <Button
              variant="primary"
              busy={busy}
              disabled={!targetCollection}
              onClick={() => {
                const name = collections.find((c) => c.id === targetCollection)?.name ?? 'collection';
                void run({ action: 'addToCollection', collectionId: targetCollection }, `Added {n} to “${name}”`);
              }}
            >
              Add
            </Button>
          </>
        }
      >
        {collectionOptions.length === 0 ? (
          <p className="dialog-text">There are no collections yet. Create one to group these items.</p>
        ) : (
          <div className="picklist" role="radiogroup" aria-label="Collection">
            {collectionOptions.map((node) => (
              <label key={node.collection.id} className="picklist-item" style={{ paddingLeft: 8 + node.depth * 16 }}>
                <input
                  type="radio"
                  name="bulk-collection"
                  checked={targetCollection === node.collection.id}
                  onChange={() => setTargetCollection(node.collection.id)}
                />
                <span className="truncate">{node.collection.name}</span>
                <span className="picklist-count">{node.collection.itemCount}</span>
              </label>
            ))}
          </div>
        )}
        <p className="field-hint" style={{ marginTop: 8 }}>
          Items stay in the collections they are already in.
        </p>
      </Dialog>
    </div>
  );
}
