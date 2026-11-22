package main

import (
	"bytes"
	"context"
	"database/sql"
	"errors"
	"fmt"
	"log/slog"
	"path/filepath"
	"strings"
	"testing"

	"codeatrophy/internal/store"
	"codeatrophy/internal/store/dbopen"
	"codeatrophy/internal/store/postgres/pgtest"
)

func TestDBMigrateOutput(t *testing.T) {
	ctx := context.Background()
	quiet := slog.New(slog.DiscardHandler)
	latest := fmt.Sprint(store.SchemaVersion)
	targets := map[string]func(t *testing.T) dbopen.Target{
		"SQLite":     func(t *testing.T) dbopen.Target { return dbopen.Target{SQLitePath: filepath.Join(t.TempDir(), "x.db")} },
		"PostgreSQL": func(t *testing.T) dbopen.Target { return dbopen.Target{PostgresURL: pgtest.URL(t)} },
	}
	for name, newTarget := range targets {
		t.Run(name, func(t *testing.T) {
			tg := newTarget(t)
			var out bytes.Buffer
			if err := runMigrate(ctx, &out, tg, quiet); err != nil {
				t.Fatal(err)
			}
			got := out.String()
			for _, want := range []string{"schema version 0, this server's version " + latest, "Pending: ",
				"_problem_interface", "The database is at schema version " + latest} {
				if !strings.Contains(got, want) {
					t.Errorf("missing %q in:\n%s", want, got)
				}
			}
			if pg := strings.Contains(got, "no backup is taken"); pg != (name == "PostgreSQL") {
				t.Errorf("backup notice shown: %v\n%s", pg, got)
			}
			out.Reset()
			if err := runMigrate(ctx, &out, tg, quiet); err != nil || !strings.Contains(out.String(), "Nothing to do") ||
				strings.Contains(out.String(), "Pending") {
				t.Errorf("second run: %v\n%s", err, out.String())
			}
			st, err := dbopen.Inspect(ctx, tg)
			if err != nil {
				t.Fatal(err)
			}
			out.Reset()
			printStatus(&out, st, false)
			for _, want := range []string{"Schema version: " + latest, "Expected version: " + latest + " (this server)",
				"Pending migrations: none"} {
				if !strings.Contains(words(out.String()), want) {
					t.Errorf("status: missing %q in:\n%s", want, out.String())
				}
			}
		})
	}
}

func TestDBStatusOfABehindDatabase(t *testing.T) {
	st := store.Status{Backend: "SQLite", Location: "/data/x.db", Exists: true, Version: 22, Latest: 23,
		Pending: []string{"0023_later.sql"}}
	var out bytes.Buffer
	printStatus(&out, st, false)
	for _, want := range []string{"Schema version: 22 Expected", "Expected version: 23 (this server)",
		"Pending migrations: 0023_later.sql (applied by codeatrophy db migrate)"} {
		if !strings.Contains(words(out.String()), want) {
			t.Errorf("missing %q in:\n%s", want, out.String())
		}
	}
	out.Reset()
	printStatus(&out, st, true)
	if !strings.Contains(out.String(), "applied at the next start, or by codeatrophy db migrate") {
		t.Errorf("with automatic migration:\n%s", out.String())
	}
}

