package postgres

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"sync"
	"testing"
	"time"

	"codeatrophy/internal/domain"
	"codeatrophy/internal/store"
	"codeatrophy/internal/store/postgres/pgtest"
	"codeatrophy/internal/store/storetest"
)

func open(t *testing.T, url string, log *slog.Logger) *DB {
	t.Helper()
	db, err := Open(context.Background(), url, Options{Logger: log})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	return db
}

func TestMigrations(t *testing.T) {
	url := pgtest.URL(t)
	var logs bytes.Buffer
	db := open(t, url, slog.New(slog.NewTextHandler(&logs, nil)))
	if v, err := db.SchemaVersion(context.Background()); err != nil || v != store.SchemaVersion {
		t.Errorf("a new database is at version %d (%v), want %d", v, err, store.SchemaVersion)
	}
	if n := strings.Count(logs.String(), "applied database migration"); n != len(MigrationVersions()) {
		t.Errorf("%d migrations logged:\n%s", n, logs.String())
	}
	db.Close()
	logs.Reset()
	db = open(t, url, slog.New(slog.NewTextHandler(&logs, nil)))
	if logs.Len() != 0 {
		t.Errorf("reopening logged: %s", logs.String())
	}
	if _, err := db.pool.Exec(`INSERT INTO schema_migrations (version, name, applied_at) VALUES (999, 'future', 0)`); err != nil {
		t.Fatal(err)
	}
	db.Close()
	_, err := Open(context.Background(), url, Options{})
	if !errors.Is(err, store.ErrNewerSchema) || !strings.Contains(err.Error(), "upgrade the server") {
		t.Errorf("opening a newer schema: %v", err)
	}
	st, err := Inspect(context.Background(), url, Options{})
	if err != nil || st.Version != 999 || len(st.Pending) != 0 || len(st.Counts) != len(store.Tables) {
		t.Errorf("inspect: %+v %v", st, err)
	}
}

// Processes starting together migrate once: the others wait and find the
// work done.
func TestConcurrentOpenMigratesOnce(t *testing.T) {
	url := pgtest.URL(t)
	var wg sync.WaitGroup
	errs := make(chan error, 4)
	for range 4 {
		wg.Go(func() {
			db, err := Open(context.Background(), url, Options{})
			if err == nil {
				db.Close()
			}
			errs <- err
		})
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}
	db := open(t, url, nil)
	var migrations, presets int
	if err := db.pool.QueryRow(`SELECT (SELECT COUNT(*) FROM schema_migrations), (SELECT COUNT(*) FROM style_presets)`).
		Scan(&migrations, &presets); err != nil {
		t.Fatal(err)
	}
	if migrations != len(MigrationVersions()) || presets != len(store.BuiltinStylePresets) {
		t.Errorf("%d migrations recorded, %d presets", migrations, presets)
	}
}

// A deleted built-in preset stays deleted after a restart, even when the
// table is empty again.
func TestBuiltinStylePresetsAreSeededOnce(t *testing.T) {
	url := pgtest.URL(t)
	db := open(t, url, nil)
	if _, err := db.pool.Exec(`DELETE FROM style_presets`); err != nil {
		t.Fatal(err)
	}
	db.Close()
	db = open(t, url, nil)
	var n int
	if err := db.pool.QueryRow(`SELECT COUNT(*) FROM style_presets`).Scan(&n); err != nil || n != 0 {
		t.Errorf("deleted presets came back: %d %v", n, err)
	}
}

