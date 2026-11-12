import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, ChevronDown, ChevronRight, CircleSlash, FlaskConical, RefreshCw, Save, ShieldCheck, ShieldQuestion, XCircle } from 'lucide-react';
import { api, isApiError } from '../../api/client';
import { qk, useItem, useMeta, useTestCases } from '../../api/queries';
import type { AiTestCasesResponse, Item, ProposedTestCase } from '../../api/types';
import { useDocumentTitle } from '../../app/useDocumentTitle';
import { sentence } from '../../lib/errors';
import { plural } from '../../lib/format';
import { LANGUAGES, languageLabel, languageName } from '../../lib/languages';
import { Button, LinkButton, cx } from '../../ui/Button';
import { CodeEditor } from '../../ui/CodeEditor';
import { DiffView } from '../../ui/DiffView';
import { Checkbox, Field, SelectField, TextAreaField } from '../../ui/Field';
import { Badge, Callout, EmptyState, ErrorCallout, ErrorState, PageLoading } from '../../ui/misc';
import { useToast } from '../../ui/Toast';
import { GeneratingPanel } from '../capture/parts';
import { useGeneration } from '../capture/useGeneration';
import { ItemBar } from '../item/ItemBar';
import { ItemMissing } from '../item/ItemPage';

export default function GenerateTestsPage() {
  const { id = '' } = useParams();
  const item = useItem(id);
  useDocumentTitle(item.data ? `Generate tests: ${item.data.title}` : 'Generate tests');
  if (item.isPending) return <PageLoading />;
  if (item.isError) {
    if (isApiError(item.error) && item.error.code === 'not_found') return <ItemMissing />;
    return (
      <div className="page">
        <ErrorState error={item.error} onRetry={() => void item.refetch()} />
      </div>
    );
  }
  if (item.data.type !== 'problem') {
    return (
      <div className="page">
        <EmptyState icon={<CircleSlash size={24} />} title="Readings have no test cases" actions={<LinkButton to={`/items/${item.data.id}`}>Open the reading</LinkButton>}>
          Test cases belong to problems.
        </EmptyState>
      </div>
    );
  }
  return <Generator key={item.data.id} item={item.data} />;
}

function CaseStatus({ c, attempted }: { c: ProposedTestCase; attempted: boolean }) {
  if (c.error) {
    return (
      <Badge tone="danger" title={c.error}>
        <XCircle size={11} /> run failed
      </Badge>
    );
  }
  if (c.verified && c.predictionMatched === false) {
    return (
      <Badge tone="warn" title="The model predicted a different output than the solution produced">
        <AlertTriangle size={11} /> prediction differed
      </Badge>
    );
  }
  if (c.verified) {
    return (
      <Badge tone="ok" title="Expected output produced by running the reference solution">
        <ShieldCheck size={11} /> verified by execution
      </Badge>
    );
  }
  return (
    <Badge title={attempted ? 'Could not be verified' : 'No judge engine: the output is the model’s prediction'}>
      <ShieldQuestion size={11} /> unverified
    </Badge>
  );
}

