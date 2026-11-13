import { useState } from 'react';
import { AlertTriangle, Check, ChevronDown, ChevronRight, Eye, EyeOff, Plus, ShieldCheck, Trash2, X } from 'lucide-react';
import { useLimits, useMeta } from '../../api/queries';
import type { Collection, CompareMode, Difficulty, DraftCheck, HarnessCode, ItemType, ProblemInterface, RunnerCheck } from '../../api/types';
import { describeDraftCheck, runnerChecks } from '../../lib/checks';
import { sentence } from '../../lib/errors';
import { plural } from '../../lib/format';
import { addFormLanguage, formLanguages, newKey, removeFormLanguage, type FormErrors, type FormTestCase, type ItemFormState } from '../../lib/itemForm';
import { LANGUAGES, languageLabel, languageName, sortLanguages } from '../../lib/languages';
import { readString, writeString } from '../../lib/storage';
import { Button, IconButton } from '../../ui/Button';
import { CodeEditor } from '../../ui/CodeEditor';
import { Checkbox, Field, Segmented, SelectField, TextField } from '../../ui/Field';
import { Markdown } from '../../ui/Markdown';
import { MenuButton } from '../../ui/Popover';
import { Badge, Tabs, tabPanelProps } from '../../ui/misc';
import { TagInput } from '../../ui/TagInput';
import { lineCount } from '../solutions/solutionWrites';
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
  /** What running the draft's reference solution on its examples found. */
  check?: DraftCheck | null;
  /** The form was edited since that check. */
  checkStale?: boolean;
}

const INTERFACE_OPTIONS: { value: ProblemInterface; label: string }[] = [
  { value: 'function', label: 'Solution only' },
  { value: 'program', label: 'Full program' },
];

const NO_RUNNER: HarnessCode = { prefix: '', suffix: '' };

const COMPARE_OPTIONS: { value: CompareMode; label: string }[] = [
  { value: 'tokens', label: 'Tokens — ignore whitespace differences' },
  { value: 'exact', label: 'Exact — only trailing whitespace ignored' },
];

/** The item form shared by draft review, manual authoring and editing. Every field is editable. */
/** A language tab of a "solution only" draft, marked with what the check found out about its runner. */
function RunnerTabLabel({ language, check }: { language: string; check: RunnerCheck | undefined }) {
  return (
    <>
      {languageName(language)}
      {check?.status === 'ok' && (
        <span className="tab-mark tone-ok" title="Its runner ran">
          <Check size={12} aria-hidden="true" />
          <span className="sr-only">runner ran</span>
        </span>
      )}
      {check?.status === 'failed' && (
        <span className="tab-mark tone-warn" title="Its runner did not run">
          <AlertTriangle size={12} aria-hidden="true" />
          <span className="sr-only">runner did not run</span>
        </span>
      )}
    </>
  );
}

