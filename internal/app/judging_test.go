package app_test

import (
	"context"
	"errors"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"codeatrophy/internal/app"
	"codeatrophy/internal/domain"
	"codeatrophy/internal/judge"
	"codeatrophy/internal/judge/judgetest"
	"codeatrophy/internal/store"
	"codeatrophy/internal/store/teststore"
)

func (e *env) submit(t *testing.T, itemID, js string) domain.Submission {
	t.Helper()
	sub := must(e.app.CreateSubmission(e.ctx, itemID, decodeInto[app.SubmissionInput](t, js)))
	if sub.Status != domain.SubmissionQueued {
		t.Fatalf("new submission status %s", sub.Status)
	}
	ctx, cancel := context.WithTimeout(e.ctx, 10*time.Second)
	defer cancel()
	done, err := e.app.WaitSubmission(ctx, sub.ID)
	if err != nil {
		t.Fatal(err)
	}
	return done
}

// solution returns one of an item's solutions.
func (e *env) solution(t *testing.T, itemID, id string) domain.ItemSolution {
	t.Helper()
	for _, s := range must(e.app.ListSolutions(e.ctx, itemID)).Items {
		if s.ID == id {
			return s
		}
	}
	t.Fatalf("no solution %s", id)
	return domain.ItemSolution{}
}

func TestSubmissionsAndStatusSideEffects(t *testing.T) {
	e := newEnv(t)
	it := e.problem(t, "")

	run := e.submit(t, it.ID, `{"language":"python","source":"sum","mode":"run"}`)
	if *run.Verdict != domain.VerdictAccepted || run.TotalCount != 1 || run.PassedCount != 1 || len(run.Results) != 1 ||
		run.FinishedAt == nil || run.TimeMs == nil {
		t.Errorf("sample run: %+v", run)
	}
	if got := must(e.app.GetItem(e.ctx, it.ID)); got.Status != domain.StatusInProgress || got.LastVerdict != nil {
		t.Errorf("after run: status %s lastVerdict %v", got.Status, got.LastVerdict)
	}
	wrong := e.submit(t, it.ID, `{"language":"python","source":"print 3","mode":"submit"}`)
	if *wrong.Verdict != domain.VerdictWrongAnswer || wrong.PassedCount != 1 || wrong.TotalCount != 2 {
		t.Errorf("submit wrong: %+v", wrong)
	}
	if got := must(e.app.GetItem(e.ctx, it.ID)); got.Status != domain.StatusInProgress || *got.LastVerdict != domain.VerdictWrongAnswer {
		t.Errorf("after wrong submit: %+v", got.ItemSummary)
	}
	ok := e.submit(t, it.ID, `{"language":"python","source":"sum","mode":"submit"}`)
	if *ok.Verdict != domain.VerdictAccepted {
		t.Errorf("submit: %+v", ok)
	}
	if got := must(e.app.GetItem(e.ctx, it.ID)); got.Status != domain.StatusDone || *got.LastVerdict != domain.VerdictAccepted {
		t.Errorf("after accepted submit: %+v", got.ItemSummary)
	}
	if got := must(e.app.GetItem(e.ctx, it.ID)); got.Revision != 1 {
		t.Errorf("status side effects must not change the revision: %d", got.Revision)
	}
	custom := e.submit(t, it.ID, `{"language":"python","source":"echo","mode":"run","stdin":"hello"}`)
	if *custom.Verdict != domain.VerdictExecuted || custom.Results[0].TestCaseID != nil || custom.Results[0].ExpectedStdout != nil ||
		custom.Results[0].Stdout != "hello" {
		t.Errorf("custom run: %+v", custom.Results)
	}
	ce := e.submit(t, it.ID, `{"language":"cpp","source":"compile_error","mode":"submit"}`)
	if *ce.Verdict != domain.VerdictCompileError || ce.CompileOutput == "" || len(ce.Results) != 0 {
		t.Errorf("compile error: %+v", ce)
	}
	page := must(e.app.ListSubmissions(e.ctx, it.ID, app.SubmissionQuery{Mode: "submit"}))
	if page.Total != 3 || page.Items[0].ID != ce.ID {
		t.Errorf("submissions newest first: %+v", page)
	}
}

