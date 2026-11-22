import { useEffect, useRef, useState, type ReactNode } from 'react';
import { AlertTriangle, Check, Eye, EyeOff, Plus, ShieldCheck, Trash2, X } from 'lucide-react';
import { useLimits, useMeta } from '../../api/queries';
import type { CheckOutcome, Collection, CompareMode, Difficulty, DraftCheck, HarnessCode, ItemType, ProblemInterface, RunnerCheck } from '../../api/types';
import { describeDraftCheck, runnerChecks } from '../../lib/checks';
import { sentence } from '../../lib/errors';
import { plural } from '../../lib/format';
import {
  addFormLanguage,
  concealedData,
  editedCase,
  formLanguages,
  largeLast,
  newKey,
  removeFormLanguage,
  restoreCases,
  type FormErrors,
  type FormTestCase,
  type ItemFormState,
  type TestDataKey,
} from '../../lib/itemForm';
import { textFilename } from '../../lib/largeText';
import { LANGUAGES, languageLabel, languageName, sortLanguages } from '../../lib/languages';
import { readString, writeString } from '../../lib/storage';
import { Button, cx, IconButton } from '../../ui/Button';
import { CodeEditor } from '../../ui/CodeEditor';
import { Collapse, ExpandChevron } from '../../ui/Collapse';
import { Checkbox, Field, Segmented, SelectField, TextField } from '../../ui/Field';
import { TestDataField } from '../../ui/LargeText';
import { Markdown } from '../../ui/Markdown';
import { MenuButton } from '../../ui/Popover';
import { Badge, Tabs, tabPanelProps } from '../../ui/misc';
import { TagInput } from '../../ui/TagInput';
import { useToast } from '../../ui/Toast';
import { lineCount } from '../solutions/solutionWrites';
import { LargeBadge, LargeCaseGenerator, LargeCaseSummary } from '../tests/LargeCaseOutcome';
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
  /** Controls placed by the Test cases heading, and what they have to say below it. */
  caseTools?: ReactNode;
  caseNotice?: ReactNode;
  /** The same for the code section, placed before "Add language". */
  codeTools?: ReactNode;
  codeNotice?: ReactNode;
  /** What was found out about the runners otherwise than by `check`, by language; it takes the place of the check's. */
  runnerResults?: ReadonlyMap<string, RunnerCheck>;
}

const INTERFACE_OPTIONS: { value: ProblemInterface; label: string }[] = [
  { value: 'function', label: 'Solution only' },
  { value: 'program', label: 'Full program' },
];

const NO_RUNNER: HarnessCode = { prefix: '', suffix: '' };

/** What "Verify all" found for a case that did not pass. */
const OUTCOME_LABEL: Record<Exclude<CheckOutcome, 'passed'>, string> = { wrong: 'wrong', failed: 'failed', not_run: 'not run' };

const COMPARE_OPTIONS: { value: CompareMode; label: string }[] = [
  { value: 'tokens', label: 'Values only' },
  { value: 'exact', label: 'Exact text' },
];
/** What each option means, behind the "i" of the choice. */
const COMPARE_HELP = (
  <>
    <p>
      <strong>Values only:</strong> spacing and line breaks are ignored.
    </p>
    <p>
      <strong>Exact text:</strong> spacing and line breaks must match.
    </p>
  </>
);

/** The item form shared by draft review, manual authoring and editing. Every field is editable. */
/** A language tab of a "solution only" draft, marked with what the check found out about its runner. */
function RunnerTabLabel({ language, check }: { language: string; check: RunnerCheck | undefined }) {
  return (
    <>
      {languageName(language)}
      {check?.status === 'ok' && (
        <span className="tab-mark tone-ok">
          <Check size={12} aria-hidden="true" />
          <span className="sr-only">runner ran</span>
        </span>
      )}
      {check?.status === 'failed' && (
        <span className="tab-mark tone-warn">
          <AlertTriangle size={12} aria-hidden="true" />
          <span className="sr-only">runner did not run</span>
        </span>
      )}
    </>
  );
}

