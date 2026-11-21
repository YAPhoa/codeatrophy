package app

import (
	"context"
	"fmt"
	"slices"

	"codeatrophy/internal/domain"
	"codeatrophy/internal/store"
)

// problemItem loads an item and checks that it is a problem.
func problemItem(tx store.Tx, id string) (domain.Item, error) {
	it, err := tx.GetItem(id)
	if err != nil {
		return it, notFoundAs(err, "item")
	}
	if it.Type != domain.TypeProblem {
		return it, errField("type", "readings have no test cases")
	}
	return it, nil
}

// ListTestCases lists a problem's test cases in order.
func (a *App) ListTestCases(ctx context.Context, itemID string) (List[domain.TestCase], error) {
	var out List[domain.TestCase]
	err := a.store.Read(ctx, func(tx store.Tx) error {
		if _, err := problemItem(tx, itemID); err != nil {
			return err
		}
		cases, err := tx.ListTestCases(itemID)
		out.Items = cases
		return err
	})
	return out, err
}

// checkProblem checks that an item exists and is a problem, before any
// work is done for it outside the write transaction.
func (a *App) checkProblem(ctx context.Context, itemID string) error {
	return a.store.Read(ctx, func(tx store.Tx) error {
		_, err := problemItem(tx, itemID)
		return err
	})
}

func (a *App) buildCases(itemID string, inputs []domain.TestCaseInput, start int) ([]domain.TestCase, error) {
	now := a.clock()
	fe := domain.FieldErrors{}
	cases := make([]domain.TestCase, 0, len(inputs))
	for i, in := range inputs {
		tc, tfe := domain.NewTestCaseFromInput(in)
		tfe.Merge("", a.validateCase(&tc))
		fe.Merge(fmt.Sprintf("cases.%d.", i), tfe)
		tc.ID, tc.ItemID, tc.Position, tc.CreatedAt, tc.UpdatedAt = newID(), itemID, start+i, now, now
		cases = append(cases, tc)
	}
	return cases, errValidation(fe)
}

// AddTestCase appends a test case to a problem. A case given a generator
// and no stdin gets what the generator prints; one given both is stored as
// given (see generatedInputs).
func (a *App) AddTestCase(ctx context.Context, itemID string, in domain.TestCaseInput) (domain.TestCase, error) {
	var out domain.TestCase
	field := func(int) string { return "generator" }
	var generated []bool
	if needsRun(in) {
		if err := a.checkProblem(ctx, itemID); err != nil {
			return out, err
		}
		inputs := []domain.TestCaseInput{in}
		var err error
		if generated, err = a.generatedInputs(ctx, inputs, field); err != nil {
			return out, err
		}
		in = inputs[0]
	}
	err := a.store.Write(ctx, func(tx store.Tx) error {
		it, err := problemItem(tx, itemID)
		if err != nil {
			return err
		}
		existing, err := tx.ListTestCases(itemID)
		if err != nil {
			return err
		}
		if len(existing) >= domain.MaxTestCasesPerItem {
			return errField("testCases", fmt.Sprintf("a problem can have at most %d test cases", domain.MaxTestCasesPerItem))
		}
		cases, err := a.buildCases(itemID, []domain.TestCaseInput{in}, len(existing))
		if err != nil {
			if ae, ok := err.(*Error); ok {
				// Report single-case field names without the list prefix.
				fields := map[string]any{}
				for k, v := range ae.Fields {
					fields[trimPrefix(k, "cases.0.")] = v
				}
				ae.Fields = fields
			}
			return err
		}
		if err := generatedRepeats(existing, cases, generated, field); err != nil {
			return err
		}
		out = cases[0]
		if err := tx.InsertTestCase(&out); err != nil {
			return err
		}
		return a.testCasesChanged(tx, &it)
	})
	return out, err
}

func trimPrefix(s, p string) string {
	if len(s) >= len(p) && s[:len(p)] == p {
		return s[len(p):]
	}
	return s
}

