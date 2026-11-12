import { useCallback, useId, useRef, useState } from 'react';
import { Check, Minus, Plus } from 'lucide-react';
import { usePreferences, useUpdatePreferences } from '../../api/queries';
import type { EditorPreferences, Preferences, PreferencesUpdate } from '../../api/types';
import { IconButton } from '../../ui/Button';
import { Checkbox, Segmented } from '../../ui/Field';
import { ErrorCallout, Spinner } from '../../ui/misc';
import { clampFontSize, FONT_SIZE_MAX, FONT_SIZE_MIN, lineHeightFor, parseFontSize, TAB_SIZES, type TabSize } from '../../ui/editorOptions';

function merge(base: PreferencesUpdate | null, change: PreferencesUpdate): PreferencesUpdate {
  return { ...base, ...change, editor: { ...base?.editor, ...change.editor } };
}

type SaveState = { status: 'idle' | 'saving' | 'saved' } | { status: 'error'; error: unknown };

/**
 * Saves each change as it is made. Changes made while a save is under way
 * are collected and sent together when it finishes, so requests never
 * overlap and an older answer cannot briefly undo a newer choice. `pending`
 * holds what has been chosen but not yet confirmed, for the controls to show.
 */
function useAutosave() {
  const { mutateAsync } = useUpdatePreferences();
  const queued = useRef<PreferencesUpdate | null>(null);
  const sending = useRef(false);
  const [pending, setPending] = useState<PreferencesUpdate | null>(null);
  const [state, setState] = useState<SaveState>({ status: 'idle' });

  const save = useCallback(
    (change: PreferencesUpdate) => {
      queued.current = merge(queued.current, change);
      setPending((p) => merge(p, change));
      if (sending.current) return;
      sending.current = true;
      setState({ status: 'saving' });
      void (async () => {
        let outcome: SaveState = { status: 'saved' };
        while (queued.current) {
          const next = queued.current;
          queued.current = null;
          try {
            await mutateAsync(next);
            setPending(queued.current);
          } catch (error) {
            // The failed change has been rolled back; drop whatever was waiting behind it too.
            queued.current = null;
            setPending(null);
            outcome = { status: 'error', error };
          }
        }
        sending.current = false;
        setState(outcome);
      })();
    },
    [mutateAsync],
  );

  return { save, pending, state };
}

function SaveStatus({ state }: { state: SaveState }) {
  return (
    <span className="prefs-status" role="status">
      {state.status === 'saving' && (
        <>
          <Spinner size={12} /> Saving…
        </>
      )}
      {state.status === 'saved' && (
        <>
          <Check size={13} aria-hidden="true" /> Saved
        </>
      )}
    </span>
  );
}

function FontSizeControl({ value, onChange }: { value: number; onChange: (size: number) => void }) {
  const id = useId();
  // What is being typed, while it differs from the saved size.
  const [draft, setDraft] = useState<string | null>(null);

  const commit = (size: number) => {
    setDraft(null);
    if (size !== value) onChange(size);
  };

  return (
    <div className="prefs-row">
      <div className="prefs-row-text">
        <label htmlFor={id} className="prefs-row-label">
          Font size
        </label>
        <div id={`${id}-hint`} className="field-hint">
          {FONT_SIZE_MIN} to {FONT_SIZE_MAX} pixels. Applies to code; notes and descriptions keep their own size.
        </div>
      </div>
      <div className="prefs-stepper">
        <IconButton
          label="Smaller font"
          size="sm"
          icon={<Minus size={14} aria-hidden="true" />}
          disabled={value <= FONT_SIZE_MIN}
          onClick={() => commit(clampFontSize(value - 1))}
        />
        <input
          id={id}
          className="input prefs-number"
          type="number"
          inputMode="numeric"
          min={FONT_SIZE_MIN}
          max={FONT_SIZE_MAX}
          step={1}
          value={draft ?? String(value)}
          aria-describedby={`${id}-hint`}
          aria-invalid={draft != null && parseFontSize(draft) == null ? true : undefined}
          onChange={(e) => {
            const text = e.target.value;
            const size = parseFontSize(text);
            // A size in range is saved as it is typed; anything else waits until the field is left.
            if (size == null) setDraft(text);
            else commit(size);
          }}
          onBlur={() => {
            if (draft == null) return;
            const typed = Number(draft);
            commit(draft.trim() === '' || Number.isNaN(typed) ? value : clampFontSize(typed));
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur();
          }}
        />
        <span className="prefs-unit" aria-hidden="true">
          px
        </span>
        <IconButton
          label="Larger font"
          size="sm"
          icon={<Plus size={14} aria-hidden="true" />}
          disabled={value >= FONT_SIZE_MAX}
          onClick={() => commit(clampFontSize(value + 1))}
        />
      </div>
    </div>
  );
}

