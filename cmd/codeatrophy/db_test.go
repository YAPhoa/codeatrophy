package main

import (
	"bytes"
	"context"
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
	st := store.Status{Backend: "SQLite", Location: "/data/x.db", Exists: true, Version: 5, Latest: 6,
		Pending: []string{"0006_problem_interface.sql"}}
	var out bytes.Buffer
	printStatus(&out, st, false)
	for _, want := range []string{"Schema version: 5", "Expected version: 6 (this server)",
		"Pending migrations: 0006_problem_interface.sql (applied by codeatrophy db migrate)"} {
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

// words collapses the column alignment of s.
func words(s string) string { return strings.Join(strings.Fields(s), " ") }
