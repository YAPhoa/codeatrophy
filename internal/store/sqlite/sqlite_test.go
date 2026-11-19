package sqlite

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"codeatrophy/internal/domain"
	"codeatrophy/internal/store"
	"codeatrophy/internal/store/storetest"
)

func openTest(t *testing.T) *DB {
	t.Helper()
	db, err := Open(context.Background(), filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	return db
}

var now = time.Date(2026, 3, 1, 10, 0, 0, 0, time.UTC)

func write(t *testing.T, db *DB, fn func(store.Tx) error) {
	t.Helper()
	if err := db.Write(context.Background(), fn); err != nil {
		t.Fatal(err)
	}
}

func read[T any](t *testing.T, db *DB, fn func(store.Tx) (T, error)) T {
	t.Helper()
	var out T
	if err := db.Read(context.Background(), func(tx store.Tx) error {
		var err error
		out, err = fn(tx)
		return err
	}); err != nil {
		t.Fatal(err)
	}
	return out
}

// clearStylePresets removes the built-in presets a new database starts with.
func clearStylePresets(t *testing.T, db *DB) {
	t.Helper()
	if _, err := db.writer.Exec(`DELETE FROM style_presets`); err != nil {
		t.Fatal(err)
	}
}

// downMigrations undo a migration, so that tests can run the latest one
// again on a database that already holds data. A new migration that cannot
// simply run twice adds its reverse here.
var downMigrations = map[int]string{
	6: `ALTER TABLE items DROP COLUMN problem_interface;
		ALTER TABLE items DROP COLUMN harness;
		ALTER TABLE submissions DROP COLUMN line_offset;
		ALTER TABLE submissions DROP COLUMN harness;`,
	7: `DROP TABLE ai_usage; DROP TABLE ai_log_bodies; DROP TABLE ai_log_texts; DROP TABLE ai_log;`,
	// The ai_providers table of 0004, which knew two kinds.
	8: `CREATE TABLE ai_providers_old (
			seq            INTEGER PRIMARY KEY,
			id             TEXT    NOT NULL UNIQUE,
			name           TEXT    NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
			name_key       TEXT    NOT NULL UNIQUE,
			kind           TEXT    NOT NULL CHECK (kind IN ('anthropic', 'openai_compatible')),
			model          TEXT    NOT NULL DEFAULT '',
			base_url       TEXT    NOT NULL DEFAULT '',
			api_key        TEXT    NOT NULL DEFAULT '',
			api_key_origin TEXT    NOT NULL DEFAULT '',
			created_at     INTEGER NOT NULL,
			updated_at     INTEGER NOT NULL);
		INSERT INTO ai_providers_old SELECT * FROM ai_providers;
		DROP TABLE ai_providers;
		ALTER TABLE ai_providers_old RENAME TO ai_providers;
		CREATE TRIGGER ai_providers_kind_immutable BEFORE UPDATE OF kind ON ai_providers
		WHEN NEW.kind != OLD.kind BEGIN SELECT RAISE(ABORT, 'the kind of an AI provider cannot be changed'); END;
		CREATE TRIGGER ai_providers_name_single_line_insert BEFORE INSERT ON ai_providers
		WHEN instr(NEW.name, char(10)) > 0 OR instr(NEW.name, char(9)) > 0 OR instr(NEW.name, char(13)) > 0
		BEGIN SELECT RAISE(ABORT, 'AI provider name must be a single line'); END;
		CREATE TRIGGER ai_providers_name_single_line_update BEFORE UPDATE OF name ON ai_providers
		WHEN instr(NEW.name, char(10)) > 0 OR instr(NEW.name, char(9)) > 0 OR instr(NEW.name, char(13)) > 0
		BEGIN SELECT RAISE(ABORT, 'AI provider name must be a single line'); END;
		CREATE TRIGGER ai_providers_max_count BEFORE INSERT ON ai_providers
		WHEN (SELECT COUNT(*) FROM ai_providers) >= 20
		BEGIN SELECT RAISE(ABORT, 'too many AI providers'); END;`,
	// The item_tags table of 0001, which referred to no tags table.
	9: `CREATE TABLE item_tags_old (
			item_id TEXT NOT NULL REFERENCES items (id) ON DELETE CASCADE,
			tag     TEXT NOT NULL,
			PRIMARY KEY (item_id, tag)) WITHOUT ROWID;
		INSERT INTO item_tags_old SELECT item_id, tag FROM item_tags;
		DROP TABLE item_tags;
		ALTER TABLE item_tags_old RENAME TO item_tags;
		CREATE INDEX item_tags_tag ON item_tags (tag);
		DROP TABLE tags;`,
}

// undoLatestMigration takes the database back to the version before the
// latest migration.
func undoLatestMigration(t *testing.T, db *DB) { undoMigrationsFrom(t, db, store.SchemaVersion) }

// undoMigrationsFrom takes the database back to the version before from.
func undoMigrationsFrom(t *testing.T, db *DB, from int) {
	t.Helper()
	for v := store.SchemaVersion; v >= from; v-- {
		if down, ok := downMigrations[v]; ok {
			if _, err := db.writer.Exec(down); err != nil {
				t.Fatal(err)
			}
		}
	}
	if _, err := db.writer.Exec(`DELETE FROM schema_migrations WHERE version >= ?`, from); err != nil {
		t.Fatal(err)
	}
}

// The built-in presets are seeded once, and only into an empty table.
func TestBuiltinStylePresetsAreSeededOnce(t *testing.T) {
	// An instance that already had presets when the seeding migration ran
	// gets none of the built-in ones.
	db := openTest(t)
	clearStylePresets(t, db)
	undoMigrationsFrom(t, db, 5)
	write(t, db, func(tx store.Tx) error {
		return tx.InsertStylePreset(&domain.StylePreset{ID: "mine", Name: "Mine", Instructions: "x", CreatedAt: now, UpdatedAt: now})
	})
	if err := db.migrate(context.Background()); err != nil {
		t.Fatal(err)
	}
	list := read(t, db, func(tx store.Tx) ([]domain.StylePreset, error) { return tx.ListStylePresets() })
	if len(list) != 1 || list[0].ID != "mine" {
		t.Errorf("existing presets: %+v", list)
	}

	// A deleted built-in preset stays deleted after a restart, even when the
	// table is empty again.
	path := filepath.Join(t.TempDir(), "seed.db")
	db2, err := Open(context.Background(), path)
	if err != nil {
		t.Fatal(err)
	}
	clearStylePresets(t, db2)
	db2.Close()
	db2, err = Open(context.Background(), path)
	if err != nil {
		t.Fatal(err)
	}
	defer db2.Close()
	if list := read(t, db2, func(tx store.Tx) ([]domain.StylePreset, error) { return tx.ListStylePresets() }); len(list) != 0 {
		t.Errorf("deleted presets came back: %+v", list)
	}
}

func TestMigrationsAreIdempotentAndForwardOnly(t *testing.T) {
	path := filepath.Join(t.TempDir(), "m.db")
	var logs bytes.Buffer
	db, err := OpenWith(context.Background(), path, Options{Logger: slog.New(slog.NewTextHandler(&logs, nil))})
	if err != nil {
		t.Fatal(err)
	}
	if v, err := db.SchemaVersion(context.Background()); err != nil || v != store.SchemaVersion {
		t.Errorf("a new database is at version %d (%v), want %d", v, err, store.SchemaVersion)
	}
	if n := strings.Count(logs.String(), "applied database migration"); n != len(MigrationVersions()) {
		t.Errorf("%d migrations logged:\n%s", n, logs.String())
	}
	db.Close()
	logs.Reset()
	db, err = OpenWith(context.Background(), path, Options{Logger: slog.New(slog.NewTextHandler(&logs, nil))})
	if err != nil {
		t.Fatalf("reopen: %v", err)
	}
	if logs.Len() != 0 {
		t.Errorf("reopening logged: %s", logs.String())
	}
	if _, err := db.writer.Exec(`INSERT INTO schema_migrations (version, name, applied_at) VALUES (999, 'future', 0)`); err != nil {
		t.Fatal(err)
	}
	db.Close()
	before, _ := os.ReadFile(path)
	_, err = Open(context.Background(), path)
	if !errors.Is(err, store.ErrNewerSchema) || !strings.Contains(err.Error(), "upgrade the server") {
		t.Errorf("opening a newer schema: %v", err)
	}
	if after, _ := os.ReadFile(path); !bytes.Equal(before, after) {
		t.Error("a database of a newer server was changed")
	}
	st, err := Inspect(context.Background(), path)
	if err != nil || st.Version != 999 || len(st.Pending) != 0 {
		t.Errorf("inspect: %+v %v", st, err)
	}
}

// Before migrating an existing database, a consistent copy of it is written
// next to it, named after the version it was at; only the newest few are
// kept.
func TestBackupBeforeMigrating(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "codeatrophy.db")
	db := func() *DB {
		db, err := Open(context.Background(), path)
		if err != nil {
			t.Fatal(err)
		}
		return db
	}()
	write(t, db, func(tx store.Tx) error { return tx.SetSetting("k", "before") })
	backups := func() []string {
		m, _ := filepath.Glob(filepath.Join(dir, "codeatrophy.db.backup-v*"))
		return m
	}
	if len(backups()) != 0 {
		t.Fatal("a new database was backed up")
	}
	for i := range keepBackups + 2 {
		// Pretend the latest migration has not run yet.
		undoLatestMigration(t, db)
		if i == 0 {
			write(t, db, func(tx store.Tx) error { return tx.SetSetting("k", "at v4") })
		}
		if err := db.migrate(context.Background()); err != nil {
			t.Fatal(err)
		}
		if i < keepBackups+1 {
			time.Sleep(1100 * time.Millisecond) // backups are named to the second
		}
	}
	if b := db.Backup(); !strings.HasPrefix(filepath.Base(b), "codeatrophy.db.backup-v") {
		t.Errorf("Backup() = %q", b)
	}
	db.Close()
	got := backups()
	if len(got) != keepBackups {
		t.Fatalf("backups: %v", got)
	}
	for _, b := range got {
		if !strings.Contains(filepath.Base(b), fmt.Sprintf(".backup-v%d-", store.SchemaVersion-1)) {
			t.Errorf("backup name %s", b)
		}
	}
	// A backup is a complete database at the old version.
	st, err := Inspect(context.Background(), got[0])
	if err != nil || st.Version != store.SchemaVersion-1 {
		t.Fatalf("backup: %+v %v", st, err)
	}
	b, err := Open(context.Background(), got[0])
	if err != nil {
		t.Fatal(err)
	}
	defer b.Close()
	if v := read(t, b, func(tx store.Tx) (string, error) { v, _, err := tx.GetSetting("k"); return v, err }); v != "at v4" {
		t.Errorf("backup holds %q", v)
	}
}