export function ItemEditor({ form, onChange, mode, errors = {}, collections, tagSuggestions, judgeLanguages, onCreateCollection, disabled, check = null, checkStale = false }: ItemEditorProps) {
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
  const solutionOnly = form.interface === 'function';
  const starterLangs = sortLanguages(formLanguages(form));
  const [starterTab, setStarterTab] = useState<string>(starterLangs[0] ?? '');
  const activeStarter = starterLangs.includes(starterTab) ? starterTab : (starterLangs[0] ?? '');
  const addable = sortLanguages(Array.from(new Set([...judgeLanguages, ...LANGUAGES.map((l) => l.id)]))).filter((l) => !starterLangs.includes(l));
  // The runner is not what one comes here to read; it opens on request.
  const [runnerOpen, setRunnerOpen] = useState(false);
  const runner = form.harness[activeStarter] ?? NO_RUNNER;
  const runnerEmpty = runner.prefix.trim() === '' && runner.suffix.trim() === '';
  const runnerChecked = runnerChecks(check, checkStale);
  const activeCheck = runnerChecked.get(activeStarter);
  const runnerFailed = activeCheck?.status === 'failed' ? activeCheck : null;
  const setRunner = (change: Partial<HarnessCode>) => set('harness', { ...form.harness, [activeStarter]: { ...runner, ...change } });
  const [solutionShown, setSolutionShown] = useState(false);
  const checkLine = describeDraftCheck(check, checkStale);

  // Editing what a case feeds in or expects undoes its verification, as on the server.
  const setCase = (key: string, change: Partial<FormTestCase>) =>
    set(
      'testCases',
      form.testCases.map((t) => (t.key === key ? { ...t, ...change, ...('stdin' in change || 'expectedStdout' in change ? { verified: false } : {}) } : t)),
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
                What you write
              </h3>
              <Segmented size="sm" label="What you write" value={form.interface} onChange={(v) => set('interface', v)} options={INTERFACE_OPTIONS} />
              <span className="spacer" />
              <MenuButton
                size="sm"
                icon={<Plus size={13} />}
                disabled={addable.length === 0}
                menuLabel="Add a language"
                items={addable.map((l) => ({
                  // With the toolchain version, since the code has to compile on it.
                  label: languageLabel(l, judged),
                  onSelect: () => {
                    onChange(addFormLanguage(form, l));
                    setStarterTab(l);
                  },
                }))}
              >
                Add language
              </MenuButton>
            </div>
            {errors.code && (
              <div className="field-error" role="alert">
                {errors.code}
              </div>
            )}
            {starterLangs.length === 0 ? (
              <p className="editor-empty">{solutionOnly ? 'No languages yet. Add one to write its stub and runner.' : 'No starter code. The editor will open empty.'}</p>
            ) : (
              <>
                <div className="row">
                  <Tabs
                    idBase="starter"
                    label="Language"
                    value={activeStarter}
                    onChange={setStarterTab}
                    tabs={starterLangs.map((l) => ({ value: l, label: solutionOnly ? <RunnerTabLabel language={l} check={runnerChecked.get(l)} /> : languageName(l) }))}
                  />
                  {judged?.find((l) => l.id === activeStarter)?.version && <span className="muted">Runs on {languageLabel(activeStarter, judged)}</span>}
                  <span className="spacer" />
                  <Button size="sm" variant="ghost" icon={<X size={13} />} onClick={() => onChange(removeFormLanguage(form, activeStarter))}>
                    Remove {languageName(activeStarter)}
                  </Button>
                </div>
                <div className="code-parts" {...tabPanelProps('starter', activeStarter)}>
                  <div className="io-block">
                    <div className="io-label">{solutionOnly ? 'Stub the solver starts from' : 'Starter code'}</div>
                    <div className="editor-frame starter-frame">
                      <CodeEditor
                        key={activeStarter}
                        value={form.starterCode[activeStarter] ?? ''}
                        onChange={(v) => set('starterCode', { ...form.starterCode, [activeStarter]: v })}
                        language={activeStarter}
                        ariaLabel={`${solutionOnly ? 'Stub' : 'Starter code'} for ${languageName(activeStarter)}`}
                        readOnly={disabled}
                      />
                    </div>
                  </div>
                  {solutionOnly && (
                    <div className={`runner${runnerOpen ? ' is-open' : ''}`}>
                      <button type="button" className="runner-toggle" aria-expanded={runnerOpen} onClick={() => setRunnerOpen((v) => !v)}>
                        {runnerOpen ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronRight size={14} aria-hidden="true" />}
                        <strong>Runner</strong>
                        <span className="chip">
                          <EyeOff size={11} aria-hidden="true" /> hidden from the solver
                        </span>
                        <span className="spacer" />
                        {runnerEmpty ? (
                          <Badge tone="warn">empty: {languageName(activeStarter)} cannot be run</Badge>
                        ) : runnerFailed ? (
                          <Badge tone="warn">did not run</Badge>
                        ) : (
                          <span className="muted">
                            {activeCheck && 'ran · '}
                            {plural(lineCount(runner.prefix) + lineCount(runner.suffix), 'line')}
                          </span>
                        )}
                      </button>
                      {runnerFailed && !runnerEmpty && (
                        <p className="check-line tone-warn runner-error" role="status">
                          {sentence(runnerFailed.error ?? 'The runner did not run')}
                        </p>
                      )}
                      {runnerOpen && (
                        <div className="runner-parts">
                          <div className="io-block">
                            <div className="io-label">Before the solution</div>
                            <div className="editor-frame runner-frame">
                              <CodeEditor
                                key={activeStarter}
                                value={runner.prefix}
                                onChange={(prefix) => setRunner({ prefix })}
                                language={activeStarter}
                                ariaLabel={`Runner code before the solution, ${languageName(activeStarter)}`}
                                readOnly={disabled}
                              />
                            </div>
                          </div>
                          <div className="io-block">
                            <div className="io-label">After the solution</div>
                            <div className="editor-frame runner-frame">
                              <CodeEditor
                                key={activeStarter}
                                value={runner.suffix}
                                onChange={(suffix) => setRunner({ suffix })}
                                language={activeStarter}
                                ariaLabel={`Runner code after the solution, ${languageName(activeStarter)}`}
                                readOnly={disabled}
                              />
                            </div>
                          </div>
                        </div>
                      )}
                    </div>
                  )}
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
                    { key: newKey(), name: `Example ${form.testCases.length + 1}`, stdin: '', expectedStdout: '', isSample: true, origin: 'manual', verified: false },
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
                      {t.verified && (
                        <Badge tone="ok" title="The reference solution printed this output">
                          <ShieldCheck size={11} aria-hidden="true" /> verified
                        </Badge>
                      )}
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

        {isProblem && mode === 'create' && form.referenceSolution && (
          <section className="editor-section" aria-labelledby="reference-heading">
            <div className="row">
              <h3 id="reference-heading" className="editor-section-title">
                Reference solution
              </h3>
              <span className="muted">
                {languageName(form.referenceSolution.language)}, written by the AI
              </span>
              <span className="spacer" />
              <Button size="sm" icon={solutionShown ? <EyeOff size={13} /> : <Eye size={13} />} aria-expanded={solutionShown} onClick={() => setSolutionShown((v) => !v)}>
                {solutionShown ? 'Hide solution' : 'Show solution'}
              </Button>
              <IconButton
                size="sm"
                label="Remove the reference solution"
                icon={<Trash2 size={13} />}
                onClick={() => {
                  setSolutionShown(false);
                  set('referenceSolution', null);
                }}
              />
            </div>
            <p className={`check-line tone-${checkLine.tone}`} role="status">
              {checkLine.text}
            </p>
            {solutionShown && (
              <div className="editor-frame starter-frame">
                <CodeEditor value={form.referenceSolution.source} language={form.referenceSolution.language} readOnly ariaLabel="Reference solution (read-only)" />
              </div>
            )}
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