// The database refuses to change a provider's kind, even when asked
// directly.
func TestAIProviderKindIsImmutable(t *testing.T) {
	db := open(t, pgtest.URL(t), nil)
	if err := db.Write(context.Background(), func(tx store.Tx) error {
		return tx.InsertAIProvider(&store.AIProvider{ID: "p", Name: "P", Kind: "anthropic", CreatedAt: time.Now(), UpdatedAt: time.Now()})
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := db.pool.Exec(`UPDATE ai_providers SET kind = 'openai_compatible' WHERE id = 'p'`); err == nil ||
		!strings.Contains(err.Error(), "cannot be changed") {
		t.Errorf("the kind was changed: %v", err)
	}
	if _, err := db.pool.Exec(`UPDATE ai_providers SET kind = 'anthropic', name = 'Q' WHERE id = 'p'`); err != nil {
		t.Errorf("an update that keeps the kind: %v", err)
	}
}

// The tables hold exactly the columns of the logical schema.
func TestTablesMatchTheLogicalSchema(t *testing.T) {
	db := open(t, pgtest.URL(t), nil)
	for _, tb := range store.Tables {
		rows, err := db.pool.Query(`SELECT column_name FROM information_schema.columns
			WHERE table_schema = current_schema() AND table_name = $1 ORDER BY ordinal_position`, tb.Name)
		if err != nil {
			t.Fatal(err)
		}
		cols, err := scanStrings(rows)
		if err != nil {
			t.Fatal(err)
		}
		if strings.Join(cols, ",") != strings.Join(tb.Columns, ",") {
			t.Errorf("%s: columns %v, want %v", tb.Name, cols, tb.Columns)
		}
	}
}

// Waiting for a server is bounded, honours the context, and never shows
// the password.
func TestOpenWaitsABoundedTime(t *testing.T) {
	url := "postgres://user:s3cret-pw@127.0.0.1:1/db?sslmode=disable&connect_timeout=1"
	start := time.Now()
	_, err := Open(context.Background(), url, Options{Wait: 2 * time.Second})
	if err == nil || !strings.Contains(err.Error(), "did not accept connections within 2s") {
		t.Errorf("unreachable server: %v", err)
	}
	if d := time.Since(start); d > 10*time.Second {
		t.Errorf("waited %v", d)
	}
	if err != nil && strings.Contains(err.Error(), "s3cret") {
		t.Errorf("the password is in the error: %v", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 500*time.Millisecond)
	defer cancel()
	start = time.Now()
	if _, err := Open(ctx, url, Options{Wait: time.Minute}); err == nil || time.Since(start) > 5*time.Second {
		t.Errorf("cancelled wait: %v after %v", err, time.Since(start))
	}
	for _, bad := range []string{"mysql://user:s3cret-pw@host/db", "postgres://user:s3cret-pw@host:notaport/db"} {
		_, err := Open(context.Background(), bad, Options{Wait: time.Second})
		if err == nil || strings.Contains(err.Error(), "s3cret") {
			t.Errorf("%s: %v", Redact(bad), err)
		}
	}
	if got := Redact("postgres://u:pw@h:5432/d?sslmode=disable"); got != "postgres://u:xxxxx@h:5432/d?sslmode=disable" {
		t.Errorf("Redact: %s", got)
	}
}

// Opened without migrating, a database that is not at this server's
// version is refused and left as it was.
func TestOpenWithoutMigrating(t *testing.T) {
	ctx := context.Background()
	url := pgtest.URL(t)
	var mn *store.MigrationNeededError
	_, err := Open(ctx, url, Options{NoMigrate: true})
	if !errors.As(err, &mn) || mn.Version != 0 || mn.Expected != store.SchemaVersion || len(mn.Pending) != len(MigrationVersions()) {
		t.Fatalf("an empty database: %v", err)
	}
	st, err := Inspect(ctx, url, Options{})
	if err != nil || st.Version != 0 || len(st.Counts) != 0 {
		t.Errorf("the empty database was changed: %+v %v", st, err)
	}
	db := open(t, url, nil)
	if _, err := db.pool.Exec(`DELETE FROM schema_migrations WHERE version = $1`, store.SchemaVersion); err != nil {
		t.Fatal(err)
	}
	_, err = Open(ctx, url, Options{NoMigrate: true})
	if !errors.As(err, &mn) || mn.Version != store.SchemaVersion-1 || len(mn.Pending) != 1 {
		t.Fatalf("a database one version behind: %v", err)
	}
	if v, _ := db.SchemaVersion(ctx); v != store.SchemaVersion-1 {
		t.Errorf("the version moved to %d", v)
	}
	if _, err := db.pool.Exec(`INSERT INTO schema_migrations (version, name, applied_at) VALUES ($1, 'x', 0), (999, 'future', 0)`,
		store.SchemaVersion); err != nil {
		t.Fatal(err)
	}
	if _, err := Open(ctx, url, Options{NoMigrate: true}); !errors.Is(err, store.ErrNewerSchema) {
		t.Errorf("a newer database: %v", err)
	}
	if _, err := db.pool.Exec(`DELETE FROM schema_migrations WHERE version = 999`); err != nil {
		t.Fatal(err)
	}
	cur, err := Open(ctx, url, Options{NoMigrate: true})
	if err != nil {
		t.Fatalf("a current database: %v", err)
	}
	cur.Close()
}

// downMigrations undo a migration, so that tests can run it again on a
// database that already holds data.
var downMigrations = map[int]string{
	// The check of version 7 knew two kinds.
	8: `ALTER TABLE ai_providers DROP CONSTRAINT ai_providers_kind_check;
		ALTER TABLE ai_providers ADD CONSTRAINT ai_providers_kind_check CHECK (kind IN ('anthropic', 'openai_compatible'));`,
	9:  `ALTER TABLE item_tags DROP CONSTRAINT item_tags_tag_fkey; DROP TABLE tags;`,
	10: `ALTER TABLE ai_providers DROP COLUMN effort;`,
	11: `ALTER TABLE solutions DROP COLUMN last_run_passed, DROP COLUMN last_run_total, DROP COLUMN last_run_time_ms,
		DROP COLUMN last_run_memory_kb, DROP COLUMN last_run_at;`,
}

// undoMigrationsFrom takes the database back to the version before from.
func undoMigrationsFrom(t *testing.T, db *DB, from int) {
	t.Helper()
	for v := store.SchemaVersion; v >= from; v-- {
		if down, ok := downMigrations[v]; ok {
			if _, err := db.pool.Exec(down); err != nil {
				t.Fatal(err)
			}
		}
	}
	if _, err := db.pool.Exec(`DELETE FROM schema_migrations WHERE version >= $1`, from); err != nil {
		t.Fatal(err)
	}
}

// Migration 8 allows the gemini kind: a database at version 7 keeps every
// provider, its usage and log rows and every other row, and the kind is
// still checked. The library is written at the current version and taken
// back, since the store writes the current schema.
func TestGeminiKindMigrationKeepsEverything(t *testing.T) {
	ctx := context.Background()
	url := pgtest.URL(t)
	db := open(t, url, nil)
	storetest.Populate(t, db)
	now := time.Date(2026, 3, 1, 10, 0, 0, 0, time.UTC)
	insert := func(db *DB, p store.AIProvider) error {
		return db.Write(ctx, func(tx store.Tx) error { return tx.InsertAIProvider(&p) })
	}
	if err := insert(db, store.AIProvider{ID: "o", Name: "Local", Kind: "openai_compatible", Model: "llama3",
		BaseURL: "http://localhost:11434/v1", CreatedAt: now, UpdatedAt: now}); err != nil {
		t.Fatal(err)
	}
	storetest.ClearLastRuns(t, db) // the schema before version 11 has none
	want := storetest.Dump(t, db)
	if len(want["ai_providers"]) != 2 || len(want["ai_usage"]) == 0 || len(want["ai_log"]) == 0 {
		t.Fatalf("the fixture has no providers or usage: %v", want)
	}
	undoMigrationsFrom(t, db, 8)
	gemini := store.AIProvider{ID: "g", Name: "Gemini", Kind: "gemini", CreatedAt: now, UpdatedAt: now}
	if err := insert(db, gemini); err == nil {
		t.Fatal("version 7 accepted the gemini kind")
	}
	db.Close()

	db = open(t, url, nil)
	if v, _ := db.SchemaVersion(ctx); v != store.SchemaVersion {
		t.Fatalf("version %d after migrating", v)
	}
	storetest.SameDump(t, "after migration 8", want, storetest.Dump(t, db))
	if err := insert(db, gemini); err != nil {
		t.Fatalf("a gemini provider: %v", err)
	}
	if err := insert(db, store.AIProvider{ID: "m", Name: "Mistral", Kind: "mistral", CreatedAt: now, UpdatedAt: now}); err == nil {
		t.Error("an unknown kind was accepted")
	}
	if _, err := db.pool.Exec(`UPDATE ai_providers SET kind = 'anthropic' WHERE id = 'g'`); err == nil {
		t.Error("the kind was changed")
	}
}

// Migration 9 makes tags records of their own: every tag an item carries
// becomes one, every other row is kept, and item_tags refers to tags.
func TestTagsMigrationRegistersCarriedTags(t *testing.T) {
	ctx := context.Background()
	url := pgtest.URL(t)
	db := open(t, url, nil)
	storetest.Populate(t, db)
	storetest.ClearLastRuns(t, db) // the schema before version 11 has none
	want := storetest.Dump(t, db)
	if len(want["tags"]) < 3 || len(want["item_tags"]) <= len(want["tags"]) {
		t.Fatalf("the fixture has too few tags: %v %v", want["tags"], want["item_tags"])
	}
	undoMigrationsFrom(t, db, 9)
	var exists bool
	if err := db.pool.QueryRow(`SELECT to_regclass('tags') IS NOT NULL`).Scan(&exists); err != nil || exists {
		t.Fatalf("version 8 has a tags table: %v %v", exists, err)
	}
	db.Close()

	db = open(t, url, nil)
	if v, _ := db.SchemaVersion(ctx); v != store.SchemaVersion {
		t.Fatalf("version %d after migrating", v)
	}
	storetest.SameDump(t, "after migration 9", want, storetest.Dump(t, db))
	if _, err := db.pool.Exec(`INSERT INTO item_tags (item_id, tag) VALUES ('origin', 'unregistered')`); err == nil {
		t.Error("an item carries a tag that is not registered")
	}
	if _, err := db.pool.Exec(`DELETE FROM tags WHERE name = 'array'`); err == nil {
		t.Error("a tag an item carries was deleted")
	}
	if _, err := db.pool.Exec(`DELETE FROM items WHERE id = 's7'`); err != nil {
		t.Errorf("deleting an item with tags: %v", err)
	}
}

// Migration 10 gives AI providers an effort level: Anthropic providers get
// high, which the server sent them until then, the other kinds none, and
// every other row is kept.
func TestEffortMigrationKeepsAnthropicAtHigh(t *testing.T) {
	ctx := context.Background()
	url := pgtest.URL(t)
	db := open(t, url, nil)
	storetest.Populate(t, db)
	now := time.Date(2026, 3, 1, 10, 0, 0, 0, time.UTC)
	if err := db.Write(ctx, func(tx store.Tx) error {
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
	}); err != nil {
		t.Fatal(err)
	}
	storetest.ClearLastRuns(t, db) // the schema before version 11 has none
	want := storetest.Dump(t, db)
	undoMigrationsFrom(t, db, 10)
	db.Close()

	db = open(t, url, nil)
	if v, _ := db.SchemaVersion(ctx); v != store.SchemaVersion {
		t.Fatalf("version %d after migrating", v)
	}
	got := storetest.Dump(t, db)
	delete(want, "ai_providers")
	delete(got, "ai_providers")
	storetest.SameDump(t, "after migration 10", want, got)
	efforts := map[string]string{}
	var list []store.AIProvider
	if err := db.Read(ctx, func(tx store.Tx) (err error) { list, err = tx.ListAIProviders(); return err }); err != nil {
		t.Fatal(err)
	}
	for _, p := range list {
		efforts[p.Kind+" "+p.Name] = p.Effort
	}
	if fmt.Sprint(efforts) != "map[anthropic Second key:high anthropic Work:high gemini Gemini: openai_compatible Local:]" {
		t.Errorf("efforts after migrating: %v", efforts)
	}
	if _, err := db.pool.Exec(`UPDATE ai_providers SET effort = 'max' WHERE id = 'a'`); err == nil {
		t.Error("an unknown effort was accepted")
	}
}

// Migration 11 gives saved solutions a last run: every existing solution
// starts without one, every other row is kept, and the figures are checked.
func TestLastRunMigrationStartsEverySolutionWithoutARun(t *testing.T) {
	ctx := context.Background()
	url := pgtest.URL(t)
	db := open(t, url, nil)
	storetest.Populate(t, db)
	want := storetest.Dump(t, db)
	undoMigrationsFrom(t, db, 11)
	db.Close()

	db = open(t, url, nil)
	if v, _ := db.SchemaVersion(ctx); v != store.SchemaVersion {
		t.Fatalf("version %d after migrating", v)
	}
	got := storetest.Dump(t, db)
	delete(want, "solutions")
	delete(got, "solutions")
	storetest.SameDump(t, "after migration 11", want, got)
	var sols []domain.ItemSolution
	if err := db.Read(ctx, func(tx store.Tx) (err error) { sols, err = tx.ListSolutions("origin"); return err }); err != nil {
		t.Fatal(err)
	}
	if len(sols) != 2 || sols[0].LastRun != nil || sols[1].LastRun != nil || sols[0].Notes != storetest.ArbitraryText {
		t.Errorf("solutions after migrating: %+v", sols)
	}
	for what, set := range map[string]string{
		"a run without its time":       `last_run_passed = 1, last_run_total = 2`,
		"a time without a run":         `last_run_time_ms = 5`,
		"more passed than ran":         `last_run_passed = 3, last_run_total = 2, last_run_at = 1`,
		"a run without its case count": `last_run_passed = 1, last_run_at = 1`,
		"a negative memory":            `last_run_passed = 1, last_run_total = 2, last_run_memory_kb = -1, last_run_at = 1`,
	} {
		if _, err := db.pool.Exec(`UPDATE solutions SET ` + set + ` WHERE id = 'sol0'`); err == nil {
			t.Errorf("%s was accepted", what)
		}
	}
	if _, err := db.pool.Exec(`UPDATE solutions SET last_run_passed = 2, last_run_total = 2, last_run_at = 1 WHERE id = 'sol0'`); err != nil {
		t.Errorf("a run without figures: %v", err)
	}
}
