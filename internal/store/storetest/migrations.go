package storetest

import (
	"context"
	"fmt"
	"slices"
	"strings"
	"testing"
	"time"

	"codeatrophy/internal/app"
	"codeatrophy/internal/domain"
	"codeatrophy/internal/store"
)

// SeededStylePresets are the built-in presets as migration 5 seeds them,
// before migration 15 refreshes their text; store.BuiltinStylePresets are
// the presets as they are now. Tests check that the migrations agree.
var SeededStylePresets = []store.BuiltinStylePreset{
	{Name: "Interview practice", IsDefault: true,
		Instructions: `Write the statement the way an interviewer would pose it: two or three short paragraphs in plain language, with no back-story. Name the inputs and say exactly what to print. Give two or three small examples, each followed by one or two sentences explaining why that output is correct. Keep the constraints to a short list, chosen so that the intended time complexity matters. Under Notes, add a "Follow-up" line that asks for a better complexity or a harder twist without giving the approach away. Starter code in Python and Java.`},
	{Name: "Contest style",
		Instructions: `Write in the style of a programming-contest problem: a short, concrete scenario of at most one paragraph, then a precise formal statement. Use math notation for every bound. Choose the limits so that the intended complexity is implied but never named. Give at least two examples and explain only the non-obvious one, under Notes. No hints. Starter code in C++ and Python.`},
	{Name: "Study notes",
		Instructions: `Write for revision rather than for a test. For a reading: open with a two-sentence summary, then short sections with descriptive headings, each with a small worked example or code sample, and close with "Key takeaways" (three to five bullets) and "Check yourself" (three questions without answers). For a problem: keep the statement brief, and use Notes to name the underlying technique and point to related topics without giving the solution. Prefer plain words to jargon, and define each term the first time it appears.`},
}

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
		{"0014Links", testLinksMigration},
		{"0015BuiltinPresets", testBuiltinPresetsMigration},
		{"0016WorkingCopies", testWorkingCopiesMigration},
		{"0017Provenance", testProvenanceMigration},
		{"0018Auth", testAuthMigration},
		{"0019MCPTokens", testMCPTokensMigration},
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

// Migration 14 adds links and the records of deleted items, and makes
// variantOf outlive its origin (SQLite rebuilds items for it): a database
// at version 13 keeps every row, and deleting an origin then keeps its
// variant's variantOf and the links to it.
func testLinksMigration(t *testing.T, h MigrationHarness) {
	want, db := h.rerun(t, 14, func(db MigrationDB) {
		Populate(t, db)
		ClearNewerData(t, db)
	}, func(db MigrationDB) {
		for _, table := range []string{"item_links", "deleted_items"} {
			if err := h.Exec(db, `SELECT COUNT(*) FROM `+table); err == nil {
				t.Errorf("version 13 has a %s table", table)
			}
		}
	}, Dump)
	if len(want["test_cases"]) == 0 || len(want["item_tags"]) == 0 || len(want["submission_results"]) == 0 {
		t.Fatal("the fixture has no rows that refer to items")
	}
	SameDump(t, "after migration 14", want, Dump(t, db))
	// The search index still finds the items it found.
	if got := ids(t, db, store.ItemFilter{Query: "sorted input"}); got != "variant" {
		t.Errorf("search after migrating: %q", got)
	}
	Write(t, db, func(tx store.Tx) error {
		if _, err := tx.LinkItems("variant", "origin", now); err != nil {
			return err
		}
		_, err := tx.DeleteItem("origin", now)
		return err
	})
	v := Read(t, db, func(tx store.Tx) (domain.Item, error) { return tx.GetItem("variant") })
	if v.VariantOf == nil || *v.VariantOf != "origin" || v.VariantOrigin == nil || v.VariantOrigin.Available ||
		*v.VariantOrigin.Title != "Two Sum (original)" {
		t.Errorf("variant after deleting its origin: %v %+v", v.VariantOf, v.VariantOrigin)
	}
	if got := linkIDs(t, db, "variant"); got != "origin!" {
		t.Errorf("links of the variant: %q", got)
	}
	// Rows that referred to the deleted item went with it.
	if n := len(Read(t, db, func(tx store.Tx) ([]domain.TestCase, error) { return tx.ListTestCases("origin") })); n != 0 {
		t.Errorf("%d test cases of the deleted item remain", n)
	}
	h.rejects(t, db, map[string]string{
		"a pair in the wrong order": `INSERT INTO item_links (item_a, item_b, created_at) VALUES ('z', 'a', 0)`,
		"a pair stored twice":       `INSERT INTO item_links (item_a, item_b, created_at) VALUES ('origin', 'variant', 0)`,
		"a test case of no item":    `INSERT INTO test_cases (id, item_id, position, name, stdin, expected_stdout, is_sample, origin, verified, created_at, updated_at) VALUES ('x', 'nobody', 0, '', '', '', false, 'manual', false, 0, 0)`,
	})
}