// BulkTestCasesInput appends or replaces test cases, optionally setting the
// reference solution in the same transaction. Replacing keeps the sample
// cases: they are part of the statement, and the new cases follow them.
type BulkTestCasesInput struct {
	Cases             []domain.TestCaseInput      `json:"cases"`
	Replace           bool                        `json:"replace"`
	ReferenceSolution domain.Opt[domain.Solution] `json:"referenceSolution"`
	ExpectedRevision  domain.Opt[int]             `json:"expectedRevision"`
}

// BulkTestCases appends (or replaces) test cases. The cases given a
// generator and no stdin get what their generator prints; they all run
// before anything is stored, and if one fails nothing is. A case given both
// is stored as given.
func (a *App) BulkTestCases(ctx context.Context, itemID string, in BulkTestCasesInput) (List[domain.TestCase], error) {
	if in.ReferenceSolution.HasValue() {
		if err := errValidation(prefixed("referenceSolution.", domain.ValidateSolution(in.ReferenceSolution.Val, a.limits))); err != nil {
			return List[domain.TestCase]{}, err
		}
	}
	field := func(i int) string { return fmt.Sprintf("cases.%d.generator", i) }
	var generated []bool
	if slices.ContainsFunc(in.Cases, needsRun) {
		if err := a.checkProblem(ctx, itemID); err != nil {
			return List[domain.TestCase]{}, err
		}
		if len(in.Cases) > domain.MaxTestCasesPerItem {
			return List[domain.TestCase]{}, errField("cases", fmt.Sprintf("a problem can have at most %d test cases", domain.MaxTestCasesPerItem))
		}
		cases := append([]domain.TestCaseInput(nil), in.Cases...)
		var err error
		if generated, err = a.generatedInputs(ctx, cases, field); err != nil {
			return List[domain.TestCase]{}, err
		}
		in.Cases = cases
	}
	var out List[domain.TestCase]
	err := a.store.Write(ctx, func(tx store.Tx) error {
		it, err := problemItem(tx, itemID)
		if err != nil {
			return err
		}
		if err := checkRevision(in.ExpectedRevision, &it); err != nil {
			return err
		}
		existing, err := tx.ListTestCases(itemID)
		if err != nil {
			return err
		}
		start := len(existing)
		var samples []string
		if in.Replace {
			for _, c := range existing {
				if c.IsSample {
					samples = append(samples, c.ID)
				}
			}
			start = len(samples)
		}
		if start+len(in.Cases) > domain.MaxTestCasesPerItem {
			return errField("cases", fmt.Sprintf("a problem can have at most %d test cases", domain.MaxTestCasesPerItem))
		}
		cases, err := a.buildCases(itemID, in.Cases, start)
		if err != nil {
			return err
		}
		kept := existing
		if in.Replace {
			kept = slices.DeleteFunc(slices.Clone(existing), func(c domain.TestCase) bool { return !c.IsSample })
		}
		if err := generatedRepeats(kept, cases, generated, field); err != nil {
			return err
		}
		if in.Replace {
			for _, c := range existing {
				if c.IsSample {
					continue
				}
				if err := tx.DeleteTestCase(c.ID); err != nil {
					return err
				}
			}
			if err := tx.SetTestCasePositions(itemID, samples); err != nil {
				return err
			}
		}
		for i := range cases {
			if err := tx.InsertTestCase(&cases[i]); err != nil {
				return err
			}
		}
		if in.ReferenceSolution.HasValue() {
			// The reference solution is item content: storing a different
			// one increases the revision.
			next := it.Clone()
			s := in.ReferenceSolution.Val
			s.Source = domain.NormalizeText(s.Source)
			next.Problem.ReferenceSolution = &s
			if err := a.saveItem(tx, &it, &next); err != nil {
				return err
			}
			it = next
		}
		if len(cases) > 0 || (in.Replace && len(existing) > len(samples)) {
			if err := a.testCasesChanged(tx, &it); err != nil {
				return err
			}
		}
		out.Items, err = tx.ListTestCases(itemID)
		return err
	})
	return out, err
}

func prefixed(p string, fe domain.FieldErrors) domain.FieldErrors {
	out := domain.FieldErrors{}
	out.Merge(p, fe)
	return out
}

