import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { GitMerge, Save } from 'lucide-react';
import { api, isApiError } from '../../api/client';
import { qk, storeItem, useCollections, useItem, useMeta, useTags } from '../../api/queries';
import type { Item } from '../../api/types';
import { useDocumentTitle } from '../../app/useDocumentTitle';
import { focusFirstInvalid } from '../../lib/focusInvalid';
import { withUnit } from '../../lib/format';
import { MOD, useHotkeys } from '../../lib/hotkeys';
import {
  FIELD_LABEL,
  changedFields,
  effectiveHarness,
  formErrorsFromFields,
  formFromItem,
  mergeForms,
  patchFromForm,
  patchTouchesContent,
  validateForm,
  type EditableField,
  type FormErrors,
  type ItemFormState,
} from '../../lib/itemForm';
import { Button } from '../../ui/Button';
import { Dialog } from '../../ui/Dialog';
import { DiffView } from '../../ui/DiffView';
import { useLeaveGuard } from '../../ui/LeaveGuard';
import { ErrorCallout, ErrorState, PageLoading } from '../../ui/misc';
import { useToast } from '../../ui/Toast';
import { useCollectionActions } from '../collections/CollectionActions';
import { useGenerateCode } from './GenerateCode';
import { ItemEditor } from './ItemEditor';
import { ItemMissing } from './ItemPage';

export default function EditItemPage() {
  const { id = '' } = useParams();
  const item = useItem(id);
  if (item.isPending) return <PageLoading />;
  if (item.isError) {
    if (isApiError(item.error) && item.error.code === 'not_found') return <ItemMissing />;
    return (
      <div className="page">
        <ErrorState page error={item.error} onRetry={() => void item.refetch()} />
      </div>
    );
  }
  return <EditForm key={item.data.id} initial={item.data} />;
}

function describeValue(field: EditableField, form: ItemFormState, collectionName: (id: string) => string): string {
  switch (field) {
    case 'tags':
      return form.tags.join(', ') || '(none)';
    case 'collectionIds':
      return form.collectionIds.map(collectionName).join(', ') || '(none)';
    case 'starterCode':
      return Object.keys(form.starterCode).join(', ') || '(none)';
    case 'interface':
      return form.interface === 'function' ? 'Solution only' : 'Full program';
    case 'harness':
      return Object.keys(effectiveHarness(form)).join(', ') || '(none)';
    case 'difficulty':
      return form.difficulty ?? '(not set)';
    case 'timeLimitMs':
      return withUnit(form.timeLimitMs, 'ms');
    case 'memoryLimitKb':
      return withUnit(Math.round(form.memoryLimitKb / 1024), 'MB');
    default:
      return String(form[field]) || '(empty)';
  }
}

interface Conflict {
  /** The item as it is on the server now. */
  latest: Item;
}

/**
 * Edit an existing item. Saves send `expectedRevision`, so an edit made
 * elsewhere in the meantime (another tab, an assistant over MCP) is detected
 * instead of overwritten; the user then decides how to reconcile the two.
 */
