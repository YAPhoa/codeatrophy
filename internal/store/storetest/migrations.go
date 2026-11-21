package storetest

import (
	"context"
	"fmt"
	"slices"
	"testing"

	"codeatrophy/internal/domain"
	"codeatrophy/internal/store"
)

// MigrationDB is a database the migration suite can inspect and close.
type MigrationDB interface {
	store.Store
	store.Bulk
	Close() error
}

// MigrationHarness drives one backend for RunMigrations.
type MigrationHarness struct {
	// New creates an empty database and returns where it is.
	New func(t *testing.T) string
	// Open opens the database at loc, running its pending migrations. The
	// database is closed when the test ends, if the test has not closed it.
	Open func(t *testing.T, loc string) MigrationDB
	// UndoFrom takes db back to the schema version before from, as the
	// backend's down migrations do.
	UndoFrom func(t *testing.T, db MigrationDB, from int)
	// Exec runs one statement on db directly, bypassing the store.
	Exec func(db MigrationDB, query string) error
	// Objects, if set, describes a table's indexes, triggers and
	// constraints; a migration run again must leave them as a new database
	// has them.
	Objects func(t *testing.T, db MigrationDB, table string) string
}

// RunMigrations runs each migration again on a database that holds a
// library written at the current schema version and then taken back to
// the version before that migration, and checks that every row is kept and
// the migration's rules hold.
func RunMigrations(t *testing.T, h MigrationHarness) {
	tests := []struct {
		name string
		fn   func(*testing.T, MigrationHarness)
	}{
		{"0008GeminiKind", testGeminiKindMigration},
		{"0009Tags", testTagsMigration},
		{"0010Effort", testEffortMigration},
		{"0011LastRun", testLastRunMigration},
		{"0012AIJobs", testAIJobsMigration},
		{"0013Generator", testGeneratorMigration},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) { tc.fn(t, h) })
	}
}