// UpdateTestCase applies a partial update to one test case. A non-null
// generator runs, and what it prints replaces stdin; null drops the
// generator and keeps stdin; a new stdin given without a generator drops
// the generator too.
func (a *App) UpdateTestCase(ctx context.Context, id string, in domain.TestCaseInput) (domain.TestCase, error) {
	var out domain.TestCase
	if in.Generator.HasValue() && in.Stdin.Set {
		return out, errField("generator", "give either stdin or a generator, not both: the server sets stdin to what the generator prints")
	}
	field := func(int) string { return "generator" }
	var generated []bool
	if in.Generator.HasValue() {
		err := a.store.Read(ctx, func(tx store.Tx) error {
			tc, err := tx.GetTestCase(id)
			if err != nil {
				return notFoundAs(err, "test case")
			}
			_, err = problemItem(tx, tc.ItemID)
			return err
		})
		if err != nil {
			return out, err
		}
		inputs := []domain.TestCaseInput{in}
		if generated, err = a.generatedInputs(ctx, inputs, field); err != nil {
			return out, err
		}
		in = inputs[0]
	}
	err := a.store.Write(ctx, func(tx store.Tx) error {
		tc, err := tx.GetTestCase(id)
		if err != nil {
			return notFoundAs(err, "test case")
		}
		it, err := problemItem(tx, tc.ItemID)
		if err != nil {
			return err
		}
		before := tc
		fe := domain.ApplyTestCaseInput(&tc, in)
		fe.Merge("", a.validateCase(&tc))
		if err := errValidation(fe); err != nil {
			return err
		}
		if len(generated) > 0 {
			others, err := tx.ListTestCases(tc.ItemID)
			if err != nil {
				return err
			}
			if err := generatedRepeats(others, []domain.TestCase{tc}, generated, field); err != nil {
				return err
			}
		}
		if domain.TestCaseEqual(&tc, &before) {
			out = tc
			return nil
		}
		tc.UpdatedAt = a.clock()
		if err := tx.UpdateTestCase(&tc); err != nil {
			return err
		}
		out = tc
		return a.testCasesChanged(tx, &it)
	})
	return out, err
}

// DeleteTestCase deletes one test case and renumbers the rest.
func (a *App) DeleteTestCase(ctx context.Context, id string) error {
	return a.store.Write(ctx, func(tx store.Tx) error {
		tc, err := tx.GetTestCase(id)
		if err != nil {
			return notFoundAs(err, "test case")
		}
		it, err := tx.GetItem(tc.ItemID)
		if err != nil {
			return err
		}
		if err := tx.DeleteTestCase(id); err != nil {
			return err
		}
		rest, err := tx.ListTestCases(tc.ItemID)
		if err != nil {
			return err
		}
		ids := make([]string, len(rest))
		for i, c := range rest {
			ids[i] = c.ID
		}
		if err := tx.SetTestCasePositions(tc.ItemID, ids); err != nil {
			return err
		}
		return a.testCasesChanged(tx, &it)
	})
}

// ReorderTestCases sets the order of a problem's test cases. ids must be
// exactly the item's case ids.
func (a *App) ReorderTestCases(ctx context.Context, itemID string, ids []string) (List[domain.TestCase], error) {
	var out List[domain.TestCase]
	err := a.store.Write(ctx, func(tx store.Tx) error {
		it, err := problemItem(tx, itemID)
		if err != nil {
			return err
		}
		cur, err := tx.ListTestCases(itemID)
		if err != nil {
			return err
		}
		want := map[string]bool{}
		for _, c := range cur {
			want[c.ID] = true
		}
		seen := map[string]bool{}
		for _, id := range ids {
			if !want[id] || seen[id] {
				return errField("ids", "must list each of the item's test case ids exactly once")
			}
			seen[id] = true
		}
		if len(seen) != len(want) {
			return errField("ids", "must list each of the item's test case ids exactly once")
		}
		changed := false
		for i, c := range cur {
			if c.ID != ids[i] {
				changed = true
			}
		}
		if changed {
			if err := tx.SetTestCasePositions(itemID, ids); err != nil {
				return err
			}
			if err := a.testCasesChanged(tx, &it); err != nil {
				return err
			}
		}
		out.Items, err = tx.ListTestCases(itemID)
		return err
	})
	return out, err
}
