package app_test

import (
	"fmt"
	"reflect"
	"testing"
	"time"

	"codeatrophy/internal/app"
	"codeatrophy/internal/domain"
	"codeatrophy/internal/store"
)

func solIn(t *testing.T, js string) domain.ItemSolutionInput {
	return decodeInto[domain.ItemSolutionInput](t, js)
}

// Solution changes always move updatedAt; the revision moves exactly when
// the effective reference solution (language and source) changes.
func TestSolutionsReferenceAndRevision(t *testing.T) {
	clock := time.Date(2026, 5, 1, 9, 0, 0, 0, time.UTC)
	e := newEnv(t, func(o *app.Options) { o.Now = func() time.Time { return clock } })
	it := e.problem(t, "")
	step := func(want int, what string) domain.Item {
		t.Helper()
		got := must(e.app.GetItem(e.ctx, it.ID))
		if got.Revision != want || !got.UpdatedAt.Equal(clock) {
			t.Errorf("%s: revision %d (want %d), updatedAt %v (want %v)", what, got.Revision, want, got.UpdatedAt, clock)
		}
		clock = clock.Add(time.Minute)
		return got
	}
	clock = clock.Add(time.Minute)
	brute := must(e.app.CreateSolution(e.ctx, it.ID, solIn(t, `{"name":"Brute force","language":"python","source":"echo"}`)))
	step(1, "a non-reference solution")
	ref := must(e.app.CreateSolution(e.ctx, it.ID, solIn(t, `{"name":"Fast","language":"python","source":"sum","isReference":true,"expectedRevision":1}`)))
	got := step(2, "a new reference")
	if got.Problem.ReferenceSolution == nil || got.Problem.ReferenceSolution.ID != ref.ID || got.Problem.ReferenceSolution.Source != "sum" {
		t.Errorf("referenceSolution view: %+v", got.Problem.ReferenceSolution)
	}
	must(e.app.UpdateSolution(e.ctx, ref.ID, solIn(t, `{"notes":"O(1)","name":"Fast sum"}`)))
	step(2, "notes and name of the reference")
	_, err := e.app.UpdateSolution(e.ctx, ref.ID, solIn(t, `{"source":"sum ","expectedRevision":1}`))
	wantCode(t, err, app.CodeConflict)
	must(e.app.UpdateSolution(e.ctx, ref.ID, solIn(t, `{"source":"sum ","expectedRevision":2}`)))
	step(3, "the reference's source")
	// Switching the reference to an identical program is not a content change.
	must(e.app.UpdateSolution(e.ctx, brute.ID, solIn(t, `{"source":"sum "}`)))
	step(3, "a non-reference source")
	must(e.app.UpdateSolution(e.ctx, brute.ID, solIn(t, `{"isReference":true}`)))
	got = step(3, "switching to an identical program")
	if got.Problem.ReferenceSolution.ID != brute.ID {
		t.Errorf("reference is now %s", got.Problem.ReferenceSolution.ID)
	}
	sols := must(e.app.ListSolutions(e.ctx, it.ID)).Items
	if len(sols) != 2 || sols[0].ID != brute.ID || !sols[0].IsReference || sols[1].IsReference {
		t.Errorf("one reference, listed first: %+v", sols)
	}

	// problem.referenceSolution writes go to the reference solution in place.
	must(e.app.UpdateItem(e.ctx, it.ID, input(t, `{"problem":{"referenceSolution":{"language":"cpp","source":"sum"}}}`)))
	got = step(4, "writing referenceSolution")
	if s := must(e.app.ListSolutions(e.ctx, it.ID)).Items[0]; s.ID != brute.ID || s.Language != "cpp" || s.Name != "Brute force" {
		t.Errorf("updated in place: %+v", s)
	}
	// null only clears the flag.
	must(e.app.UpdateItem(e.ctx, it.ID, input(t, `{"problem":{"referenceSolution":null}}`)))
	got = step(5, "clearing referenceSolution")
	if got.Problem.ReferenceSolution != nil || len(must(e.app.ListSolutions(e.ctx, it.ID)).Items) != 2 || got.SolutionCount != 2 {
		t.Errorf("after null: %+v", got.Problem.ReferenceSolution)
	}
	// Without a reference, writing one creates "Reference solution".
	must(e.app.UpdateItem(e.ctx, it.ID, input(t, `{"problem":{"referenceSolution":{"language":"python","source":"sum"}}}`)))
	step(6, "a new reference through the item")
	sols = must(e.app.ListSolutions(e.ctx, it.ID)).Items
	if len(sols) != 3 || sols[0].Name != domain.ReferenceSolutionName || !sols[0].IsReference {
		t.Errorf("created: %+v", sols)
	}
	// Deleting the reference leaves none.
	must(struct{}{}, e.app.DeleteSolution(e.ctx, sols[0].ID))
	if got := step(7, "deleting the reference"); got.Problem.ReferenceSolution != nil {
		t.Error("no reference after deleting it")
	}
	must(struct{}{}, e.app.DeleteSolution(e.ctx, sols[1].ID))
	step(7, "deleting a non-reference solution")
}