// The database refuses to change a provider's kind, even when asked
// directly.
func TestAIProviderKindIsImmutable(t *testing.T) {
	db := openTest(t)
	write(t, db, func(tx store.Tx) error {
		return tx.InsertAIProvider(&store.AIProvider{ID: "p", Name: "P", Kind: "anthropic", CreatedAt: now, UpdatedAt: now})
	})
	if _, err := db.writer.Exec(`UPDATE ai_providers SET kind = 'openai_compatible' WHERE id = 'p'`); err == nil {
		t.Error("the kind was changed")
	}
	if _, err := db.writer.Exec(`UPDATE ai_providers SET kind = 'anthropic', name = 'Q' WHERE id = 'p'`); err != nil {
		t.Errorf("an update that keeps the kind: %v", err)
	}
}

// The tables hold exactly the columns of the logical schema.
func TestTablesMatchTheLogicalSchema(t *testing.T) {
	db := openTest(t)
	for _, tb := range store.Tables {
		cols := read(t, db, func(stx store.Tx) ([]string, error) {
			rows, err := stx.(*tx).query(`SELECT name FROM pragma_table_info(?) ORDER BY cid`, tb.Name)
			if err != nil {
				return nil, err
			}
			return scanStrings(rows)
		})
		if strings.Join(cols, ",") != strings.Join(tb.Columns, ",") {
			t.Errorf("%s: columns %v, want %v", tb.Name, cols, tb.Columns)
		}
	}
}

