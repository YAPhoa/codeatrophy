import { useCallback } from 'react';
import { useNavigate } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { Download, GitBranch, Pencil, Trash2 } from 'lucide-react';
import { api } from '../../api/client';
import { invalidateLibrary, qk } from '../../api/queries';
import type { Item } from '../../api/types';
import { exportItemsPath } from '../../lib/exportLink';
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
          // The count of items in no collection may have moved.
          void qc.invalidateQueries({ queryKey: qk.stats });
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
          ? 'Its test cases, submissions and your notes are deleted too. This cannot be undone.'
          : 'Your notes on it are deleted too. This cannot be undone.',
      confirmLabel: item.type === 'problem' ? 'Delete problem' : 'Delete reading',
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

  // A problem's test cases and variants have their own way in (the Tests page,
  // the Variants tab); a reading is reworked from here, and its variants are
  // listed under Related items.
  const menu: MenuEntry[] = [
    { label: 'Edit details…', icon: <Pencil size={14} />, to: `/items/${item.id}/edit` },
    { label: 'Export this item…', icon: <Download size={14} />, to: exportItemsPath([item.id]) },
    ...(item.type === 'reading' ? [{ label: 'Rework this reading…', icon: <GitBranch size={14} />, to: `/items/${item.id}/variant` }] : []),
    'separator',
    { label: 'Delete', icon: <Trash2 size={14} />, danger: true, onSelect: () => void remove() },
  ];

  return { toggleCollection, remove, menu };
}
