import { useState } from 'react';
import { Plus, Trash2, X } from 'lucide-react';
import { useLimits, useMeta } from '../../api/queries';
import type { Collection, CompareMode, Difficulty, ItemType } from '../../api/types';
import { newKey, type FormErrors, type FormTestCase, type ItemFormState } from '../../lib/itemForm';
import { LANGUAGES, languageLabel, languageName, sortLanguages } from '../../lib/languages';
import { readString, writeString } from '../../lib/storage';
import { Button, IconButton } from '../../ui/Button';
import { CodeEditor } from '../../ui/CodeEditor';
import { Checkbox, Field, Segmented, SelectField, TextField } from '../../ui/Field';
import { Markdown } from '../../ui/Markdown';
import { MenuButton } from '../../ui/Popover';
import { Tabs, tabPanelProps } from '../../ui/misc';
import { TagInput } from '../../ui/TagInput';
import { CollectionPicker } from './controls';

type BodyView = 'write' | 'split' | 'preview';

interface ItemEditorProps {
  form: ItemFormState;
  onChange: (form: ItemFormState) => void;
  /** `create` allows choosing the type and editing the initial test cases. */
  mode: 'create' | 'edit';
  errors?: FormErrors;
  collections: readonly Collection[];
  tagSuggestions: readonly string[];
  /** Language ids the judge offers; listed first when adding starter code. */
  judgeLanguages: readonly string[];
  onCreateCollection?: () => void;
  disabled?: boolean;
}

const COMPARE_OPTIONS: { value: CompareMode; label: string }[] = [
  { value: 'tokens', label: 'Tokens — ignore whitespace differences' },
  { value: 'exact', label: 'Exact — only trailing whitespace ignored' },
];