func TestSubmissionValidation(t *testing.T) {
	e := newEnv(t)
	it := e.problem(t, "")
	bad := []string{
		`{"language":"cobol","source":"x"}`,
		`{"language":"python","source":"   "}`,
		`{"language":"python","source":"x","mode":"submit","stdin":"1"}`,
		`{"language":"python","source":"x","mode":"walk"}`,
	}
	for _, js := range bad {
		_, err := e.app.CreateSubmission(e.ctx, it.ID, decodeInto[app.SubmissionInput](t, js))
		wantCode(t, err, app.CodeValidation)
	}
	big := `{"language":"python","source":"` + strings.Repeat("x", 70000) + `"}`
	_, err := e.app.CreateSubmission(e.ctx, it.ID, decodeInto[app.SubmissionInput](t, big))
	wantCode(t, err, app.CodeValidation)
	// A language the engine does not offer.
	_, err = e.app.CreateSubmission(e.ctx, it.ID, decodeInto[app.SubmissionInput](t, `{"language":"rust","source":"x"}`))
	wantCode(t, err, app.CodeValidation)
	empty := must(e.app.CreateItem(e.ctx, input(t, `{"type":"problem","title":"empty"}`)))
	_, err = e.app.CreateSubmission(e.ctx, empty.ID, decodeInto[app.SubmissionInput](t, `{"language":"python","source":"x"}`))
	wantCode(t, err, app.CodeValidation)
	reading := must(e.app.CreateItem(e.ctx, input(t, `{"type":"reading","title":"r"}`)))
	_, err = e.app.CreateSubmission(e.ctx, reading.ID, decodeInto[app.SubmissionInput](t, `{"language":"python","source":"x"}`))
	wantCode(t, err, app.CodeValidation)

	// A configured but unreachable engine still accepts the submission; it
	// completes as an internal error.
	e.engine.SetHealth(errors.New("down"))
	if st := e.app.RefreshJudgeStatus(e.ctx); st.Healthy {
		t.Error("refresh should see the engine down")
	}
	down := e.submit(t, it.ID, `{"language":"python","source":"x","mode":"submit"}`)
	if *down.Verdict != domain.VerdictInternalError || down.Error == nil || down.TotalCount != 2 {
		t.Errorf("unreachable engine: %+v", down)
	}
	e.engine.SetHealth(nil)

	noJudge := newEnv(t, withoutEngine())
	p := noJudge.problem(t, "")
	_, err = noJudge.app.CreateSubmission(noJudge.ctx, p.ID, decodeInto[app.SubmissionInput](t, `{"language":"python","source":"x"}`))
	wantCode(t, err, app.CodeJudgeUnavailable)
	if st := noJudge.app.JudgeStatus(); st.Enabled || st.Healthy || st.Engine != "none" || len(st.Languages) != 0 {
		t.Errorf("judge status without engine: %+v", st)
	}
}

