package app

import (
	"context"
	"encoding/json"

	"codeatrophy/internal/domain"
	"codeatrophy/internal/store"
)

// Items record who created them and who last changed them (see
// domain.ChangeSource). The adapters say who makes a request: each puts a
// change source in the request's context with WithChangeSource, and the
// write paths here read it with changedBy. A change made without one (a
// background worker, a test) is recorded as unknown.

type changeSourceKey struct{}

// WithChangeSource returns ctx carrying who makes the changes made under
// it: the adapter (via, one of domain.ViaHTTP, ViaMCP, ViaImport) and the
// client and model the caller reported, which are sanitised here (empty
// ones are unknown).
func WithChangeSource(ctx context.Context, via, client, model string) context.Context {
	return context.WithValue(ctx, changeSourceKey{}, domain.NewChangeSource(via, client, model))
}

// changedBy is the change source ctx carries, as a copy, or nil.
func changedBy(ctx context.Context) *domain.ChangeSource {
	c, _ := ctx.Value(changeSourceKey{}).(*domain.ChangeSource)
	return c.Clone()
}

// withModel returns ctx with the model of its change source replaced by
// one the server knows (the model of its own AI work). Without a change
// source in ctx it is ctx unchanged.
func withModel(ctx context.Context, model string) context.Context {
	c := changedBy(ctx)
	if c == nil {
		return ctx
	}
	c.Model = domain.CleanSourceText(model)
	return context.WithValue(ctx, changeSourceKey{}, c)
}

// contentChanged records a change that moves the item's updatedAt: it
// moves it and records who made the change.
func (a *App) contentChanged(ctx context.Context, it *domain.Item) {
	it.UpdatedAt = a.clock()
	it.LastUpdatedBy = changedBy(ctx)
}

// draftModel is the model of a draft's latest successful generation, when
// its content was built from a generation, or "".
func draftModel(d store.Draft) string {
	if d.BasedOn <= 0 || d.Generation == nil {
		return ""
	}
	var g struct {
		Usage struct {
			Model string `json:"model"`
		} `json:"usage"`
	}
	if json.Unmarshal([]byte(*d.Generation), &g) != nil {
		return ""
	}
	return g.Usage.Model
}