/** The item form shared by draft review, manual authoring and editing. Every field is editable. */
export function ItemEditor({ form, onChange, mode, errors = {}, collections, tagSuggestions, judgeLanguages, onCreateCollection, disabled }: ItemEditorProps) {
  const set = <K extends keyof ItemFormState>(key: K, value: ItemFormState[K]) => onChange({ ...form, [key]: value });
  const limits = useLimits();
  const judged = useMeta().data?.judge.languages;
  const [bodyView, setBodyViewState] = useState<BodyView>(() => {
    const stored = readString('editor:bodyView');
    if (stored === 'write' || stored === 'split' || stored === 'preview') return stored;
    return window.innerWidth >= 1200 ? 'split' : 'write';
  });
  const setBodyView = (v: BodyView) => {
    setBodyViewState(v);
    writeString('editor:bodyView', v);
  };

  const isProblem = form.type === 'problem';
  const starterLangs = sortLanguages(Object.keys(form.starterCode));
  const [starterTab, setStarterTab] = useState<string>(starterLangs[0] ?? '');
  const activeStarter = starterLangs.includes(starterTab) ? starterTab : (starterLangs[0] ?? '');
  const addable = sortLanguages(Array.from(new Set([...judgeLanguages, ...LANGUAGES.map((l) => l.id)]))).filter((l) => !(l in form.starterCode));

  const setCase = (key: string, change: Partial<FormTestCase>) =>
    set(
      'testCases',
      form.testCases.map((t) => (t.key === key ? { ...t, ...change } : t)),
    );

  return (
    <fieldset className="editor-grid" disabled={disabled}>
      <legend className="sr-only">Item details</legend>
      <div className="editor-main">
        <TextField
          label="Title"
          value={form.title}
          onChange={(v) => set('title', v)}
          error={errors.title}
          maxLength={limits?.maxTitleChars}
          className="input-title"
          placeholder={isProblem ? 'e.g. Two Sum' : 'e.g. Notes on consistent hashing'}
          autoComplete="off"
        />
        <TextField
          label="Summary"
          value={form.summary}
          onChange={(v) => set('summary', v)}
          error={errors.summary}
          placeholder="One line shown in lists"
          autoComplete="off"
        />

        <div className="field">
          <div className="row">
            <span className="field-label" id="body-label">
              {isProblem ? 'Statement' : 'Text'} <span className="muted" style={{ fontWeight: 400 }}>· Markdown, with $math$ and code blocks</span>
            </span>
            <span className="spacer" />
            <Segmented
              size="sm"
              label="Editor layout"
              value={bodyView}
              onChange={setBodyView}
              options={[
                { value: 'write', label: 'Write' },
                { value: 'split', label: 'Side by side' },
                { value: 'preview', label: 'Preview' },
              ]}
            />
          </div>
          <div className={`body-editor body-editor-${bodyView}`}>
            {bodyView !== 'preview' && (
              <div className="body-editor-pane">
                <CodeEditor
                  value={form.body}
                  onChange={(v) => set('body', v)}
                  language="markdown"
                  prose
                  ariaLabel={isProblem ? 'Statement (Markdown)' : 'Text (Markdown)'}
                  placeholder={isProblem ? 'Describe the task, the input and output format, constraints and examples.' : 'Write or paste the text.'}
                  readOnly={disabled}
                />
              </div>
            )}
            {bodyView !== 'write' && (
              <div className="body-editor-pane body-editor-preview" role="region" aria-label="Preview" tabIndex={0}>
                <Markdown source={form.body} emptyText="Nothing to preview yet." />
              </div>
            )}
          </div>
          {errors.body && (
            <div className="field-error" role="alert">
              {errors.body}
            </div>
          )}
        </div>

        {isProblem && (
          <section className="editor-section" aria-labelledby="starter-heading">
            <div className="row">
              <h3 id="starter-heading" className="editor-section-title">
                Starter code
              </h3>
              <span className="muted">
                What the editor opens with, per language. Optional.
                {judged?.find((l) => l.id === activeStarter)?.version ? ` Runs on ${languageLabel(activeStarter, judged)}.` : ''}
              </span>
              <span className="spacer" />
              <MenuButton
                size="sm"
                icon={<Plus size={13} />}
                disabled={addable.length === 0}
                menuLabel="Add starter code for a language"
                items={addable.map((l) => ({
                  // With the toolchain version, since starter code has to compile on it.
                  label: languageLabel(l, judged),
                  onSelect: () => {
                    set('starterCode', { ...form.starterCode, [l]: '' });
                    setStarterTab(l);
                  },
                }))}
              >
                Add language
              </MenuButton>
            </div>
            {starterLangs.length === 0 ? (
              <p className="editor-empty">No starter code. The editor will open empty.</p>
            ) : (
              <>
                <div className="row">
                  <Tabs
                    idBase="starter"
                    label="Starter code language"
                    value={activeStarter}
                    onChange={setStarterTab}
                    tabs={starterLangs.map((l) => ({ value: l, label: languageName(l) }))}
                  />
                  <span className="spacer" />
                  <Button
                    size="sm"
                    variant="ghost"
                    icon={<X size={13} />}
                    onClick={() => {
                      const next = { ...form.starterCode };
                      delete next[activeStarter];
                      set('starterCode', next);
                    }}
                  >
                    Remove {languageName(activeStarter)}
                  </Button>
                </div>
                <div className="editor-frame starter-frame" {...tabPanelProps('starter', activeStarter)}>
                  <CodeEditor
                    key={activeStarter}
                    value={form.starterCode[activeStarter] ?? ''}
                    onChange={(v) => set('starterCode', { ...form.starterCode, [activeStarter]: v })}
                    language={activeStarter}
                    ariaLabel={`Starter code for ${languageName(activeStarter)}`}
                    readOnly={disabled}
                  />
                </div>
              </>
            )}
          </section>
        )}

        {isProblem && mode === 'create' && (
          <section className="editor-section" aria-labelledby="cases-heading">
            <div className="row">
              <h3 id="cases-heading" className="editor-section-title">
                Test cases
              </h3>
              <span className="muted">Saved with the problem. You can generate a fuller set afterwards.</span>
              <span className="spacer" />
              <Button
                size="sm"
                icon={<Plus size={13} />}
                onClick={() =>
                  set('testCases', [
                    ...form.testCases,
                    { key: newKey(), name: `Example ${form.testCases.length + 1}`, stdin: '', expectedStdout: '', isSample: true, origin: 'manual' },
                  ])
                }
              >
                Add case
              </Button>
            </div>
            {errors.testCases && (
              <div className="field-error" role="alert">
                {errors.testCases}
              </div>
            )}
            {form.testCases.length === 0 ? (
              <p className="editor-empty">No test cases yet. Without any, the problem can be read but not judged.</p>
            ) : (
              <ol className="case-cards">
                {form.testCases.map((t, i) => (
                  <li key={t.key} className="case-card">
                    <div className="row">
                      <span className="case-no">{i + 1}</span>
                      <TextField label={`Name of case ${i + 1}`} hideLabel value={t.name} onChange={(v) => setCase(t.key, { name: v })} placeholder="Name" maxLength={limits?.maxTestCaseNameChars} className="input-sm" fieldClassName="grow" />
                      <Checkbox checked={t.isSample} onChange={(v) => setCase(t.key, { isSample: v })} label="Sample" />
                      <IconButton size="sm" label={`Remove case ${i + 1}`} icon={<Trash2 size={13} />} onClick={() => set('testCases', form.testCases.filter((c) => c.key !== t.key))} />
                    </div>
                    <div className="case-io">
                      <Field label="Input (stdin)">
                        {(a) => <textarea {...a} className="input textarea mono" rows={3} spellCheck={false} value={t.stdin} onChange={(e) => setCase(t.key, { stdin: e.target.value })} />}
                      </Field>
                      <Field label="Expected output">
                        {(a) => (
                          <textarea {...a} className="input textarea mono" rows={3} spellCheck={false} value={t.expectedStdout} onChange={(e) => setCase(t.key, { expectedStdout: e.target.value })} />
                        )}
                      </Field>
                    </div>
                  </li>
                ))}
              </ol>
            )}
            <p className="field-hint">Sample cases are shown with the statement and used by “Run”. All cases are used by “Submit”.</p>
          </section>
        )}
      </div>

      <aside className="editor-side" aria-label="Properties">
        {mode === 'create' && (
          <div className="field">
            <span className="field-label">Type</span>
            <Segmented<ItemType>
              label="Type"
              value={form.type}
              onChange={(v) => set('type', v)}
              options={[
                { value: 'problem', label: 'Problem' },
                { value: 'reading', label: 'Reading' },
              ]}
            />
            <span className="field-hint">The type cannot be changed after saving.</span>
          </div>
        )}
        <div className="field">
          <span className="field-label">Difficulty</span>
          <Segmented<Difficulty | 'none'>
            label="Difficulty"
            value={form.difficulty ?? 'none'}
            onChange={(v) => set('difficulty', v === 'none' ? null : v)}
            options={[
              { value: 'none', label: '—', title: 'Not set' },
              { value: 'easy', label: 'Easy' },
              { value: 'medium', label: 'Medium' },
              { value: 'hard', label: 'Hard' },
            ]}
          />
        </div>
        <Field label="Tags" error={errors.tags}>
          {(a) => <TagInput {...a} value={form.tags} onChange={(v) => set('tags', v)} suggestions={tagSuggestions} />}
        </Field>
        <div className="field">
          <span className="field-label">Collections</span>
          <CollectionPicker
            collections={collections}
            selected={form.collectionIds}
            onToggle={(id, on) => set('collectionIds', on ? [...form.collectionIds, id] : form.collectionIds.filter((c) => c !== id))}
            onCreate={onCreateCollection}
          />
        </div>
        <TextField label="Source link" type="url" value={form.sourceUrl} onChange={(v) => set('sourceUrl', v)} placeholder="https://…" error={errors.sourceUrl} maxLength={limits?.maxSourceUrlChars} autoComplete="off" />
        <TextField label="Source note" value={form.sourceNote} onChange={(v) => set('sourceNote', v)} error={errors.sourceNote} placeholder="e.g. onsite interview, spring" maxLength={limits?.maxSourceNoteChars} autoComplete="off" />

        {isProblem && (
          <>
            <hr className="editor-rule" />
            <div className="form-grid">
              <Field label="Time limit (ms)" error={errors.timeLimitMs}>
                {(a) => (
                  <input
                    {...a}
                    className="input"
                    type="number"
                    min={limits?.timeLimitMs.min}
                    max={limits?.timeLimitMs.max}
                    step={100}
                    value={Number.isFinite(form.timeLimitMs) ? form.timeLimitMs : ''}
                    onChange={(e) => set('timeLimitMs', e.target.value === '' ? NaN : Number(e.target.value))}
                  />
                )}
              </Field>
              <Field label="Memory limit (MB)" error={errors.memoryLimitKb}>
                {(a) => (
                  <input
                    {...a}
                    className="input"
                    type="number"
                    min={limits ? limits.memoryLimitKb.min / 1024 : undefined}
                    max={limits ? limits.memoryLimitKb.max / 1024 : undefined}
                    step={16}
                    value={Number.isFinite(form.memoryLimitKb) ? Math.round(form.memoryLimitKb / 1024) : ''}
                    onChange={(e) => set('memoryLimitKb', e.target.value === '' ? NaN : Math.round(Number(e.target.value) * 1024))}
                  />
                )}
              </Field>
            </div>
            <SelectField label="Output comparison" value={form.compare} onChange={(v) => set('compare', v)} options={COMPARE_OPTIONS} />
          </>
        )}
      </aside>
    </fieldset>
  );
}