export function ItemEditor({
  form,
  onChange,
  mode,
  errors = {},
  collections,
  tagSuggestions,
  judgeLanguages,
  onCreateCollection,
  disabled,
  check = null,
  checkStale = false,
  caseTools,
  caseNotice,
  codeTools,
  codeNotice,
  runnerResults,
}: ItemEditorProps) {
  const set = <K extends keyof ItemFormState>(key: K, value: ItemFormState[K]) => onChange({ ...form, [key]: value });
  const toast = useToast();
  // The form as it is when an "Undo" is pressed, which may be a few edits after what it undoes.
  const latest = useRef({ form, onChange });
  useEffect(() => {
    latest.current = { form, onChange };
  });
  /** Announce a removal with a way back. `restore` puts the removed part into the form as it then is. */
  const removed = (what: string, restore: (now: ItemFormState) => ItemFormState) =>
    toast.info(`Removed ${what}`, { label: 'Undo', onClick: () => latest.current.onChange(restore(latest.current.form)) });
  const removeLanguage = (language: string) => {
    const starter = form.starterCode[language];
    const harness = form.harness[language];
    onChange(removeFormLanguage(form, language));
    removed(languageName(language), (now) => ({
      ...now,
      starterCode: starter === undefined || language in now.starterCode ? now.starterCode : { ...now.starterCode, [language]: starter },
      harness: harness === undefined || language in now.harness ? now.harness : { ...now.harness, [language]: harness },
    }));
  };
  const removeCase = (key: string, position: number) => {
    const before = form.testCases;
    set('testCases', before.filter((c) => c.key !== key));
    removed(`case ${position}`, (now) => restoreCases(now, before, [key]));
  };
  // The cases the form opened with; any other case (added, put back by Undo, brought by a revision) plays its entrance.
  const [initialCases] = useState(() => new Set(form.testCases.map((t) => t.key)));
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
  const runnerChecked = runnerResults ?? runnerChecks(check, checkStale);
  const activeCheck = runnerChecked.get(activeStarter);
  const runnerFailed = activeCheck?.status === 'failed' ? activeCheck : null;
  const setRunner = (change: Partial<HarnessCode>) => set('harness', { ...form.harness, [activeStarter]: { ...runner, ...change } });
  const [solutionShown, setSolutionShown] = useState(false);
  const checkLine = describeDraftCheck(check, checkStale);
  // When every case came out the same way (the engine was down, say), the check's own line says it once.
  const sharedOutcome = form.testCases.length > 1 && form.testCases.every((t) => t.outcome?.error === form.testCases[0]?.outcome?.error);

  const setCase = (key: string, change: Partial<FormTestCase>) =>
    set(
      'testCases',
      form.testCases.map((t) => (t.key === key ? editedCase(t, change) : t)),
    );
  // A large case's data, once cleared or typed into, is edited like any other.
  const setData = (t: FormTestCase, field: TestDataKey, value: string) =>
    setCase(t.key, { ...(field === 'stdin' ? { stdin: value } : { expectedStdout: value }), ...(t.large && !t.unlocked?.includes(field) ? { unlocked: [...(t.unlocked ?? []), field] } : {}) });
  // The large cases come last, after their summary, and only on request.
  // The form keeps them last too, so a case's number is its place in it.
  const regularCases = form.testCases.filter((t) => !t.large);
  const largeCases = form.testCases.filter((t) => t.large);
  /** A draft kept from before there could be several has no `largeCases`. */
  const largeReports = check?.largeCases ?? [];
  const [largeShown, setLargeShown] = useState(false);
  // A draft from before cases carried their generators: theirs are the added reports', in order, while none of the cases is gone.
  const reportedGenerators = largeReports.flatMap((r) => (r.status === 'added' && r.index !== null ? [r] : [])).sort((a, b) => a.index! - b.index!);
  const generatorOf = (t: FormTestCase) =>
    t.generator !== undefined
      ? t.generator
      : largeCases.every((c) => c.generator === undefined) && reportedGenerators.length === largeCases.length
        ? (reportedGenerators[largeCases.indexOf(t)]?.generator ?? null)
        : null;

  const caseCard = (t: FormTestCase, n: number) => {
    const generator = generatorOf(t);
    return (
      <li key={t.key} className={cx('case-card', !initialCases.has(t.key) && 'is-added')}>
        <div className="row">
          <span className="case-no">{n}</span>
          <TextField label={`Name of case ${n}`} hideLabel value={t.name} onChange={(v) => setCase(t.key, { name: v })} placeholder="e.g. Minimum size…" maxLength={limits?.maxTestCaseNameChars} className="input-sm" fieldClassName="grow" />
          {generator && <LargeBadge stdin={t.stdin} />}
          {t.verified && (
            <Badge tone="ok">
              <ShieldCheck size={12} aria-hidden="true" /> verified
            </Badge>
          )}
          {!checkStale && t.outcome && t.outcome.outcome !== 'passed' && <Badge tone={t.outcome.outcome === 'not_run' ? 'neutral' : 'danger'}>{OUTCOME_LABEL[t.outcome.outcome]}</Badge>}
          <Checkbox checked={t.isSample} onChange={(v) => setCase(t.key, { isSample: v })} label="Sample" />
          <IconButton size="sm" label={`Remove case ${n}`} title="" icon={<Trash2 size={14} />} onClick={() => removeCase(t.key, n)} />
        </div>
        {!checkStale && t.outcome?.error && !sharedOutcome && <p className={`check-line case-outcome tone-${t.outcome.outcome === 'failed' ? 'danger' : 'neutral'}`}>{sentence(t.outcome.error)}</p>}
        {generator && <LargeCaseGenerator generator={generator} of={`case ${n}`} />}
        <div className="case-io">
          <TestDataField
            label="Input (stdin)"
            rows={3}
            value={t.stdin}
            onChange={(stdin) => setData(t, 'stdin', stdin)}
            concealed={concealedData(t, 'stdin')}
            filename={textFilename(form.title, t.name || `case ${n}`, 'input')}
          />
          <TestDataField
            label="Expected output"
            rows={3}
            value={t.expectedStdout}
            onChange={(expectedStdout) => setData(t, 'expectedStdout', expectedStdout)}
            concealed={concealedData(t, 'expectedStdout')}
            filename={textFilename(form.title, t.name || `case ${n}`, 'output')}
          />
        </div>
      </li>
    );
  };

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
          placeholder={isProblem ? 'e.g. Two Sum…' : 'e.g. Notes on consistent hashing…'}
          autoComplete="off"
        />
        <TextField
          label="Summary"
          value={form.summary}
          onChange={(v) => set('summary', v)}
          error={errors.summary}
          placeholder="One line shown in lists…"
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
                  placeholder={isProblem ? 'Describe the task, the input and output format, constraints and examples…' : 'Write or paste the text…'}
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
              <h2 id="starter-heading" className="editor-section-title">
                What you write
              </h2>
              <Segmented size="sm" label="What you write" value={form.interface} onChange={(v) => set('interface', v)} options={INTERFACE_OPTIONS} />
              <span className="spacer" />
              {codeTools}
              <MenuButton
                size="sm"
                icon={<Plus size={14} />}
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
            {codeNotice}
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
                  <Button size="sm" variant="ghost" icon={<X size={14} />} onClick={() => removeLanguage(activeStarter)}>
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
                        runsAfter={solutionOnly ? runner.prefix : null}
                        ariaLabel={`${solutionOnly ? 'Stub' : 'Starter code'} for ${languageName(activeStarter)}`}
                        readOnly={disabled}
                      />
                    </div>
                  </div>
                  {solutionOnly && (
                    <div className={`runner${runnerOpen ? ' is-open' : ''}`}>
                      <button type="button" className="runner-toggle" aria-expanded={runnerOpen} onClick={() => setRunnerOpen((v) => !v)}>
                        <ExpandChevron open={runnerOpen} />
                        <strong>Runner</strong>
                        <span className="chip">
                          <EyeOff size={12} aria-hidden="true" /> hidden from the solver
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
                      <Collapse open={runnerOpen} heavy>
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
                      </Collapse>
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
              <h2 id="cases-heading" className="editor-section-title">
                Test cases
              </h2>
              <span className="spacer" />
              {caseTools}
              <Button
                size="sm"
                icon={<Plus size={14} />}
                onClick={() =>
                  set(
                    'testCases',
                    largeLast([
                      ...form.testCases,
                      { key: newKey(), name: `Example ${regularCases.length + 1}`, stdin: '', expectedStdout: '', isSample: true, origin: 'manual', verified: false },
                    ]),
                  )
                }
              >
                Add case
              </Button>
            </div>
            {caseNotice}
            {errors.testCases && (
              <div className="field-error" role="alert">
                {errors.testCases}
              </div>
            )}
            {form.testCases.length === 0 ? (
              <p className="editor-empty">No test cases yet. Without any, the problem can be read but not judged.</p>
            ) : (
              regularCases.length > 0 && <ol className="case-cards">{regularCases.map((t, i) => caseCard(t, i + 1))}</ol>
            )}
            <LargeCaseSummary
              reports={largeReports}
              timeLimitMs={form.timeLimitMs}
              open={largeShown}
              onToggle={() => setLargeShown((v) => !v)}
              info="Regenerated when the AI revises the draft."
            />
            {/* Without the reports there is no summary to open them from. */}
            {largeCases.length > 0 && (largeShown || largeReports.length === 0) && (
              <ol className="case-cards">{largeCases.map((t, i) => caseCard(t, regularCases.length + i + 1))}</ol>
            )}
            <p className="field-hint">Sample cases are shown with the statement and used by “Run”. All cases are used by “Submit”.</p>
          </section>
        )}

        {isProblem && mode === 'create' && form.referenceSolution && (
          <section className="editor-section" aria-labelledby="reference-heading">
            <div className="row">
              <h2 id="reference-heading" className="editor-section-title">
                Reference solution
              </h2>
              <span className="muted">
                {languageName(form.referenceSolution.language)}, written by the AI
              </span>
              <span className="spacer" />
              <Button size="sm" icon={solutionShown ? <EyeOff size={14} /> : <Eye size={14} />} aria-expanded={solutionShown} onClick={() => setSolutionShown((v) => !v)}>
                {solutionShown ? 'Hide solution' : 'Show solution'}
              </Button>
              <IconButton
                size="sm"
                label="Remove the reference solution"
                title=""
                icon={<Trash2 size={14} />}
                onClick={() => {
                  const solution = form.referenceSolution;
                  setSolutionShown(false);
                  set('referenceSolution', null);
                  removed('the reference solution', (now) => ({ ...now, referenceSolution: now.referenceSolution ?? solution }));
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

      <aside className="editor-side card" aria-label="Properties">
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
              {
                value: 'none',
                label: (
                  <>
                    <span aria-hidden="true">—</span>
                    <span className="sr-only">Not set</span>
                  </>
                ),
              },
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
        <TextField label="Source note" value={form.sourceNote} onChange={(v) => set('sourceNote', v)} error={errors.sourceNote} placeholder="e.g. onsite interview, spring…" maxLength={limits?.maxSourceNoteChars} autoComplete="off" />

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
                    inputMode="numeric"
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
                    inputMode="numeric"
                    min={limits ? limits.memoryLimitKb.min / 1024 : undefined}
                    max={limits ? limits.memoryLimitKb.max / 1024 : undefined}
                    step={16}
                    value={Number.isFinite(form.memoryLimitKb) ? Math.round(form.memoryLimitKb / 1024) : ''}
                    onChange={(e) => set('memoryLimitKb', e.target.value === '' ? NaN : Math.round(Number(e.target.value) * 1024))}
                  />
                )}
              </Field>
            </div>
            <SelectField label="Output comparison" value={form.compare} onChange={(v) => set('compare', v)} options={COMPARE_OPTIONS} info={COMPARE_HELP} />
          </>
        )}
      </aside>
    </fieldset>
  );
}