// A database migrated by a newer server is refused, and its status says so.
func TestDBMigrateRefusesANewerSchema(t *testing.T) {
	ctx := context.Background()
	quiet := slog.New(slog.DiscardHandler)
	tg := dbopen.Target{SQLitePath: filepath.Join(t.TempDir(), "x.db")}
	var out bytes.Buffer
	if err := runMigrate(ctx, &out, tg, quiet); err != nil {
		t.Fatal(err)
	}
	raw, err := sql.Open("sqlite", tg.SQLitePath)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := raw.ExecContext(ctx, `INSERT INTO schema_migrations (version, name, applied_at) VALUES (999, 'future', 0)`); err != nil {
		t.Fatal(err)
	}
	raw.Close()
	out.Reset()
	err = runMigrate(ctx, &out, tg, quiet)
	if !errors.Is(err, store.ErrNewerSchema) || !strings.Contains(out.String(), "schema version 999") ||
		strings.Contains(out.String(), "Applied") {
		t.Errorf("newer schema: %v\n%s", err, out.String())
	}
	st, err := dbopen.Inspect(ctx, tg)
	if err != nil {
		t.Fatal(err)
	}
	out.Reset()
	printStatus(&out, st, false)
	if !strings.Contains(words(out.String()), "Schema version: 999 (newer than this server: upgrade the server)") {
		t.Errorf("status of a newer database:\n%s", out.String())
	}
}

// A database from before 1.0.0 is refused with what to do, nothing is
// applied, and its status says so.
func TestDBMigrateRefusesAPre100Database(t *testing.T) {
	ctx := context.Background()
	quiet := slog.New(slog.DiscardHandler)
	tg := dbopen.Target{SQLitePath: filepath.Join(t.TempDir(), "x.db")}
	var out bytes.Buffer
	if err := runMigrate(ctx, &out, tg, quiet); err != nil {
		t.Fatal(err)
	}
	raw, err := sql.Open("sqlite", tg.SQLitePath)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := raw.ExecContext(ctx, `DELETE FROM schema_migrations WHERE version > 10`); err != nil {
		t.Fatal(err)
	}
	raw.Close()
	out.Reset()
	err = runMigrate(ctx, &out, tg, quiet)
	if !errors.Is(err, store.ErrOlderSchema) || !strings.Contains(out.String(), "schema version 10") ||
		strings.Contains(out.String(), "Pending") || strings.Contains(out.String(), "Applied") {
		t.Errorf("a database from before 1.0.0: %v\n%s", err, out.String())
	}
	st, err := dbopen.Inspect(ctx, tg)
	if err != nil || st.Version != 10 {
		t.Fatalf("inspect: %+v %v", st, err)
	}
	out.Reset()
	printStatus(&out, st, false)
	for _, want := range []string{"Schema version: 10 (from before Codeatrophy 1.0.0: upgrade it with 1.0.0 first)",
		"Pending migrations: none"} {
		if !strings.Contains(words(out.String()), want) {
			t.Errorf("status: missing %q in:\n%s", want, out.String())
		}
	}
}

func TestDBStatusBranches(t *testing.T) {
	var out bytes.Buffer
	printStatus(&out, store.Status{Backend: "SQLite", Location: "/data/new.db", Latest: 6,
		Pending: []string{"0001_init.sql"}}, true)
	for _, want := range []string{"Backend: SQLite", "Database: /data/new.db",
		"does not exist yet; it is created at the next start, or by codeatrophy db migrate",
		"Schema version: none (no schema yet)", "Pending migrations: 0001_init.sql (applied at the next start"} {
		if !strings.Contains(words(out.String()), want) {
			t.Errorf("missing %q in:\n%s", want, out.String())
		}
	}
	if strings.Contains(out.String(), "Rows:") {
		t.Errorf("rows without counts:\n%s", out.String())
	}
	out.Reset()
	printStatus(&out, store.Status{Backend: "PostgreSQL", Location: "postgres://db/x", Exists: true, Version: 22, Latest: 22,
		Counts: []store.TableCount{{Table: "items", Rows: 3}, {Table: "test_cases", Rows: 12}}}, false)
	got := words(out.String())
	for _, want := range []string{"Schema version: 22 Expected", "Pending migrations: none", "Rows: items 3 test_cases 12"} {
		if !strings.Contains(got, want) {
			t.Errorf("missing %q in:\n%s", want, out.String())
		}
	}
	if strings.Contains(got, "does not exist") {
		t.Errorf("an existing database:\n%s", out.String())
	}
}

// words collapses the column alignment of s.
func words(s string) string { return strings.Join(strings.Fields(s), " ") }
