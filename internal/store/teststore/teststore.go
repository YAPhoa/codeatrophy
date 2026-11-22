// Package teststore opens throwaway databases for tests (see pgtest for
// the PostgreSQL test server).
//
// Application-level tests open their store with Open, which uses
// PostgreSQL when CODEATROPHY_TEST_POSTGRES_URL is set and SQLite otherwise.
package teststore

import (
	"context"
	"path/filepath"
	"testing"

	"codeatrophy/internal/store"
	"codeatrophy/internal/store/postgres"
	"codeatrophy/internal/store/postgres/pgtest"
	"codeatrophy/internal/store/sqlite"
)

// DB is an open database of either backend.
type DB interface {
	store.Store
	store.Bulk
}

// Postgres reports whether a PostgreSQL test server is configured.
func Postgres() bool { return pgtest.Available() }

// PostgresURL creates an empty database on the test server and returns its
// URL. The test is skipped when no server is configured.
func PostgresURL(t testing.TB) string { return pgtest.URL(t) }

// OpenPostgres opens a new PostgreSQL database, closed when the test ends.
func OpenPostgres(t testing.TB) *postgres.DB {
	t.Helper()
	db, err := postgres.Open(context.Background(), PostgresURL(t), postgres.Options{})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	return db
}

// OpenSQLite opens a new SQLite database, closed when the test ends.
func OpenSQLite(t testing.TB) *sqlite.DB {
	t.Helper()
	db, err := sqlite.Open(context.Background(), filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	return db
}

// Open opens a new database of the backend under test: PostgreSQL when a
// test server is configured, SQLite otherwise.
func Open(t testing.TB) store.Store {
	t.Helper()
	if Postgres() {
		return OpenPostgres(t)
	}
	return OpenSQLite(t)
}