func TestSolutionLimitsAndValidation(t *testing.T) {
	e := newEnv(t)
	it := e.problem(t, "")
	for _, js := range []string{`{"language":"python","source":"x"}`, `{"name":"a\nb","language":"python","source":"x"}`,
		`{"name":"n","language":"cobol","source":"x"}`, `{"name":"n","language":"python","source":""}`,
		fmt.Sprintf(`{"name":"%0101d","language":"python","source":"x"}`, 0)} {
		_, err := e.app.CreateSolution(e.ctx, it.ID, solIn(t, js))
		wantCode(t, err, app.CodeValidation)
	}
	for i := range domain.MaxSolutionsPerItem {
		must(e.app.CreateSolution(e.ctx, it.ID, solIn(t, fmt.Sprintf(`{"name":"s%d","language":"python","source":"x"}`, i))))
	}
	_, err := e.app.CreateSolution(e.ctx, it.ID, solIn(t, `{"name":"one more","language":"python","source":"x"}`))
	wantCode(t, err, app.CodeConflict)
	// The reference view cannot create a 51st either.
	_, err = e.app.UpdateItem(e.ctx, it.ID, input(t, `{"problem":{"referenceSolution":{"language":"python","source":"y"}}}`))
	wantCode(t, err, app.CodeConflict)
	reading := must(e.app.CreateItem(e.ctx, input(t, `{"type":"reading","title":"R"}`)))
	_, err = e.app.CreateSolution(e.ctx, reading.ID, solIn(t, `{"name":"n","language":"python","source":"x"}`))
	wantCode(t, err, app.CodeValidation)
	// Solutions go with their item.
	sol := must(e.app.ListSolutions(e.ctx, it.ID)).Items[0]
	must(struct{}{}, e.app.DeleteItem(e.ctx, it.ID))
	_, err = e.app.UpdateSolution(e.ctx, sol.ID, solIn(t, `{"name":"x"}`))
	wantCode(t, err, app.CodeNotFound)
}

// A solution saved from a submission takes the submission's figures as its
// last run, as the server stored them, but only when the submission is a
// judged run of exactly that code on this problem's test cases; otherwise
// the solution is saved without one.
func TestSolutionFromSubmissionKeepsItsFigures(t *testing.T) {
	e := newEnv(t)
	it := e.problem(t, "")
	sub := e.submit(t, it.ID, `{"language":"python","source":"sum\r\n","mode":"submit"}`)
	create := func(js string) domain.ItemSolution {
		t.Helper()
		return must(e.app.CreateSolution(e.ctx, it.ID, solIn(t, js)))
	}
	// The source matches once line endings are normalised, as every saved source is.
	s := create(fmt.Sprintf(`{"name":"Sum","language":"python","source":"sum\n","submissionId":%q}`, sub.ID))
	if r := s.LastRun; r == nil || r.Passed != 2 || r.Total != 2 || *r.TimeMs != *sub.TimeMs || *r.MemoryKb != *sub.MemoryKb ||
		!r.RanAt.Equal(*sub.FinishedAt) {
		t.Errorf("from an accepted submission: %+v", r)
	}
	if got := must(e.app.ListSolutions(e.ctx, it.ID)).Items[0]; !reflect.DeepEqual(got.LastRun, s.LastRun) {
		t.Errorf("stored: %+v", got.LastRun)
	}
	wrong := e.submit(t, it.ID, `{"language":"python","source":"print 3","mode":"submit"}`)
	if r := create(fmt.Sprintf(`{"name":"Three","language":"python","source":"print 3","submissionId":%q}`, wrong.ID)).LastRun; r == nil ||
		r.Passed != 1 || r.Total != 2 {
		t.Errorf("from a wrong answer: %+v", r)
	}
	other := e.problem(t, "")
	elsewhere := e.submit(t, other.ID, `{"language":"python","source":"sum","mode":"submit"}`)
	custom := e.submit(t, it.ID, `{"language":"python","source":"sum","mode":"run","stdin":"1 1"}`)
	if err := e.db.Write(e.ctx, func(tx store.Tx) error {
		return tx.InsertSubmission(&domain.Submission{ID: "judging", ItemID: it.ID, Mode: domain.ModeSubmit, Language: "python",
			Source: "sum", Status: domain.SubmissionRunning, TotalCount: 2, CreatedAt: time.Now()})
	}); err != nil {
		t.Fatal(err)
	}
	for what, js := range map[string]string{
		"another source":                 fmt.Sprintf(`{"name":"n","language":"python","source":"sum\nx","submissionId":%q}`, sub.ID),
		"another language":               fmt.Sprintf(`{"name":"n","language":"cpp","source":"sum\n","submissionId":%q}`, sub.ID),
		"another problem's submission":   fmt.Sprintf(`{"name":"n","language":"python","source":"sum","submissionId":%q}`, elsewhere.ID),
		"a run on custom input":          fmt.Sprintf(`{"name":"n","language":"python","source":"sum","submissionId":%q}`, custom.ID),
		"a submission still judged":      `{"name":"n","language":"python","source":"sum","submissionId":"judging"}`,
		"a submission that is not there": `{"name":"n","language":"python","source":"sum","submissionId":"nope"}`,
		"figures from the client":        `{"name":"n","language":"python","source":"sum","lastRun":{"passed":9,"total":9,"ranAt":"2026-01-01T00:00:00Z"}}`,
	} {
		if s := create(js); s.LastRun != nil {
			t.Errorf("%s: %+v", what, s.LastRun)
		}
	}
	_, err := e.app.UpdateSolution(e.ctx, s.ID, solIn(t, fmt.Sprintf(`{"submissionId":%q}`, sub.ID)))
	wantField(t, err, "submissionId")
}
