package storetest

import (
	"context"
	"errors"
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
		return store.Session{ID: id, UserID: user, CreatedAt: now, ExpiresAt: expires}
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
	Write(t, db, func(tx store.Tx) error { return tx.ExtendSession("a", later.Add(time.Hour)) })
	if s := Read(t, db, func(tx store.Tx) (store.Session, error) { return tx.GetSession("a") }); !s.ExpiresAt.Equal(later.Add(time.Hour)) {
		t.Errorf("extended: %+v", s)
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
