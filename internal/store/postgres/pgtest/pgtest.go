// Package pgtest creates throwaway PostgreSQL databases for tests.
//
// PostgreSQL tests need a server: set CODEATROPHY_TEST_POSTGRES_URL to the
// URL of a database whose user may create databases (make test-postgres
// starts one). Each test gets a database of its own, dropped when it ends.
// Tests that need PostgreSQL skip when the variable is unset.
package pgtest

import (
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"net/url"
	"os"
	"sync"
	"testing"

	_ "github.com/jackc/pgx/v5/stdlib" // driver "pgx"
)

// EnvURL names the variable with the test server's URL.
const EnvURL = "CODEATROPHY_TEST_POSTGRES_URL"

// Available reports whether a test server is configured.
func Available() bool { return os.Getenv(EnvURL) != "" }

var admin struct {
	once sync.Once
	db   *sql.DB
	err  error
}

// URL creates an empty database on the test server and returns its
// URL. The test is skipped when no server is configured.
func URL(t testing.TB) string {
	t.Helper()
	base := os.Getenv(EnvURL)
	if base == "" {
		t.Skip("PostgreSQL tests need " + EnvURL + " (make test-postgres provides a server)")
	}
	admin.once.Do(func() {
		admin.db, admin.err = sql.Open("pgx", base)
		if admin.err == nil {
			admin.db.SetMaxOpenConns(4)
			admin.err = admin.db.Ping()
		}
	})
	if admin.err != nil {
		t.Fatalf("PostgreSQL test server: %v", admin.err)
	}
	b := make([]byte, 8)
	rand.Read(b)
	name := "codeatrophy_test_" + hex.EncodeToString(b)
	if _, err := admin.db.Exec(`CREATE DATABASE ` + name); err != nil {
		t.Fatalf("create test database: %v", err)
	}
	t.Cleanup(func() {
		if _, err := admin.db.Exec(`DROP DATABASE IF EXISTS ` + name + ` WITH (FORCE)`); err != nil {
			t.Errorf("drop test database: %v", err)
		}
	})
	u, err := url.Parse(base)
	if err != nil {
		t.Fatal(err)
	}
	u.Path = "/" + name
	return u.String()
}
