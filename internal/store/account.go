package store

import "context"

// Personal data belongs to an account: an item's status, favorite and
// notes, working copies, submissions, drafts, AI jobs, the AI log and
// preferences. The library itself (items, test cases, solutions,
// collections, tags, AI providers, style presets) is shared by every
// account.
//
// The account "" (Unowned) holds what is kept while no account exists,
// which is how sign-in off starts out; the first account created takes it
// over (ClaimUnowned).
//
// Items carry the personal state of the account in the transaction's
// context (WithAccount): item reads fill status, favorite and notes for
// that account, and item writes store them for it, as does the last verdict
// and the submission counts of Stats. Other personal records carry their
// account in a UserID field instead, which the caller sets and checks, so
// that background work can reach them whoever owns them.

// Unowned is the account of the personal data kept while no account
// exists.
const Unowned = ""

type accountKey struct{}

// WithAccount returns ctx with the account whose personal state item reads
// and writes under it use.
func WithAccount(ctx context.Context, userID string) context.Context {
	return context.WithValue(ctx, accountKey{}, userID)
}

// AccountOf is the account ctx carries, Unowned when it carries none.
func AccountOf(ctx context.Context) string {
	id, _ := ctx.Value(accountKey{}).(string)
	return id
}

// PersonalTables are the tables whose rows belong to an account, in their
// user_id column.
var PersonalTables = []string{"item_states", "working_copies", "submissions", "drafts", "ai_jobs", "ai_log"}

// PreferencesKey is the setting that holds an account's preferences.
func PreferencesKey(userID string) string {
	if userID == Unowned {
		return "preferences"
	}
	return "preferences:" + userID
}
