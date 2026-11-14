package app

import (
	"context"
	"fmt"
	"time"

	"codeatrophy/internal/domain"
)

// itemCheckBounds bound the check of an unsaved problem: every test case,
// and five minutes, which stays inside the HTTP API's six-minute deadline
// for long-running requests.
var itemCheckBounds = checkBounds{maxCases: 0, timeout: 5 * time.Minute}

// ItemCheckResult is the result of checking an unsaved problem.
type ItemCheckResult struct {
	Check *DraftCheck `json:"check"`
	// Cases has one entry per test case, in order.
	Cases []CaseOutcome `json:"cases"`
}

// CheckItem runs the draft check on a problem that is not saved: its
// reference solution on all of its test cases, then the runners. problem
// and testCases are validated as for CreateItem; the other fields are
// ignored. Nothing is stored and no AI provider is involved.
func (a *App) CheckItem(ctx context.Context, in domain.ItemInput) (ItemCheckResult, error) {
	fe := domain.FieldErrors{}
	if in.Type.Set && (in.Type.Null || in.Type.Val != domain.TypeProblem) {
		fe.Add("type", "only a problem can be checked")
	}
	if !in.Problem.HasValue() {
		fe.Add("problem", "is required")
	}
	if err := errValidation(fe); err != nil {
		return ItemCheckResult{}, err
	}
	it := domain.Item{ItemSummary: domain.ItemSummary{Type: domain.TypeProblem}, Problem: domain.DefaultProblemSpec()}
	fe.Merge("", domain.ApplyItemInput(&it, domain.ItemInput{Problem: in.Problem}))
	domain.NormalizeItem(&it)
	fe.Merge("problem.", domain.ValidateProblem(it.Problem, a.limits))
	var inputs []domain.TestCaseInput
	if in.TestCases.HasValue() {
		inputs = in.TestCases.Val
	}
	if len(inputs) > domain.MaxTestCasesPerItem {
		fe.Add("testCases", fmt.Sprintf("at most %d test cases", domain.MaxTestCasesPerItem))
	}
	p := it.Problem
	d := ItemDraft{Type: domain.TypeProblem, TestCases: []DraftTestCase{}, Problem: &DraftProblem{
		Interface: p.Interface, TimeLimitMs: p.TimeLimitMs, MemoryLimitKb: p.MemoryLimitKb, Compare: p.Compare,
		StarterCode: p.StarterCode, Harness: p.Harness, ReferenceSolution: p.ReferenceSolution}}
	for i, tci := range inputs {
		tc, tfe := domain.NewTestCaseFromInput(tci)
		tfe.Merge("", domain.ValidateTestCase(&tc))
		fe.Merge(fmt.Sprintf("testCases.%d.", i), tfe)
		d.TestCases = append(d.TestCases, DraftTestCase{Name: tc.Name, Stdin: tc.Stdin, ExpectedStdout: tc.ExpectedStdout,
			IsSample: tc.IsSample})
	}
	if err := errValidation(fe); err != nil {
		return ItemCheckResult{}, err
	}
	// Without an engine or a reference solution nothing runs.
	switch {
	case a.engine == nil:
		setOutcomes(&d, "not_run", "no judge engine is configured")
	case p.ReferenceSolution == nil:
		setOutcomes(&d, "not_run", "there is no reference solution")
	}
	out := ItemCheckResult{Check: a.checkDraft(ctx, &d, itemCheckBounds, 0, nil), Cases: make([]CaseOutcome, len(d.TestCases))}
	for i, tc := range d.TestCases {
		out.Cases[i] = tc.outcome
	}
	return out, nil
}