// rerun opens a new database, lets prepare fill it, takes it back to the
// version before from, lets atOld check it there, and reopens it, which
// runs the migrations again. It returns the database before (dumped by
// dump) and after, and checks that the version is current again and, with
// Objects, that every table has the objects of a new database.
func (h MigrationHarness) rerun(t *testing.T, from int, prepare func(MigrationDB), atOld func(MigrationDB),
	dump func(*testing.T, store.Bulk) map[string][]string) (map[string][]string, MigrationDB) {
	t.Helper()
	ctx := context.Background()
	loc := h.New(t)
	db := h.Open(t, loc)
	prepare(db)
	want := dump(t, db)
	objects := map[string]string{}
	if h.Objects != nil {
		for _, tb := range store.Tables {
			objects[tb.Name] = h.Objects(t, db, tb.Name)
		}
		if objects["ai_providers"] == "" {
			t.Fatal("Objects describes nothing of ai_providers")
		}
	}
	h.UndoFrom(t, db, from)
	if v, err := db.SchemaVersion(ctx); err != nil || v != from-1 {
		t.Fatalf("taken back to version %d (%v), want %d", v, err, from-1)
	}
	if atOld != nil {
		atOld(db)
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
	db = h.Open(t, loc)
	if v, err := db.SchemaVersion(ctx); err != nil || v != store.SchemaVersion {
		t.Fatalf("version %d (%v) after migrating", v, err)
	}
	for _, tb := range store.Tables {
		if h.Objects != nil && h.Objects(t, db, tb.Name) != objects[tb.Name] {
			t.Errorf("%s: indexes, triggers and constraints\n  %s\nwant\n  %s", tb.Name, h.Objects(t, db, tb.Name), objects[tb.Name])
		}
	}
	return want, db
}

// rejects checks that each statement fails.
func (h MigrationHarness) rejects(t *testing.T, db MigrationDB, statements map[string]string) {
	t.Helper()
	for what, q := range statements {
		if err := h.Exec(db, q); err == nil {
			t.Errorf("%s was accepted", what)
		}
	}
}

// Migration 8 allows the gemini kind (SQLite rebuilds ai_providers for
// it): a database at version 7 keeps every provider, its usage and log rows
// and every other row, and the table's rules still hold. The library is
// written at the current version and taken back, since the store writes the
// current schema.
func testGeminiKindMigration(t *testing.T, h MigrationHarness) {
	ctx := context.Background()
	gemini := store.AIProvider{ID: "g", Name: "Gemini", Kind: "gemini", CreatedAt: now, UpdatedAt: now}
	insert := func(db store.Store, p store.AIProvider) error {
		return db.Write(ctx, func(tx store.Tx) error { return tx.InsertAIProvider(&p) })
	}
	want, db := h.rerun(t, 8, func(db MigrationDB) {
		Populate(t, db)
		if err := insert(db, store.AIProvider{ID: "o", Name: "Local", Kind: "openai_compatible", Model: "llama3",
			BaseURL: "http://localhost:11434/v1", CreatedAt: now, UpdatedAt: now}); err != nil {
			t.Fatal(err)
		}
		ClearNewerData(t, db) // older schemas lack some of it
	}, func(db MigrationDB) {
		// Written directly: the store writes columns version 7 lacks.
		row := func(id, kind string) string {
			return `INSERT INTO ai_providers (id, name, name_key, kind, created_at, updated_at) VALUES ('` + id + `', '` + id +
				`', '` + id + `', '` + kind + `', 0, 0)`
		}
		if err := h.Exec(db, row("g", "gemini")); err == nil {
			t.Fatal("version 7 accepted the gemini kind")
		}
		if err := h.Exec(db, row("ctl", "openai_compatible")); err != nil {
			t.Fatalf("version 7 refused a kind it knows: %v", err)
		}
		if err := h.Exec(db, `DELETE FROM ai_providers WHERE id = 'ctl'`); err != nil {
			t.Fatal(err)
		}
	}, Dump)
	if len(want["ai_providers"]) != 2 || len(want["ai_usage"]) == 0 || len(want["ai_log"]) == 0 {
		t.Fatalf("the fixture has no providers or usage: %v", want)
	}
	SameDump(t, "after migration 8", want, Dump(t, db))
	if err := insert(db, gemini); err != nil {
		t.Fatalf("a gemini provider: %v", err)
	}
	if got := Read(t, db, func(tx store.Tx) (store.AIProvider, error) { return tx.GetAIProvider("g") }); got.Kind != "gemini" {
		t.Errorf("stored as %+v", got)
	}
	// New rows follow the copied ones.
	if ids := columnValues(t, db, "ai_providers", "id"); fmt.Sprint(ids[len(ids)-2:]) != "[o g]" {
		t.Errorf("insertion order: %v", ids)
	}
	h.rejects(t, db, map[string]string{
		"an unknown kind":   `INSERT INTO ai_providers (id, name, name_key, kind, created_at, updated_at) VALUES ('x', 'X', 'x', 'mistral', 0, 0)`,
		"a duplicate name":  `INSERT INTO ai_providers (id, name, name_key, kind, created_at, updated_at) VALUES ('x', 'Local', 'local', 'gemini', 0, 0)`,
		"a multi-line name": `INSERT INTO ai_providers (id, name, name_key, kind, created_at, updated_at) VALUES ('x', 'a` + "\n" + `b', 'a b', 'gemini', 0, 0)`,
		"a changed kind":    `UPDATE ai_providers SET kind = 'anthropic' WHERE id = 'g'`,
	})
}

// Migration 9 makes tags records of their own: every tag an item carries
// becomes one, every other row is kept, and item_tags refers to tags.
func testTagsMigration(t *testing.T, h MigrationHarness) {
	want, db := h.rerun(t, 9, func(db MigrationDB) {
		Populate(t, db)
		ClearNewerData(t, db)
	}, func(db MigrationDB) {
		if err := h.Exec(db, `SELECT COUNT(*) FROM tags`); err == nil {
			t.Fatal("version 8 has a tags table")
		}
	}, Dump)
	if len(want["tags"]) < 3 || len(want["item_tags"]) <= len(want["tags"]) {
		t.Fatalf("the fixture has too few tags: %v %v", want["tags"], want["item_tags"])
	}
	SameDump(t, "after migration 9", want, Dump(t, db))
	h.rejects(t, db, map[string]string{
		"a tag that is not registered": `INSERT INTO item_tags (item_id, tag) VALUES ('origin', 'unregistered')`,
		"deleting a tag an item has":   `DELETE FROM tags WHERE name = 'array'`,
	})
	if err := h.Exec(db, `DELETE FROM items WHERE id = 's7'`); err != nil {
		t.Errorf("deleting an item with tags: %v", err)
	}
}

// Migration 10 gives AI providers an effort level: Anthropic providers get
// high, which the server sent them until then, the other kinds none, and
// every other column and row is kept.
func testEffortMigration(t *testing.T, h MigrationHarness) {
	withoutEffort := func(t *testing.T, b store.Bulk) map[string][]string {
		return DumpWithout(t, b, map[string][]string{"ai_providers": {"effort"}})
	}
	want, db := h.rerun(t, 10, func(db MigrationDB) {
		Populate(t, db)
		Write(t, db, func(tx store.Tx) error {
			for _, p := range []store.AIProvider{
				{ID: "a", Name: "Second key", Kind: "anthropic"},
				{ID: "o", Name: "Local", Kind: "openai_compatible", Effort: "low"},
				{ID: "g", Name: "Gemini", Kind: "gemini", Effort: "medium"},
			} {
				p.CreatedAt, p.UpdatedAt = now, now
				if err := tx.InsertAIProvider(&p); err != nil {
					return err
				}
			}
			return nil
		})
		ClearNewerData(t, db)
	}, nil, withoutEffort)
	SameDump(t, "after migration 10", want, withoutEffort(t, db))
	efforts := map[string]string{}
	for _, p := range Read(t, db, func(tx store.Tx) ([]store.AIProvider, error) { return tx.ListAIProviders() }) {
		efforts[p.Kind+" "+p.Name] = p.Effort
	}
	if fmt.Sprint(efforts) != "map[anthropic Second key:high anthropic Work:high gemini Gemini: openai_compatible Local:]" {
		t.Errorf("efforts after migrating: %v", efforts)
	}
	h.rejects(t, db, map[string]string{"an unknown effort": `UPDATE ai_providers SET effort = 'max' WHERE id = 'a'`})
}

// Migration 11 gives saved solutions a last run: every existing solution
// starts without one, every row is kept, and the figures are checked.
func testLastRunMigration(t *testing.T, h MigrationHarness) {
	want, db := h.rerun(t, 11, func(db MigrationDB) {
		Populate(t, db)
		ClearNewerData(t, db) // the last runs are what migration 11 adds
	}, nil, Dump)
	SameDump(t, "after migration 11", want, Dump(t, db))
	sols := Read(t, db, func(tx store.Tx) ([]domain.ItemSolution, error) { return tx.ListSolutions("origin") })
	if len(sols) != 2 || sols[0].LastRun != nil || sols[1].LastRun != nil || sols[0].Notes != ArbitraryText {
		t.Errorf("solutions after migrating: %+v", sols)
	}
	h.rejects(t, db, map[string]string{
		"a run without its time":       `UPDATE solutions SET last_run_passed = 1, last_run_total = 2 WHERE id = 'sol0'`,
		"a time without a run":         `UPDATE solutions SET last_run_time_ms = 5 WHERE id = 'sol0'`,
		"more passed than ran":         `UPDATE solutions SET last_run_passed = 3, last_run_total = 2, last_run_at = 1 WHERE id = 'sol0'`,
		"a run without its case count": `UPDATE solutions SET last_run_passed = 1, last_run_at = 1 WHERE id = 'sol0'`,
		"a negative memory":            `UPDATE solutions SET last_run_passed = 1, last_run_total = 2, last_run_memory_kb = -1, last_run_at = 1 WHERE id = 'sol0'`,
	})
	if err := h.Exec(db, `UPDATE solutions SET last_run_passed = 2, last_run_total = 2, last_run_at = 1 WHERE id = 'sol0'`); err != nil {
		t.Errorf("a run without figures: %v", err)
	}
}

// Migration 12 adds the AI jobs and drafts tables and keeps every other row.
func testAIJobsMigration(t *testing.T, h MigrationHarness) {
	want, db := h.rerun(t, 12, func(db MigrationDB) {
		Populate(t, db)
		ClearNewerData(t, db)
	}, func(db MigrationDB) {
		for _, table := range []string{"ai_jobs", "drafts"} {
			if err := h.Exec(db, `SELECT COUNT(*) FROM `+table); err == nil {
				t.Errorf("version 11 has a %s table", table)
			}
		}
	}, Dump)
	SameDump(t, "after migration 12", want, Dump(t, db))
	item, content := "origin", `{"form":"x"}`
	Write(t, db, func(tx store.Tx) error {
		if err := tx.InsertAIJob(&store.AIJob{ID: "j", CreatedAt: now, Kind: "testcases", ItemID: &item, Title: "Two Sum",
			Status: store.JobQueued, Request: `{}`}); err != nil {
			return err
		}
		return tx.InsertDraft(&store.Draft{ID: "d", CreatedAt: now, UpdatedAt: now, Kind: "capture", Title: "Untitled draft",
			Revision: 1, Content: &content})
	})
	j := Read(t, db, func(tx store.Tx) (store.AIJob, error) { return tx.GetAIJob("j") })
	d := Read(t, db, func(tx store.Tx) (store.Draft, error) { return tx.GetDraft("d") })
	if j.Status != store.JobQueued || j.ItemID == nil || *j.ItemID != item || d.Content == nil || *d.Content != content {
		t.Errorf("after migrating: job %+v, draft %+v", j, d)
	}
}

// Migration 13 adds a test case's generator: a database at version 12
// keeps every row, its cases have no generator, and a generator is either
// complete or absent.
func testGeneratorMigration(t *testing.T, h MigrationHarness) {
	want, db := h.rerun(t, 13, func(db MigrationDB) {
		Populate(t, db)
		ClearNewerData(t, db)
	}, func(db MigrationDB) {
		if err := h.Exec(db, `SELECT generator_language FROM test_cases`); err == nil {
			t.Error("version 12 has the generator columns")
		}
	}, Dump)
	SameDump(t, "after migration 13", want, Dump(t, db))
	for _, c := range Read(t, db, func(tx store.Tx) ([]domain.TestCase, error) { return tx.ListTestCases("origin") }) {
		if c.Generator != nil {
			t.Errorf("case %s has a generator after migrating", c.ID)
		}
	}
	h.rejects(t, db, map[string]string{
		"a language without a source": `UPDATE test_cases SET generator_language = 'python' WHERE id = 'tc0'`,
	})
	Write(t, db, func(tx store.Tx) error {
		c, err := tx.GetTestCase("tc0")
		if err != nil {
			return err
		}
		c.Generator = &domain.GeneratorSpec{Language: "python", Source: "print(1)"}
		return tx.UpdateTestCase(&c)
	})
	if c := Read(t, db, func(tx store.Tx) (domain.TestCase, error) { return tx.GetTestCase("tc0") }); c.Generator == nil ||
		c.Generator.Source != "print(1)" {
		t.Errorf("after migrating: %+v", c)
	}
}

// DumpWithout is Dump without some columns, by table.
func DumpWithout(t *testing.T, b store.Bulk, skip map[string][]string) map[string][]string {
	t.Helper()
	out := map[string][]string{}
	if err := b.Export(context.Background(), func(d store.Dump) error {
		for _, tb := range store.Tables {
			out[tb.Name] = []string{}
			if err := d.Rows(tb, func(row []any) error {
				var kept []any
				for i, v := range row {
					if !slices.Contains(skip[tb.Name], tb.Columns[i]) {
						kept = append(kept, v)
					}
				}
				out[tb.Name] = append(out[tb.Name], fmt.Sprintf("%#v", kept))
				return nil
			}); err != nil {
				return err
			}
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	return out
}

// columnValues returns one column of a table, in key order.
func columnValues(t *testing.T, b store.Bulk, table, column string) []any {
	t.Helper()
	tb, ok := store.TableByName(table)
	i := slices.Index(tb.Columns, column)
	if !ok || i < 0 {
		t.Fatalf("no column %s.%s", table, column)
	}
	var out []any
	if err := b.Export(context.Background(), func(d store.Dump) error {
		return d.Rows(tb, func(row []any) error { out = append(out, row[i]); return nil })
	}); err != nil {
		t.Fatal(err)
	}
	return out
}
