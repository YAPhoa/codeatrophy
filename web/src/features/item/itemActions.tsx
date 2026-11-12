import { useCallback } from 'react';
import { useNavigate } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { Download, FlaskConical, GitBranch, Pencil, Trash2 } from 'lucide-react';
import { api } from '../../api/client';
import { invalidateLibrary, qk } from '../../api/queries';
import type { Item } from '../../api/types';
import { readString } from '../../lib/storage';
import { useConfirm } from '../../ui/Dialog';
import type { MenuEntry } from '../../ui/Popover';
import { useToast } from '../../ui/Toast';

/** Where "back" from an item leads: the library view the user last looked at. */
export function libraryHref(): string {
  return readString('library:last') ?? '/';
}

export function useItemActions(item: Item) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const toast = useToast();
  const confirm = useConfirm();

  /** Add the item to or remove it from one collection. Membership does not change the revision. */
  const toggleCollection = useCallback(
    (collectionId: string, member: boolean) => {
      const next = member ? [...item.collectionIds, collectionId] : item.collectionIds.filter((c) => c !== collectionId);
      qc.setQueryData<Item>(qk.item(item.id), (cur) => (cur ? { ...cur, collectionIds: next } : cur));
      api.items
        .update(item.id, { collectionIds: next })
        .then((updated) => {
          qc.setQueryData(qk.item(item.id), updated);
          void qc.invalidateQueries({ queryKey: qk.collections });
          void qc.invalidateQueries({ queryKey: qk.itemLists });
        })
        .catch((e) => {
          toast.error(e);
          void qc.invalidateQueries({ queryKey: qk.item(item.id) });
        });
    },
    [item.id, item.collectionIds, qc, toast],
  );

  const remove = useCallback(async () => {
    const ok = await confirm({
      title: `Delete “${item.title}”?`,
      body:
        item.type === 'problem'
          ? 'Its test cases, submissions and your notes are deleted too. Variants of it stay, unlinked. This cannot be undone.'
          : 'Your notes on it are deleted too. This cannot be undone.',
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!ok) return;
    try {
      await api.items.remove(item.id);
      qc.removeQueries({ queryKey: qk.item(item.id) });
      await invalidateLibrary(qc);
      toast.success(`Deleted “${item.title}”`);
      navigate(libraryHref());
    } catch (e) {
      toast.error(e);
    }
  }, [item, confirm, qc, toast, navigate]);

  const menu: MenuEntry[] = [
    { label: 'Edit details…', icon: <Pencil size={14} />, onSelect: () => navigate(`/items/${item.id}/edit`) },
    ...(item.type === 'problem'
      ? ([
          { label: 'Generate test cases…', icon: <FlaskConical size={14} />, onSelect: () => navigate(`/items/${item.id}/tests/generate`) },
          { label: 'Practise a variant…', icon: <GitBranch size={14} />, onSelect: () => navigate(`/items/${item.id}/variant`) },
        ] satisfies MenuEntry[])
      : ([{ label: 'Rework as a new reading…', icon: <GitBranch size={14} />, onSelect: () => navigate(`/items/${item.id}/variant`) }] satisfies MenuEntry[])),
    { label: 'Export this item…', icon: <Download size={14} />, onSelect: () => navigate('/export', { state: { itemIds: [item.id] } }) },
    'separator',
    { label: 'Delete', icon: <Trash2 size={14} />, danger: true, onSelect: () => void remove() },
  ];

  return { toggleCollection, remove, menu };
}
