package sqlite

import (
	"bytes"
	"context"
	"database/sql"
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"testing/fstest"
	"time"

	"codeatrophy/internal/domain"
	"codeatrophy/internal/store"
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

// addMigration adds a migration after the latest one, as a later release
// would, until the test ends.
func addMigration(t *testing.T, name, query string) {
	t.Helper()
	fsys := fstest.MapFS{"migrations/" + name: {Data: []byte(query)}}
	entries, err := fs.ReadDir(embeddedMigrations, "migrations")
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range entries {
		b, err := fs.ReadFile(embeddedMigrations, "migrations/"+e.Name())
		if err != nil {
			t.Fatal(err)
		}
		fsys["migrations/"+e.Name()] = &fstest.MapFile{Data: b}
	}
	embedded := migrationFS
	migrationFS = fsys
	t.Cleanup(func() { migrationFS = embedded })
}

// laterMigration is the name of the migration addMigration adds.
var laterMigration = fmt.Sprintf("%04d_later.sql", store.SchemaVersion+1)

// setVersion makes the database at path record that migrations 1 to v ran,
// as one last used by an older Codeatrophy does.
func setVersion(t *testing.T, path string, v int) {
	t.Helper()
	raw, err := sql.Open("sqlite", "file:"+path)
	if err != nil {
		t.Fatal(err)
	}
	defer raw.Close()
	if _, err := raw.Exec(`DELETE FROM schema_migrations`); err != nil {
		t.Fatal(err)
	}
	for i := 1; i <= v; i++ {
		if _, err := raw.Exec(`INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, 0)`,
			i, fmt.Sprintf("%04d_old.sql", i)); err != nil {
			t.Fatal(err)
		}
	}
}

// A deleted built-in preset stays deleted after a restart, even when the
// table is empty again.
func TestBuiltinStylePresetsAreSeededOnce(t *testing.T) {
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
	addMigration(t, laterMigration, `CREATE TABLE later (x INTEGER);`)
	for i := range keepBackups + 2 {
		if i == 0 {
			write(t, db, func(tx store.Tx) error { return tx.SetSetting("k", "at the old version") })
		}
		if err := db.migrate(context.Background()); err != nil {
			t.Fatal(err)
		}
		// Undo the later migration, for the next round to apply it again.
		if _, err := db.writer.Exec(`DROP TABLE later; DELETE FROM schema_migrations WHERE version = ?`,
			store.SchemaVersion+1); err != nil {
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
		if !strings.Contains(filepath.Base(b), fmt.Sprintf(".backup-v%d-", store.SchemaVersion)) {
			t.Errorf("backup name %s", b)
		}
	}
	// A backup is a complete database at the old version.
	st, err := Inspect(context.Background(), got[0])
	if err != nil || st.Version != store.SchemaVersion {
		t.Fatalf("backup: %+v %v", st, err)
	}
	b, err := sql.Open("sqlite", "file:"+got[0])
	if err != nil {
		t.Fatal(err)
	}
	defer b.Close()
	var v string
	if err := b.QueryRow(`SELECT value FROM settings WHERE key = 'k'`).Scan(&v); err != nil || v != "at the old version" {
		t.Errorf("backup holds %q (%v)", v, err)
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
	if !errors.As(err, &mn) || mn.Version != 0 || mn.Expected != store.SchemaVersion || len(mn.Pending) != len(MigrationVersions()) {
		t.Fatalf("a missing database: %v", err)
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Error("the database file was created")
	}
	db, err := Open(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	db.Close()
	addMigration(t, laterMigration, `CREATE TABLE later (x INTEGER);`)
	before, _ := os.ReadFile(path)
	_, err = OpenWith(ctx, path, Options{NoMigrate: true})
	if !errors.As(err, &mn) || mn.Version != store.SchemaVersion || len(mn.Pending) != 1 ||
		!strings.Contains(err.Error(), fmt.Sprintf("expects version %d", store.SchemaVersion+1)) {
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

// A database from before 1.0.0, at a version between 1 and 21, is refused,
// migrating or not, and left exactly as it was: nothing is applied and no
// backup is written.
func TestOlderSchemaIsRefused(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	path := filepath.Join(dir, "codeatrophy.db")
	db, err := Open(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	write(t, db, func(tx store.Tx) error { return tx.SetSetting("k", "v") })
	db.Close()
	for _, v := range []int{1, 10, store.BaselineVersion - 1} {
		setVersion(t, path, v)
		before, _ := os.ReadFile(path)
		for _, opts := range []Options{{}, {NoMigrate: true}} {
			_, err := OpenWith(ctx, path, opts)
			if !errors.Is(err, store.ErrOlderSchema) || errors.Is(err, store.ErrMigrationNeeded) ||
				!strings.Contains(err.Error(), fmt.Sprintf("schema version %d is older", v)) ||
				!strings.Contains(err.Error(), "upgrade it with Codeatrophy 1.0.0 first") {
				t.Errorf("version %d, NoMigrate %v: %v", v, opts.NoMigrate, err)
			}
		}
		if after, _ := os.ReadFile(path); !bytes.Equal(before, after) {
			t.Errorf("version %d: the database was changed", v)
		}
		if m, _ := filepath.Glob(filepath.Join(dir, "*.backup-v*")); len(m) != 0 {
			t.Errorf("version %d: a backup was written: %v", v, m)
		}
		st, err := Inspect(ctx, path)
		if err != nil || st.Version != v || len(st.Pending) != 0 {
			t.Errorf("version %d: inspect %+v %v", v, st, err)
		}
	}
}

// A database the migrations before the baseline brought to the schema of
// 1.0.0 records their versions, 1 to 22. It opens with nothing applied and
// its record unchanged, migrating or not, as one the baseline built does.
func TestDatabaseUpgradedTo100OpensUnchanged(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	path := filepath.Join(dir, "codeatrophy.db")
	db, err := Open(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	db.Close()
	setVersion(t, path, store.BaselineVersion)
	for _, opts := range []Options{{}, {NoMigrate: true}} {
		var logs bytes.Buffer
		opts.Logger = slog.New(slog.NewTextHandler(&logs, nil))
		db, err := OpenWith(ctx, path, opts)
		if err != nil {
			t.Fatalf("NoMigrate %v: %v", opts.NoMigrate, err)
		}
		var n, last int
		if err := db.writer.QueryRow(`SELECT COUNT(*), MAX(version) FROM schema_migrations`).Scan(&n, &last); err != nil {
			t.Fatal(err)
		}
		db.Close()
		if n != store.BaselineVersion || last != store.BaselineVersion || logs.Len() != 0 {
			t.Errorf("NoMigrate %v: %d migrations recorded, the latest %d; logged: %s", opts.NoMigrate, n, last, logs.String())
		}
	}
	if m, _ := filepath.Glob(filepath.Join(dir, "*.backup-v*")); len(m) != 0 {
		t.Errorf("a backup was written: %v", m)
	}
}
