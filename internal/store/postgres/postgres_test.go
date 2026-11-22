package postgres

import (
	"bytes"
	"context"
	"errors"
	"log/slog"
	"strings"
	"sync"
	"testing"
	"time"

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

// The migrations hold the seeded text of every built-in preset, and the
// refreshing one the current text too.
func TestBuiltinStylePresetMigrations(t *testing.T) {
	seed, err := migrationFS.ReadFile("migrations/0005_initial_schema.sql")
	if err != nil {
		t.Fatal(err)
	}
	refresh, err := migrationFS.ReadFile("migrations/0015_refresh_builtin_style_presets.sql")
	if err != nil {
		t.Fatal(err)
	}
	for i, b := range storetest.SeededStylePresets {
		quoted := "'" + b.Instructions + "'"
		if !strings.Contains(string(seed), quoted) || !strings.Contains(string(refresh), quoted) ||
			!strings.Contains(string(refresh), "'"+store.BuiltinStylePresets[i].Instructions+"'") {
			t.Errorf("%s: the migrations' text differs from the tests' copy", b.Name)
		}
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
	12: `DROP TABLE ai_jobs; DROP TABLE drafts;`,
	13: `ALTER TABLE test_cases DROP COLUMN generator_language, DROP COLUMN generator_source;`,
	14: `DROP TABLE item_links; DROP TABLE deleted_items;
		ALTER TABLE items ADD CONSTRAINT items_variant_of_fkey
			FOREIGN KEY (variant_of) REFERENCES items (id) ON DELETE SET NULL DEFERRABLE;`,
	16: `DROP TABLE working_copies;`,
	17: `ALTER TABLE items DROP COLUMN created_via, DROP COLUMN created_client, DROP COLUMN created_model,
		DROP COLUMN updated_via, DROP COLUMN updated_client, DROP COLUMN updated_model;`,
	18: `DROP TABLE sessions; DROP TABLE users;`,
	19: `DROP TABLE mcp_tokens;`,
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

// pgObjects lists a table's indexes, triggers and constraints, with the
// constraints' definitions.
func pgObjects(t *testing.T, db *DB, table string) string {
	t.Helper()
	var s string
	if err := db.pool.QueryRow(`SELECT COALESCE(string_agg(o, ', ' ORDER BY o), '') FROM (
			SELECT 'index ' || indexname AS o FROM pg_indexes WHERE schemaname = current_schema() AND tablename = $1
			UNION ALL SELECT 'trigger ' || tgname FROM pg_trigger WHERE tgrelid = to_regclass($1) AND NOT tgisinternal
			UNION ALL SELECT 'constraint ' || conname || ' ' || pg_get_constraintdef(oid) FROM pg_constraint
				WHERE conrelid = to_regclass($1)) objects`, table).Scan(&s); err != nil {
		t.Fatal(err)
	}
	return s
}

// Each migration run again keeps the library, and leaves each table's
// indexes, triggers and constraints as a new database has them.
func TestMigrationsKeepData(t *testing.T) {
	storetest.RunMigrations(t, storetest.MigrationHarness{
		New: func(t *testing.T) string { return pgtest.URL(t) },
		Open: func(t *testing.T, url string) storetest.MigrationDB {
			return open(t, url, nil)
		},
		UndoFrom: func(t *testing.T, db storetest.MigrationDB, from int) { undoMigrationsFrom(t, db.(*DB), from) },
		Exec: func(db storetest.MigrationDB, q string) error {
			_, err := db.(*DB).pool.Exec(q)
			return err
		},
		Objects: func(t *testing.T, db storetest.MigrationDB, table string) string {
			return pgObjects(t, db.(*DB), table)
		},
	})
}
