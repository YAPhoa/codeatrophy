package storetest

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"

	"codeatrophy/internal/store"
)

// Accounts and sessions: emails are unique, a user's sessions go with it,
// and the session deletions remove what they say.
func testUsersAndSessions(t *testing.T, db store.Store) {
	ctx := context.Background()
	later := now.Add(time.Hour)
	u := store.User{ID: "u1", Email: "me@example.com", PasswordHash: "$2a$hash", CreatedAt: now, UpdatedAt: now}
	other := store.User{ID: "u2", Email: "you@example.com", PasswordHash: "$2a$other", CreatedAt: now, UpdatedAt: now}
	Write(t, db, func(tx store.Tx) error {
		if err := tx.InsertUser(&u); err != nil {
			return err
		}
		return tx.InsertUser(&other)
	})
	if err := db.Write(ctx, func(tx store.Tx) error {
		return tx.InsertUser(&store.User{ID: "u3", Email: "me@example.com", PasswordHash: "x", CreatedAt: now, UpdatedAt: now})
	}); err == nil {
		t.Error("a second account with the same email was accepted")
	}
	if err := db.Write(ctx, func(tx store.Tx) error {
		return tx.InsertUser(&store.User{ID: "u4", Email: "Me@Example.com", PasswordHash: "x", CreatedAt: now, UpdatedAt: now})
	}); err == nil {
		t.Error("an email in upper case was accepted")
	}
	if n := Read(t, db, func(tx store.Tx) (int, error) { return tx.CountUsers() }); n != 2 {
		t.Errorf("%d users", n)
	}
	got := Read(t, db, func(tx store.Tx) (store.User, error) { return tx.GetUserByEmail("me@example.com") })
	if got != u {
		t.Errorf("by email: %+v", got)
	}
	if err := db.Read(ctx, func(tx store.Tx) error { _, err := tx.GetUser("nobody"); return err }); !errors.Is(err, store.ErrNotFound) {
		t.Errorf("missing user: %v", err)
	}
	if err := db.Read(ctx, func(tx store.Tx) error { _, err := tx.GetUserByEmail("nobody@example.com"); return err }); !errors.Is(err, store.ErrNotFound) {
		t.Errorf("missing email: %v", err)
	}
	Write(t, db, func(tx store.Tx) error { return tx.UpdateUserPassword("u1", "$2a$new", later) })
	got = Read(t, db, func(tx store.Tx) (store.User, error) { return tx.GetUser("u1") })
	if got.PasswordHash != "$2a$new" || !got.UpdatedAt.Equal(later) || !got.CreatedAt.Equal(now) {
		t.Errorf("after the password change: %+v", got)
	}
	if err := db.Write(ctx, func(tx store.Tx) error { return tx.UpdateUserPassword("nobody", "x", later) }); !errors.Is(err, store.ErrNotFound) {
		t.Errorf("password of nobody: %v", err)
	}
	if l := Read(t, db, func(tx store.Tx) ([]store.User, error) { return tx.ListUsers() }); len(l) != 2 || l[0].ID != "u1" || l[1].ID != "u2" {
		t.Errorf("list: %+v", l)
	}

	sess := func(id, user string, expires time.Time) store.Session {
		return store.Session{ID: id, UserID: user, CreatedAt: now, ExpiresAt: expires,
			UserAgent: "Mozilla/5.0 (" + id + ") Firefox/140.0 é", LastUsedAt: now}
	}
	Write(t, db, func(tx store.Tx) error {
		for _, s := range []store.Session{sess("a", "u1", later), sess("b", "u1", later), sess("c", "u1", now), sess("d", "u2", later)} {
			if err := tx.InsertSession(&s); err != nil {
				return err
			}
		}
		return nil
	})
	if err := db.Write(ctx, func(tx store.Tx) error { s := sess("e", "nobody", later); return tx.InsertSession(&s) }); err == nil {
		t.Error("a session of no user was accepted")
	}
	if s := Read(t, db, func(tx store.Tx) (store.Session, error) { return tx.GetSession("a") }); s != sess("a", "u1", later) {
		t.Errorf("session: %+v", s)
	}
	Write(t, db, func(tx store.Tx) error { return tx.ExtendSession("b", later, later.Add(time.Hour)) })
	if s := Read(t, db, func(tx store.Tx) (store.Session, error) { return tx.GetSession("b") }); !s.ExpiresAt.Equal(later.Add(time.Hour)) ||
		!s.LastUsedAt.Equal(later) || !s.CreatedAt.Equal(now) || s.UserAgent != sess("b", "u1", later).UserAgent {
		t.Errorf("extended: %+v", s)
	}
	// A missing User-Agent is filled in once; a recorded one stays.
	Write(t, db, func(tx store.Tx) error {
		if err := tx.InsertSession(&store.Session{ID: "blank", UserID: "u1", CreatedAt: now, ExpiresAt: later, LastUsedAt: now}); err != nil {
			return err
		}
		if err := tx.SetSessionUserAgent("blank", "first"); err != nil {
			return err
		}
		if err := tx.SetSessionUserAgent("blank", "second"); err != nil {
			return err
		}
		return tx.SetSessionUserAgent("b", "replaced")
	})
	if s := Read(t, db, func(tx store.Tx) (store.Session, error) { return tx.GetSession("blank") }); s.UserAgent != "first" {
		t.Errorf("filled in user agent = %q, want first", s.UserAgent)
	}
	if s := Read(t, db, func(tx store.Tx) (store.Session, error) { return tx.GetSession("b") }); s.UserAgent != sess("b", "u1", later).UserAgent {
		t.Errorf("recorded user agent replaced: %q", s.UserAgent)
	}
	Write(t, db, func(tx store.Tx) error { return tx.DeleteSession("blank") })
	// A user's sessions, last used first, whatever their expiry.
	listed := func(user string) (ids string) {
		for _, s := range Read(t, db, func(tx store.Tx) ([]store.Session, error) { return tx.ListUserSessions(user) }) {
			ids += s.ID
		}
		return ids
	}
	if got := listed("u1"); got != "bac" {
		t.Errorf("sessions of u1: %q", got)
	}
	if got := listed("u2"); got != "d" {
		t.Errorf("sessions of u2: %q", got)
	}
	if got := listed("nobody"); got != "" {
		t.Errorf("sessions of nobody: %q", got)
	}
	exists := func(id string) bool {
		err := db.Read(ctx, func(tx store.Tx) error { _, err := tx.GetSession(id); return err })
		if err != nil && !errors.Is(err, store.ErrNotFound) {
			t.Fatal(err)
		}
		return err == nil
	}
	Write(t, db, func(tx store.Tx) error { return tx.DeleteExpiredSessions(now.Add(time.Second)) })
	if exists("c") || !exists("a") {
		t.Error("DeleteExpiredSessions")
	}
	Write(t, db, func(tx store.Tx) error { return tx.DeleteUserSessions("u1", "a") })
	if !exists("a") || exists("b") || !exists("d") {
		t.Error("DeleteUserSessions")
	}
	Write(t, db, func(tx store.Tx) error { return tx.DeleteSession("a") })
	if exists("a") {
		t.Error("DeleteSession")
	}
	deleteUser := func(id string) (ok bool) {
		Write(t, db, func(tx store.Tx) (err error) { ok, err = tx.DeleteUser(id); return })
		return ok
	}
	if !deleteUser("u2") || exists("d") {
		t.Error("DeleteUser left its session")
	}
	if deleteUser("u2") {
		t.Error("deleted u2 twice")
	}
}

