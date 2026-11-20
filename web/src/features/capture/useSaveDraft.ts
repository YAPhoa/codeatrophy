import { useCallback, useState } from 'react';
import { useNavigate } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { isApiError } from '../../api/client';
import { invalidateJobs, qk, storeItem, useLimits } from '../../api/queries';
import type { Item, ItemInput } from '../../api/types';
import { formErrorsFromFields, inputFromForm, validateForm, type CreateExtras, type FormErrors, type ItemFormState } from '../../lib/itemForm';
import { useToast } from '../../ui/Toast';

/**
 * Saves a reviewed draft as a new item through `create` (the draft's save,
 * which also deletes the draft), then leads on: problems go to the "what
 * next" screen, readings straight to the reader.
 */
export function useSaveDraft(draftId: string, create: (input: ItemInput) => Promise<Item>) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const toast = useToast();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [errors, setErrors] = useState<FormErrors>({});
  const limits = useLimits();

  const save = useCallback(
    async (form: ItemFormState, extras: CreateExtras) => {
      const local = validateForm(form, limits);
      setErrors(local);
      if (Object.keys(local).length > 0) {
        setError(null);
        toast.error('Some fields need attention before saving.');
        return;
      }
      setSaving(true);
      setError(null);
      try {
        const item = await create(inputFromForm(form, extras));
        storeItem(qc, item);
        qc.removeQueries({ queryKey: qk.draft(draftId) });
        void invalidateJobs(qc);
        if (item.type === 'problem') {
          navigate(`/items/${item.id}/saved`, { replace: true });
        } else {
          toast.success('Saved to your library');
          navigate(`/items/${item.id}`, { replace: true });
        }
      } catch (e) {
        setError(e);
        if (isApiError(e) && e.code === 'validation_failed') setErrors(formErrorsFromFields(e.fields).errors);
      } finally {
        setSaving(false);
      }
    },
    [qc, navigate, toast, limits, create, draftId],
  );

  return { save, saving, error, errors, clearErrors: () => setErrors({}) };
}
