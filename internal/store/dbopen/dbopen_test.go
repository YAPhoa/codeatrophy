package dbopen_test

import (
	"bytes"
	"context"
	"database/sql"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"codeatrophy/internal/domain"
	"codeatrophy/internal/store"
	"codeatrophy/internal/store/dbcopy"
	"codeatrophy/internal/store/dbopen"
	"codeatrophy/internal/store/postgres/pgtest"
	"codeatrophy/internal/store/sqlite"
	"codeatrophy/internal/store/storetest"
)

// sqliteLibrary writes a populated SQLite database at dir/codeatrophy.db
// and returns its path and contents.
func sqliteLibrary(t *testing.T, dir string) (string, map[string][]string) {
	t.Helper()
	path := filepath.Join(dir, "codeatrophy.db")
	db, err := sqlite.Open(context.Background(), path)
	if err != nil {
		t.Fatal(err)
	}
	storetest.Populate(t, db)
	want := storetest.Dump(t, db)
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
	return path, want
}

func open(t *testing.T, cfg dbopen.Config) (dbopen.DB, string) {
	t.Helper()
	var logs bytes.Buffer
	cfg.Logger = slog.New(slog.NewTextHandler(&logs, nil))
	db, err := dbopen.Open(context.Background(), cfg)
	if err != nil {
		t.Fatalf("open: %v\n%s", err, logs.String())
	}
	return db, logs.String()
}

func migrated(t *testing.T, path string) []string {
	t.Helper()
	m, err := filepath.Glob(path + "*" + dbopen.MigratedSuffix + "*")
	if err != nil {
		t.Fatal(err)
	}
	return m
}

// An empty PostgreSQL database takes over the SQLite database once; the
// file is renamed and kept, and a SQLite file found later is ignored.
func TestAutomaticImport(t *testing.T) {
	url := pgtest.URL(t)
	dir := t.TempDir()
	path, want := sqliteLibrary(t, dir)
	cfg := dbopen.Config{DatabaseURL: url, SQLitePath: path, SQLiteImport: true}

	db, logs := open(t, cfg)
	storetest.SameDump(t, "after the import", want, storetest.Dump(t, db))
	if !strings.Contains(logs, "imported the SQLite database into PostgreSQL: 2 settings, 1 AI provider, 3 days of AI usage, 3 AI log entries, 2 AI log texts, 3 AI log bodies, 3 style presets") ||
		!strings.Contains(logs, "renamed the imported SQLite database") || !strings.Contains(logs, "backend=PostgreSQL") {
		t.Errorf("logs:\n%s", logs)
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Errorf("the SQLite file is still at %s: %v", path, err)
	}
	m := migrated(t, path)
	if len(m) != 1 || !strings.HasPrefix(filepath.Base(m[0]), "codeatrophy.db.migrated-") {
		t.Fatalf("renamed files: %v", m)
	}
	// The renamed file is a complete backup.
	st, err := sqlite.Inspect(context.Background(), m[0])
	if err != nil || st.Version != store.SchemaVersion {
		t.Errorf("backup: %+v %v", st, err)
	}
	db.Close()

	// A restart imports nothing.
	db, logs = open(t, cfg)
	if strings.Contains(logs, "import") {
		t.Errorf("a restart imported again:\n%s", logs)
	}
	db.Close()

	// A SQLite file that turns up while PostgreSQL holds data is ignored.
	b, err := os.ReadFile(m[0])
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, b, 0o600); err != nil {
		t.Fatal(err)
	}
	storetest.Write(t, db2(t, url), func(tx store.Tx) error { return tx.SetSetting("after", "import") })
	db, logs = open(t, cfg)
	defer db.Close()
	if n := strings.Count(logs, "the SQLite database there was ignored"); n != 1 {
		t.Errorf("logs:\n%s", logs)
	}
	if _, err := os.Stat(path); err != nil {
		t.Errorf("the ignored file was moved: %v", err)
	}
	if v := storetest.Read(t, db, func(tx store.Tx) (string, error) { v, _, err := tx.GetSetting("after"); return v, err }); v != "import" {
		t.Error("PostgreSQL data was replaced")
	}
}