function EditForm({ initial }: { initial: Item }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const toast = useToast();
  const meta = useMeta();
  const { data: collections = [] } = useCollections();
  const { data: tags = [] } = useTags();
  const collectionActions = useCollectionActions();
  useDocumentTitle(`Edit: ${initial.title}`);

  // `base` is the server state the form was last synchronised with.
  const [base, setBase] = useState<Item>(initial);
  const [form, setForm] = useState<ItemFormState>(() => formFromItem(initial));
  const [errors, setErrors] = useState<FormErrors>({});
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<unknown>(null);
  const [conflict, setConflict] = useState<Conflict | null>(null);
  // Generated code goes into the form, and is saved with it.
  const code = useGenerateCode({ form, setForm, itemId: base.id });

  const baseForm = useMemo(() => formFromItem(base), [base]);
  const dirty = useMemo(() => changedFields(baseForm, form).length > 0, [baseForm, form]);

  const leaveGuard = useLeaveGuard({
    when: dirty,
    body: <>Your edits to “{base.title}” have not been saved.</>,
    stayLabel: 'Keep editing',
    leaveLabel: 'Discard changes',
  });

  const finish = (item: Item) => {
    storeItem(qc, item);
    toast.success('Saved');
    leaveGuard.allow();
    navigate(`/items/${item.id}`);
  };

  const save = async (against: Item = base, current: ItemFormState = form) => {
    const local = validateForm(current, meta.data?.limits);
    setErrors(local);
    if (Object.keys(local).length > 0) {
      toast.error('Some fields need attention before saving.');
      focusFirstInvalid();
      return;
    }
    const patch = patchFromForm(against, current);
    if (Object.keys(patch).length === 0) {
      finish(against);
      return;
    }
    // Collection membership is not part of the revisioned content; a change to
    // it alone cannot conflict.
    if (patchTouchesContent(patch)) patch.expectedRevision = against.revision;
    setSaving(true);
    setSaveError(null);
    try {
      finish(await api.items.update(against.id, patch));
    } catch (e) {
      if (isApiError(e) && e.isRevisionConflict) {
        try {
          const latest = await api.items.get(against.id);
          qc.setQueryData(qk.item(latest.id), latest);
          setConflict({ latest });
        } catch (inner) {
          setSaveError(inner);
        }
      } else {
        setSaveError(e);
        if (isApiError(e) && e.code === 'validation_failed') setErrors(formErrorsFromFields(e.fields).errors);
      }
    } finally {
      setSaving(false);
    }
  };

  useHotkeys({
    'mod+s': (e) => {
      e.preventDefault();
      if (!saving && !conflict) void save();
    },
  });

  const merge = conflict ? mergeForms(baseForm, form, formFromItem(conflict.latest)) : null;
  const collectionName = (cid: string) => collections.find((c) => c.id === cid)?.name ?? 'a deleted collection';

  return (
    <div className="page page-wide">
      <div className="review-bar">
        <div>
          <nav className="crumbs" aria-label="Breadcrumb">
            <Link to={`/items/${base.id}`}>{base.title}</Link>
            <span aria-hidden="true">/</span>
            <span>Edit</span>
          </nav>
          <h1 className="page-title">Edit {base.type === 'problem' ? 'problem' : 'reading'}</h1>
        </div>
        <span className="spacer" />
        {base.type === 'problem' && (
          <Link to={`/items/${base.id}/tests`} className="muted">
            Update test cases and solutions
          </Link>
        )}
        <Button variant="ghost" onClick={() => navigate(`/items/${base.id}`)} disabled={saving}>
          Cancel
        </Button>
        <Button variant="primary" icon={<Save size={14} />} onClick={() => void save()} busy={saving} title={`${MOD}+S`}>
          Save changes
        </Button>
      </div>

      {saveError != null && <ErrorCallout error={saveError} title="Could not save" onRetry={() => void save()} />}

      <ItemEditor
        form={form}
        onChange={setForm}
        mode="edit"
        errors={errors}
        collections={collections}
        tagSuggestions={tags.map((t) => t.name)}
        judgeLanguages={meta.data?.judge.languages.map((l) => l.id) ?? []}
        onCreateCollection={() => collectionActions.create(null, (c) => setForm((f) => ({ ...f, collectionIds: [...f.collectionIds, c.id] })))}
        disabled={saving}
        codeTools={code.tools}
        codeNotice={code.notice}
        runnerResults={code.runnerResults}
      />

      {leaveGuard.dialog}

      {conflict && merge && (
        <Dialog
          open
          onClose={() => setConflict(null)}
          title="This item changed elsewhere"
          size="lg"
          footer={
            <>
              <Button
                variant="ghost"
                style={{ marginRight: 'auto' }}
                onClick={() => {
                  setBase(conflict.latest);
                  setForm(formFromItem(conflict.latest));
                  setConflict(null);
                  toast.info('Loaded the current version. Your edits were discarded.');
                }}
              >
                Discard your edits and load the latest version
              </Button>
              <Button
                onClick={() => {
                  // Rebase: adopt their changes, keep mine on top, and let the user look before saving.
                  setBase(conflict.latest);
                  setForm(merge.merged);
                  setConflict(null);
                  toast.info('Merged into the form. Review it, then save.');
                }}
              >
                Merge and keep editing
              </Button>
              <Button
                variant="primary"
                icon={<GitMerge size={14} />}
                data-autofocus
                onClick={() => {
                  const latest = conflict.latest;
                  setBase(latest);
                  setForm(merge.merged);
                  setConflict(null);
                  void save(latest, merge.merged);
                }}
              >
                {merge.overlapping.length > 0 ? 'Merge, keeping your version where both changed' : 'Merge and save'}
              </Button>
            </>
          }
        >
          <div className="conflict">
            <p className="dialog-text">
              While you were editing, this item was changed in another tab or by an assistant connected over MCP. It is now at revision {conflict.latest.revision}; you started from revision{' '}
              {base.revision}. <strong>Nothing has been overwritten and your edits are still here.</strong>
            </p>

            {merge.theirs.length > 0 && (
              <section>
                <h3>Changed elsewhere ({merge.theirs.length})</h3>
                <p className="muted">You did not touch these, so a merge takes the new values.</p>
                <ul className="conflict-fields">
                  {merge.theirs.map((f) => (
                    <li key={f}>
                      <strong>{FIELD_LABEL[f]}</strong>
                      {f === 'body' ? (
                        <DiffView expected={baseForm.body} actual={conflict.latest.body} leftLabel="When you opened it" rightLabel="Now" variant="before-after" />
                      ) : (
                        <span className="conflict-value">{describeValue(f, formFromItem(conflict.latest), collectionName)}</span>
                      )}
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {merge.overlapping.length > 0 && (
              <section>
                <h3 className="conflict-overlap">Changed by both ({merge.overlapping.length})</h3>
                <p className="muted">These need a decision. A merge keeps your version; to take theirs for a field, merge, then edit it in the form.</p>
                <ul className="conflict-fields">
                  {merge.overlapping.map((f) => (
                    <li key={f}>
                      <strong>{FIELD_LABEL[f]}</strong>
                      {f === 'body' ? (
                        <DiffView expected={conflict.latest.body} actual={form.body} leftLabel="Their version" rightLabel="Your version" variant="before-after" />
                      ) : (
                        <dl className="conflict-pair">
                          <dt>Theirs</dt>
                          <dd>{describeValue(f, formFromItem(conflict.latest), collectionName)}</dd>
                          <dt>Yours</dt>
                          <dd>{describeValue(f, form, collectionName)}</dd>
                        </dl>
                      )}
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {merge.theirs.length === 0 && merge.overlapping.length === 0 && (
              <p className="muted">The other change did not touch any field shown in this form (it may have been to the reference solution). Merging is safe.</p>
            )}

            {merge.mine.length > 0 && (
              <p className="muted">
                Your edits: {merge.mine.concat(merge.overlapping).map((f) => FIELD_LABEL[f]).join(', ')}.
              </p>
            )}
          </div>
        </Dialog>
      )}
    </div>
  );
}
