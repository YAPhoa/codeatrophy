import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, ArrowDown, ArrowUp, Check, CircleSlash, Eye, EyeOff, FlaskConical, Plus, Save, ShieldCheck, Trash2, X } from 'lucide-react';
import { api, isApiError } from '../../api/client';
import { qk, useItem, useLimits, useMeta, usePreferences, useSolutions, useTestCases } from '../../api/queries';
import type { Item, Solution, TestCase, VerifyResult } from '../../api/types';
import { useDocumentTitle } from '../../app/useDocumentTitle';
import { ORIGIN_LABEL, VERDICT_LABEL, formatBytes, plural } from '../../lib/format';
import { byteLength } from '../../lib/itemForm';
import { languageLabel } from '../../lib/languages';
import { textFilename } from '../../lib/largeText';
import { moveIndex } from '../../lib/tree';
import { useUrlMirror } from '../../lib/urlState';
import { Button, IconButton, LinkButton, cx } from '../../ui/Button';
import { useConfirm } from '../../ui/Dialog';
import { useLeaveGuard } from '../../ui/LeaveGuard';
import { DiffView } from '../../ui/DiffView';
import { Checkbox, TextField } from '../../ui/Field';
import { TestDataField } from '../../ui/LargeText';
import { Badge, Callout, EmptyState, ErrorCallout, ErrorState, PageLoading } from '../../ui/misc';
import { useToast } from '../../ui/Toast';
import { ItemBar } from '../item/ItemBar';
import { ItemMissing } from '../item/ItemPage';
import { WriteProblems } from '../solutions/parts';
import { useSolutionWrite } from '../solutions/solutionWrites';

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

/** Why a test case's input or output cannot be saved, or `null`. */
const sizeProblem = (text: string | undefined, limit: number | undefined): string | null =>
  text !== undefined && limit !== undefined && byteLength(text) > limit ? `Larger than ${formatBytes(limit)}.` : null;

/** How a solution is referred to in the results of a verification run with it. */
const solutionPhrase = (s: Pick<Solution, 'name' | 'isReference'>): string => (s.isReference ? 'the reference solution' : `“${s.name}”`);
const capitalize = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);