// Migration 18 adds the accounts and sessions: a database at version 17
// keeps every row, and afterwards accounts can be added.
func testAuthMigration(t *testing.T, h MigrationHarness) {
	want, db := h.rerun(t, 18, func(db MigrationDB) {
		Populate(t, db)
	}, func(db MigrationDB) {
		if err := h.Exec(db, `SELECT COUNT(*) FROM users`); err == nil {
			t.Error("version 17 has a users table")
		}
	}, Dump)
	SameDump(t, "after migration 18", want, Dump(t, db))
	Write(t, db, func(tx store.Tx) error {
		u := store.User{ID: "u", Email: "me@example.com", PasswordHash: "h", CreatedAt: now, UpdatedAt: now}
		if err := tx.InsertUser(&u); err != nil {
			return err
		}
		return tx.InsertSession(&store.Session{ID: "s", UserID: "u", CreatedAt: now, ExpiresAt: now})
	})
	h.rejects(t, db, map[string]string{
		"a session of no user": `INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES ('x', 'nobody', 0, 0)`,
	})
}

// MCP tokens belong to one user, go with it, and are deleted only by it.
func testMCPTokens(t *testing.T, db store.Store) {
	ctx := context.Background()
	Write(t, db, func(tx store.Tx) error {
		for _, id := range []string{"u1", "u2"} {
			u := store.User{ID: id, Email: id + "@example.com", PasswordHash: "h", CreatedAt: now, UpdatedAt: now}
			if err := tx.InsertUser(&u); err != nil {
				return err
			}
		}
		for i, tk := range []store.MCPToken{
			{ID: "t1", UserID: "u1", Name: "Laptop", Hint: "ab12", CreatedAt: now},
			{ID: "t2", UserID: "u1", Name: "Desktop", Hint: "cd34", CreatedAt: now.Add(time.Minute)},
			{ID: "t3", UserID: "u2", Name: "Other", Hint: "ef56", CreatedAt: now},
		} {
			if err := tx.InsertMCPToken(&tk); err != nil {
				return fmt.Errorf("token %d: %w", i, err)
			}
		}
		return nil
	})
	if err := db.Write(ctx, func(tx store.Tx) error {
		return tx.InsertMCPToken(&store.MCPToken{ID: "t4", UserID: "nobody", Name: "x", Hint: "x", CreatedAt: now})
	}); err == nil {
		t.Error("a token of no user was accepted")
	}
	if err := db.Write(ctx, func(tx store.Tx) error {
		return tx.InsertMCPToken(&store.MCPToken{ID: "t5", UserID: "u1", Name: "", Hint: "x", CreatedAt: now})
	}); err == nil {
		t.Error("a token without a name was accepted")
	}
	l := Read(t, db, func(tx store.Tx) ([]store.MCPToken, error) { return tx.ListMCPTokens("u1") })
	if len(l) != 2 || l[0].ID != "t2" || l[1].ID != "t1" || l[1].LastUsedAt != nil || l[1].Name != "Laptop" || l[1].Hint != "ab12" {
		t.Errorf("list: %+v", l)
	}
	Write(t, db, func(tx store.Tx) error { return tx.TouchMCPToken("t1", now.Add(time.Hour)) })
	if tk := Read(t, db, func(tx store.Tx) (store.MCPToken, error) { return tx.GetMCPToken("t1") }); tk.LastUsedAt == nil ||
		!tk.LastUsedAt.Equal(now.Add(time.Hour)) || !tk.CreatedAt.Equal(now) {
		t.Errorf("touched: %+v", tk)
	}
	if err := db.Read(ctx, func(tx store.Tx) error { _, err := tx.GetMCPToken("none"); return err }); !errors.Is(err, store.ErrNotFound) {
		t.Errorf("missing token: %v", err)
	}
	del := func(user, id string) (ok bool) {
		Write(t, db, func(tx store.Tx) (err error) { ok, err = tx.DeleteMCPToken(user, id); return })
		return ok
	}
	if del("u2", "t1") {
		t.Error("u2 deleted a token of u1")
	}
	if !del("u1", "t1") || del("u1", "t1") {
		t.Error("DeleteMCPToken")
	}
	Write(t, db, func(tx store.Tx) error { _, err := tx.DeleteUser("u1"); return err })
	if err := db.Read(ctx, func(tx store.Tx) error { _, err := tx.GetMCPToken("t2"); return err }); !errors.Is(err, store.ErrNotFound) {
		t.Errorf("a token outlived its user: %v", err)
	}
}

