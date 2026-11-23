import { useId, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { PenLine, Pencil, Plus, Trash2 } from 'lucide-react';
import { api, isApiError, validationFields } from '../../api/client';
import { qk, useLimits, useStyles } from '../../api/queries';
import type { StylePreset } from '../../api/types';
import { focusFirstInvalid } from '../../lib/focusInvalid';
import { Button, IconButton, cx } from '../../ui/Button';
import { Dialog, useConfirm } from '../../ui/Dialog';
import { Checkbox, Field } from '../../ui/Field';
import { ErrorCallout, ErrorState, PageLoading } from '../../ui/misc';
import { useToast } from '../../ui/Toast';
import { SaveStatus, type SaveState } from './PreferencesSection';
import { SYSTEM_PROMPT_ID, SystemPromptCards } from './SystemPromptCard';

const EXAMPLE_NAME = 'LeetCode style';
const EXAMPLE_INSTRUCTIONS =
  'Open with a short description of the task in two or three sentences. Then give Example blocks, each with Input, Output and a one-line Explanation. End with a Constraints list. Keep the tone neutral and direct. Starter code in Python and Go only.';

/** Length as the server counts it: Unicode code points after trimming. */
const length = (s: string) => Array.from(s.trim()).length;

// Control characters other than newline and tab are rejected by the server.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/;

type Editing = { preset: StylePreset | null; name: string; instructions: string; isDefault: boolean } | null;

/**
 * The presets in the order they were first shown, new ones at the end. The
 * server lists the default first; keeping the first order stops a card from
 * jumping to the top when it is chosen, under the pointer or the arrow keys.
 */
function useStableOrder(list: StylePreset[]): StylePreset[] {
  const order = useRef<string[]>([]);
  const known = new Set(order.current);
  const added = list.filter((s) => !known.has(s.id)).map((s) => s.id);
  if (added.length > 0) order.current = [...order.current, ...added];
  const rank = new Map(order.current.map((id, i) => [id, i]));
  return [...list].sort((a, b) => rank.get(a.id)! - rank.get(b.id)!);
}

/**
 * Chooses the default style as the radios change. Choices made while one is
 * being saved are sent after it, the latest only, so requests never overlap.
 * `picked` is the choice on its way, for the radios to show; on a failure it
 * is dropped and the radios show what the server has.
 */
function useDefaultChoice(onSettled: () => Promise<unknown>, onError: (e: unknown) => void) {
  const queued = useRef<{ id: string | null } | null>(null);
  const sending = useRef(false);
  const [picked, setPicked] = useState<{ id: string | null } | null>(null);
  const [state, setState] = useState<SaveState>({ status: 'idle' });

  const send = async (id: string | null) => {
    if (id !== null) {
      await api.styles.update(id, { isDefault: true });
      return;
    }
    // Built-in conventions: no preset is the default.
    const { items } = await api.styles.list();
    for (const s of items) if (s.isDefault) await api.styles.update(s.id, { isDefault: false });
  };

  const choose = (id: string | null) => {
    queued.current = { id };
    setPicked({ id });
    if (sending.current) return;
    sending.current = true;
    setState({ status: 'saving' });
    void (async () => {
      let outcome: SaveState = { status: 'saved' };
      while (queued.current) {
        const next = queued.current;
        queued.current = null;
        try {
          await send(next.id);
        } catch (e) {
          queued.current = null;
          outcome = { status: 'idle' };
          onError(e);
        }
      }
      await onSettled();
      setPicked(null);
      sending.current = false;
      setState(outcome);
    })();
  };

  return { picked, state, choose };
}

/**
 * Style presets: the user's own standing instructions for how generated
 * items are written. Independent of the AI provider, and also read by
 * assistants connected over MCP, so this section works with AI turned off.
 */
export function StylesSection() {
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const styles = useStyles();
  const [editing, setEditing] = useState<Editing>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  // An empty name or text is pointed out once the user has tried to save.
  const [attempted, setAttempted] = useState(false);

  const limits = useLimits();
  // Until the limits are known nothing is checked here; the server still enforces them.
  const bounds = {
    nameMax: limits?.maxStyleNameChars ?? Infinity,
    instructionsMax: limits?.maxStyleInstructionsChars ?? Infinity,
    maxPresets: limits?.maxStylePresets ?? Infinity,
  };

  const list = useStableOrder(styles.data ?? []);
  const full = list.length >= bounds.maxPresets;
  const refresh = () => qc.invalidateQueries({ queryKey: qk.styles });
  const choice = useDefaultChoice(refresh, (e) => toast.error(e));
  const savedDefault = list.find((s) => s.isDefault)?.id ?? null;
  const selected = choice.picked ? choice.picked.id : savedDefault;
  const radioName = useId();

  const open = (preset: StylePreset | null, seed?: { name: string; instructions: string }) => {
    setError(null);
    setAttempted(false);
    setEditing({
      preset,
      name: preset?.name ?? seed?.name ?? '',
      instructions: preset?.instructions ?? seed?.instructions ?? '',
      isDefault: preset?.isDefault ?? list.length === 0,
    });
  };

  const nameLen = editing ? length(editing.name) : 0;
  const textLen = editing ? length(editing.instructions) : 0;
  const duplicate = editing ? list.some((s) => s.id !== editing.preset?.id && s.name.trim().toLowerCase() === editing.name.trim().toLowerCase()) : false;
  const nameError =
    nameLen > bounds.nameMax
      ? `${nameLen - bounds.nameMax} over the ${bounds.nameMax}-character limit.`
      : duplicate
        ? 'Another style already has this name.'
        : editing && /[\n\r\t]/.test(editing.name.trim())
          ? 'A name is a single line, without tabs.'
          : editing && CONTROL.test(editing.name)
            ? 'Contains a control character that cannot be saved.'
            : attempted && nameLen === 0
              ? 'Give the style a name.'
              : null;
  const textError =
    textLen > bounds.instructionsMax
      ? `${(textLen - bounds.instructionsMax).toLocaleString()} over the limit. Shorten it; nothing is cut off automatically.`
      : editing && CONTROL.test(editing.instructions.replace(/\r\n/g, '\n').replace(/\r/g, '\n'))
        ? 'Contains a control character that cannot be saved (often pasted from a terminal or PDF).'
        : attempted && textLen === 0
          ? 'Write the instructions the AI should follow.'
          : null;
  const serverFields = validationFields(error);
  const canSave = editing !== null && nameLen > 0 && textLen > 0 && !nameError && !textError;

  const save = async () => {
    if (!editing) return;
    setAttempted(true);
    if (!canSave) {
      focusFirstInvalid();
      return;
    }
    setBusy(true);
    setError(null);
    const body = { name: editing.name.trim(), instructions: editing.instructions.replace(/\r\n?/g, '\n').trim(), isDefault: editing.isDefault };
    try {
      if (editing.preset) await api.styles.update(editing.preset.id, body);
      else await api.styles.create(body);
      await refresh();
      toast.success(editing.preset ? 'Style saved' : 'Style created');
      setEditing(null);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (preset: StylePreset) => {
    const ok = await confirm({
      title: `Delete the style “${preset.name}”?`,
      body: preset.isDefault ? 'It is your default style. After deleting it there is no default until you choose another.' : 'Items already written in this style are not affected.',
      confirmLabel: 'Delete style',
      danger: true,
    });
    if (!ok) return;
    setBusy(true);
    try {
      await api.styles.remove(preset.id);
      await refresh();
      toast.success(`Deleted “${preset.name}”`);
      setEditing(null);
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };

  const showSystemPrompt = () => {
    const card = document.getElementById(SYSTEM_PROMPT_ID);
    card?.scrollIntoView({ block: 'start' });
    card?.querySelector<HTMLElement>('h2')?.focus({ preventScroll: true });
  };

  return (
    <section className="settings-section" aria-labelledby="styles-title">
      <div className="row">
        <h1 id="styles-title" className="page-title">
          Writing styles
        </h1>
      </div>
      <p className="settings-lead">
        Brief instructions for how drafts are written: statement layout, tone, and starter languages. Assistants connected over MCP follow them too. Styles can’t change an item’s
        fields or the stdin/stdout format.
      </p>

      {full && (
        <p className="styles-full" role="status">
          You have reached the limit of {bounds.maxPresets} styles. Delete one to add another.
        </p>
      )}

      {styles.isPending ? (
        <PageLoading />
      ) : styles.isError ? (
        <ErrorState compact error={styles.error} onRetry={() => void styles.refetch()} />
      ) : list.length === 0 ? (
        <div className="card card-pad styles-empty">
          <PenLine size={18} aria-hidden="true" />
          <div className="grow">
            <strong>No styles yet</strong>
            <p className="muted">Drafts follow the built-in conventions. If you would rather have them laid out your way, start from an example and adjust it:</p>
            <blockquote className="style-example">{EXAMPLE_INSTRUCTIONS}</blockquote>
            <div className="form-actions">
              <Button onClick={() => open(null, { name: EXAMPLE_NAME, instructions: EXAMPLE_INSTRUCTIONS })}>Start from this example</Button>
              <Button variant="ghost" onClick={() => open(null)}>
                Write your own
              </Button>
            </div>
          </div>
        </div>
      ) : (
        <div className="styles-default">
          <div className="styles-head">
            <div className="grow">
              <div className="row">
                <h2 id="default-style-title" className="prefs-group-title">
                  Default style
                </h2>
                <SaveStatus state={choice.state} />
              </div>
              <p id="default-style-hint" className="field-hint">
                Used as default. You can manually pick a different one when drafting.
              </p>
            </div>
            <Button
              icon={<Plus size={14} />}
              onClick={() => open(null)}
              disabled={full}
              title={full ? `You have ${bounds.maxPresets} styles, the most you can keep` : undefined}
            >
              New style
            </Button>
          </div>
          <div role="radiogroup" aria-labelledby="default-style-title" aria-describedby="default-style-hint" className="choice-cards style-choices">
            <div className={cx('choice-card style-choice', selected === null && 'is-selected')}>
              <input
                type="radio"
                id={`${radioName}-builtin`}
                name={radioName}
                checked={selected === null}
                onChange={() => choice.choose(null)}
                aria-describedby={`${radioName}-builtin-text`}
              />
              <div className="grow">
                <label htmlFor={`${radioName}-builtin`} className="style-choice-name">
                  Built-in conventions
                </label>
                <p id={`${radioName}-builtin-text`} className="style-text">
                  No style applied. Drafts follow the standard format.
                </p>
              </div>
              <button type="button" className="link-btn style-choice-action" onClick={showSystemPrompt}>
                System prompt
              </button>
            </div>
            {list.map((s) => (
              <div key={s.id} className={cx('choice-card style-choice', selected === s.id && 'is-selected')}>
                <input
                  type="radio"
                  id={`${radioName}-${s.id}`}
                  name={radioName}
                  checked={selected === s.id}
                  onChange={() => choice.choose(s.id)}
                  aria-describedby={`${radioName}-${s.id}-text`}
                />
                <div className="grow">
                  <label htmlFor={`${radioName}-${s.id}`} className="style-choice-name">
                    {s.name}
                  </label>
                  <p id={`${radioName}-${s.id}-text`} className="style-text">
                    {s.instructions}
                  </p>
                </div>
                <IconButton size="sm" className="style-choice-action" label={`Edit ${s.name}`} icon={<Pencil size={14} />} onClick={() => open(s)} />
              </div>
            ))}
          </div>
        </div>
      )}

      <SystemPromptCards />

      <Dialog
        open={editing !== null}
        onClose={() => setEditing(null)}
        guard
        title={editing?.preset ? 'Edit style' : 'New style'}
        size="md"
        locked={busy}
        footer={
          <>
            {editing?.preset && (
              <>
                <Button variant="danger" icon={<Trash2 size={14} />} onClick={() => editing.preset && void remove(editing.preset)} disabled={busy}>
                  Delete
                </Button>
                <span className="spacer" />
              </>
            )}
            <Button onClick={() => setEditing(null)} disabled={busy}>
              Cancel
            </Button>
            <Button variant="primary" type="submit" form="style-form" busy={busy}>
              {editing?.preset ? 'Save style' : 'Create style'}
            </Button>
          </>
        }
      >
        {editing && (
          <form
            id="style-form"
            className="stack"
            onSubmit={(e) => {
              e.preventDefault();
              void save();
            }}
          >
            <Field label="Name" error={nameError ?? (serverFields.name != null ? String(serverFields.name) : null)} hint={`${nameLen} / ${bounds.nameMax}`}>
              {(a) => (
                <input
                  {...a}
                  className="input"
                  value={editing.name}
                  onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                  placeholder="e.g. LeetCode style…"
                  autoComplete="off"
                  data-autofocus
                />
              )}
            </Field>
            <Field
              label="Instructions"
              error={textError ?? (serverFields.instructions != null ? String(serverFields.instructions) : null)}
              hint={
                <span className="style-counter">
                  <span>Layout, tone, starter languages. It cannot add or remove fields, or change the stdin/stdout convention.</span>
                  <span className={cx('style-count', textLen > bounds.instructionsMax && 'is-over')}>
                    {textLen.toLocaleString()} / {bounds.instructionsMax.toLocaleString()}
                  </span>
                </span>
              }
            >
              {(a) => (
                <textarea
                  {...a}
                  className="input textarea"
                  rows={8}
                  autoComplete="off"
                  value={editing.instructions}
                  onChange={(e) => setEditing({ ...editing, instructions: e.target.value })}
                  placeholder="Describe how you want statements laid out and written…"
                />
              )}
            </Field>
            {editing.instructions.trim() === '' && (
              <button type="button" className="link-btn style-fill" onClick={() => setEditing({ ...editing, name: editing.name || EXAMPLE_NAME, instructions: EXAMPLE_INSTRUCTIONS })}>
                Fill in an example to start from
              </button>
            )}
            <Checkbox
              checked={editing.isDefault}
              onChange={(v) => setEditing({ ...editing, isDefault: v })}
              label="Use by default"
            />
            {error != null && !(serverFields.name != null || serverFields.instructions != null) && (
              <ErrorCallout error={error} title={isApiError(error) && error.code === 'conflict' ? 'Style limit reached' : 'Could not save the style'} />
            )}
          </form>
        )}
      </Dialog>
    </section>
  );
}