/**
 * AI test-case generation: ask for a proposal, review it — reference
 * solution, the reason for each case, which outputs were verified by
 * execution, and where the model's prediction disagreed — choose what to
 * keep, then save. Nothing is written until "Save".
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
  const generation = useGeneration();

  const languageOptions = useMemo(() => {
    const judge = meta?.judge.languages.map((l) => l.id) ?? [];
    return (judge.length > 0 ? judge : LANGUAGES.map((l) => l.id)).map((l) => ({ value: l, label: languageLabel(l, meta?.judge.languages) }));
  }, [meta]);
  const storedSolution = item.problem?.referenceSolution ?? null;

  const [count, setCount] = useState(8);
  const [language, setLanguage] = useState(() => {
    const preferred = storedSolution?.language ?? 'python';
    return languageOptions.some((o) => o.value === preferred) ? preferred : (languageOptions[0]?.value ?? 'python');
  });
  const [instruction, setInstruction] = useState('');

  const [proposal, setProposal] = useState<AiTestCasesResponse | null>(null);
  const [keep, setKeep] = useState<boolean[]>([]);
  const [samples, setSamples] = useState<boolean[]>([]);
  const [open, setOpen] = useState<Set<number>>(new Set());
  const [replace, setReplace] = useState(false);
  const [keepSolution, setKeepSolution] = useState(true);
  const [showSolution, setShowSolution] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<unknown>(null);
  const [conflict, setConflict] = useState<Item | null>(null);

  const maxCount = meta?.limits.maxGeneratedTestCases ?? 30;
  const countValid = Number.isInteger(count) && count >= 1 && count <= maxCount;

  const generate = async () => {
    if (!countValid) return;
    const res = await generation.run((signal) => api.ai.testCases(item.id, { count, language, instruction: instruction.trim() || null }, signal));
    if (!res) return;
    setProposal(res);
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
      await Promise.all([qc.invalidateQueries({ queryKey: qk.item(item.id) }), qc.invalidateQueries({ queryKey: qk.itemLists })]);
      toast.success(`Saved ${plural(cases.length, 'test case')}`);
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
  const mismatches = proposal?.cases.filter((c) => c.predictionMatched === false).length ?? 0;
  const failures = proposal?.cases.filter((c) => c.error).length ?? 0;
  const verifiedCount = proposal?.cases.filter((c) => c.verified).length ?? 0;

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
              ? 'The solution is then run on every input, so the expected outputs are real results rather than the model’s arithmetic.'
              : 'No judge engine is available, so expected outputs will be the model’s own predictions and are kept as unverified.'}{' '}
            You review everything before it is saved.
          </p>

          {!aiEnabled ? (
            <Callout
              tone="info"
              title="AI is not set up"
              className="capture-callout"
              actions={
                <>
                  <Link to="/settings#ai">Set up an AI provider</Link>
                  <Link to={`/items/${item.id}/tests`}>Add test cases by hand</Link>
                </>
              }
            >
              Generating test cases needs an AI provider. Test cases can always be written by hand.
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
                <Field label="How many" error={countValid ? null : `Between 1 and ${maxCount}.`}>
                  {(a) => (
                    <input
                      {...a}
                      className="input"
                      type="number"
                      min={1}
                      max={maxCount}
                      value={Number.isNaN(count) ? '' : count}
                      onChange={(e) => setCount(e.target.value === '' ? NaN : Number(e.target.value))}
                      disabled={generation.running}
                    />
                  )}
                </Field>
                <SelectField label="Reference solution in" value={language} onChange={setLanguage} options={languageOptions} disabled={generation.running} />
              </div>
              <TextAreaField
                label="Anything to focus on? (optional)"
                value={instruction}
                onChange={setInstruction}
                rows={2}
                maxLength={meta?.limits.maxInstructionChars}
                placeholder="e.g. include negative numbers and duplicates · stress the upper limit of n"
                disabled={generation.running}
              />
              {storedSolution && <p className="field-hint">The problem’s current reference solution ({languageName(storedSolution.language)}) is given to the model as context.</p>}
              {!generation.running && (
                <div className="form-actions">
                  <Button type="submit" variant={proposal ? 'default' : 'primary'} icon={proposal ? <RefreshCw size={14} /> : <FlaskConical size={14} />} disabled={!countValid}>
                    {proposal ? 'Generate again' : 'Generate'}
                  </Button>
                  {proposal && <span className="muted">Generating again replaces the proposal below.</span>}
                </div>
              )}
            </form>
          )}

          {generation.running && (
            <GeneratingPanel title="Writing a solution and test cases…" startedAt={generation.startedAt} onCancel={generation.cancel}>
              {judgeOn ? 'The solution is run on each proposed input, which adds to the wait.' : 'This can take up to a couple of minutes.'} Your settings above are kept if it fails.
            </GeneratingPanel>
          )}
          {generation.error != null && <ErrorCallout error={generation.error} title="Generation failed — nothing was changed" onRetry={() => void generate()} />}

          {proposal && !generation.running && (
            <section className="proposal" aria-label="Proposed test cases">
              {proposal.verification.error ? (
                <Callout tone="warn" title="The outputs could not be verified">
                  {sentence(proposal.verification.error)} Expected outputs below are the model’s predictions. Verify them later from the Test cases page.
                </Callout>
              ) : !proposal.verification.attempted ? (
                <Callout tone="warn" title="Unverified: no judge engine is available">
                  The expected outputs below are what the model predicts, and models are unreliable at computing outputs by hand. The cases are saved as unverified; once a judge is available, use “Verify
                  against reference solution”.
                </Callout>
              ) : (
                <Callout tone={mismatches + failures > 0 ? 'info' : 'ok'} title={`${verifiedCount} of ${proposal.cases.length} expected outputs were verified by running the solution`}>
                  Engine: {proposal.verification.engine ?? 'judge'}. A verified output is what the reference solution actually printed for that input.
                </Callout>
              )}

              {mismatches > 0 && (
                <Callout tone="warn" role="alert" title={`The model’s predicted output disagreed with the actual output in ${plural(mismatches, 'case')}`}>
                  The expected output shown is the real one. A disagreement often just means the model miscalculated — but it can also mean the reference solution or the statement is wrong. Look at the
                  marked {mismatches === 1 ? 'case' : 'cases'} and the solution before saving.
                </Callout>
              )}
              {failures > 0 && (
                <Callout tone="danger" title={`The reference solution failed on ${plural(failures, 'input')}`}>
                  Those cases keep the model’s predicted output and are left unselected. A crash on a valid input suggests a bug in the solution.
                </Callout>
              )}

              <div className="card solution-preview">
                <button type="button" className="solution-toggle" aria-expanded={showSolution} onClick={() => setShowSolution((v) => !v)}>
                  {showSolution ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                  <strong>Reference solution</strong>
                  <span className="muted">
                    {languageName(proposal.referenceSolution.language)} · {plural(proposal.referenceSolution.source.split('\n').length, 'line')}
                  </span>
                </button>
                {showSolution && (
                  <div className="solution-editor solution-editor-ro">
                    <CodeEditor value={proposal.referenceSolution.source} language={proposal.referenceSolution.language} readOnly ariaLabel="Proposed reference solution (read-only)" />
                  </div>
                )}
                <div className="solution-keep">
                  <Checkbox
                    checked={keepSolution}
                    onChange={setKeepSolution}
                    label="Save it as the problem’s reference solution"
                    hint={storedSolution ? 'Replaces the current reference solution.' : 'Needed later to verify or regenerate expected outputs.'}
                  />
                </div>
              </div>

              <div className="row proposal-head">
                <h3 className="section-title">Proposed cases</h3>
                <span className="muted">
                  {kept} of {proposal.cases.length} selected
                </span>
                <span className="spacer" />
                <Button size="sm" variant="ghost" onClick={() => setKeep(proposal.cases.map(() => true))}>
                  Select all
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setKeep(proposal.cases.map(() => false))}>
                  None
                </Button>
              </div>

              <ol className="proposal-list">
                {proposal.cases.map((c, i) => {
                  const isOpen = open.has(i);
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
                          {isOpen ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronRight size={14} aria-hidden="true" />}
                          <span className="proposal-text">
                            <span className="proposal-name">{c.name}</span>
                            <span className="proposal-rationale">{c.rationale}</span>
                          </span>
                        </button>
                        <CaseStatus c={c} attempted={proposal.verification.attempted} />
                        <label className="proposal-sample">
                          <input type="checkbox" checked={samples[i] ?? false} onChange={(e) => setSamples((s) => s.map((v, j) => (j === i ? e.target.checked : v)))} />
                          Sample
                        </label>
                      </div>
                      {isOpen && (
                        <div className="proposal-detail">
                          {c.error && (
                            <Callout tone="danger" title="The solution did not produce an output for this input">
                              {c.error}
                            </Callout>
                          )}
                          <div className="io-pair">
                            <div className="io-block">
                              <div className="io-label">Input</div>
                              <pre className={cx('code-block', c.stdin === '' && 'code-block-empty')}>{c.stdin}</pre>
                            </div>
                            {c.predictionMatched !== false && (
                              <div className="io-block">
                                <div className="io-label">{c.verified ? 'Expected output (from running the solution)' : 'Expected output (the model’s prediction)'}</div>
                                <pre className={cx('code-block', c.expectedStdout === '' && 'code-block-empty')}>{c.expectedStdout}</pre>
                              </div>
                            )}
                          </div>
                          {c.predictionMatched === false && (
                            <div className="io-block">
                              <div className="io-label">What the model predicted vs. what the solution printed (kept as the expected output)</div>
                              <DiffView expected={c.predictedStdout} actual={c.expectedStdout} mode={item.problem?.compare} leftLabel="Model’s prediction" rightLabel="Actual output" variant="before-after" />
                            </div>
                          )}
                        </div>
                      )}
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
                  Another tab, or an assistant connected over MCP, edited it — possibly its statement or its reference solution — after this proposal was generated. Nothing was saved. Saving anyway
                  stores the selected cases{keepSolution ? ' and replaces the reference solution with the one above' : ''}.
                </Callout>
              )}

              <div className="proposal-save card card-pad">
                {existingCount > 0 ? (
                  <fieldset className="proposal-mode">
                    <legend className="field-label">This problem already has {plural(existingCount, 'test case')}</legend>
                    <label className="check">
                      <input type="radio" name="replace" checked={!replace} onChange={() => setReplace(false)} />
                      <span>Add the selected cases after them</span>
                    </label>
                    <label className="check">
                      <input type="radio" name="replace" checked={replace} onChange={() => setReplace(true)} />
                      <span>
                        Replace them <span className="muted">— the existing {plural(existingCount, 'case')} {existingCount === 1 ? 'is' : 'are'} deleted</span>
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
    </div>
  );
}