// Migration 19 adds the MCP tokens: a database at version 18 keeps every
// row, and afterwards tokens can be added.
func testMCPTokensMigration(t *testing.T, h MigrationHarness) {
	want, db := h.rerun(t, 19, func(db MigrationDB) {
		Populate(t, db)
		Write(t, db, func(tx store.Tx) error {
			u := store.User{ID: "u", Email: "me@example.com", PasswordHash: "h", CreatedAt: now, UpdatedAt: now}
			if err := tx.InsertUser(&u); err != nil {
				return err
			}
			return tx.ClaimUnowned("u")
		})
	}, func(db MigrationDB) {
		if err := h.Exec(db, `SELECT COUNT(*) FROM mcp_tokens`); err == nil {
			t.Error("version 18 has an mcp_tokens table")
		}
	}, Dump)
	SameDump(t, "after migration 19", want, Dump(t, db))
	Write(t, db, func(tx store.Tx) error {
		return tx.InsertMCPToken(&store.MCPToken{ID: "t", UserID: "u", Name: "Laptop", Hint: "ab12", CreatedAt: now})
	})
	h.rejects(t, db, map[string]string{
		"a token of no user": `INSERT INTO mcp_tokens (id, user_id, name, hint, created_at) VALUES ('x', 'nobody', 'n', 'h', 0)`,
	})
}