/** Manage a problem's test cases, and verify their expected outputs by running a saved solution. */
function TestsManager({ item }: { item: Item }) {
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const meta = useMeta().data;
  const casesQuery = useTestCases(item.id);
  const cases = useMemo(() => casesQuery.data ?? [], [casesQuery.data]);
  const casesLoaded = casesQuery.data !== undefined;
  const judgeOn = meta?.judge.enabled ?? false;

  // The selected case is in the address (`?case=…`, left out for the first
  // one), so a link can point at a case. The address only follows the
  // selection: a change to it from outside is not taken up, since the editor
  // may hold edits to the case that is open.
  const [searchParams] = useSearchParams();
  const [selectedId, setSelectedId] = useState<string | null>(() => searchParams.get('case'));
  const linked = useRef(selectedId);
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
  // The solution the results in `verify` came from.
  const [verifiedBy, setVerifiedBy] = useState<Solution | null>(null);
  // The solution being run on every case, while it runs.
  const [verifying, setVerifying] = useState<Solution | null>(null);
  const [verifyError, setVerifyError] = useState<unknown>(null);

  const selected = selectedId && selectedId !== NEW ? (cases.find((c) => c.id === selectedId) ?? null) : null;

  // With "hide test cases" on, the content of non-sample cases stays out of
  // the page until the user asks for it; asking once reveals everything for
  // this visit. Sample cases are part of the statement, and cases added
  // during the visit were typed by the user, so neither is concealed.
  const hideCases = usePreferences().hideTestCases;
  const [revealed, setRevealed] = useState(false);
  const [added, setAdded] = useState<ReadonlySet<string>>(new Set());
  const concealing = hideCases && !revealed && cases.some((c) => !c.isSample && !added.has(c.id));
  const selectedConcealed = concealing && selected !== null && !selected.isSample && !added.has(selected.id);
  const editorRef = useRef<HTMLDivElement>(null);
  const reveal = () => {
    setRevealed(true);
    // The button that was pressed is about to go; hand the focus to what replaces it.
    requestAnimationFrame(() => editorRef.current?.focus());
  };

  // Select the first case once loaded, and follow the selection when the list changes.
  useEffect(() => {
    if (selectedId === NEW || !casesLoaded) return;
    const current = selectedId ? cases.find((c) => c.id === selectedId) : undefined;
    if (current) {
      // The case named by the link is selected, but not yet in the editor.
      if (linked.current === selectedId) load(draftOf(current));
      linked.current = null;
      return;
    }
    linked.current = null;
    const first = cases[0];
    setSelectedId(first?.id ?? null);
    load(first ? draftOf(first) : null);
  }, [cases, casesLoaded, selectedId]);
  useUrlMirror('case', selectedId && selectedId !== NEW && selectedId !== cases[0]?.id ? selectedId : null, () => undefined);

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
  const leaveGuard = useLeaveGuard({ when: dirty, body: selectedId === NEW ? 'The new test case has not been saved.' : 'Your changes to this test case have not been saved.' });

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
  // Measured once per change, not on every render: test data can run to megabytes.
  const stdin = draft?.stdin;
  const expected = draft?.expectedStdout;
  const stdinError = useMemo(() => sizeProblem(stdin, dataLimit), [stdin, dataLimit]);
  const expectedError = useMemo(() => sizeProblem(expected, dataLimit), [expected, dataLimit]);
  const maxCases = meta?.limits.maxTestCasesPerItem;
  const atCaseLimit = maxCases !== undefined && cases.length >= maxCases;

  const saveCase = async () => {
    if (!draft || stdinError || expectedError) return;
    setBusy(true);
    setCaseError(null);
    try {
      if (selectedId === NEW) {
        const created = await api.testCases.create(item.id, { ...draft, origin: 'manual' });
        setAdded((prev) => new Set(prev).add(created.id));
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

  // ---- Solutions: the reference, and the one to verify against ----
  const limits = useLimits();
  const solutionsQuery = useSolutions(item.id);
  const solutions = useMemo(() => solutionsQuery.data ?? [], [solutionsQuery.data]);
  const reference = solutions.find((s) => s.isReference) ?? null;
  // Any other solution can be run on the cases as a check. Until one is chosen it is the first.
  const others = useMemo(() => solutions.filter((s) => !s.isReference), [solutions]);
  const [pickedId, setPickedId] = useState<string | null>(null);
  const other = others.find((s) => s.id === pickedId) ?? others[0] ?? null;
  const referenceWrite = useSolutionWrite(item);

  // Which solution is the reference is part of the problem's content, so the
  // change is checked against the item's revision.
  const makeReference = (solution: Solution) =>
    referenceWrite.run({
      write: (expectedRevision) => api.solutions.update(solution.id, { isReference: true, ...(expectedRevision !== undefined ? { expectedRevision } : {}) }),
      checked: true,
      done: () => {
        // Results of a check with it were not a verification; run it again as the reference.
        setVerify(null);
        setVerifiedBy(null);
        toast.success(`“${solution.name}” is now the reference solution`);
      },
    });

  // ---- Verification ----
  //
  // Only a run of the reference solution changes anything: it marks the cases
  // it reproduces as verified, clears the mark on those it does not, and can
  // replace differing expected outputs. A run of any other solution is a
  // check that reports results and leaves the cases as they are.
  const runVerify = async (by: Solution | null, updateExpected = false) => {
    if (!by || verifying) return;
    if (updateExpected && !by.isReference) return;
    setVerifying(by);
    setVerifyError(null);
    try {
      // The reference solution is asked for as such (no id), so the run is a
      // reference run whatever was changed elsewhere in the meantime.
      const res = await api.testCases.verify(item.id, updateExpected, by.isReference ? null : by.id);
      setVerify(new Map(res.results.map((r) => [r.testCaseId, r])));
      setVerifiedBy(by);
      if (by.isReference) {
        // Verified marks were set and cleared, and outputs possibly replaced.
        await Promise.all([refresh(), qc.invalidateQueries({ queryKey: qk.solutions(item.id) })]);
        if (updateExpected) toast.success('Expected outputs updated from the reference solution');
      }
    } catch (e) {
      setVerify(null);
      setVerifiedBy(by);
      setVerifyError(e);
    } finally {
      setVerifying(null);
    }
  };

  // When the stored case changes underneath the editor (a verification that
  // sets or clears "verified", or rewrites the expected output), take over
  // the new state — field by field, so that what the user has edited and not
  // yet saved is kept and only the untouched fields follow the stored case.
  useEffect(() => {
    if (!selected || !base || !draft) return;
    const stored = draftOf(selected);
    if (sameDraft(stored, base)) return;
    setBase(stored);
    setDraft({
      name: draft.name === base.name ? stored.name : draft.name,
      stdin: draft.stdin === base.stdin ? stored.stdin : draft.stdin,
      expectedStdout: draft.expectedStdout === base.expectedStdout ? stored.expectedStdout : draft.expectedStdout,
      isSample: draft.isSample === base.isSample ? stored.isSample : draft.isSample,
      verified: draft.verified === base.verified ? stored.verified : draft.verified,
    });
  }, [selected, base, draft]);

  const results = verify ? cases.map((c) => verify.get(c.id)).filter((r): r is VerifyResult => !!r) : [];
  const mismatched = results.filter((r) => r.ok && !r.matches).length;
  const failed = results.filter((r) => !r.ok).length;
  const matched = results.filter((r) => r.ok && r.matches).length;
  const selectedVerify = selected && verify ? verify.get(selected.id) : undefined;
  // Why "Verify all" cannot run, or `null` when it can.
  const verifyBlocked = !judgeOn ? 'Needs a judge engine' : !reference ? 'Needs a reference solution' : cases.length === 0 ? 'No test cases yet' : null;
  const canCheck = judgeOn && cases.length > 0;
  // The solution the shown results came from, as it was when it ran: only a
  // run of the reference solution marks cases and may replace their outputs.
  const ranWith = verifiedBy;
  const who = ranWith ? solutionPhrase(ranWith) : 'the solution';
  const referenceRun = ranWith?.isReference ?? false;

  const replaceable = mismatched > 0 && referenceRun && reference !== null && reference.id === ranWith?.id;
  // After a run of the reference solution, the cases it did not reproduce or
  // failed on can go in one step — unless none matched, which points at the
  // solution rather than the cases. A case the engine could not run is left.
  const discardable =
    referenceRun && reference !== null && reference.id === ranWith?.id && matched > 0
      ? results.filter((r) => (r.ok && !r.matches) || (!r.ok && r.verdict !== 'internal_error')).map((r) => r.testCaseId)
      : [];
  const [discarding, setDiscarding] = useState(false);
  const discardFailed = async () => {
    const n = discardable.length;
    const ok = await confirm({
      title: `Delete ${plural(n, 'test case')}?`,
      body: `${n === 1 ? 'It does' : 'They do'} not match the reference solution, or it fails on ${n === 1 ? 'it' : 'them'}.`,
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!ok) return;
    setDiscarding(true);
    try {
      for (const id of discardable) await api.testCases.remove(id);
      toast.success(`Deleted ${plural(n, 'test case')}`);
    } catch (e) {
      toast.error(e);
    } finally {
      setVerify((v) => {
        if (!v) return v;
        const next = new Map(v);
        for (const id of discardable) next.delete(id);
        return next;
      });
      await refresh();
      setDiscarding(false);
    }
  };

  // What the last run found, shown by the button that started it.
  const outcome = (
    <>
      {verifyError != null && <ErrorCallout error={verifyError} title="Verification could not run" onRetry={() => void runVerify(ranWith?.isReference ? reference : ranWith)} />}
      {verify && results.length > 0 && (
        <Callout
          tone={mismatched + failed === 0 ? 'ok' : 'warn'}
          role="status"
          title={
            mismatched + failed === 0
              ? referenceRun
                ? `All ${plural(matched, 'case')} match the reference solution and are marked verified`
                : `${capitalize(who)} reproduces the expected output of all ${plural(matched, 'case')}`
              : `${matched} of ${results.length} match · ${mismatched} differ · ${failed} failed to run`
          }
          actions={
            replaceable || discardable.length > 0 ? (
              <>
                {/* Only the reference solution's output can become the expected output. */}
                {replaceable && (
                  <Button
                    size="sm"
                    disabled={verifying !== null}
                    onClick={async () => {
                      const ok = await confirm({
                        title: `Replace the expected output of ${plural(mismatched, 'case')}?`,
                        body: 'The stored expected output is replaced by what the reference solution prints, and those cases are marked verified. Do this only if you trust the solution.',
                        confirmLabel: 'Use the solution’s output',
                      });
                      if (ok) void runVerify(reference, true);
                    }}
                  >
                    Use the solution’s output for the {plural(mismatched, 'differing case')}
                  </Button>
                )}
                {discardable.length > 0 && (
                  <Button size="sm" icon={<Trash2 size={13} />} onClick={() => void discardFailed()} busy={discarding} disabled={verifying !== null}>
                    Discard {discardable.length} failed
                  </Button>
                )}
              </>
            ) : undefined
          }
        >
          {!referenceRun && ranWith && 'A check only: marks and expected outputs are unchanged. '}
          {referenceRun && mismatched + failed > 0 && 'Cases that differ or failed are no longer marked verified. '}
          {mismatched + failed > 0 && 'Open a marked case to see why.'}
        </Callout>
      )}
    </>
  );

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
            {concealing && (
              <Button icon={<Eye size={14} />} onClick={reveal} title="Show the inputs and expected outputs of hidden cases">
                Show test cases
              </Button>
            )}
            <Button
              icon={<ShieldCheck size={14} />}
              onClick={() => void runVerify(reference)}
              busy={verifying?.isReference === true}
              disabled={verifyBlocked !== null || verifying !== null}
              title={verifyBlocked ?? 'Run the reference solution on every case'}
            >
              Verify all
            </Button>
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

          {(ranWith === null || ranWith.isReference) && (verifyError != null || results.length > 0) && <div className="tests-outcome">{outcome}</div>}

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
                  // A name can give a case away as much as its input, so a concealed case goes by its number.
                  const name = concealing && !c.isSample && !added.has(c.id) ? '' : c.name;
                  return (
                    <li key={c.id} className={cx('case-row', selectedId === c.id && 'is-selected')}>
                      <button type="button" className="case-row-main" onClick={() => void select(c.id)} aria-current={selectedId === c.id || undefined}>
                        <span className="case-no">{i + 1}</span>
                        <span className="grow truncate">{name || <span className="muted">{name === c.name ? 'Unnamed' : 'Hidden case'}</span>}</span>
                        {c.isSample && <Badge tone="accent">sample</Badge>}
                        {c.origin !== 'manual' && <Badge>{ORIGIN_LABEL[c.origin]}</Badge>}
                        {v ? (
                          v.ok && v.matches ? (
                            <Badge tone="ok" title={`${capitalize(who)} produces this expected output`}>
                              <Check size={11} /> matches
                            </Badge>
                          ) : v.ok ? (
                            <Badge tone="danger" title={`${capitalize(who)} produces a different output`}>
                              <AlertTriangle size={11} /> differs
                            </Badge>
                          ) : (
                            <Badge tone="warn" title={VERDICT_LABEL[v.verdict]}>
                              <X size={11} /> failed
                            </Badge>
                          )
                        ) : c.verified ? (
                          <Badge tone="ok" title="Expected output confirmed, by running the reference solution or by hand">
                            <ShieldCheck size={11} /> verified
                          </Badge>
                        ) : (
                          <Badge title="Expected output has not been confirmed by execution">unverified</Badge>
                        )}
                      </button>
                      <IconButton size="sm" label={`Move ${name || `case ${i + 1}`} up`} icon={<ArrowUp size={13} />} disabled={i === 0} onClick={() => void move(i, -1)} />
                      <IconButton size="sm" label={`Move ${name || `case ${i + 1}`} down`} icon={<ArrowDown size={13} />} disabled={i === cases.length - 1} onClick={() => void move(i, 1)} />
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

              <div className="case-editor card card-pad" ref={editorRef} tabIndex={-1} role="group" aria-label="Selected test case">
                {selectedConcealed ? (
                  <div className="case-concealed">
                    <EyeOff size={20} className="case-concealed-icon" aria-hidden="true" />
                    <h3 className="case-concealed-title">The content of this case is hidden</h3>
                    <p className="muted">
                      Inputs and expected outputs of hidden test cases are kept out of sight so that managing them does not give the problem away. Sample cases stay visible, and you can add a case
                      without showing the others.
                    </p>
                    <div className="case-concealed-actions">
                      <Button icon={<Eye size={14} />} onClick={reveal}>
                        Show test cases
                      </Button>
                      <Link to="/settings/preferences">Turn this off in Settings</Link>
                    </div>
                  </div>
                ) : draft ? (
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
                      <TestDataField
                        label="Input (stdin)"
                        rows={8}
                        value={draft.stdin}
                        onChange={(stdin) => setIo({ stdin })}
                        error={stdinError}
                        filename={textFilename(item.title, draft.name || 'case', 'input')}
                      />
                      <TestDataField
                        label="Expected output (stdout)"
                        rows={8}
                        value={draft.expectedStdout}
                        onChange={(expectedStdout) => setIo({ expectedStdout })}
                        error={expectedError}
                        filename={textFilename(item.title, draft.name || 'case', 'output')}
                      />
                    </div>
                    {base && (draft.stdin !== base.stdin || draft.expectedStdout !== base.expectedStdout) && base.verified && !draft.verified && (
                      <p className="field-hint">
                        The input or expected output changed, so “Verified” was cleared. Verify the cases again, or tick it yourself if you have confirmed the new output.
                      </p>
                    )}
                    {selectedVerify && !dirty && (
                      <div className="verify-detail">
                        {selectedVerify.ok && selectedVerify.matches && (
                          <Callout tone="ok" title={`${capitalize(who)} produces exactly this output`} />
                        )}
                        {selectedVerify.ok && !selectedVerify.matches && (
                          <>
                            <Callout tone="danger" title={`${capitalize(who)} produces a different output`}>
                              Either the stored expected output is wrong, or the solution is. Decide which before trusting this case.
                            </Callout>
                            <DiffView expected={draft.expectedStdout} actual={selectedVerify.actualStdout} mode={item.problem?.compare} downloadName={`${item.title} ${draft.name}`} leftLabel="Stored expected output" rightLabel={ranWith && !ranWith.isReference ? `Output of “${ranWith.name}”` : 'Reference solution output'} variant="before-after" />
                          </>
                        )}
                        {!selectedVerify.ok && (
                          <Callout tone="warn" title={`${capitalize(who)} did not finish on this input: ${VERDICT_LABEL[selectedVerify.verdict]}`}>
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
                Verification
              </h2>
            </div>
            {solutionsQuery.isPending ? (
              <PageLoading />
            ) : solutionsQuery.isError ? (
              <ErrorState compact error={solutionsQuery.error} onRetry={() => void solutionsQuery.refetch()} />
            ) : solutions.length === 0 ? (
              <div className="card">
                <EmptyState
                  compact
                  icon={<ShieldCheck size={18} />}
                  title="No saved solutions yet"
                  actions={
                    <LinkButton to={`/items/${item.id}/solutions?add`} icon={<Plus size={14} />}>
                      Add a solution
                    </LinkButton>
                  }
                >
                  Verifying runs a reference solution on every case. Save one on the Solutions page and mark it as the reference.
                </EmptyState>
              </div>
            ) : (
              <div className="card verify-panel">
                <div className="verify-panel-row">
                  <span className="verify-panel-label">Reference solution</span>
                  {reference ? (
                    <span className="verify-panel-value">
                      <strong>{reference.name}</strong> <span className="muted">{languageLabel(reference.language, meta?.judge.languages)}</span>
                    </span>
                  ) : (
                    <span className="verify-panel-value muted">None chosen</span>
                  )}
                  <Link to={`/items/${item.id}/solutions`} className="nowrap">
                    {reference ? 'Edit on the Solutions page' : 'Open the Solutions page'}
                  </Link>
                </div>
                {other && (
                  <div className="verify-panel-row">
                    <label htmlFor="verify-solution" className="verify-panel-label">
                      Check another
                    </label>
                    <select
                      name="solution"
                      id="verify-solution"
                      className="input select verify-select"
                      value={other.id}
                      onChange={(e) => {
                        setPickedId(e.target.value);
                        // Results belong to the solution that produced them.
                        if (!referenceRun) {
                          setVerify(null);
                          setVerifiedBy(null);
                          setVerifyError(null);
                        }
                      }}
                      disabled={verifying !== null}
                    >
                      {others.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.name} · {languageLabel(s.language, meta?.judge.languages)}
                        </option>
                      ))}
                    </select>
                    <Button onClick={() => void runVerify(other)} busy={verifying?.id === other.id} disabled={!canCheck || verifying !== null} title={!judgeOn ? 'Needs a judge engine' : undefined}>
                      Check
                    </Button>
                    <Button onClick={() => void makeReference(other)} busy={referenceWrite.busy} disabled={verifying !== null}>
                      Use as reference
                    </Button>
                  </div>
                )}
                <p className="verify-panel-note muted">
                  {!judgeOn ? (
                    <>
                      Needs a judge engine. <Link to="/settings/judge">Judge status</Link>
                    </>
                  ) : verifying ? (
                    `Running ${solutionPhrase(verifying)} on every case…`
                  ) : other ? (
                    'A check runs another solution on every case and changes nothing.'
                  ) : (
                    '“Verify all” runs the reference solution on every case and marks those it reproduces.'
                  )}
                </p>
              </div>
            )}
            <WriteProblems write={referenceWrite} limits={limits} title="Could not change the reference solution" consequence="Saving anyway makes the chosen solution the reference." />
            {ranWith !== null && !ranWith.isReference && outcome}
          </section>
        </div>
      </div>
      {leaveGuard.dialog}
    </div>
  );
}