func TestInterruptedSubmissionsAreFinishedOnStart(t *testing.T) {
	db := teststore.Open(t)
	now := time.Now().UTC().Truncate(time.Second)
	err := db.Write(context.Background(), func(tx store.Tx) error {
		it := domain.Item{ItemSummary: domain.ItemSummary{ID: "i", Type: domain.TypeProblem, Title: "t", Status: domain.StatusTodo,
			Revision: 1, CreatedAt: now, UpdatedAt: now}, Problem: domain.DefaultProblemSpec()}
		if err := tx.InsertItem(&it); err != nil {
			return err
		}
		for _, st := range []domain.SubmissionStatus{domain.SubmissionQueued, domain.SubmissionRunning} {
			s := domain.Submission{ID: string(st), ItemID: "i", Mode: domain.ModeRun, Language: "python", Source: "x",
				Status: st, TotalCount: 1, CreatedAt: now}
			if err := tx.InsertSubmission(&s); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	a := app.New(app.Options{Store: db})
	if err := a.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	defer a.Stop()
	for _, id := range []string{"queued", "running"} {
		s := must(a.GetSubmission(context.Background(), id))
		if s.Status != domain.SubmissionCompleted || *s.Verdict != domain.VerdictInternalError || s.Error == nil || s.FinishedAt == nil {
			t.Errorf("%s: %+v", id, s)
		}
	}
}

func TestVerifyTestCases(t *testing.T) {
	e := newEnv(t)
	it := e.problem(t, `,"problem":{"referenceSolution":{"language":"python","source":"sum"}}`)
	// Make the second case wrong.
	cases := must(e.app.ListTestCases(e.ctx, it.ID)).Items
	must(e.app.UpdateTestCase(e.ctx, cases[1].ID, decodeInto[domain.TestCaseInput](t, `{"expectedStdout":"11"}`)))

	res := must(e.app.VerifyTestCases(e.ctx, it.ID, false, ""))
	if len(res.Results) != 2 || !res.Results[0].OK || !res.Results[0].Matches || res.Results[1].Matches || res.Results[1].ActualStdout != "10\n" ||
		res.Results[0].Verdict != domain.VerdictExecuted {
		t.Fatalf("verify: %+v", res.Results)
	}
	after := must(e.app.ListTestCases(e.ctx, it.ID)).Items
	if !after[0].Verified || after[1].Verified || after[1].ExpectedStdout != "11" {
		t.Errorf("without updateExpected: %+v", after)
	}
	must(e.app.VerifyTestCases(e.ctx, it.ID, true, ""))
	after = must(e.app.ListTestCases(e.ctx, it.ID)).Items
	if !after[1].Verified || after[1].ExpectedStdout != "10\n" {
		t.Errorf("with updateExpected: %+v", after[1])
	}
	// A failing reference solution reports why and leaves the cases
	// unverified; their expected output is kept.
	must(e.app.UpdateItem(e.ctx, it.ID, input(t, `{"problem":{"referenceSolution":{"language":"python","source":"crash"}}}`)))
	res = must(e.app.VerifyTestCases(e.ctx, it.ID, true, ""))
	if res.Results[0].OK || res.Results[0].Verdict != domain.VerdictRuntimeError || res.Results[0].Stderr == "" {
		t.Errorf("crashing solution: %+v", res.Results[0])
	}
	after = must(e.app.ListTestCases(e.ctx, it.ID)).Items
	if after[0].Verified || after[1].Verified || after[1].ExpectedStdout != "10\n" {
		t.Errorf("after a failing reference: %+v", after)
	}
	noRef := e.problem(t, "")
	_, err := e.app.VerifyTestCases(e.ctx, noRef.ID, false, "")
	wantCode(t, err, app.CodeValidation)
	noJudge := newEnv(t, withoutEngine())
	p := noJudge.problem(t, `,"problem":{"referenceSolution":{"language":"python","source":"sum"}}`)
	_, err = noJudge.app.VerifyTestCases(noJudge.ctx, p.ID, false, "")
	wantCode(t, err, app.CodeJudgeUnavailable)
}

// Verification with updateExpected leaves alone a case the engine failed
// on, which says nothing about it, and a case edited while it ran.
func TestVerifyLeavesCasesItCannotVouchFor(t *testing.T) {
	e := newEnv(t)
	it := e.problem(t, `,"problem":{"referenceSolution":{"language":"python","source":"sum"}}`)
	must(e.app.VerifyTestCases(e.ctx, it.ID, false, ""))
	cases := must(e.app.ListTestCases(e.ctx, it.ID)).Items
	if !cases[0].Verified || !cases[1].Verified {
		t.Fatalf("setup: %+v", cases)
	}
	e.engine.Handler = func(_ context.Context, req judge.ExecRequest) (judge.ExecResult, error) {
		if req.Stdin == "5 5" {
			return judge.ExecResult{}, errors.New("connection reset")
		}
		return judgetest.Script(req), nil
	}
	res := must(e.app.VerifyTestCases(e.ctx, it.ID, true, ""))
	if res.Results[1].OK || res.Results[1].Verdict != domain.VerdictInternalError {
		t.Fatalf("engine failure: %+v", res.Results[1])
	}
	if got := must(e.app.ListTestCases(e.ctx, it.ID)).Items[1]; !got.Verified || got.ExpectedStdout != "10" {
		t.Errorf("the case the engine failed on: %+v", got)
	}

	// Both cases are wrong; one is edited while the solution runs.
	for _, c := range cases {
		must(e.app.UpdateTestCase(e.ctx, c.ID, decodeInto[domain.TestCaseInput](t, `{"expectedStdout":"wrong"}`)))
	}
	var once sync.Once
	edit := decodeInto[domain.TestCaseInput](t, `{"expectedStdout":"edited"}`)
	e.engine.Handler = func(_ context.Context, req judge.ExecRequest) (judge.ExecResult, error) {
		once.Do(func() { must(e.app.UpdateTestCase(e.ctx, cases[1].ID, edit)) })
		return judgetest.Script(req), nil
	}
	must(e.app.VerifyTestCases(e.ctx, it.ID, true, ""))
	after := must(e.app.ListTestCases(e.ctx, it.ID)).Items
	if !after[0].Verified || after[0].ExpectedStdout != "3\n" {
		t.Errorf("the untouched case was not fixed: %+v", after[0])
	}
	if after[1].Verified || after[1].ExpectedStdout != "edited" {
		t.Errorf("the edit made while it ran was overwritten: %+v", after[1])
	}
}

// An internal error reported by the engine (Judge0's status 13) is an
// engine failure, not the reference solution failing: the case keeps its
// verified flag, and when every case meets it nothing changes at all.
func TestVerifyTreatsEngineInternalErrorAsEngineFailure(t *testing.T) {
	e := newEnv(t)
	it := e.problem(t, `,"problem":{"referenceSolution":{"language":"python","source":"sum"}}`)
	must(e.app.VerifyTestCases(e.ctx, it.ID, false, ""))
	cases := must(e.app.ListTestCases(e.ctx, it.ID)).Items
	if !cases[0].Verified || !cases[1].Verified {
		t.Fatalf("setup: %+v", cases)
	}
	internalError := judge.ExecResult{Status: judge.StatusInternalError, Message: "cgroup setup failed"}

	// One case meets it: that case keeps its flag, the other is verified as usual.
	e.engine.Handler = func(_ context.Context, req judge.ExecRequest) (judge.ExecResult, error) {
		if req.Stdin == "5 5" {
			return internalError, nil
		}
		return judgetest.Script(req), nil
	}
	before := must(e.app.GetItem(e.ctx, it.ID))
	res := must(e.app.VerifyTestCases(e.ctx, it.ID, true, ""))
	if r := res.Results[1]; r.OK || r.Verdict != domain.VerdictInternalError || !strings.Contains(r.Stderr, "cgroup setup failed") {
		t.Fatalf("internal error result: %+v", r)
	}
	after := must(e.app.ListTestCases(e.ctx, it.ID)).Items
	if !after[0].Verified || !after[1].Verified || after[1].ExpectedStdout != "10" || !after[1].UpdatedAt.Equal(cases[1].UpdatedAt) {
		t.Errorf("a case the engine failed on lost its flag: %+v", after[1])
	}
	if got := must(e.app.GetItem(e.ctx, it.ID)); !got.UpdatedAt.Equal(before.UpdatedAt) {
		t.Error("nothing changed, yet the item's updatedAt moved")
	}

	// Every case meets it: reported as the engine being unavailable, and
	// nothing changes.
	e.engine.Handler = func(context.Context, judge.ExecRequest) (judge.ExecResult, error) {
		return internalError, nil
	}
	_, err := e.app.VerifyTestCases(e.ctx, it.ID, true, "")
	wantCode(t, err, app.CodeJudgeUnavailable)
	after = must(e.app.ListTestCases(e.ctx, it.ID)).Items
	if !after[0].Verified || !after[1].Verified {
		t.Errorf("an engine failing on every case cleared verified: %+v", after)
	}
	if got := must(e.app.GetItem(e.ctx, it.ID)); !got.UpdatedAt.Equal(before.UpdatedAt) {
		t.Error("an engine failing on every case moved the item's updatedAt")
	}
}

func TestSubmissionTotalCountIsFixedAtCreation(t *testing.T) {
	e := newEnv(t) // two workers
	it := e.problem(t, "")
	release := make(chan struct{})
	e.engine.Handler = func(ctx context.Context, req judge.ExecRequest) (judge.ExecResult, error) {
		<-release
		return judgetest.Script(req), nil
	}
	create := func() domain.Submission {
		return must(e.app.CreateSubmission(e.ctx, it.ID, decodeInto[app.SubmissionInput](t, `{"language":"python","source":"sum","mode":"submit"}`)))
	}
	// Occupy both workers so the next submission stays queued.
	create()
	create()
	waitFor(t, "both workers to run", func() bool { return e.engine.Calls() >= 2 })
	sub := create()
	if sub.TotalCount != 2 || sub.PassedCount != 0 {
		t.Errorf("queued submission: %+v", sub)
	}
	// A case deleted before it runs is reported, not silently dropped.
	cases := must(e.app.ListTestCases(e.ctx, it.ID)).Items
	if err := e.app.DeleteTestCase(e.ctx, cases[1].ID); err != nil {
		t.Fatal(err)
	}
	if got := must(e.app.GetSubmission(e.ctx, sub.ID)); got.TotalCount != 2 || got.Status != domain.SubmissionQueued {
		t.Errorf("while queued: %+v", got)
	}
	close(release)
	ctx, cancel := context.WithTimeout(e.ctx, 5*time.Second)
	defer cancel()
	done := must(e.app.WaitSubmission(ctx, sub.ID))
	if done.TotalCount != 2 || done.PassedCount != 1 || *done.Verdict != domain.VerdictInternalError || len(done.Results) != 2 ||
		done.Results[1].Verdict != domain.VerdictInternalError || done.Error == nil {
		t.Errorf("after deletion: %+v", done)
	}
	e.engine.Handler = nil
	custom := e.submit(t, it.ID, `{"language":"python","source":"echo","mode":"run","stdin":"x"}`)
	if custom.TotalCount != 1 || custom.PassedCount != 1 {
		t.Errorf("custom run counts: %+v", custom)
	}
	ce := e.submit(t, it.ID, `{"language":"cpp","source":"compile_error","mode":"submit"}`)
	if ce.TotalCount != 1 || ce.PassedCount != 0 || ce.TimeMs != nil || ce.MemoryKb != nil {
		t.Errorf("compile error counts: %+v", ce)
	}
}

func TestVerifyWithUnreachableEngineChangesNothing(t *testing.T) {
	e := newEnv(t)
	it := e.problem(t, `,"problem":{"referenceSolution":{"language":"python","source":"sum"}}`)
	before := must(e.app.GetItem(e.ctx, it.ID))
	e.engine.SetHealth(errors.New("down"))
	_, err := e.app.VerifyTestCases(e.ctx, it.ID, true, "")
	wantCode(t, err, app.CodeJudgeUnavailable)
	// Healthy probe but failing executions are reported the same way.
	e.engine.SetHealth(nil)
	e.app.RefreshJudgeStatus(e.ctx)
	e.engine.Handler = func(context.Context, judge.ExecRequest) (judge.ExecResult, error) {
		return judge.ExecResult{}, errors.New("connection reset")
	}
	_, err = e.app.VerifyTestCases(e.ctx, it.ID, true, "")
	wantCode(t, err, app.CodeJudgeUnavailable)
	after := must(e.app.GetItem(e.ctx, it.ID))
	cases := must(e.app.ListTestCases(e.ctx, it.ID)).Items
	if !after.UpdatedAt.Equal(before.UpdatedAt) || cases[0].Verified {
		t.Error("an unreachable engine must change nothing")
	}
}

// Verifying with the reference solution sets verified from the result; any
// other solution is a check only, and updateExpected needs the reference.
func TestVerifyWithSolutionID(t *testing.T) {
	e := newEnv(t)
	it := e.problem(t, `,"problem":{"referenceSolution":{"language":"python","source":"sum"}}`)
	must(e.app.VerifyTestCases(e.ctx, it.ID, false, ""))
	other := must(e.app.CreateSolution(e.ctx, it.ID, decodeInto[domain.ItemSolutionInput](t,
		`{"name":"Broken","language":"python","source":"crash"}`)))
	before := must(e.app.GetItem(e.ctx, it.ID))
	res := must(e.app.VerifyTestCases(e.ctx, it.ID, false, other.ID))
	if res.Results[0].OK {
		t.Errorf("the selected solution was not the one run: %+v", res.Results[0])
	}
	cases := must(e.app.ListTestCases(e.ctx, it.ID)).Items
	after := must(e.app.GetItem(e.ctx, it.ID))
	if !cases[0].Verified || !cases[1].Verified || !after.UpdatedAt.Equal(before.UpdatedAt) || after.Revision != before.Revision {
		t.Errorf("a non-reference check changed the item: %+v", cases)
	}
	_, err := e.app.VerifyTestCases(e.ctx, it.ID, true, other.ID)
	wantField(t, err, "updateExpected")
	_, err = e.app.VerifyTestCases(e.ctx, it.ID, false, "no-such-solution")
	wantField(t, err, "solutionId")
	// Passing the reference solution's id behaves like omitting it.
	sols := must(e.app.ListSolutions(e.ctx, it.ID)).Items
	must(e.app.UpdateTestCase(e.ctx, cases[0].ID, decodeInto[domain.TestCaseInput](t, `{"expectedStdout":"nope"}`)))
	must(e.app.VerifyTestCases(e.ctx, it.ID, true, sols[0].ID))
	cases = must(e.app.ListTestCases(e.ctx, it.ID)).Items
	if !sols[0].IsReference || !cases[0].Verified || cases[0].ExpectedStdout == "nope" {
		t.Errorf("verify with the reference id: %+v", cases[0])
	}
}

// Every verification records the last run of the solution that ran: the
// cases passed, the slowest case and the peak memory. A run the engine cut
// short, or of code that changed while it ran, leaves it as it was, and a
// run changes neither the solution's updatedAt nor the item's revision.
func TestVerifyRecordsLastRun(t *testing.T) {
	clock := time.Date(2026, 5, 1, 9, 0, 0, 0, time.UTC)
	e := newEnv(t, func(o *app.Options) { o.Now = func() time.Time { return clock } })
	it := e.problem(t, `,"problem":{"referenceSolution":{"language":"python","source":"sum"}}`)
	// The second case is the slower one, the first takes more memory.
	e.engine.Handler = func(_ context.Context, req judge.ExecRequest) (judge.ExecResult, error) {
		r := judgetest.Script(req)
		ms, kb := 7, 2048
		if req.Stdin == "5 5" {
			ms, kb = 12, 1024
		}
		r.TimeMs, r.MemoryKb = &ms, &kb
		return r, nil
	}
	solution := func(id string) domain.ItemSolution { t.Helper(); return e.solution(t, it.ID, id) }
	ref := must(e.app.ListSolutions(e.ctx, it.ID)).Items[0]
	if ref.LastRun != nil {
		t.Fatalf("a new solution has a last run: %+v", ref.LastRun)
	}
	clock = clock.Add(time.Hour)
	res := must(e.app.VerifyTestCases(e.ctx, it.ID, false, ""))
	if res.Results[0].MemoryKb == nil || *res.Results[0].MemoryKb != 2048 || *res.Results[1].TimeMs != 12 {
		t.Errorf("per-case figures: %+v", res.Results)
	}
	got := solution(ref.ID)
	if r := got.LastRun; r == nil || r.Passed != 2 || r.Total != 2 || *r.TimeMs != 12 || *r.MemoryKb != 2048 || !r.RanAt.Equal(clock) {
		t.Errorf("reference's last run: %+v", r)
	}
	if !got.UpdatedAt.Equal(ref.UpdatedAt) {
		t.Errorf("a run moved updatedAt: %v", got.UpdatedAt)
	}

	// Another solution: its own figures, and the reference's are kept.
	other := must(e.app.CreateSolution(e.ctx, it.ID, decodeInto[domain.ItemSolutionInput](t,
		`{"name":"Off by one","language":"python","source":"print 10"}`)))
	before := must(e.app.GetItem(e.ctx, it.ID))
	clock = clock.Add(time.Hour)
	must(e.app.VerifyTestCases(e.ctx, it.ID, false, other.ID))
	if r := solution(other.ID).LastRun; r == nil || r.Passed != 1 || r.Total != 2 || !r.RanAt.Equal(clock) {
		t.Errorf("other's last run: %+v", r)
	}
	if r := solution(ref.ID).LastRun; r == nil || r.RanAt.Equal(clock) {
		t.Errorf("checking another solution changed the reference's run: %+v", r)
	}
	if after := must(e.app.GetItem(e.ctx, it.ID)); after.Revision != before.Revision || !after.UpdatedAt.Equal(before.UpdatedAt) {
		t.Errorf("a check changed the item: revision %d, updatedAt %v", after.Revision, after.UpdatedAt)
	}
	ranAt := clock

	// An engine failure on one case cuts the run short: nothing is recorded.
	e.engine.Handler = func(_ context.Context, req judge.ExecRequest) (judge.ExecResult, error) {
		if req.Stdin == "5 5" {
			return judge.ExecResult{Status: judge.StatusInternalError, Message: "sandbox failed"}, nil
		}
		return judgetest.Script(req), nil
	}
	clock = clock.Add(time.Hour)
	res = must(e.app.VerifyTestCases(e.ctx, it.ID, false, other.ID))
	if res.Results[1].Verdict != domain.VerdictInternalError {
		t.Fatalf("engine failure: %+v", res.Results[1])
	}
	if r := solution(other.ID).LastRun; r == nil || !r.RanAt.Equal(ranAt) || r.Passed != 1 {
		t.Errorf("an engine failure replaced the last run: %+v", r)
	}

	// Code that does not build: no figures, every case failed.
	e.engine.Handler = nil
	broken := must(e.app.CreateSolution(e.ctx, it.ID, decodeInto[domain.ItemSolutionInput](t,
		`{"name":"Broken","language":"cpp","source":"compile_error"}`)))
	must(e.app.VerifyTestCases(e.ctx, it.ID, false, broken.ID))
	if r := solution(broken.ID).LastRun; r == nil || r.Passed != 0 || r.Total != 2 || r.TimeMs != nil || r.MemoryKb != nil {
		t.Errorf("compile error's last run: %+v", r)
	}

	// Code changed while it ran: the figures belong to the old code.
	var once sync.Once
	edit := decodeInto[domain.ItemSolutionInput](t, `{"source":"sum"}`)
	e.engine.Handler = func(_ context.Context, req judge.ExecRequest) (judge.ExecResult, error) {
		once.Do(func() { must(e.app.UpdateSolution(e.ctx, other.ID, edit)) })
		return judgetest.Script(req), nil
	}
	must(e.app.VerifyTestCases(e.ctx, it.ID, false, other.ID))
	if r := solution(other.ID).LastRun; r != nil {
		t.Errorf("a run of code since changed was recorded: %+v", r)
	}
}

// The last run belongs to the code: changing a solution's language or
// source clears it, by whichever route; its name, notes and reference mark
// do not.
func TestLastRunClearsWithTheCode(t *testing.T) {
	e := newEnv(t)
	it := e.problem(t, `,"problem":{"referenceSolution":{"language":"python","source":"sum"}}`)
	ref := must(e.app.ListSolutions(e.ctx, it.ID)).Items[0]
	other := must(e.app.CreateSolution(e.ctx, it.ID, decodeInto[domain.ItemSolutionInput](t,
		`{"name":"Echo","language":"python","source":"echo\n"}`)))
	ran := func(id string) bool { t.Helper(); return e.solution(t, it.ID, id).LastRun != nil }
	verify := func(id string) {
		t.Helper()
		must(e.app.VerifyTestCases(e.ctx, it.ID, false, id))
		if !ran(id) {
			t.Fatalf("%s was not recorded", id)
		}
	}
	verify(other.ID)
	for _, js := range []string{`{"name":"Echo back"}`, `{"notes":"prints its input"}`, `{"source":"echo\r\n"}`, `{"isReference":false}`} {
		if s := must(e.app.UpdateSolution(e.ctx, other.ID, decodeInto[domain.ItemSolutionInput](t, js))); s.LastRun == nil {
			t.Errorf("%s cleared the last run", js)
		}
	}
	if s := must(e.app.UpdateSolution(e.ctx, other.ID, decodeInto[domain.ItemSolutionInput](t, `{"source":"print 3"}`))); s.LastRun != nil {
		t.Error("a new source kept the last run")
	}
	verify(other.ID)
	must(e.app.UpdateSolution(e.ctx, other.ID, decodeInto[domain.ItemSolutionInput](t, `{"language":"cpp"}`)))
	if ran(other.ID) {
		t.Error("a new language kept the last run")
	}
	// The reference solution, written through the item.
	verify(ref.ID)
	must(e.app.UpdateItem(e.ctx, it.ID, input(t, `{"title":"A plus B, again"}`)))
	if !ran(ref.ID) {
		t.Error("an item edit that leaves the reference alone cleared its last run")
	}
	must(e.app.UpdateItem(e.ctx, it.ID, input(t, `{"problem":{"referenceSolution":{"language":"python","source":"echo"}}}`)))
	if ran(ref.ID) {
		t.Error("a new reference source kept the last run")
	}
}

// stats counts submit-mode submissions only, and of those the accepted.
func TestStatsCountsSubmitsOnly(t *testing.T) {
	e := newEnv(t)
	it := e.problem(t, "")
	if run := e.submit(t, it.ID, `{"language":"python","source":"sum","mode":"run"}`); *run.Verdict != domain.VerdictAccepted {
		t.Fatalf("a passing sample run: %s", *run.Verdict)
	}
	e.submit(t, it.ID, `{"language":"python","source":"sum","mode":"submit"}`)
	e.submit(t, it.ID, `{"language":"python","source":"crash","mode":"submit"}`)
	st := must(e.app.Stats(e.ctx))
	if st.Submissions.Total != 2 || st.Submissions.Accepted != 1 {
		t.Errorf("submissions: %+v", st.Submissions)
	}
}

// A run replaces the problem's earlier completed runs; submits, runs still
// being judged and other problems' runs are kept.
func TestOnlyTheLatestRunIsKept(t *testing.T) {
	e := newEnv(t)
	it := e.problem(t, "")
	other := e.problem(t, "")
	ids := func(itemID, mode string) []string {
		var out []string
		for _, s := range must(e.app.ListSubmissions(e.ctx, itemID, app.SubmissionQuery{Mode: mode})).Items {
			out = append(out, s.ID)
		}
		return out
	}
	otherRun := e.submit(t, other.ID, `{"language":"python","source":"sum","mode":"run"}`)
	first := e.submit(t, it.ID, `{"language":"python","source":"sum","mode":"submit"}`)
	e.submit(t, it.ID, `{"language":"python","source":"sum","mode":"run"}`)
	custom := e.submit(t, it.ID, `{"language":"python","source":"echo","mode":"run","stdin":"x"}`)
	second := e.submit(t, it.ID, `{"language":"python","source":"crash","mode":"submit"}`)
	if got := ids(it.ID, ""); !slices.Equal(got, []string{second.ID, custom.ID, first.ID}) {
		t.Errorf("after two runs: %v", got)
	}
	// A submit does not prune the latest run.
	if got := ids(it.ID, "run"); !slices.Equal(got, []string{custom.ID}) {
		t.Errorf("runs: %v", got)
	}
	if got := ids(other.ID, ""); !slices.Equal(got, []string{otherRun.ID}) {
		t.Errorf("another problem's runs: %v", got)
	}

	// A run still being judged is left alone; the next run removes it.
	release := make(chan struct{})
	e.engine.Handler = func(ctx context.Context, req judge.ExecRequest) (judge.ExecResult, error) {
		<-release
		return judgetest.Script(req), nil
	}
	calls := e.engine.Calls()
	pending := must(e.app.CreateSubmission(e.ctx, it.ID, decodeInto[app.SubmissionInput](t, `{"language":"python","source":"sum","mode":"run"}`)))
	waitFor(t, "the first run to start", func() bool { return e.engine.Calls() > calls })
	next := must(e.app.CreateSubmission(e.ctx, it.ID, decodeInto[app.SubmissionInput](t, `{"language":"python","source":"sum","mode":"run"}`)))
	if got := ids(it.ID, "run"); !slices.Equal(got, []string{next.ID, pending.ID}) {
		t.Errorf("with a run in progress: %v", got)
	}
	close(release)
	ctx, cancel := context.WithTimeout(e.ctx, 5*time.Second)
	defer cancel()
	for _, id := range []string{pending.ID, next.ID} {
		if _, err := e.app.WaitSubmission(ctx, id); err != nil {
			t.Fatal(err)
		}
	}
	e.engine.Handler = nil
	last := e.submit(t, it.ID, `{"language":"python","source":"sum","mode":"run"}`)
	if got := ids(it.ID, ""); !slices.Equal(got, []string{last.ID, second.ID, first.ID}) {
		t.Errorf("after the runs finished: %v", got)
	}
}