// Opened without migrating, a database that is not at this server's
// version is refused and left exactly as it was.
func TestOpenWithoutMigrating(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	path := filepath.Join(dir, "codeatrophy.db")
	var mn *store.MigrationNeededError
	_, err := OpenWith(ctx, path, Options{NoMigrate: true})
	if !errors.As(err, &mn) || mn.Version != 0 || mn.Expected != store.SchemaVersion || len(mn.Pending) != store.SchemaVersion {
		t.Fatalf("a missing database: %v", err)
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Error("the database file was created")
	}
	db, err := Open(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	undoLatestMigration(t, db)
	db.Close()
	before, _ := os.ReadFile(path)
	_, err = OpenWith(ctx, path, Options{NoMigrate: true})
	if !errors.As(err, &mn) || mn.Version != store.SchemaVersion-1 || len(mn.Pending) != 1 ||
		!strings.Contains(err.Error(), fmt.Sprintf("expects version %d", store.SchemaVersion)) {
		t.Fatalf("a database one version behind: %v", err)
	}
	if after, _ := os.ReadFile(path); !bytes.Equal(before, after) {
		t.Error("the database was changed")
	}
	if m, _ := filepath.Glob(filepath.Join(dir, "*.backup-v*")); len(m) != 0 {
		t.Errorf("a backup was written: %v", m)
	}
	db, err = Open(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.writer.Exec(`INSERT INTO schema_migrations (version, name, applied_at) VALUES (999, 'future', 0)`); err != nil {
		t.Fatal(err)
	}
	db.Close()
	if _, err := OpenWith(ctx, path, Options{NoMigrate: true}); !errors.Is(err, store.ErrNewerSchema) {
		t.Errorf("a newer database: %v", err)
	}
	if _, err := os.ReadFile(path); err != nil {
		t.Fatal(err)
	}
	// At the expected version it opens normally.
	path2 := filepath.Join(dir, "current.db")
	db, err = Open(ctx, path2)
	if err != nil {
		t.Fatal(err)
	}
	db.Close()
	db, err = OpenWith(ctx, path2, Options{NoMigrate: true})
	if err != nil {
		t.Fatal(err)
	}
	write(t, db, func(tx store.Tx) error { return tx.SetSetting("k", "v") })
	db.Close()
}

// sqliteObjects lists the names of a table's triggers and indexes.
func sqliteObjects(t *testing.T, db *DB, table string) string {
	t.Helper()
	var names string
	if err := db.writer.QueryRow(`SELECT group_concat(name, ',') FROM (SELECT name FROM sqlite_master
		WHERE tbl_name = ? ORDER BY name)`, table).Scan(&names); err != nil {
		t.Fatal(err)
	}
	return names
}

// Migration 8 rebuilds ai_providers to allow the gemini kind: a database at
// version 7 keeps every provider, its usage and log rows and every other
// row, and the table's rules still hold. The library is written at the
// current version and taken back, since the store writes the current schema.
func TestGeminiKindMigrationKeepsEverything(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "v7.db")
	db, err := Open(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	storetest.Populate(t, db)
	write(t, db, func(tx store.Tx) error {
		return tx.InsertAIProvider(&store.AIProvider{ID: "o", Name: "Local", Kind: "openai_compatible", Model: "llama3",
			BaseURL: "http://localhost:11434/v1", CreatedAt: now, UpdatedAt: now})
	})
	wantTriggers := sqliteObjects(t, db, "ai_providers")
	want := storetest.Dump(t, db)
	if len(want["ai_providers"]) != 2 || len(want["ai_usage"]) == 0 || len(want["ai_log"]) == 0 {
		t.Fatalf("the fixture has no providers or usage: %v", want)
	}
	undoMigrationsFrom(t, db, 8)
	gemini := &store.AIProvider{ID: "g", Name: "Gemini", Kind: "gemini", CreatedAt: now, UpdatedAt: now}
	insert := func(db *DB, p *store.AIProvider) error {
		return db.Write(ctx, func(tx store.Tx) error { return tx.InsertAIProvider(p) })
	}
	if err := insert(db, gemini); err == nil {
		t.Fatal("version 7 accepted the gemini kind")
	}
	db.Close()

	db, err = Open(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if v, _ := db.SchemaVersion(ctx); v != store.SchemaVersion {
		t.Fatalf("version %d after migrating", v)
	}
	storetest.SameDump(t, "after migration 8", want, storetest.Dump(t, db))
	if got := sqliteObjects(t, db, "ai_providers"); got != wantTriggers {
		t.Errorf("triggers and indexes: %s, want %s", got, wantTriggers)
	}
	if err := insert(db, gemini); err != nil {
		t.Fatalf("a gemini provider: %v", err)
	}
	if got := read(t, db, func(tx store.Tx) (store.AIProvider, error) { return tx.GetAIProvider("g") }); got.Kind != "gemini" {
		t.Errorf("stored as %+v", got)
	}
	// New rows follow the copied ones, and the table's rules still hold.
	var seqs string
	if err := db.writer.QueryRow(`SELECT group_concat(id, ',') FROM (SELECT id FROM ai_providers ORDER BY seq)`).
		Scan(&seqs); err != nil || !strings.HasSuffix(seqs, ",o,g") {
		t.Errorf("insertion order: %s %v", seqs, err)
	}
	for what, q := range map[string]string{
		"an unknown kind":   `INSERT INTO ai_providers (id, name, name_key, kind, created_at, updated_at) VALUES ('x', 'X', 'x', 'mistral', 0, 0)`,
		"a duplicate name":  `INSERT INTO ai_providers (id, name, name_key, kind, created_at, updated_at) VALUES ('x', 'Local', 'local', 'gemini', 0, 0)`,
		"a multi-line name": `INSERT INTO ai_providers (id, name, name_key, kind, created_at, updated_at) VALUES ('x', 'a` + "\n" + `b', 'a b', 'gemini', 0, 0)`,
		"a changed kind":    `UPDATE ai_providers SET kind = 'anthropic' WHERE id = 'g'`,
	} {
		if _, err := db.writer.Exec(q); err == nil {
			t.Errorf("%s was accepted", what)
		}
	}
}

// Migration 9 makes tags records of their own: every tag an item carries
// becomes one, every other row is kept, and item_tags refers to tags.
func TestTagsMigrationRegistersCarriedTags(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "v8.db")
	db, err := Open(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	storetest.Populate(t, db)
	wantIndexes := sqliteObjects(t, db, "item_tags")
	want := storetest.Dump(t, db)
	if len(want["tags"]) < 3 || len(want["item_tags"]) <= len(want["tags"]) {
		t.Fatalf("the fixture has too few tags: %v %v", want["tags"], want["item_tags"])
	}
	undoMigrationsFrom(t, db, 9)
	var n int
	if err := db.writer.QueryRow(`SELECT COUNT(*) FROM sqlite_master WHERE name = 'tags'`).Scan(&n); err != nil || n != 0 {
		t.Fatalf("version 8 has a tags table: %d %v", n, err)
	}
	db.Close()

	db, err = Open(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if v, _ := db.SchemaVersion(ctx); v != 9 {
		t.Fatalf("version %d after migrating", v)
	}
	storetest.SameDump(t, "after migration 9", want, storetest.Dump(t, db))
	if got := sqliteObjects(t, db, "item_tags"); got != wantIndexes {
		t.Errorf("indexes: %s, want %s", got, wantIndexes)
	}
	if _, err := db.writer.Exec(`INSERT INTO item_tags (item_id, tag) VALUES ('origin', 'unregistered')`); err == nil {
		t.Error("an item carries a tag that is not registered")
	}
	if _, err := db.writer.Exec(`DELETE FROM tags WHERE name = 'array'`); err == nil {
		t.Error("a tag an item carries was deleted")
	}
	if _, err := db.writer.Exec(`DELETE FROM items WHERE id = 's7'`); err != nil {
		t.Errorf("deleting an item with tags: %v", err)
	}
}
