import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, ArrowDown, ArrowUp, Check, CircleSlash, FlaskConical, Plus, Save, ShieldCheck, Trash2, X } from 'lucide-react';
import { api, isApiError } from '../../api/client';
import { qk, useItem, useMeta, useTestCases } from '../../api/queries';
import type { Item, SourceCode, TestCase, VerifyResult } from '../../api/types';
import { useDocumentTitle } from '../../app/useDocumentTitle';
import { ORIGIN_LABEL, VERDICT_LABEL, formatBytes, plural } from '../../lib/format';
import { byteLength } from '../../lib/itemForm';
import { LANGUAGES, languageLabel } from '../../lib/languages';
import { moveIndex } from '../../lib/tree';
import { Button, IconButton, LinkButton, cx } from '../../ui/Button';
import { CodeEditor } from '../../ui/CodeEditor';
import { useConfirm } from '../../ui/Dialog';
import { DiffView } from '../../ui/DiffView';
import { Checkbox, Field, TextField } from '../../ui/Field';
import { Badge, Callout, EmptyState, ErrorCallout, ErrorState, PageLoading } from '../../ui/misc';
import { useToast } from '../../ui/Toast';
import { ItemBar } from '../item/ItemBar';
import { ItemMissing } from '../item/ItemPage';

export default function TestsPage() {
  const { id = '' } = useParams();
  const item = useItem(id);
  useDocumentTitle(item.data ? `Test cases: ${item.data.title}` : 'Test cases');
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
  return <TestsManager key={item.data.id} item={item.data} />;
}

interface CaseDraft {
  name: string;
  stdin: string;
  expectedStdout: string;
  isSample: boolean;
  verified: boolean;
}

const NEW = '__new__';
const blank = (n: number): CaseDraft => ({ name: `Case ${n}`, stdin: '', expectedStdout: '', isSample: false, verified: false });
const draftOf = (c: TestCase): CaseDraft => ({ name: c.name, stdin: c.stdin, expectedStdout: c.expectedStdout, isSample: c.isSample, verified: c.verified });

const sameDraft = (a: CaseDraft, b: CaseDraft): boolean =>
  a.name === b.name && a.stdin === b.stdin && a.expectedStdout === b.expectedStdout && a.isSample === b.isSample && a.verified === b.verified;

function sameSolution(a: SourceCode | null, b: SourceCode | null): boolean {
  return a === b || (a !== null && b !== null && a.language === b.language && a.source === b.source);
}

