package app

import (
	"context"
	"errors"
	"fmt"

	"codeatrophy/internal/domain"
	"codeatrophy/internal/store"
)

// ListSolutions lists a problem's saved solutions, the reference first.
func (a *App) ListSolutions(ctx context.Context, itemID string) (List[domain.ItemSolution], error) {
	var out List[domain.ItemSolution]
	err := a.store.Read(ctx, func(tx store.Tx) error {
		if _, err := problemItem(tx, itemID); err != nil {
			return err
		}
		sols, err := tx.ListSolutions(itemID)
		out.Items = sols
		return err
	})
	return out, err
}

// solutionsChanged records a change to an item's solutions made in tx. When
// the reference-solution view (language and source) changed, the revision
// increases; updatedAt moves in every case.
func (a *App) solutionsChanged(tx store.Tx, it *domain.Item, before *domain.Solution) error {
	sols, err := tx.ListSolutions(it.ID)
	if err != nil {
		return err
	}
	if !domain.RefEqual(before, domain.RefOf(sols)) {
		it.Revision++
	}
	it.UpdatedAt = a.clock()
	return tx.UpdateItem(it)
}

func refOf(it *domain.Item) *domain.Solution {
	if it.Problem == nil {
		return nil
	}
	return it.Problem.ReferenceSolution
}

// CreateSolution saves a new solution for a problem.
func (a *App) CreateSolution(ctx context.Context, itemID string, in domain.ItemSolutionInput) (domain.ItemSolution, error) {
	now := a.clock()
	s := domain.ItemSolution{ID: newID(), ItemID: itemID, CreatedAt: now, UpdatedAt: now}
	fe := domain.FieldErrors{}
	for name, o := range map[string]domain.Opt[string]{"name": in.Name, "language": in.Language, "source": in.Source} {
		if !o.HasValue() {
			fe.Add(name, "is required")
		}
	}
	fe.Merge("", domain.ApplyItemSolutionInput(&s, in))
	fe.Merge("", domain.ValidateItemSolution(&s, a.limits))
	if err := errValidation(fe); err != nil {
		return s, err
	}
	err := a.store.Write(ctx, func(tx store.Tx) error {
		it, err := problemItem(tx, itemID)
		if err != nil {
			return err
		}
		if err := checkRevision(in.ExpectedRevision, &it); err != nil {
			return err
		}
		if in.SubmissionID.HasValue() {
			if s.LastRun, err = submissionRun(tx, &s, in.SubmissionID.Val); err != nil {
				return err
			}
		}
		existing, err := tx.ListSolutions(itemID)
		if err != nil {
			return err
		}
		if len(existing) >= domain.MaxSolutionsPerItem {
			return errConflict(fmt.Sprintf("a problem can keep at most %d solutions", domain.MaxSolutionsPerItem), nil)
		}
		before := refOf(&it)
		if s.IsReference {
			if err := tx.ClearReference(itemID); err != nil {
				return err
			}
		}
		if err := tx.InsertSolution(&s); err != nil {
			return err
		}
		return a.solutionsChanged(tx, &it, before)
	})
	return s, err
}

// UpdateSolution applies a partial update to a saved solution.
func (a *App) UpdateSolution(ctx context.Context, id string, in domain.ItemSolutionInput) (domain.ItemSolution, error) {
	var out domain.ItemSolution
	if in.SubmissionID.HasValue() {
		return out, errField("submissionId", "only applies when creating a solution")
	}
	err := a.store.Write(ctx, func(tx store.Tx) error {
		s, err := tx.GetSolution(id)
		if err != nil {
			return notFoundAs(err, "solution")
		}
		it, err := problemItem(tx, s.ItemID)
		if err != nil {
			return err
		}
		if err := checkRevision(in.ExpectedRevision, &it); err != nil {
			return err
		}
		prev := s
		fe := domain.ApplyItemSolutionInput(&s, in)
		fe.Merge("", domain.ValidateItemSolution(&s, a.limits))
		if err := errValidation(fe); err != nil {
			return err
		}
		if s == prev {
			out = s
			return nil
		}
		before := refOf(&it)
		if s.IsReference && !prev.IsReference {
			if err := tx.ClearReference(s.ItemID); err != nil {
				return err
			}
		}
		s.UpdatedAt = a.clock()
		if err := tx.UpdateSolution(&s); err != nil {
			return err
		}
		out = s
		return a.solutionsChanged(tx, &it, before)
	})
	return out, err
}