// Migration 22 adds a session's User-Agent and last use: sessions that
// exist keep every column, with no User-Agent and last used when they
// started, and new ones store both.
func testSessionDetailsMigration(t *testing.T, h MigrationHarness) {
	skip := map[string][]string{"sessions": {"user_agent", "last_used_at"}}
	want, db := h.rerun(t, 22, func(db MigrationDB) {
		Populate(t, db)
		Write(t, db, func(tx store.Tx) error {
			u := store.User{ID: "u", Email: "me@example.com", PasswordHash: "h", CreatedAt: now, UpdatedAt: now}
			if err := tx.InsertUser(&u); err != nil {
				return err
			}
			for i, id := range []string{"s1", "s2"} {
				at := now.Add(time.Duration(i) * time.Hour)
				s := store.Session{ID: id, UserID: "u", CreatedAt: at, ExpiresAt: at.Add(24 * time.Hour),
					UserAgent: "Firefox", LastUsedAt: at.Add(5 * time.Hour)}
				if err := tx.InsertSession(&s); err != nil {
					return err
				}
			}
			return nil
		})
	}, func(db MigrationDB) {
		if err := h.Exec(db, `SELECT user_agent FROM sessions`); err == nil {
			t.Error("version 21 has sessions.user_agent")
		}
	}, func(t *testing.T, b store.Bulk) map[string][]string { return DumpWithout(t, b, skip) })
	SameDump(t, "after migration 22", want, DumpWithout(t, db, skip))
	for i, id := range []string{"s1", "s2"} {
		s := Read(t, db, func(tx store.Tx) (store.Session, error) { return tx.GetSession(id) })
		if at := now.Add(time.Duration(i) * time.Hour); s.UserAgent != "" || !s.LastUsedAt.Equal(at) || !s.CreatedAt.Equal(at) {
			t.Errorf("%s after migrating: %+v", id, s)
		}
	}
	Write(t, db, func(tx store.Tx) error {
		return tx.InsertSession(&store.Session{ID: "s3", UserID: "u", CreatedAt: now, ExpiresAt: now,
			UserAgent: "Chrome", LastUsedAt: now.Add(time.Minute)})
	})
	if s := Read(t, db, func(tx store.Tx) (store.Session, error) { return tx.GetSession("s3") }); s.UserAgent != "Chrome" ||
		!s.LastUsedAt.Equal(now.Add(time.Minute)) {
		t.Errorf("new session: %+v", s)
	}
}
