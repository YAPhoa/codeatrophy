import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '../../api/client';
import { invalidateLibrary, useCollections, useLimits } from '../../api/queries';
import type { Collection } from '../../api/types';
import { focusFirstInvalid } from '../../lib/focusInvalid';
import { buildTree, descendantIds, flattenTree, siblingsOf } from '../../lib/tree';
import { Button } from '../../ui/Button';
import { Dialog, useConfirm } from '../../ui/Dialog';
import { SelectField, TextAreaField, TextField } from '../../ui/Field';
import { ErrorCallout } from '../../ui/misc';
import { useToast } from '../../ui/Toast';

interface CollectionActions {
  /** Open the "new collection" dialog, optionally nested under a parent. */
  create: (parentId?: string | null, onCreated?: (c: Collection) => void) => void;
  /** Open the dialog to rename, describe or move a collection. */
  edit: (collection: Collection) => void;
  /** Move a collection one place up or down among its siblings. */
  shift: (collection: Collection, delta: -1 | 1) => void;
  remove: (collection: Collection) => void;
}

const Ctx = createContext<CollectionActions | null>(null);

type EditorState = { mode: 'create'; parentId: string | null; onCreated?: (c: Collection) => void } | { mode: 'edit'; collection: Collection };

const ROOT = '__root__';

function CollectionEditor({ state, collections, onClose }: { state: EditorState; collections: Collection[]; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const editing = state.mode === 'edit' ? state.collection : null;
  const limits = useLimits();
  const [name, setName] = useState(editing?.name ?? '');
  const [description, setDescription] = useState(editing?.description ?? '');
  const [parentId, setParentId] = useState<string>((editing ? editing.parentId : state.mode === 'create' ? state.parentId : null) ?? ROOT);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  // A missing name is pointed out once the user has tried to save.
  const [attempted, setAttempted] = useState(false);

  const parentOptions = useMemo(() => {
    const tree = buildTree(collections);
    // A collection cannot be moved under itself or one of its descendants.
    const blocked = new Set(editing ? [editing.id, ...descendantIds(tree, editing.id)] : []);
    return [
      { value: ROOT, label: '— Top level —' },
      ...flattenTree(tree)
        .filter((n) => !blocked.has(n.collection.id))
        .map((n) => ({ value: n.collection.id, label: `${' '.repeat(n.depth)}${n.collection.name}` })),
    ];
  }, [collections, editing]);

  const submit = async () => {
    const trimmed = name.trim();
    setAttempted(true);
    if (!trimmed) {
      focusFirstInvalid();
      return;
    }
    setBusy(true);
    setError(null);
    const parent = parentId === ROOT ? null : parentId;
    try {
      if (editing) {
        const patch: { name?: string; description?: string; parentId?: string | null } = {};
        if (trimmed !== editing.name) patch.name = trimmed;
        if (description !== editing.description) patch.description = description;
        if (parent !== editing.parentId) patch.parentId = parent;
        if (Object.keys(patch).length > 0) await api.collections.update(editing.id, patch);
        toast.success('Collection updated');
      } else {
        const created = await api.collections.create({ name: trimmed, description, parentId: parent });
        toast.success(`Created “${created.name}”`);
        if (state.mode === 'create') state.onCreated?.(created);
      }
      await invalidateLibrary(qc);
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
      title={editing ? 'Edit collection' : 'New collection'}
      size="sm"
      locked={busy}
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" form="collection-form" busy={busy}>
            {editing ? 'Save collection' : 'Create collection'}
          </Button>
        </>
      }
    >
      <form
        id="collection-form"
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <TextField label="Name" value={name} onChange={setName} error={attempted && !name.trim() ? 'Give the collection a name.' : null} placeholder="e.g. Dynamic programming…" data-autofocus autoComplete="off" maxLength={limits?.maxCollectionNameChars} />
        <TextAreaField
          label="Description (optional)"
          value={description}
          onChange={setDescription}
          rows={2}
          maxLength={limits?.maxCollectionDescriptionChars}
          placeholder="e.g. Problems to redo before the next interview…"
        />
        <SelectField label="Inside" value={parentId} onChange={setParentId} options={parentOptions} hint="Collections can be nested to any depth." />
        {error != null && <ErrorCallout error={error} />}
      </form>
    </Dialog>
  );
}

/** Dialogs and operations for managing collections, shared by the sidebar and the collection page. */
export function CollectionActionsProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const navigate = useNavigate();
  const { data: collections = [] } = useCollections();
  const [editor, setEditor] = useState<EditorState | null>(null);

  const create = useCallback<CollectionActions['create']>((parentId = null, onCreated) => setEditor({ mode: 'create', parentId, onCreated }), []);
  const edit = useCallback<CollectionActions['edit']>((collection) => setEditor({ mode: 'edit', collection }), []);

  const shift = useCallback<CollectionActions['shift']>(
    (collection, delta) => {
      const siblings = siblingsOf(collections, collection.id);
      const index = siblings.findIndex((c) => c.id === collection.id);
      const target = index + delta;
      if (index === -1 || target < 0 || target >= siblings.length) return;
      api.collections
        .update(collection.id, { position: target })
        .then(() => qc.invalidateQueries({ queryKey: ['collections'] }))
        .catch((e) => toast.error(e));
    },
    [collections, qc, toast],
  );

  const remove = useCallback<CollectionActions['remove']>(
    async (collection) => {
      const hasChildren = collections.some((c) => c.parentId === collection.id);
      const ok = await confirm({
        title: `Delete “${collection.name}”?`,
        body: (
          <>
            The collection is removed; <strong>its items stay in your library</strong>
            {hasChildren ? ', and its nested collections move up one level' : ''}.
          </>
        ),
        confirmLabel: 'Delete collection',
        danger: true,
      });
      if (!ok) return;
      try {
        await api.collections.remove(collection.id);
        await invalidateLibrary(qc);
        toast.success(`Deleted “${collection.name}”`);
        if (window.location.pathname === `/collections/${collection.id}`) navigate('/');
      } catch (e) {
        toast.error(e);
      }
    },
    [collections, confirm, qc, toast, navigate],
  );

  const value = useMemo(() => ({ create, edit, shift, remove }), [create, edit, shift, remove]);

  return (
    <Ctx.Provider value={value}>
      {children}
      {editor && (
        <CollectionEditor
          key={editor.mode === 'edit' ? editor.collection.id : `new-${editor.parentId}`}
          state={editor}
          collections={collections}
          onClose={() => setEditor(null)}
        />
      )}
    </Ctx.Provider>
  );
}

export function useCollectionActions(): CollectionActions {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useCollectionActions must be used inside CollectionActionsProvider');
  return ctx;
}
