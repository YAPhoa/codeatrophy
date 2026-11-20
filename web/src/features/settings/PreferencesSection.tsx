import { useCallback, useId, useRef, useState, type ComponentProps } from 'react';
import { Check } from 'lucide-react';
import { useLimits, usePreferences, useUpdatePreferences } from '../../api/queries';
import type { EditorPreferences, Preferences, PreferencesUpdate } from '../../api/types';
import { setThemePreference, useThemePreference } from '../../lib/theme';
import { setReadingSize, useReadingSize } from '../../lib/readingSize';
import { setTextWidth, TEXT_WIDTHS, useTextWidth } from '../../lib/textWidth';
import { StatusSwap } from '../../ui/Animated';
import { Checkbox, NumberStepper, Segmented } from '../../ui/Field';
import { ErrorCallout, Spinner } from '../../ui/misc';
import { FONT_SIZE_MAX, FONT_SIZE_MIN, lineHeightFor, TAB_SIZES, type TabSize } from '../../ui/editorOptions';

function merge(base: PreferencesUpdate | null, change: PreferencesUpdate): PreferencesUpdate {
  return { ...base, ...change, editor: { ...base?.editor, ...change.editor } };
}

export type SaveState = { status: 'idle' | 'saving' | 'saved' } | { status: 'error'; error: unknown };

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

/** "Saving…", then "Saved": how a setting that saves itself says so. */
export function SaveStatus({ state }: { state: SaveState }) {
  const saving = state.status === 'saving';
  const saved = state.status === 'saved';
  return (
    <span className="prefs-status">
      <StatusSwap icon={saving ? <Spinner size={12} /> : saved && <Check size={14} />} text={saving ? 'Saving…' : saved ? 'Saved' : ''} />
    </span>
  );
}

/** A numeric setting: its name and hint on the left, a stepper on the right. */
function StepperRow({ label, hint, ...stepper }: { label: string; hint?: string } & Omit<ComponentProps<typeof NumberStepper>, 'id' | 'aria-describedby'>) {
  const id = useId();
  return (
    <div className="prefs-row">
      <div className="prefs-row-text">
        <label htmlFor={id} className="prefs-row-label">
          {label}
        </label>
        {hint && (
          <div id={`${id}-hint`} className="field-hint">
            {hint}
          </div>
        )}
      </div>
      <NumberStepper id={id} aria-describedby={hint ? `${id}-hint` : undefined} {...stepper} />
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
        translate="no"
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
  const theme = useThemePreference();
  const readingSize = useReadingSize();
  const textWidth = useTextWidth();
  const limits = useLimits();
  const maxGenerated = limits?.maxGeneratedTestCases ?? 30;
  const maxLarge = limits?.maxLargeTestCases ?? 5;

  return (
    <section className="settings-section" aria-labelledby="preferences-title">
      <div className="row">
        <h1 id="preferences-title" className="page-title">
          Preferences
        </h1>
        <SaveStatus state={state} />
      </div>
      <p className="settings-lead">
        All changes are applied immediately and stored on the server, except for Appearance and Reading, which are stored in the browser.
      </p>
      {state.status === 'error' && <ErrorCallout error={state.error} title="Could not save the change. The previous setting is restored." />}

      <div className="card card-pad prefs-group" role="group" aria-labelledby="preferences-appearance-title">
        <h2 id="preferences-appearance-title" className="prefs-group-title">
          Appearance
        </h2>
        <div className="prefs-row">
          <div className="prefs-row-text">
            <div className="prefs-row-label">Theme</div>
          </div>
          <Segmented
            label="Theme"
            value={theme}
            onChange={setThemePreference}
            options={[
              { value: 'system', label: 'System' },
              { value: 'light', label: 'Light' },
              { value: 'dark', label: 'Dark' },
            ]}
          />
        </div>
        <div className="prefs-row">
          <div className="prefs-row-text">
            <div className="prefs-row-label">Reading text size</div>
            <div className="field-hint">For statements, readings and notes.</div>
          </div>
          <Segmented
            label="Reading text size"
            value={readingSize}
            onChange={setReadingSize}
            options={[
              { value: 'small', label: 'Small' },
              { value: 'default', label: 'Default' },
              { value: 'large', label: 'Large' },
            ]}
          />
        </div>
      </div>

      <div className="card card-pad prefs-group" role="group" aria-labelledby="preferences-reading-title">
        <h2 id="preferences-reading-title" className="prefs-group-title">
          Reading
        </h2>
        <div className="prefs-row">
          <div className="prefs-row-text">
            <div className="prefs-row-label">Text width</div>
            <div className="field-hint">The width of a reading's text column.</div>
          </div>
          <Segmented label="Text width" value={textWidth} onChange={setTextWidth} options={TEXT_WIDTHS} />
        </div>
      </div>

      <div className="card card-pad prefs-group" role="group" aria-labelledby="preferences-tests-title">
        <h2 id="preferences-tests-title" className="prefs-group-title">
          Test cases
        </h2>
        <Checkbox
          checked={shown.hideTestCases}
          onChange={(hideTestCases) => save({ hideTestCases })}
          label="Hide test cases by default"
          hint="Only the counts and the example cases are shown until you reveal the rest."
        />
        <StepperRow
          label="Test cases to generate"
          hint="Default number of test cases to be generated by AI. You can manually modify it on the drafting page."
          value={Math.min(maxGenerated, Math.max(1, shown.generatedTestCases))}
          onChange={(generatedTestCases) => save({ generatedTestCases })}
          min={1}
          max={maxGenerated}
          decreaseLabel="Fewer test cases"
          increaseLabel="More test cases"
        />
        <Checkbox
          className="prefs-check-row"
          checked={shown.largeTestCase}
          onChange={(largeTestCase) => save({ largeTestCase })}
          label="Generate large test cases by default"
          hint="Large test cases are generated separately. The AI writes a generator program for each one."
        />
        <StepperRow
          label="Large test cases to generate"
          value={Math.min(maxLarge, Math.max(1, shown.largeTestCaseCount))}
          onChange={(largeTestCaseCount) => save({ largeTestCaseCount })}
          min={1}
          max={maxLarge}
          decreaseLabel="Fewer large test cases"
          increaseLabel="More large test cases"
        />
      </div>

      <div className="card card-pad prefs-group" role="group" aria-labelledby="preferences-editor-title">
        <h2 id="preferences-editor-title" className="prefs-group-title">
          Code editor
        </h2>
        <Checkbox checked={editor.autocomplete} onChange={(autocomplete) => setEditor({ autocomplete })} label="Enable code completion" />
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

        <StepperRow
          label="Font size"
          hint={`${FONT_SIZE_MIN} to ${FONT_SIZE_MAX} pixels. Applies to code; notes and descriptions keep their own size.`}
          value={editor.fontSize}
          onChange={(fontSize) => setEditor({ fontSize })}
          min={FONT_SIZE_MIN}
          max={FONT_SIZE_MAX}
          unit="px"
          decreaseLabel="Smaller font"
          increaseLabel="Larger font"
        />
        <EditorPreview editor={editor} />
      </div>
    </section>
  );
}