/** Two lines of code set the way the editors will set them. */
function EditorPreview({ editor }: { editor: EditorPreferences }) {
  const indent = ' '.repeat(editor.tabSize);
  return (
    <figure className="prefs-preview">
      <figcaption className="field-hint">Preview</figcaption>
      <pre
        className={editor.lineWrapping ? 'prefs-preview-code is-wrapped' : 'prefs-preview-code'}
        style={{ fontSize: editor.fontSize, lineHeight: `${lineHeightFor(editor.fontSize)}px` }}
        // Scrolls sideways when lines are not wrapped, so it has to be reachable by keyboard.
        tabIndex={0}
      >
        <span className="tok-keyword">def</span> <span className="tok-fn">sum_of_even</span>(numbers):{'\n'}
        {indent}
        <span className="tok-keyword">return</span> <span className="tok-fn">sum</span>(n <span className="tok-keyword">for</span> n <span className="tok-keyword">in</span> numbers{' '}
        <span className="tok-keyword">if</span> n % <span className="tok-number">2</span> == <span className="tok-number">0</span>){'  '}
        <span className="tok-comment"># 0 when there are none</span>
      </pre>
    </figure>
  );
}

export function PreferencesSection() {
  const saved = usePreferences();
  const { save, pending, state } = useAutosave();
  // What the controls show: the saved preferences with any unconfirmed choices on top.
  const shown: Preferences = { ...saved, ...pending, editor: { ...saved.editor, ...pending?.editor } };
  const { editor } = shown;
  const setEditor = (change: Partial<EditorPreferences>) => save({ editor: change });

  return (
    <section id="preferences" className="settings-section" aria-labelledby="preferences-title">
      <div className="row">
        <h2 id="preferences-title">Preferences</h2>
        <SaveStatus state={state} />
      </div>
      <p className="settings-lead">
        Changes are saved as you make them. Preferences are stored on the server, so they follow you to any browser you use; the theme, under Appearance, is kept per
        browser.
      </p>
      {state.status === 'error' && <ErrorCallout error={state.error} title="That change was not saved, and the setting is back to what it was" />}

      <div className="card card-pad prefs-group" role="group" aria-labelledby="preferences-tests-title">
        <h3 id="preferences-tests-title" className="prefs-group-title">
          Test cases
        </h3>
        <Checkbox
          checked={shown.hideTestCases}
          onChange={(hideTestCases) => save({ hideTestCases })}
          label="Hide test cases by default"
          hint={
            <>
              The inputs and expected outputs of a problem’s test cases stay out of sight until you choose to reveal them, so they cannot give the answer away. Counts
              are always shown (“7 test cases · 2 shown as examples”, “Ran 7 test cases — 5 passed”), and so are the cases marked as examples.
            </>
          }
        />
      </div>

      <div className="card card-pad prefs-group" role="group" aria-labelledby="preferences-editor-title">
        <h3 id="preferences-editor-title" className="prefs-group-title">
          Code editor
        </h3>
        <Checkbox
          checked={editor.autocomplete}
          onChange={(autocomplete) => setEditor({ autocomplete })}
          label="Code completion"
          hint="Suggests keywords and snippets of the language where they are available, and words already in the file."
        />
        <Checkbox checked={editor.closeBrackets} onChange={(closeBrackets) => setEditor({ closeBrackets })} label="Close brackets and quotes automatically" />
        <Checkbox checked={editor.matchBrackets} onChange={(matchBrackets) => setEditor({ matchBrackets })} label="Highlight the matching bracket" />
        <Checkbox
          checked={editor.lineWrapping}
          onChange={(lineWrapping) => setEditor({ lineWrapping })}
          label="Wrap long lines"
          hint="Applies to code. Notes and descriptions always wrap."
        />

        <div className="prefs-row">
          <div className="prefs-row-text">
            <div className="prefs-row-label">Tab size</div>
            <div className="field-hint">The width of one level of indentation, in spaces.</div>
          </div>
          <Segmented<`${TabSize}`>
            label="Tab size"
            value={`${editor.tabSize}`}
            onChange={(size) => setEditor({ tabSize: Number(size) as TabSize })}
            options={TAB_SIZES.map((size) => ({ value: `${size}` as const, label: `${size}` }))}
          />
        </div>

        <FontSizeControl value={editor.fontSize} onChange={(fontSize) => setEditor({ fontSize })} />
        <EditorPreview editor={editor} />
      </div>
    </section>
  );
}
