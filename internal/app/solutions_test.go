package app_test

import (
	"fmt"
	"testing"
	"time"

	"codeatrophy/internal/app"
	"codeatrophy/internal/domain"
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
