package app

import (
	"context"
	"time"

	"codeatrophy/internal/store"
)

// Personal data (an item's status, favorite and notes, working copies,
// submissions, drafts, AI jobs, the AI log and preferences) belongs to the
// account a request acts for; the library is shared (see store.Unowned).
// The adapters say which account that is with WithAccount: the signed-in
// account, or DefaultAccount when sign-in is off. Background work acts for
// the account that started it.

// WithAccount returns ctx acting for the account with that id.
func WithAccount(ctx context.Context, userID string) context.Context {
	return store.WithAccount(ctx, userID)
}

// accountOf is the account ctx acts for.
func accountOf(ctx context.Context) string { return store.AccountOf(ctx) }

// DefaultAccount is the account requests act for when nobody signs in
// (sign-in off, or the server-wide MCP token): the oldest account, or
// store.Unowned while there is none.
func (a *App) DefaultAccount(ctx context.Context) (string, error) {
	var users []store.User
	if err := a.store.Read(ctx, func(tx store.Tx) (err error) { users, err = tx.ListUsers(); return err }); err != nil {
		return "", err
	}
	id := store.Unowned
	var at time.Time
	for _, u := range users {
		if id == store.Unowned || u.CreatedAt.Before(at) || (u.CreatedAt.Equal(at) && u.ID < id) {
			id, at = u.ID, u.CreatedAt
		}
	}
	return id, nil
}
