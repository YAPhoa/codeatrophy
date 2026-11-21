package app

import (
	"context"
	"errors"

	"codeatrophy/internal/domain"
	"codeatrophy/internal/store"
)

// Working copies are the code the user is writing on a problem, one per
// language. They are personal work in progress: never content, so writing
// one leaves the item's revision and updatedAt alone, bundles do not carry
// them and MCP does not show them.

// workspaceItem checks that id names a problem.
func workspaceItem(tx store.Tx, id string) (domain.Item, error) {
	it, err := tx.GetItem(id)
	if err != nil {
		return it, notFoundAs(err, "item")
	}
	if it.Type != domain.TypeProblem {
		return it, errField("type", "readings have no working copies")
	}
	return it, nil
}

// ListWorkingCopies lists a problem's working copies, the most recently
// written first.
func (a *App) ListWorkingCopies(ctx context.Context, itemID string) (List[domain.WorkingCopy], error) {
	var out List[domain.WorkingCopy]
	err := a.store.Read(ctx, func(tx store.Tx) error {
		if _, err := workspaceItem(tx, itemID); err != nil {
			return err
		}
		ws, err := tx.ListWorkingCopies(itemID)
		out.Items = ws
		return err
	})
	return out, err
}

// PutWorkingCopy creates or replaces a problem's working copy in a
// language. The write is one upsert, so concurrent writes each leave one
// whole row and the last one wins; updatedAt is the server's time.
func (a *App) PutWorkingCopy(ctx context.Context, itemID, language string, in domain.WorkingCopyInput) (domain.WorkingCopy, error) {
	w := domain.WorkingCopy{ItemID: itemID, Language: language, Source: in.Source.Val}
	fe := domain.FieldErrors{}
	if !in.Source.HasValue() {
		fe.Add("source", "is required")
	}
	fe.Merge("", domain.ValidateWorkingCopy(&w, a.limits))
	if err := errValidation(fe); err != nil {
		return w, err
	}
	err := a.store.Write(ctx, func(tx store.Tx) error {
		w.UpdatedAt = a.clock()
		err := tx.PutWorkingCopy(&w)
		if !errors.Is(err, store.ErrNotFound) {
			return err
		}
		// Nothing was written: say whether the item is missing or a
		// reading. Writers are serialised, so this read sees what the
		// upsert saw.
		if _, err := workspaceItem(tx, itemID); err != nil {
			return err
		}
		return errNotFound("item")
	})
	return w, err
}

// DeleteWorkingCopy removes a problem's working copy in a language; there
// being none is not an error.
func (a *App) DeleteWorkingCopy(ctx context.Context, itemID, language string) error {
	if !domain.KnownLanguage(language) {
		return errField("language", "unknown language")
	}
	return a.store.Write(ctx, func(tx store.Tx) error {
		if _, err := workspaceItem(tx, itemID); err != nil {
			return err
		}
		_, err := tx.DeleteWorkingCopy(itemID, language)
		return err
	})
}
