package app_test

import (
	"context"
	"errors"
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
	big := `{"language":"python","source":"` + string(make([]byte, 0)) + repeat("x", 70000) + `"}`
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

func repeat(s string, n int) string {
	b := make([]byte, 0, len(s)*n)
	for range n {
		b = append(b, s...)
	}
	return string(b)
}

func TestEngineFailureFinishesAsInternalError(t *testing.T) {
	e := newEnv(t)
	it := e.problem(t, "")
	e.engine.Handler = func(context.Context, judge.ExecRequest) (judge.ExecResult, error) {
		return judge.ExecResult{}, errors.New("judge0: connection refused")
	}
	sub := e.submit(t, it.ID, `{"language":"python","source":"sum","mode":"submit"}`)
	if *sub.Verdict != domain.VerdictInternalError || sub.Error == nil {
		t.Errorf("got %+v", sub)
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
	for deadline := time.Now().Add(5 * time.Second); e.engine.Calls() < 2 && time.Now().Before(deadline); {
		time.Sleep(5 * time.Millisecond)
	}
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

// stats counts accepted submit-mode submissions only.
func TestStatsCountsAcceptedSubmissionsOnly(t *testing.T) {
	e := newEnv(t)
	it := e.problem(t, "")
	if run := e.submit(t, it.ID, `{"language":"python","source":"sum","mode":"run"}`); *run.Verdict != domain.VerdictAccepted {
		t.Fatalf("a passing sample run: %s", *run.Verdict)
	}
	e.submit(t, it.ID, `{"language":"python","source":"sum","mode":"submit"}`)
	e.submit(t, it.ID, `{"language":"python","source":"crash","mode":"submit"}`)
	st := must(e.app.Stats(e.ctx))
	if st.Submissions.Total != 3 || st.Submissions.Accepted != 1 {
		t.Errorf("submissions: %+v", st.Submissions)
	}
}