// db2 opens the PostgreSQL database directly, without an import.
func db2(t *testing.T, url string) dbopen.DB {
	t.Helper()
	db, err := dbopen.OpenTarget(context.Background(), dbopen.Target{PostgresURL: url}, slog.New(slog.DiscardHandler))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	return db
}

// A SQLite database of an older schema version is migrated, then imported
// whole, and PostgreSQL then takes the provider kind a migration added.
func TestImportOfAnOlderSQLiteDatabase(t *testing.T) {
	url := pgtest.URL(t)
	path, want := sqliteLibrary(t, t.TempDir())
	// Back to version 7: without a tags table, and with an ai_providers that
	// knew two kinds and no effort levels. Migrations 8 and 9 rebuild
	// ai_providers and item_tags, so their triggers and indexes are not
	// needed here.
	raw, err := sql.Open("sqlite", "file:"+path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := raw.Exec(`CREATE TABLE item_tags_old (item_id TEXT NOT NULL REFERENCES items (id) ON DELETE CASCADE,
			tag TEXT NOT NULL, PRIMARY KEY (item_id, tag)) WITHOUT ROWID;
		INSERT INTO item_tags_old SELECT item_id, tag FROM item_tags;
		DROP TABLE item_tags;
		ALTER TABLE item_tags_old RENAME TO item_tags;
		DROP TABLE tags;
		CREATE TABLE ai_providers_old (
			seq INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, name TEXT NOT NULL, name_key TEXT NOT NULL UNIQUE,
			kind TEXT NOT NULL CHECK (kind IN ('anthropic', 'openai_compatible')), model TEXT NOT NULL DEFAULT '',
			base_url TEXT NOT NULL DEFAULT '', api_key TEXT NOT NULL DEFAULT '', api_key_origin TEXT NOT NULL DEFAULT '',
			created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
		INSERT INTO ai_providers_old SELECT seq, id, name, name_key, kind, model, base_url, api_key, api_key_origin,
			created_at, updated_at FROM ai_providers;
		DROP TABLE ai_providers;
		ALTER TABLE ai_providers_old RENAME TO ai_providers;
		DELETE FROM schema_migrations WHERE version >= 8`); err != nil {
		t.Fatal(err)
	}
	raw.Close()
	if st, err := sqlite.Inspect(context.Background(), path); err != nil || st.Version != 7 {
		t.Fatalf("the SQLite database is at %+v %v", st, err)
	}
	db, logs := open(t, dbopen.Config{DatabaseURL: url, SQLitePath: path, SQLiteImport: true})
	defer db.Close()
	if !strings.Contains(logs, "0008_gemini_provider_kind.sql") || !strings.Contains(logs, "0009_tags.sql") ||
		!strings.Contains(logs, "0010_ai_provider_effort.sql") || !strings.Contains(logs, "imported the SQLite database") {
		t.Errorf("logs:\n%s", logs)
	}
	storetest.SameDump(t, "after the import", want, storetest.Dump(t, db))
	now := time.Date(2026, 3, 1, 10, 0, 0, 0, time.UTC)
	storetest.Write(t, db, func(tx store.Tx) error {
		return tx.InsertAIProvider(&store.AIProvider{ID: "g", Name: "Gemini", Kind: "gemini", CreatedAt: now, UpdatedAt: now})
	})
}

func TestImportCanBeTurnedOff(t *testing.T) {
	url := pgtest.URL(t)
	path, _ := sqliteLibrary(t, t.TempDir())
	db, logs := open(t, dbopen.Config{DatabaseURL: url, SQLitePath: path})
	defer db.Close()
	if strings.Contains(logs, "import") {
		t.Errorf("logs:\n%s", logs)
	}
	if empty, err := dbcopy.Empty(context.Background(), db); err != nil || !empty {
		t.Errorf("PostgreSQL is not empty: %v", err)
	}
	if _, err := os.Stat(path); err != nil {
		t.Error(err)
	}
}

// When the import fails, nothing is imported, the SQLite file stays where
// it is, and startup fails with a message that says what to do.
func TestFailedImportChangesNothing(t *testing.T) {
	url := pgtest.URL(t)
	path, _ := sqliteLibrary(t, t.TempDir())
	// A title that is not valid UTF-8, which SQLite stores and PostgreSQL
	// refuses, part-way through the copy.
	raw, err := sql.Open("sqlite", "file:"+path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := raw.Exec(`UPDATE items SET title = CAST(x'4166ff' AS TEXT) WHERE id = 's7'`); err != nil {
		t.Fatal(err)
	}
	raw.Close()
	before, _ := os.ReadFile(path)
	_, err = dbopen.Open(context.Background(), dbopen.Config{DatabaseURL: url, SQLitePath: path, SQLiteImport: true,
		Logger: slog.New(slog.NewTextHandler(io.Discard, nil))})
	if err == nil || !strings.Contains(err.Error(), "nothing was imported") ||
		!strings.Contains(err.Error(), "CODEATROPHY_SQLITE_IMPORT=off") || !strings.Contains(err.Error(), "UTF8") {
		t.Fatalf("open: %v", err)
	}
	if after, err := os.ReadFile(path); err != nil || !bytes.Equal(before, after) {
		t.Errorf("the SQLite file was changed or moved: %v", err)
	}
	if m := migrated(t, path); len(m) != 0 {
		t.Errorf("renamed: %v", m)
	}
	pg := db2(t, url)
	if empty, err := dbcopy.Empty(context.Background(), pg); err != nil || !empty {
		t.Errorf("PostgreSQL holds part of the library: %v", err)
	}
	if n := len(storetest.Read(t, pg, func(tx store.Tx) ([]domain.StylePreset, error) {
		return tx.ListStylePresets()
	})); n != len(store.BuiltinStylePresets) {
		t.Errorf("%d presets after the rollback", n)
	}
}

func TestSQLiteWithoutURL(t *testing.T) {
	path := filepath.Join(t.TempDir(), "x.db")
	db, logs := open(t, dbopen.Config{SQLitePath: path, SQLiteImport: true})
	defer db.Close()
	if db.Backend() != "SQLite" || !strings.Contains(logs, fmt.Sprintf("schemaVersion=%d", store.SchemaVersion)) {
		t.Errorf("backend %s, logs:\n%s", db.Backend(), logs)
	}
	if _, err := os.Stat(path); err != nil {
		t.Error(err)
	}
}

func TestTargets(t *testing.T) {
	for in, want := range map[string]dbopen.Target{
		"postgres://u:p@h/db":  {PostgresURL: "postgres://u:p@h/db"},
		"postgresql://h/db":    {PostgresURL: "postgresql://h/db"},
		"/data/codeatrophy.db": {SQLitePath: "/data/codeatrophy.db"},
		" relative/path.db ":   {SQLitePath: "relative/path.db"},
		"mysql://u:p@h/db":     {},
		"":                     {},
	} {
		got, err := dbopen.ParseTarget(in)
		if got != want || (err != nil) != (want == dbopen.Target{}) {
			t.Errorf("%q: %+v %v", in, got, err)
		}
	}
	if s := (dbopen.Target{PostgresURL: "postgres://u:secret@h/db"}).String(); strings.Contains(s, "secret") {
		t.Errorf("String shows the password: %s", s)
	}
	dir := t.TempDir()
	link := filepath.Join(dir, "link.db")
	os.WriteFile(filepath.Join(dir, "a.db"), nil, 0o600)
	os.Symlink(filepath.Join(dir, "a.db"), link)
	same := [][2]string{
		{filepath.Join(dir, "a.db"), link},
		{"postgres://u:p@Host:5432/db?sslmode=disable", "postgres://other:q@host/db"},
	}
	differ := [][2]string{
		{filepath.Join(dir, "a.db"), filepath.Join(dir, "b.db")},
		{"postgres://h/db1", "postgres://h/db2"},
		{"postgres://h:5432/db", "postgres://h:5433/db"},
		{"postgres://h/db", filepath.Join(dir, "a.db")},
	}
	for _, p := range same {
		a, _ := dbopen.ParseTarget(p[0])
		b, _ := dbopen.ParseTarget(p[1])
		if !dbopen.Same(a, b) {
			t.Errorf("%s and %s are the same database", p[0], p[1])
		}
	}
	for _, p := range differ {
		a, _ := dbopen.ParseTarget(p[0])
		b, _ := dbopen.ParseTarget(p[1])
		if dbopen.Same(a, b) {
			t.Errorf("%s and %s are different databases", p[0], p[1])
		}
	}
}

// With automatic migration off, a database that needs migrating stops
// startup with what to run, and nothing is created or changed.
func TestManualMigration(t *testing.T) {
	ctx := context.Background()
	quiet := slog.New(slog.DiscardHandler)
	wantHelp := func(t *testing.T, err error, version string) {
		t.Helper()
		for _, want := range []string{"CODEATROPHY_DB_AUTO_MIGRATE=off", version, fmt.Sprintf("expects version %d", store.SchemaVersion),
			"run codeatrophy db migrate (with Compose: docker compose run --rm app db migrate)",
			"CODEATROPHY_DB_AUTO_MIGRATE=on"} {
			if err == nil || !strings.Contains(err.Error(), want) {
				t.Errorf("missing %q in: %v", want, err)
			}
		}
		if !errors.Is(err, store.ErrMigrationNeeded) {
			t.Errorf("not ErrMigrationNeeded: %v", err)
		}
	}
	t.Run("SQLite", func(t *testing.T) {
		path := filepath.Join(t.TempDir(), "codeatrophy.db")
		cfg := dbopen.Config{SQLitePath: path, ManualMigration: true, Logger: quiet}
		_, err := dbopen.Open(ctx, cfg)
		wantHelp(t, err, "has no schema yet (version 0)")
		if _, err := os.Stat(path); !os.IsNotExist(err) {
			t.Error("the database file was created")
		}
		db, err := dbopen.OpenTarget(ctx, dbopen.Target{SQLitePath: path}, quiet) // db migrate
		if err != nil {
			t.Fatal(err)
		}
		db.Close()
		db, err = dbopen.Open(ctx, cfg)
		if err != nil {
			t.Fatalf("a migrated database: %v", err)
		}
		db.Close()
	})
	t.Run("PostgreSQL", func(t *testing.T) {
		url := pgtest.URL(t)
		path, _ := sqliteLibrary(t, t.TempDir())
		cfg := dbopen.Config{DatabaseURL: url, SQLitePath: path, SQLiteImport: true, ManualMigration: true, Logger: quiet}
		_, err := dbopen.Open(ctx, cfg)
		wantHelp(t, err, "has no schema yet (version 0)")
		if st, err := dbopen.Inspect(ctx, dbopen.Target{PostgresURL: url}); err != nil || st.Version != 0 {
			t.Errorf("PostgreSQL was changed: %+v %v", st, err)
		}
		db2(t, url) // db migrate
		// The empty, migrated database does not take the SQLite library
		// over at startup: that would migrate and rename the file.
		before, _ := os.ReadFile(path)
		_, err = dbopen.Open(ctx, cfg)
		for _, want := range []string{"is not imported", "codeatrophy db copy --from " + path + " --to configured",
			"docker compose run --rm app db copy --from " + path + " --to configured", "CODEATROPHY_DB_AUTO_MIGRATE=on",
			"CODEATROPHY_SQLITE_IMPORT=off"} {
			if err == nil || !strings.Contains(err.Error(), want) {
				t.Errorf("missing %q in: %v", want, err)
			}
		}
		if after, _ := os.ReadFile(path); !bytes.Equal(before, after) {
			t.Error("the SQLite file was changed or moved")
		}
		if empty, err := dbcopy.Empty(ctx, db2(t, url)); err != nil || !empty {
			t.Errorf("PostgreSQL is not empty: %v", err)
		}
		// Without the import it starts, empty.
		noImport := cfg
		noImport.SQLiteImport = false
		db, err := dbopen.Open(ctx, noImport)
		if err != nil {
			t.Fatal(err)
		}
		db.Close()
		// Once PostgreSQL holds data the file is ignored, as with automatic
		// migration.
		storetest.Write(t, db2(t, url), func(tx store.Tx) error { return tx.SetSetting("k", "v") })
		var logs bytes.Buffer
		cfg.Logger = slog.New(slog.NewTextHandler(&logs, nil))
		db, err = dbopen.Open(ctx, cfg)
		if err != nil {
			t.Fatal(err)
		}
		db.Close()
		if !strings.Contains(logs.String(), "was ignored") {
			t.Errorf("logs: %s", logs.String())
		}
	})
}