/** Manage a problem's test cases and reference solution, and verify one against the other. */
function TestsManager({ item }: { item: Item }) {
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const meta = useMeta().data;
  const casesQuery = useTestCases(item.id);
  const cases = useMemo(() => casesQuery.data ?? [], [casesQuery.data]);
  const judgeOn = meta?.judge.enabled ?? false;

  const [selectedId, setSelectedId] = useState<string | null>(null);
  // `draft` is what the editor shows; `base` is the stored state it was loaded
  // from. Comparing the two (not the draft with the live case) tells the
  // user's edits apart from changes made to the case underneath, such as a
  // verification that rewrites its expected output.
  const [draft, setDraft] = useState<CaseDraft | null>(null);
  const [base, setBase] = useState<CaseDraft | null>(null);
  const load = (next: CaseDraft | null) => {
    setDraft(next);
    setBase(next);
  };
  const [busy, setBusy] = useState(false);
  const [caseError, setCaseError] = useState<unknown>(null);
  const [verify, setVerify] = useState<Map<string, VerifyResult> | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [verifyError, setVerifyError] = useState<unknown>(null);

  const selected = selectedId && selectedId !== NEW ? (cases.find((c) => c.id === selectedId) ?? null) : null;

  // Select the first case once loaded, and follow the selection when the list changes.
  useEffect(() => {
    if (selectedId === NEW) return;
    if (selectedId && cases.some((c) => c.id === selectedId)) return;
    const first = cases[0];
    setSelectedId(first?.id ?? null);
    load(first ? draftOf(first) : null);
  }, [cases, selectedId]);

  /**
   * Edit the input or expected output. A verified case stops being verified
   * the moment either changes — visibly, by clearing the checkbox, which the
   * user can tick again on purpose — and is restored if the edit is undone.
   */
  const setIo = (change: Partial<Pick<CaseDraft, 'stdin' | 'expectedStdout'>>) => {
    if (!draft) return;
    const next = { ...draft, ...change };
    if (base && selectedId !== NEW) {
      const differs = (d: CaseDraft) => d.stdin !== base.stdin || d.expectedStdout !== base.expectedStdout;
      if (differs(next) && !differs(draft) && base.verified) next.verified = false;
      if (!differs(next) && differs(draft)) next.verified = base.verified;
    }
    setDraft(next);
  };

  const dirty = draft !== null && (selectedId === NEW || (base !== null && !sameDraft(draft, base)));

  /** Test-case writes change the item's case count and `updatedAt` (not its revision); refresh what shows them. */
  const refresh = async () => {
    await Promise.all([
      qc.invalidateQueries({ queryKey: qk.testCases(item.id) }),
      qc.invalidateQueries({ queryKey: qk.item(item.id) }),
      qc.invalidateQueries({ queryKey: qk.itemLists }),
    ]);
  };

  const select = async (id: string) => {
    if (id === selectedId) return;
    if (dirty && !(await confirm({ title: 'Discard changes to this case?', confirmLabel: 'Discard', danger: true }))) return;
    setCaseError(null);
    setSelectedId(id);
    const c = cases.find((x) => x.id === id);
    load(id === NEW ? blank(cases.length + 1) : c ? draftOf(c) : null);
  };

  const dataLimit = meta?.limits.maxTestDataBytes;
  const tooBig = (text: string) => (dataLimit !== undefined && byteLength(text) > dataLimit ? `Larger than ${formatBytes(dataLimit)}.` : null);
  const stdinError = draft ? tooBig(draft.stdin) : null;
  const expectedError = draft ? tooBig(draft.expectedStdout) : null;
  const maxCases = meta?.limits.maxTestCasesPerItem;
  const atCaseLimit = maxCases !== undefined && cases.length >= maxCases;

  const saveCase = async () => {
    if (!draft || stdinError || expectedError) return;
    setBusy(true);
    setCaseError(null);
    try {
      if (selectedId === NEW) {
        const created = await api.testCases.create(item.id, { ...draft, origin: 'manual' });
        await refresh();
        setSelectedId(created.id);
        load(draftOf(created));
        toast.success('Test case added');
      } else if (selected && base) {
        // Only what the user changed is sent, so a field rewritten underneath
        // (by a verification, say) is not put back to its old value.
        const ioChanged = draft.stdin !== base.stdin || draft.expectedStdout !== base.expectedStdout;
        const updated = await api.testCases.update(selected.id, {
          ...(draft.name !== base.name ? { name: draft.name } : {}),
          ...(draft.stdin !== base.stdin ? { stdin: draft.stdin } : {}),
          ...(draft.expectedStdout !== base.expectedStdout ? { expectedStdout: draft.expectedStdout } : {}),
          ...(draft.isSample !== base.isSample ? { isSample: draft.isSample } : {}),
          // Changing the input or output resets "verified" on the server unless it is set explicitly.
          ...(draft.verified !== base.verified || (ioChanged && draft.verified) ? { verified: draft.verified } : {}),
        });
        await refresh();
        load(draftOf(updated));
        setVerify((v) => {
          if (!v) return v;
          const next = new Map(v);
          next.delete(updated.id);
          return next;
        });
        toast.success('Test case saved');
      }
    } catch (e) {
      setCaseError(e);
    } finally {
      setBusy(false);
    }
  };

  const deleteCase = async () => {
    if (selectedId === NEW) {
      setSelectedId(null);
      return;
    }
    if (!selected) return;
    if (!(await confirm({ title: `Delete “${selected.name || 'this case'}”?`, confirmLabel: 'Delete', danger: true }))) return;
    setBusy(true);
    try {
      await api.testCases.remove(selected.id);
      setSelectedId(null);
      await refresh();
      toast.success('Test case deleted');
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };

  const move = async (index: number, delta: -1 | 1) => {
    const target = index + delta;
    if (target < 0 || target >= cases.length) return;
    const ids = moveIndex(cases, index, target).map((c) => c.id);
    try {
      const res = await api.testCases.reorder(item.id, ids);
      qc.setQueryData(qk.testCases(item.id), res);
    } catch (e) {
      toast.error(e);
    }
  };

  // ---- Reference solution ----
  const stored = item.problem?.referenceSolution ?? null;
  const languageOptions = useMemo(() => {
    const judge = meta?.judge.languages.map((l) => l.id) ?? [];
    return judge.length > 0 ? judge : LANGUAGES.map((l) => l.id);
  }, [meta]);
  const [solution, setSolution] = useState<SourceCode>(() => stored ?? { language: languageOptions.includes('python') ? 'python' : (languageOptions[0] ?? 'python'), source: '' });
  const [solutionBase, setSolutionBase] = useState<SourceCode | null>(stored);
  const [solutionBusy, setSolutionBusy] = useState(false);
  const [solutionError, setSolutionError] = useState<unknown>(null);
  const [solutionConflict, setSolutionConflict] = useState<Item | null>(null);
  const solutionDirty = !sameSolution(solution.source.trim() === '' ? null : solution, solutionBase);

  // Pick up a solution stored from elsewhere (AI generation, another tab) while this one is untouched.
  useEffect(() => {
    if (!solutionDirty && !sameSolution(stored, solutionBase)) {
      setSolutionBase(stored);
      if (stored) setSolution(stored);
    }
  }, [stored, solutionBase, solutionDirty]);

  const saveSolution = async (revision: number = item.revision, retried = false): Promise<void> => {
    const value = solution.source.trim() === '' ? null : solution;
    setSolutionBusy(true);
    setSolutionError(null);
    try {
      const updated = await api.items.update(item.id, { problem: { referenceSolution: value }, expectedRevision: revision });
      qc.setQueryData(qk.item(item.id), updated);
      setSolutionBase(value);
      setSolutionConflict(null);
      setVerify(null);
      toast.success(value ? 'Reference solution saved' : 'Reference solution removed');
    } catch (e) {
      if (isApiError(e) && e.isRevisionConflict) {
        try {
          const latest = await api.items.get(item.id);
          qc.setQueryData(qk.item(item.id), latest);
          // Someone changed the item while this solution was being edited. If
          // the stored solution is still the one this edit started from, the
          // other change was to a different field and saving overwrites
          // nothing; otherwise the two solutions are put side by side.
          if (!retried && sameSolution(latest.problem?.referenceSolution ?? null, solutionBase)) {
            await saveSolution(latest.revision, true);
            return;
          }
          setSolutionConflict(latest);
        } catch (inner) {
          setSolutionError(inner);
        }
      } else {
        setSolutionError(e);
      }
    } finally {
      setSolutionBusy(false);
    }
  };

  // ---- Verification ----
  const runVerify = async (updateExpected: boolean) => {
    setVerifying(true);
    setVerifyError(null);
    try {
      const res = await api.testCases.verify(item.id, updateExpected);
      setVerify(new Map(res.results.map((r) => [r.testCaseId, r])));
      await refresh();
      if (updateExpected) {
        toast.success('Expected outputs updated from the reference solution');
      }
    } catch (e) {
      setVerifyError(e);
    } finally {
      setVerifying(false);
    }
  };

  // When the stored case changes underneath an unmodified editor (expected
  // outputs rewritten by a verification, a verified flag set), show the new state.
  useEffect(() => {
    if (!selected || !base || dirty) return;
    const stored = draftOf(selected);
    if (!sameDraft(stored, base)) load(stored);
  }, [selected, base, dirty]);

  const results = verify ? cases.map((c) => verify.get(c.id)).filter((r): r is VerifyResult => !!r) : [];
  const mismatched = results.filter((r) => r.ok && !r.matches).length;
  const failed = results.filter((r) => !r.ok).length;
  const matched = results.filter((r) => r.ok && r.matches).length;
  const selectedVerify = selected && verify ? verify.get(selected.id) : undefined;
  const canVerify = judgeOn && solutionBase !== null && !solutionDirty && cases.length > 0;

  return (
    <div className="workspace">
      <ItemBar item={item} />
      <div className="workspace-scroll">
        <div className="page page-wide tests">
          <div className="section-head">
            <h2 className="section-title">Test cases</h2>
            <span className="muted">
              {cases.length === 0 ? 'none yet' : `${plural(cases.filter((c) => c.isSample).length, 'sample')} · ${cases.filter((c) => !c.isSample).length} hidden · ${cases.filter((c) => c.verified).length} verified`}
            </span>
            <span className="spacer" />
            <Button
              icon={<Plus size={14} />}
              onClick={() => void select(NEW)}
              disabled={atCaseLimit}
              title={atCaseLimit ? `A problem can have at most ${maxCases?.toLocaleString()} test cases` : undefined}
            >
              Add case
            </Button>
            <LinkButton to={`/items/${item.id}/tests/generate`} icon={<FlaskConical size={14} />}>
              Generate with AI
            </LinkButton>
          </div>

          {casesQuery.isPending ? (
            <PageLoading />
          ) : casesQuery.isError ? (
            <ErrorState compact error={casesQuery.error} onRetry={() => void casesQuery.refetch()} />
          ) : cases.length === 0 && selectedId !== NEW ? (
            <div className="card">
              <EmptyState
                compact
                icon={<FlaskConical size={18} />}
                title="No test cases yet"
                actions={
                  <>
                    <Button icon={<Plus size={14} />} onClick={() => void select(NEW)}>
                      Add the first case
                    </Button>
                    {meta?.ai.enabled && (
                      <LinkButton to={`/items/${item.id}/tests/generate`} variant="primary" icon={<FlaskConical size={14} />}>
                        Generate with AI
                      </LinkButton>
                    )}
                  </>
                }
              >
                A problem needs test cases to be judged: sample cases for “Run”, and hidden ones that “Submit” also checks.
              </EmptyState>
            </div>
          ) : (
            <div className="tests-grid">
              <ol className="case-list card" aria-label="Test cases">
                {cases.map((c, i) => {
                  const v = verify?.get(c.id);
                  return (
                    <li key={c.id} className={cx('case-row', selectedId === c.id && 'is-selected')}>
                      <button type="button" className="case-row-main" onClick={() => void select(c.id)} aria-current={selectedId === c.id || undefined}>
                        <span className="case-no">{i + 1}</span>
                        <span className="grow truncate">{c.name || <span className="muted">Unnamed</span>}</span>
                        {c.isSample && <Badge tone="accent">sample</Badge>}
                        {c.origin !== 'manual' && <Badge>{ORIGIN_LABEL[c.origin]}</Badge>}
                        {v ? (
                          v.ok && v.matches ? (
                            <Badge tone="ok" title="The reference solution produces this expected output">
                              <Check size={11} /> matches
                            </Badge>
                          ) : v.ok ? (
                            <Badge tone="danger" title="The reference solution produces a different output">
                              <AlertTriangle size={11} /> differs
                            </Badge>
                          ) : (
                            <Badge tone="warn" title={VERDICT_LABEL[v.verdict]}>
                              <X size={11} /> failed
                            </Badge>
                          )
                        ) : c.verified ? (
                          <Badge tone="ok" title="Expected output confirmed by running the reference solution">
                            <ShieldCheck size={11} /> verified
                          </Badge>
                        ) : (
                          <Badge title="Expected output has not been confirmed by execution">unverified</Badge>
                        )}
                      </button>
                      <IconButton size="sm" label={`Move ${c.name || `case ${i + 1}`} up`} icon={<ArrowUp size={13} />} disabled={i === 0} onClick={() => void move(i, -1)} />
                      <IconButton size="sm" label={`Move ${c.name || `case ${i + 1}`} down`} icon={<ArrowDown size={13} />} disabled={i === cases.length - 1} onClick={() => void move(i, 1)} />
                    </li>
                  );
                })}
                {selectedId === NEW && (
                  <li className="case-row is-selected">
                    <span className="case-row-main">
                      <span className="case-no">{cases.length + 1}</span>
                      <span className="grow muted">New case (not saved yet)</span>
                    </span>
                  </li>
                )}
              </ol>

              <div className="case-editor card card-pad">
                {draft ? (
                  <form
                    className="stack"
                    onSubmit={(e) => {
                      e.preventDefault();
                      void saveCase();
                    }}
                  >
                    <div className="row-wrap">
                      <TextField label="Name" value={draft.name} onChange={(v) => setDraft({ ...draft, name: v })} fieldClassName="grow" autoComplete="off" maxLength={meta?.limits.maxTestCaseNameChars} placeholder="e.g. Minimum size" />
                      <Checkbox className="case-flag" checked={draft.isSample} onChange={(v) => setDraft({ ...draft, isSample: v })} label="Sample" hint="Shown to “Run”" />
                      <Checkbox className="case-flag" checked={draft.verified} onChange={(v) => setDraft({ ...draft, verified: v })} label="Verified" hint="Output confirmed" />
                    </div>
                    <div className="case-io">
                      <Field label="Input (stdin)" error={stdinError}>
                        {(a) => <textarea {...a} className="input textarea mono" rows={8} spellCheck={false} value={draft.stdin} onChange={(e) => setIo({ stdin: e.target.value })} />}
                      </Field>
                      <Field label="Expected output (stdout)" error={expectedError}>
                        {(a) => (
                          <textarea {...a} className="input textarea mono" rows={8} spellCheck={false} value={draft.expectedStdout} onChange={(e) => setIo({ expectedStdout: e.target.value })} />
                        )}
                      </Field>
                    </div>
                    {base && (draft.stdin !== base.stdin || draft.expectedStdout !== base.expectedStdout) && base.verified && !draft.verified && (
                      <p className="field-hint">
                        The input or expected output changed, so “Verified” was cleared. Verify against the reference solution again, or tick it yourself if you have confirmed the new output.
                      </p>
                    )}
                    {selectedVerify && !dirty && (
                      <div className="verify-detail">
                        {selectedVerify.ok && selectedVerify.matches && (
                          <Callout tone="ok" title="The reference solution produces exactly this output" />
                        )}
                        {selectedVerify.ok && !selectedVerify.matches && (
                          <>
                            <Callout tone="danger" title="The reference solution produces a different output">
                              Either the stored expected output is wrong, or the solution is. Decide which before trusting this case.
                            </Callout>
                            <DiffView expected={draft.expectedStdout} actual={selectedVerify.actualStdout} mode={item.problem?.compare} leftLabel="Stored expected output" rightLabel="Reference solution output" variant="before-after" />
                          </>
                        )}
                        {!selectedVerify.ok && (
                          <Callout tone="warn" title={`The reference solution did not finish on this input: ${VERDICT_LABEL[selectedVerify.verdict]}`}>
                            {selectedVerify.stderr ? <pre className="code-block code-block-wrap">{selectedVerify.stderr}</pre> : 'No error output was captured.'}
                          </Callout>
                        )}
                      </div>
                    )}
                    {caseError != null && <ErrorCallout error={caseError} title="Could not save the case" />}
                    <div className="form-actions">
                      <Button type="submit" variant="primary" icon={<Save size={14} />} busy={busy} disabled={!dirty || !!stdinError || !!expectedError}>
                        {selectedId === NEW ? 'Add case' : 'Save case'}
                      </Button>
                      {dirty && selected && (
                        <Button variant="ghost" onClick={() => load(draftOf(selected))} disabled={busy}>
                          Revert
                        </Button>
                      )}
                      <span className="spacer" />
                      <Button variant="ghost" icon={<Trash2 size={14} />} onClick={() => void deleteCase()} disabled={busy}>
                        {selectedId === NEW ? 'Cancel' : 'Delete'}
                      </Button>
                    </div>
                  </form>
                ) : (
                  <p className="muted">Select a case to edit it.</p>
                )}
              </div>
            </div>
          )}

          <section className="section" aria-labelledby="solution-title">
            <div className="section-head">
              <h2 id="solution-title" className="section-title">
                Reference solution
              </h2>
              <span className="muted">A known-correct program. Running it is how expected outputs are verified. It is never shown while solving.</span>
            </div>
            <div className="card solution-card">
              <div className="editor-toolbar">
                <label htmlFor="solution-language" className="sr-only">
                  Language of the reference solution
                </label>
                <select
                  id="solution-language"
                  className="input input-sm select solve-language"
                  value={solution.language}
                  onChange={(e) => setSolution({ ...solution, language: e.target.value })}
                >
                  {Array.from(new Set([...languageOptions, solution.language])).map((l) => (
                    <option key={l} value={l}>
                      {languageLabel(l, meta?.judge.languages)}
                    </option>
                  ))}
                </select>
                <span className="spacer" />
                {solutionDirty && solutionBase && (
                  <Button size="sm" variant="ghost" onClick={() => setSolution(solutionBase)} disabled={solutionBusy}>
                    Revert
                  </Button>
                )}
                <Button size="sm" variant={solutionDirty ? 'primary' : 'default'} icon={<Save size={13} />} onClick={() => void saveSolution()} busy={solutionBusy} disabled={!solutionDirty}>
                  Save solution
                </Button>
              </div>
              <div className="solution-editor">
                <CodeEditor
                  key={solution.language}
                  value={solution.source}
                  onChange={(v) => setSolution({ ...solution, source: v })}
                  language={solution.language}
                  ariaLabel="Reference solution"
                  placeholder="Paste or write a correct solution that reads stdin and writes stdout."
                />
              </div>
            </div>
            {solutionError != null && <ErrorCallout error={solutionError} title="Could not save the solution" onRetry={() => void saveSolution()} />}
            {solutionConflict && (
              <Callout
                tone="warn"
                role="alert"
                title="The reference solution was changed elsewhere"
                actions={
                  <>
                    <Button
                      size="sm"
                      onClick={() => {
                        const theirs = solutionConflict.problem?.referenceSolution ?? null;
                        setSolutionBase(theirs);
                        setSolution(theirs ?? { ...solution, source: '' });
                        setSolutionConflict(null);
                      }}
                    >
                      Load their version
                    </Button>
                    <Button size="sm" onClick={() => void saveSolution(solutionConflict.revision, true)}>
                      Keep mine and save
                    </Button>
                  </>
                }
              >
                Another tab, or an assistant connected over MCP, saved a different solution while you were editing. Yours is still in the editor and nothing was overwritten.
              </Callout>
            )}

            <div className="verify-bar">
              <Button icon={<ShieldCheck size={14} />} onClick={() => void runVerify(false)} busy={verifying} disabled={!canVerify}>
                Verify against reference solution
              </Button>
              <span className="muted">
                {!judgeOn ? (
                  <>
                    Needs a judge engine to run the solution. <Link to="/settings#judge">Judge status</Link>
                  </>
                ) : solutionBase === null ? (
                  'Save a reference solution first.'
                ) : solutionDirty ? (
                  'Save the solution to verify with it.'
                ) : cases.length === 0 ? (
                  'Add test cases first.'
                ) : verifying ? (
                  'Running the solution on every case…'
                ) : (
                  'Runs the solution on every case and compares its output with the stored expected output.'
                )}
              </span>
            </div>
            {verifyError != null && <ErrorCallout error={verifyError} title="Verification could not run" onRetry={() => void runVerify(false)} />}
            {verify && results.length > 0 && (
              <Callout
                tone={mismatched + failed === 0 ? 'ok' : 'warn'}
                role="status"
                title={
                  mismatched + failed === 0
                    ? `All ${plural(matched, 'case')} match the reference solution and are marked verified`
                    : `${matched} of ${results.length} match · ${mismatched} differ · ${failed} failed to run`
                }
                actions={
                  mismatched > 0 ? (
                    <Button
                      size="sm"
                      disabled={verifying}
                      onClick={async () => {
                        const ok = await confirm({
                          title: `Replace the expected output of ${plural(mismatched, 'case')}?`,
                          body: 'The stored expected output is replaced by what the reference solution prints, and those cases are marked verified. Do this only if you trust the solution.',
                          confirmLabel: 'Use the solution’s output',
                        });
                        if (ok) void runVerify(true);
                      }}
                    >
                      Use the solution’s output for the {plural(mismatched, 'differing case')}
                    </Button>
                  ) : undefined
                }
              >
                {mismatched + failed > 0 && 'Open a marked case in the list above to compare the two outputs or see the error.'}
              </Callout>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