// Migration 15 refreshes the text of every built-in preset that still has
// its built-in name and seeded text, also when it was made the default
// since, and changes nothing else: an edited, renamed or deleted preset is
// left as it is, and no column but the text changes.
func testBuiltinPresetsMigration(t *testing.T, h MigrationHarness) {
	ctx := context.Background()
	builtin := map[string]string{}
	for _, b := range store.BuiltinStylePresets {
		builtin[b.Name] = b.Instructions
	}
	seeded := map[string]string{}
	for _, b := range SeededStylePresets {
		seeded[b.Name] = b.Instructions
	}
	// At version 14, a preset with a built-in preset's text has the text
	// migration 5 seeded, whatever its name.
	asSeeded := func(db MigrationDB) {
		quote := func(s string) string { return "'" + strings.ReplaceAll(s, "'", "''") + "'" }
		for name, text := range builtin {
			if err := h.Exec(db, `UPDATE style_presets SET instructions = `+quote(seeded[name])+
				` WHERE instructions = `+quote(text)); err != nil {
				t.Fatal(err)
			}
		}
	}
	allButText := func(t *testing.T, b store.Bulk) map[string][]string {
		return DumpWithout(t, b, map[string][]string{"style_presets": {"instructions"}})
	}
	texts := func(t *testing.T, db store.Store, want map[string]string) {
		t.Helper()
		got := map[string]string{}
		for _, p := range Read(t, db, func(tx store.Tx) ([]domain.StylePreset, error) { return tx.ListStylePresets() }) {
			got[p.Name] = p.Instructions
		}
		if fmt.Sprint(got) != fmt.Sprint(want) {
			t.Errorf("preset texts after migration 15:\n  %v\nwant\n  %v", got, want)
		}
	}

	// The fixture keeps the default untouched, edits "Contest style",
	// deletes "Study notes" and adds a preset of the user's.
	t.Run("Library", func(t *testing.T) {
		want, db := h.rerun(t, 15, func(db MigrationDB) { Populate(t, db); ClearWorkingCopies(t, db); ClearProvenance(t, db) },
			asSeeded, allButText)
		SameDump(t, "after migration 15", want, allButText(t, db))
		texts(t, db, map[string]string{"Interview practice": builtin["Interview practice"],
			"Contest style": "My own contest rules.", "Mine": "Short."})
	})

	// "Contest style" was made the default, which changes its updated_at
	// and that of no other preset, and "Study notes" was renamed.
	t.Run("DefaultAndRenamed", func(t *testing.T) {
		want, db := h.rerun(t, 15, func(db MigrationDB) {
			a := app.New(app.Options{Store: db, Secrets: FixtureSecrets, Now: func() time.Time { return now }})
			list := Read(t, db, func(tx store.Tx) ([]domain.StylePreset, error) { return tx.ListStylePresets() })
			for _, p := range list {
				var in domain.StylePresetInput
				switch p.Name {
				case "Contest style":
					in.IsDefault = domain.Some(true)
				case "Study notes":
					in.Name = domain.Some("My notes")
				default:
					continue
				}
				if _, err := a.UpdateStylePreset(ctx, p.ID, in); err != nil {
					t.Fatal(err)
				}
			}
			for _, p := range Read(t, db, func(tx store.Tx) ([]domain.StylePreset, error) { return tx.ListStylePresets() }) {
				if moved := !p.UpdatedAt.Equal(p.CreatedAt); moved != (p.Name != "Interview practice") || p.IsDefault != (p.Name == "Contest style") {
					t.Fatalf("%s: default %v, created %v, updated %v", p.Name, p.IsDefault, p.CreatedAt, p.UpdatedAt)
				}
			}
		}, asSeeded, allButText)
		SameDump(t, "after migration 15", want, allButText(t, db))
		texts(t, db, map[string]string{"Interview practice": builtin["Interview practice"],
			"Contest style": builtin["Contest style"], "My notes": seeded["Study notes"]})
	})
}

