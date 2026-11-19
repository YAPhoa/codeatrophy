import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CircleSlash, Eye, EyeOff, FlaskConical, RefreshCw, Save, ShieldCheck, ShieldQuestion, XCircle } from 'lucide-react';
import { api, isApiError } from '../../api/client';
import { qk, useItem, useLargeTestCaseCount, useLimits, useMeta, usePreferences, useSolutions, useTestCases } from '../../api/queries';
import type { AiTestCasesResponse, Item, ProposedTestCase } from '../../api/types';
import { useDocumentTitle } from '../../app/useDocumentTitle';
import { sentence } from '../../lib/errors';
import { plural } from '../../lib/format';
import { LANGUAGES, languageLabel, languageName } from '../../lib/languages';
import { textFilename } from '../../lib/largeText';
import { Button, LinkButton, cx } from '../../ui/Button';
import { CodeEditor } from '../../ui/CodeEditor';
import { Collapse, ExpandChevron } from '../../ui/Collapse';
import { DiffView } from '../../ui/DiffView';
import { Checkbox, Field, NumberStepper, SelectField, TextAreaField } from '../../ui/Field';
import { Badge, Callout, EmptyState, ErrorCallout, ErrorState, PageLoading } from '../../ui/misc';
import { useLeaveGuard } from '../../ui/LeaveGuard';
import { useToast } from '../../ui/Toast';
import { modelOptions, useProviderChoice, type ProviderChoice } from '../capture/ModelPicker';
import { GeneratingPanel, UsageLine } from '../capture/parts';
import { useGeneration } from '../capture/useGeneration';
import { ItemBar } from '../item/ItemBar';
import { ItemMissing } from '../item/ItemPage';
import { Output } from '../solve/ResultPanel';
import { LargeCaseOutcomes } from './LargeCaseOutcome';

export default function GenerateTestsPage() {
  const { id = '' } = useParams();
  const item = useItem(id);
  useDocumentTitle(item.data ? `Generate tests: ${item.data.title}` : 'Generate tests');
  if (item.isPending) return <PageLoading />;
  if (item.isError) {
    if (isApiError(item.error) && item.error.code === 'not_found') return <ItemMissing />;
    return (
      <div className="page">
        <ErrorState page error={item.error} onRetry={() => void item.refetch()} />
      </div>
    );
  }
  if (item.data.type !== 'problem') {
    return (
      <div className="page">
        <EmptyState icon={<CircleSlash size={20} />} page title="Readings have no test cases" actions={<LinkButton to={`/items/${item.data.id}`}>Open the reading</LinkButton>}>
          Test cases belong to problems.
        </EmptyState>
      </div>
    );
  }
  return <Generator key={item.data.id} item={item.data} />;
}

/** `revealed`: the solution is on screen, so its error output (which can quote the code) may be too. */
function CaseStatus({ c, attempted, revealed }: { c: ProposedTestCase; attempted: boolean; revealed: boolean }) {
  if (c.error) {
    return (
      <Badge tone="danger" title={revealed ? c.error : 'The solution failed on this input'}>
        <XCircle size={12} /> run failed
      </Badge>
    );
  }
  if (c.verified && c.predictionMatched === false) {
    return (
      <Badge tone="warn" title="The model predicted a different output than the solution produced">
        <AlertTriangle size={12} /> prediction differed
      </Badge>
    );
  }
  if (c.verified) {
    return (
      <Badge tone="ok" title="Expected output produced by running the reference solution">
        <ShieldCheck size={12} /> verified by execution
      </Badge>
    );
  }
  return (
    <Badge title={attempted ? 'Could not be verified' : 'No judge engine: the output is the model’s prediction'}>
      <ShieldQuestion size={12} /> unverified
    </Badge>
  );
}

/**
 * AI test-case generation: ask for a proposal, review it — the reason for
 * each case, which outputs were verified by execution, and where the model's
 * prediction disagreed — choose what to keep, then save. The proposed
 * reference solution stays out of sight until it is asked for. Nothing is
 * written until "Save".
 */
