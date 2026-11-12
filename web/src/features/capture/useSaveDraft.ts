import { useCallback, useState } from 'react';
import { useNavigate } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { api, isApiError } from '../../api/client';
import { storeItem, useLimits } from '../../api/queries';
import { formErrorsFromFields, inputFromForm, validateForm, type CreateExtras, type FormErrors, type ItemFormState } from '../../lib/itemForm';
import { useToast } from '../../ui/Toast';

/**
 * Saves a reviewed form as a new item, then leads on: problems go to the
 * "what next" screen, readings straight to the reader.
 */
export function useSaveDraft(onSaved: () => void) {
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
        const item = await api.items.create(inputFromForm(form, extras));
        storeItem(qc, item);
        onSaved();
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
    [qc, navigate, toast, onSaved, limits],
  );

  return { save, saving, error, errors, clearErrors: () => setErrors({}) };
}