// DeleteSolution deletes a saved solution. Deleting the reference solution
// leaves the item without one.
func (a *App) DeleteSolution(ctx context.Context, id string) error {
	return a.store.Write(ctx, func(tx store.Tx) error {
		s, err := tx.GetSolution(id)
		if err != nil {
			return notFoundAs(err, "solution")
		}
		it, err := tx.GetItem(s.ItemID)
		if err != nil {
			return err
		}
		before := refOf(&it)
		if err := tx.DeleteSolution(id); err != nil {
			return err
		}
		return a.solutionsChanged(tx, &it, before)
	})
}

// submissionRun returns the figures of a submission as the last run of a
// new solution s, or nil when the submission does not describe s's code:
// it is missing, of another item, not completed, a run on custom input,
// stopped by an engine failure, or of another language or source. The
// figures are always the server's own, never the client's.
func submissionRun(tx store.Tx, s *domain.ItemSolution, submissionID string) (*domain.SolutionRun, error) {
	sub, err := tx.GetSubmission(submissionID)
	if errors.Is(err, store.ErrNotFound) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if sub.ItemID != s.ItemID || sub.Status != domain.SubmissionCompleted || sub.FinishedAt == nil || sub.Stdin != nil ||
		sub.Verdict == nil || *sub.Verdict == domain.VerdictInternalError ||
		sub.Language != s.Language || domain.NormalizeText(sub.Source) != s.Source {
		return nil, nil
	}
	return &domain.SolutionRun{Passed: sub.PassedCount, Total: sub.TotalCount, TimeMs: sub.TimeMs, MemoryKb: sub.MemoryKb,
		RanAt: *sub.FinishedAt}, nil
}

// writeReference persists a write to the problem.referenceSolution view:
// a value updates the reference solution in place (or creates one named
// "Reference solution"); nil only clears the reference mark.
func (a *App) writeReference(tx store.Tx, itemID string, ref *domain.Solution) error {
	if ref == nil {
		return tx.ClearReference(itemID)
	}
	sols, err := tx.ListSolutions(itemID)
	if err != nil {
		return err
	}
	now := a.clock()
	for _, s := range sols {
		if s.IsReference {
			if s.Language != ref.Language || s.Source != ref.Source {
				s.LastRun = nil // the figures belong to the code that ran
			}
			s.Language, s.Source, s.UpdatedAt = ref.Language, ref.Source, now
			return tx.UpdateSolution(&s)
		}
	}
	if len(sols) >= domain.MaxSolutionsPerItem {
		return errConflict(fmt.Sprintf("a problem can keep at most %d solutions", domain.MaxSolutionsPerItem), nil)
	}
	s := domain.ItemSolution{ID: newID(), ItemID: itemID, Name: domain.ReferenceSolutionName, Language: ref.Language,
		Source: ref.Source, IsReference: true, CreatedAt: now, UpdatedAt: now}
	return tx.InsertSolution(&s)
}

// solutionFor returns the solution to run for an item: the given one, or
// the reference solution when id is empty.
// solutionFor resolves the solution a run uses: the given one, or the
// reference solution when id is empty. isRef reports whether it is the
// item's reference solution.
func solutionFor(tx store.Tx, it *domain.Item, id string) (sol domain.Solution, isRef bool, err error) {
	if id == "" {
		if ref := refOf(it); ref != nil {
			return *ref, true, nil
		}
		return domain.Solution{}, false, errField("referenceSolution", "the problem has no reference solution")
	}
	s, err := tx.GetSolution(id)
	if err != nil || s.ItemID != it.ID {
		return domain.Solution{}, false, errField("solutionId", "is not a solution of this item")
	}
	return domain.Solution{ID: s.ID, Language: s.Language, Source: s.Source}, s.IsReference, nil
}