function Generator({ item }: { item: Item }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const toast = useToast();
  const meta = useMeta().data;
  const aiEnabled = meta?.ai.enabled ?? false;
  const judgeOn = meta?.judge.enabled ?? false;
  const existing = useTestCases(item.id);
  const existingCount = existing.data?.length ?? item.testCaseCount;
  // Replacing keeps the sample cases, so only the others can go.
  const sampleCount = existing.data?.filter((c) => c.isSample).length ?? 0;
  const replaceableCount = existingCount - sampleCount;
  const generation = useGeneration();

  // A "Solution only" problem takes a reference solution only in a language it has a runner for.
  const solutionOnly = item.problem?.interface === 'function';
  const languageOptions = useMemo(() => {
    const judge = meta?.judge.languages.map((l) => l.id) ?? [];
    const runners = item.problem?.harness ?? {};
    return (judge.length > 0 ? judge : LANGUAGES.map((l) => l.id))
      .filter((l) => !solutionOnly || l in runners)
      .map((l) => ({ value: l, label: languageLabel(l, meta?.judge.languages) }));
  }, [meta, solutionOnly, item.problem]);
  const noRunner = solutionOnly && languageOptions.length === 0;
  // The reference solution is one of the problem's saved solutions. Saving
  // the proposed one updates it in place, or adds a solution named "Reference
  // solution" when the problem has none.
  const storedSolution = item.problem?.referenceSolution ?? null;
  const limits = useLimits();
  const savedSolutions = useSolutions(item.id).data;
  const storedName = savedSolutions?.find((s) => s.isReference)?.name ?? null;
  // Without a reference to update, saving the solution adds one — which a full list does not allow.
  const noRoom = storedSolution === null && limits !== undefined && item.solutionCount >= limits.maxSolutionsPerItem;

  // The count starts from the user's preference and can be changed for this run.
  const maxCount = meta?.limits.maxGeneratedTestCases ?? 30;
  const preferences = usePreferences();
  const [chosenCount, setCount] = useState<number | null>(null);
  const count = Math.min(maxCount, Math.max(1, chosenCount ?? preferences.generatedTestCases));
  // So does the choice of large test cases, which need a judge to be built; how many is the preference's.
  const [chosenLarge, setLarge] = useState<boolean | null>(null);
  const large = judgeOn && (chosenLarge ?? preferences.largeTestCase);
  const largeCount = useLargeTestCaseCount();
  const [language, setLanguage] = useState(() => {
    const preferred = storedSolution?.language ?? 'python';
    return languageOptions.some((o) => o.value === preferred) ? preferred : (languageOptions[0]?.value ?? 'python');
  });
  const [instruction, setInstruction] = useState('');
  // The provider for this page's generations; the default until another is chosen.
  const [providerChoice, setProviderChoice] = useState<ProviderChoice>(undefined);
  const provider = useProviderChoice(providerChoice, generation.error);
  const models = modelOptions(provider.settings);

  const [proposal, setProposal] = useState<AiTestCasesResponse | null>(null);
  // Counts the proposals, so that what was opened in one is closed in the next.
  const [proposalNo, setProposalNo] = useState(0);
  const [keep, setKeep] = useState<boolean[]>([]);
  const [samples, setSamples] = useState<boolean[]>([]);
  const [open, setOpen] = useState<Set<number>>(new Set());
  const [replace, setReplace] = useState(false);
  const [wantsSolution, setKeepSolution] = useState(true);
  const keepSolution = wantsSolution && !noRoom;
  const [showSolution, setShowSolution] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<unknown>(null);
  const [conflict, setConflict] = useState<Item | null>(null);

  // Every proposal repeated an input the problem has: there is nothing to review.
  const allRepeats = proposal !== null && proposal.cases.length === 0 && proposal.duplicatesDropped > 0;

  // A proposal exists only on this page until it is saved, and cost a generation to get.
  const leaveGuard = useLeaveGuard({
    when: proposal !== null && !allRepeats,
    title: 'Discard the proposed test cases?',
    body: 'They have not been saved, and leaving this page discards them.',
    leaveLabel: 'Discard proposals',
  });

  const generate = async () => {
    if (noRunner) return;
    const res = await generation.run((signal) => api.ai.testCases(item.id, { count, language, instruction: instruction.trim() || null, largeTestCases: large ? largeCount : 0, ...provider.request }, signal));
    if (!res) return;
    setProposal(res);
    setProposalNo((n) => n + 1);
    // Cases whose run failed have no trustworthy expected output; leave them out by default.
    setKeep(res.cases.map((c) => !c.error));
    setSamples(res.cases.map((c) => c.isSample));
    // Open the cases that need a look.
    setOpen(new Set(res.cases.flatMap((c, i) => (c.error || c.predictionMatched === false ? [i] : []))));
    setKeepSolution(true);
    setShowSolution(false);
    setSaveError(null);
  };

  // `revision` is the item revision the save is made against. Storing a
  // reference solution changes the item's content, so it is checked.
  const save = async (revision: number = item.revision) => {
    if (!proposal) return;
    const cases = proposal.cases
      .map((c, i) => ({ c, i }))
      .filter(({ i }) => keep[i])
      .map(({ c, i }) => ({ name: c.name, stdin: c.stdin, expectedStdout: c.expectedStdout, isSample: samples[i] ?? c.isSample, origin: 'ai' as const, verified: c.verified }));
    setSaving(true);
    setSaveError(null);
    try {
      const res = await api.testCases.bulk(item.id, {
        cases,
        replace: replace && cases.length > 0,
        referenceSolution: keepSolution ? proposal.referenceSolution : null,
        ...(keepSolution ? { expectedRevision: revision } : {}),
      });
      setConflict(null);
      qc.setQueryData(qk.testCases(item.id), res);
      await Promise.all([
        qc.invalidateQueries({ queryKey: qk.item(item.id) }),
        qc.invalidateQueries({ queryKey: qk.itemLists }),
        qc.invalidateQueries({ queryKey: qk.solutions(item.id) }),
      ]);
      toast.success(cases.length > 0 ? `Saved ${plural(cases.length, 'test case')}` : 'Saved the reference solution');
      leaveGuard.allow();
      navigate(`/items/${item.id}/tests`);
    } catch (e) {
      if (isApiError(e) && e.isRevisionConflict) {
        // The problem was edited elsewhere after this page loaded. Nothing was
        // written; show what the item looks like now and let the user decide.
        try {
          const latest = await api.items.get(item.id);
          qc.setQueryData(qk.item(item.id), latest);
          setConflict(latest);
        } catch (inner) {
          setSaveError(inner);
        }
      } else {
        setSaveError(e);
      }
    } finally {
      setSaving(false);
    }
  };

  const toggleOpen = (i: number) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });

  const kept = keep.filter(Boolean).length;
  // Where the large cases that were added are among the proposed ones.
  const largeAt = new Set(proposal?.largeCases.flatMap((c) => (c.status === 'added' && c.index !== null ? [c.index] : [])));
  const mismatches = proposal?.cases.filter((c) => c.predictionMatched === false).length ?? 0;
  const failures = proposal?.cases.filter((c) => c.error).length ?? 0;
  const verifiedCount = proposal?.cases.filter((c) => c.verified).length ?? 0;
  // What running the proposed solution found, shown in place of its code.
  const found: { tone: 'ok' | 'warn' | 'danger' | 'neutral'; text: string } = !proposal
    ? { tone: 'neutral', text: '' }
    : proposal.verification.error
      ? { tone: 'warn', text: `Not run. ${sentence(proposal.verification.error)}` }
      : !proposal.verification.attempted
        ? { tone: 'neutral', text: 'Not run' }
        : failures > 0
          ? { tone: 'danger', text: `Failed on ${failures} of ${plural(proposal.cases.length, 'input')}` }
          : { tone: 'ok', text: `Ran on all ${plural(proposal.cases.length, 'input')}` };

  return (
    <div className="workspace">
      <ItemBar item={item} />
      <div className="workspace-scroll">
        <div className="page generate">
          <nav className="crumbs" aria-label="Breadcrumb">
            <Link to={`/items/${item.id}/tests`}>Test cases</Link>
            <span aria-hidden="true">/</span>
            <span>Generate</span>
          </nav>
          <h2 className="page-title">Generate test cases</h2>
          <p className="page-sub">
            The AI writes a reference solution and proposes inputs that probe the edges of the problem.{' '}
            {judgeOn
              ? 'The solution is then run on every input, and what it prints becomes the expected output.'
              : 'No judge engine is available, so expected outputs will be the model’s own predictions and are kept as unverified.'}{' '}
            You review everything before it is saved.
          </p>

          {!aiEnabled ? (
            <Callout
              tone="info"
              title="AI is off"
              className="capture-callout"
              actions={
                <>
                  <Link to="/settings/ai">AI settings</Link>
                  <Link to={`/items/${item.id}/tests`}>Add test cases by hand</Link>
                </>
              }
            >
              Generating test cases needs AI features on. Test cases can always be written by hand.
            </Callout>
          ) : (
            <form
              className="card card-pad generate-form"
              onSubmit={(e) => {
                e.preventDefault();
                void generate();
              }}
            >
              <div className="generate-fields">
                <Field label="How many">
                  {(a) => (
                    <NumberStepper
                      id={a.id}
                      aria-describedby={a['aria-describedby']}
                      value={count}
                      onChange={setCount}
                      min={1}
                      max={maxCount}
                      decreaseLabel="Fewer test cases"
                      increaseLabel="More test cases"
                      disabled={generation.running}
                    />
                  )}
                </Field>
                <SelectField label="Reference solution in" value={language} onChange={setLanguage} options={languageOptions} disabled={generation.running || noRunner} />
                {models.length > 1 && <SelectField label="Model" value={provider.value ?? ''} onChange={setProviderChoice} options={models} disabled={generation.running} />}
              </div>
              <Checkbox
                checked={large}
                onChange={setLarge}
                disabled={generation.running || !judgeOn}
                label={largeCount === 1 ? 'Add a large test case' : `Add ${largeCount} large test cases`}
                hint={judgeOn ? undefined : 'Needs a judge engine.'}
              />
              <TextAreaField
                label="Anything to focus on? (optional)"
                value={instruction}
                onChange={setInstruction}
                rows={2}
                maxLength={meta?.limits.maxInstructionChars}
                placeholder="e.g. include negative numbers and duplicates · stress the upper limit of n…"
                disabled={generation.running}
              />
              {storedSolution && <p className="field-hint">The problem’s current reference solution ({languageName(storedSolution.language)}) is given to the model as context.</p>}
              {noRunner && (
                <Callout tone="warn" title="This problem has no runner yet" actions={<Link to={`/items/${item.id}/edit`}>Edit the problem</Link>}>
                  A solution cannot be run without one.
                </Callout>
              )}
              {!generation.running && (
                <div className="form-actions">
                  <Button type="submit" variant={proposal ? 'default' : 'primary'} icon={proposal ? <RefreshCw size={14} /> : <FlaskConical size={14} />} disabled={noRunner}>
                    {proposal ? 'Generate again' : 'Generate test cases'}
                  </Button>
                  {proposal && <span className="muted">Generating again replaces the proposal below.</span>}
                </div>
              )}
            </form>
          )}

          {generation.running && (
            <GeneratingPanel title="Writing a solution and test cases…" startedAt={generation.startedAt} onCancel={generation.cancel}>
              {judgeOn ? 'The solution is run on each proposed input, which adds to the wait.' : 'This can take up to a couple of minutes.'}
            </GeneratingPanel>
          )}
          {generation.error != null && <ErrorCallout error={generation.error} title="Generation failed" onRetry={() => void generate()} />}

          {allRepeats && proposal && !generation.running && (
            <>
              <p className="editor-empty row proposal-none" role="status">
                {proposal.duplicatesDropped === 1 ? 'The proposed case duplicated an existing one.' : `All ${proposal.duplicatesDropped} proposed cases duplicated existing ones.`}
                <UsageLine usage={proposal.usage} newTab />
              </p>
              <LargeCaseOutcomes key={proposalNo} reports={proposal.largeCases} timeLimitMs={item.problem?.timeLimitMs} className="card large-case-card" />
            </>
          )}

          {proposal && !allRepeats && !generation.running && (
            <section className="proposal" aria-label="Proposed test cases">
              {proposal.verification.error ? (
                <Callout tone="warn" title="The outputs could not be verified">
                  {sentence(proposal.verification.error)} Expected outputs below are the model’s predictions. Verify them later from the Test cases page.
                </Callout>
              ) : !proposal.verification.attempted ? (
                <Callout tone="warn" title="Unverified: no judge engine is available">
                  The expected outputs below are the model’s predictions and may be wrong, since no code was run. The cases are saved as unverified; once a judge engine is available, use
                  “Verify all” on the Test cases page.
                </Callout>
              ) : (
                <Callout tone={mismatches + failures > 0 ? 'info' : 'ok'} title={`${verifiedCount} of ${proposal.cases.length} expected outputs were verified by running the solution`}>
                  Engine: {proposal.verification.engine ?? 'judge'}. Verified outputs come from running the reference solution on each input.
                </Callout>
              )}

              {mismatches > 0 && (
                <Callout tone="warn" role="alert" title={`The model’s predicted output disagreed with the actual output in ${plural(mismatches, 'case')}`}>
                  The expected output shown is the real one. Usually the model miscalculated, but the reference solution or the statement may be wrong. Look at the
                  marked {mismatches === 1 ? 'case' : 'cases'} and the solution before saving.
                </Callout>
              )}
              {failures > 0 && (
                <Callout tone="danger" title={`The reference solution failed on ${plural(failures, 'input')}`}>
                  Those cases keep the model’s predicted output and are left unselected. A crash on a valid input suggests a bug in the solution.
                </Callout>
              )}

              <div className="card solution-preview">
                <div className="solution-toggle">
                  <strong>Reference solution</strong>
                  <span className="muted">{languageName(proposal.referenceSolution.language)}, written by the AI</span>
                  <span className="spacer" />
                  <Button size="sm" icon={showSolution ? <EyeOff size={14} /> : <Eye size={14} />} aria-expanded={showSolution} onClick={() => setShowSolution((v) => !v)}>
                    {showSolution ? 'Hide solution' : 'Show solution'}
                  </Button>
                </div>
                <p className={`check-line solution-found tone-${found.tone}`} role="status">
                  {found.text}
                </p>
                {showSolution && (
                  <div className="solution-editor solution-editor-ro">
                    <CodeEditor value={proposal.referenceSolution.source} language={proposal.referenceSolution.language} readOnly ariaLabel="Proposed reference solution (read-only)" />
                  </div>
                )}
                <div className="solution-keep">
                  <Checkbox
                    checked={keepSolution}
                    onChange={setKeepSolution}
                    disabled={noRoom}
                    label="Save it as the problem’s reference solution"
                    hint={
                      noRoom ? (
                        <>
                          This problem has no reference solution and already holds the maximum of {limits?.maxSolutionsPerItem.toLocaleString()} saved solutions, so this one cannot be added.{' '}
                          <Link to={`/items/${item.id}/solutions`}>Manage solutions</Link>
                        </>
                      ) : storedSolution ? (
                        <>
                          Replaces the code ({languageName(storedSolution.language)}) of the current reference solution{storedName ? ` “${storedName}”` : ''} and keeps its name and notes.
                        </>
                      ) : (
                        'Adds it to the problem’s saved solutions, named “Reference solution” and marked as the reference. Needed later to verify or regenerate expected outputs.'
                      )
                    }
                  />
                </div>
              </div>

              <div className="row proposal-head">
                <h3 className="section-title">Proposed cases</h3>
                <span className="muted">
                  {kept} of {proposal.cases.length} selected
                  {proposal.duplicatesDropped > 0 && ` · ${plural(proposal.duplicatesDropped, 'repeated input')} left out`}
                </span>
                <span className="spacer" />
                <UsageLine usage={proposal.usage} newTab />
                <Button size="sm" variant="ghost" onClick={() => setKeep(proposal.cases.map(() => true))}>
                  Select all
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setKeep(proposal.cases.map(() => false))}>
                  Select none
                </Button>
              </div>

              <LargeCaseOutcomes key={proposalNo} reports={proposal.largeCases} timeLimitMs={item.problem?.timeLimitMs} className="card large-case-card" />

              <ol className="proposal-list">
                {proposal.cases.map((c, i) => {
                  const isOpen = open.has(i);
                  const isLarge = largeAt.has(i);
                  return (
                    <li key={i} className={cx('proposal-case card', !keep[i] && 'is-off', c.predictionMatched === false && 'is-flagged', c.error && 'is-failed')}>
                      <div className="proposal-row">
                        <input
                          type="checkbox"
                          checked={keep[i] ?? false}
                          aria-label={`Keep ${c.name}`}
                          onChange={(e) => setKeep((k) => k.map((v, j) => (j === i ? e.target.checked : v)))}
                        />
                        <button type="button" className="proposal-main" aria-expanded={isOpen} onClick={() => toggleOpen(i)}>
                          <ExpandChevron open={isOpen} />
                          <span className="proposal-text">
                            <span className="proposal-name">{c.name}</span>
                            <span className="proposal-rationale">{c.rationale}</span>
                          </span>
                        </button>
                        {isLarge && <Badge>large</Badge>}
                        <CaseStatus c={c} attempted={proposal.verification.attempted} revealed={showSolution} />
                        <label className="proposal-sample">
                          <input type="checkbox" checked={samples[i] ?? false} onChange={(e) => setSamples((s) => s.map((v, j) => (j === i ? e.target.checked : v)))} />
                          Sample
                        </label>
                      </div>
                      <Collapse open={isOpen} heavy>
                        <div className="proposal-detail">
                          {c.error && (
                            <Callout tone="danger" title="The solution did not produce an output for this input">
                              {showSolution ? c.error : 'The error is shown with the solution.'}
                            </Callout>
                          )}
                          <div className="io-pair">
                            <Output label="Input" text={c.stdin} filename={textFilename(item.title, c.name, 'input')} />
                            {c.predictionMatched !== false && (
                              <Output
                                label={c.verified ? 'Expected output (from running the solution)' : 'Expected output (the model’s prediction)'}
                                text={c.expectedStdout}
                                filename={textFilename(item.title, c.name, 'output')}
                              />
                            )}
                          </div>
                          {c.predictionMatched === false && (
                            <div className="io-block">
                              <div className="io-label">What the model predicted vs. what the solution printed (kept as the expected output)</div>
                              <DiffView expected={c.predictedStdout ?? ''} actual={c.expectedStdout} mode={item.problem?.compare} leftLabel="Model’s prediction" rightLabel="Actual output" variant="before-after" />
                            </div>
                          )}
                        </div>
                      </Collapse>
                    </li>
                  );
                })}
              </ol>

              {saveError != null && <ErrorCallout error={saveError} title="Could not save the test cases" onRetry={() => void save()} />}
              {conflict && (
                <Callout
                  tone="warn"
                  role="alert"
                  title="This problem was changed elsewhere while you were reviewing"
                  actions={
                    <>
                      <Button size="sm" onClick={() => void save(conflict.revision)} busy={saving}>
                        Save anyway
                      </Button>
                      <a href={`/items/${item.id}/tests`} target="_blank" rel="noreferrer">
                        See the current version
                      </a>
                    </>
                  }
                >
                  Another tab or an assistant connected over MCP edited this problem after this proposal was generated, possibly its statement or reference solution. Nothing was saved. Saving anyway
                  stores the selected cases{keepSolution ? ' and makes the solution above the problem’s reference solution' : ''}.
                </Callout>
              )}

              <div className="proposal-save card card-pad">
                {replaceableCount > 0 ? (
                  <fieldset className="proposal-mode">
                    <legend className="field-label">This problem already has {plural(existingCount, 'test case')}</legend>
                    <label className="check">
                      <input type="radio" name="replace" checked={!replace} onChange={() => setReplace(false)} />
                      <span>Add the selected cases after them</span>
                    </label>
                    <label className="check">
                      <input type="radio" name="replace" checked={replace} onChange={() => setReplace(true)} />
                      <span>
                        {sampleCount === 0 ? 'Replace them' : sampleCount === 1 ? 'Replace all but the sample' : `Replace all but the ${sampleCount} samples`}{' '}
                        <span className="muted">
                          ({sampleCount > 0 ? plural(replaceableCount, 'case') : `the existing ${plural(replaceableCount, 'case')}`} {replaceableCount === 1 ? 'is' : 'are'} deleted)
                        </span>
                      </span>
                    </label>
                  </fieldset>
                ) : (
                  <span className="muted">Nothing is saved until you confirm.</span>
                )}
                <span className="spacer" />
                <LinkButton to={`/items/${item.id}/tests`} variant="ghost">
                  Discard
                </LinkButton>
                <Button variant="primary" icon={<Save size={14} />} onClick={() => void save()} busy={saving} disabled={kept === 0 && !keepSolution}>
                  {kept === 0 ? 'Save the solution only' : `Save ${plural(kept, 'case')}`}
                </Button>
              </div>
            </section>
          )}
        </div>
      </div>
      {leaveGuard.dialog}
    </div>
  );
}