// Migration 16 adds working copies: a database at version 15 keeps every
// row, and afterwards a working copy can be written and goes with its item.
func testWorkingCopiesMigration(t *testing.T, h MigrationHarness) {
	want, db := h.rerun(t, 16, func(db MigrationDB) {
		Populate(t, db)
		ClearWorkingCopies(t, db)
		ClearProvenance(t, db)
	}, func(db MigrationDB) {
		if err := h.Exec(db, `SELECT COUNT(*) FROM working_copies`); err == nil {
			t.Error("version 15 has a working_copies table")
		}
	}, Dump)
	SameDump(t, "after migration 16", want, Dump(t, db))
	Write(t, db, func(tx store.Tx) error {
		return tx.PutWorkingCopy(&domain.WorkingCopy{ItemID: "origin", Language: "go", Source: "package main", UpdatedAt: now})
	})
	if ws := Read(t, db, func(tx store.Tx) ([]domain.WorkingCopy, error) { return tx.ListWorkingCopies("origin") }); len(ws) != 1 ||
		ws[0].Source != "package main" {
		t.Errorf("after migrating: %+v", ws)
	}
	Write(t, db, func(tx store.Tx) error { _, err := tx.DeleteItem("origin", now); return err })
	if n := len(columnValues(t, db, "working_copies", "item_id")); n != 0 {
		t.Errorf("%d working copies remain after deleting their item", n)
	}
	h.rejects(t, db, map[string]string{
		"a working copy of no item": `INSERT INTO working_copies (item_id, language, source, updated_at, write_seq) VALUES ('nobody', 'go', '', 0, 1)`,
	})
}

// Migration 17 records who created an item and who last changed it: a
// database at version 16 keeps every row, its items record nobody, and
// afterwards an item keeps who created it and who last changed it.
func testProvenanceMigration(t *testing.T, h MigrationHarness) {
	want, db := h.rerun(t, 17, func(db MigrationDB) {
		Populate(t, db)
		ClearProvenance(t, db)
	}, func(db MigrationDB) {
		if err := h.Exec(db, `SELECT created_via FROM items`); err == nil {
			t.Error("version 16 has the provenance columns")
		}
	}, Dump)
	SameDump(t, "after migration 17", want, Dump(t, db))
	for _, id := range []string{"origin", "variant", TrackedID} {
		if it := Read(t, db, func(tx store.Tx) (domain.Item, error) { return tx.GetItem(id) }); it.CreatedBy != nil || it.LastUpdatedBy != nil {
			t.Errorf("%s after migrating: created by %+v, last updated by %+v", id, it.CreatedBy, it.LastUpdatedBy)
		}
	}
	Write(t, db, func(tx store.Tx) error {
		if _, err := tx.DeleteItem(TrackedID, now); err != nil {
			return err
		}
		return insertTracked(tx)
	})
	it := Read(t, db, func(tx store.Tx) (domain.Item, error) { return tx.GetItem(TrackedID) })
	if got := sourceText(it.CreatedBy) + " / " + sourceText(it.LastUpdatedBy); got != "mcp claude-code é 🙂 claude-opus-5-5 / http - claude-opus-5-5" {
		t.Errorf("after migrating: %s", got)
	}
}

// sourceText shows a change source as "via client model", "-" for a
// missing one, or "nobody".
func sourceText(c *domain.ChangeSource) string {
	if c == nil {
		return "nobody"
	}
	opt := func(p *string) string {
		if p == nil {
			return "-"
		}
		return *p
	}
	return c.Via + " " + opt(c.Client) + " " + opt(c.Model)
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
