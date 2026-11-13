// Package dbopen opens the configured database: SQLite at a file path, or
// PostgreSQL at a postgres:// URL. Opening applies pending migrations, and
// a PostgreSQL database that holds no library data takes over an existing
// SQLite database once (see Open).
package dbopen

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"codeatrophy/internal/store"
	"codeatrophy/internal/store/dbcopy"
	"codeatrophy/internal/store/postgres"
	"codeatrophy/internal/store/sqlite"
)

// DB is an open database of either backend.
type DB interface {
	store.Store
	store.Bulk
}

// Target is a database location: a SQLite file or a PostgreSQL URL.
type Target struct {
	SQLitePath  string
	PostgresURL string
}

// ParseTarget reads a database location given on the command line: a
// postgres:// or postgresql:// URL, or else a SQLite file path.
func ParseTarget(s string) (Target, error) {
	s = strings.TrimSpace(s)
	switch {
	case s == "":
		return Target{}, errors.New("no database given")
	case postgres.IsURL(s):
		return Target{PostgresURL: s}, nil
	case strings.Contains(s, "://"):
		return Target{}, errors.New("a database is a SQLite file path or a postgres:// URL")
	}
	return Target{SQLitePath: s}, nil
}

// String describes the target without a password.
func (t Target) String() string {
	if t.PostgresURL != "" {
		return "PostgreSQL " + postgres.Redact(t.PostgresURL)
	}
	return "SQLite " + t.SQLitePath
}

// Same reports whether a and b name the same database: the same file, or
// the same server and database name.
func Same(a, b Target) bool {
	if (a.PostgresURL == "") != (b.PostgresURL == "") {
		return false
	}
	if a.PostgresURL == "" {
		return canonicalPath(a.SQLitePath) == canonicalPath(b.SQLitePath)
	}
	ca, errA := pgx.ParseConfig(a.PostgresURL)
	cb, errB := pgx.ParseConfig(b.PostgresURL)
	if errA != nil || errB != nil {
		return a.PostgresURL == b.PostgresURL
	}
	return strings.EqualFold(ca.Host, cb.Host) && ca.Port == cb.Port && ca.Database == cb.Database
}

func canonicalPath(p string) string {
	abs, err := filepath.Abs(p)
	if err != nil {
		return p
	}
	if real, err := filepath.EvalSymlinks(abs); err == nil {
		return real
	}
	return abs
}

// OpenTarget opens the database, applying pending migrations, and logs the
// backend and schema version. A SQLite file is created if missing.
func OpenTarget(ctx context.Context, t Target, log *slog.Logger) (DB, error) {
	return openTarget(ctx, t, log, true)
}

// openTarget is OpenTarget; without migrate it opens only a database at
// this server's schema version and changes nothing otherwise.
func openTarget(ctx context.Context, t Target, log *slog.Logger, migrate bool) (DB, error) {
	var (
		db       DB
		location string
		err      error
	)
	if t.PostgresURL != "" {
		var pg *postgres.DB
		pg, err = postgres.Open(ctx, t.PostgresURL, postgres.Options{Logger: log, NoMigrate: !migrate})
		if err == nil {
			db, location = pg, pg.Location()
		}
	} else {
		var lite *sqlite.DB
		lite, err = sqlite.OpenWith(ctx, t.SQLitePath, sqlite.Options{Logger: log, NoMigrate: !migrate})
		if err == nil {
			db, location = lite, lite.Path()
		}
	}
	if err != nil {
		return nil, fmt.Errorf("%s: %w", t, err)
	}
	v, err := db.SchemaVersion(ctx)
	if err != nil {
		db.Close()
		return nil, err
	}
	log.Info("database open", "backend", db.Backend(), "database", location, "schemaVersion", v)
	return db, nil
}

// Inspect describes the database without changing it.
func Inspect(ctx context.Context, t Target) (store.Status, error) {
	if t.PostgresURL != "" {
		return postgres.Inspect(ctx, t.PostgresURL, postgres.Options{Wait: 10 * time.Second})
	}
	return sqlite.Inspect(ctx, t.SQLitePath)
}

// Config is the database configuration of the server.
type Config struct {
	// DatabaseURL selects PostgreSQL when set.
	DatabaseURL string
	// SQLitePath is the SQLite database: the database itself without
	// DatabaseURL, else the one to import.
	SQLitePath string
	// SQLiteImport enables the automatic import into PostgreSQL.
	SQLiteImport bool
	// ManualMigration (CODEATROPHY_DB_AUTO_MIGRATE=off) leaves the schema
	// alone: a database behind this server's version, or without a schema,
	// is not opened, and nothing is imported.
	ManualMigration bool
	Logger          *slog.Logger
}

// migrateCommand is how an operator migrates by hand.
const migrateCommand = "codeatrophy db migrate (with Compose: docker compose run --rm app db migrate)"

// manualMigrationError explains how to start a server whose database needs
// migrating while automatic migration is off.
func manualMigrationError(t Target, e *store.MigrationNeededError) error {
	at := fmt.Sprintf("is at schema version %d", e.Version)
	if e.Version == 0 {
		at = "has no schema yet (version 0)"
	}
	return &migrationError{e, fmt.Sprintf("automatic migration is off (CODEATROPHY_DB_AUTO_MIGRATE=off), and the "+
		"database (%s) %s while this server expects version %d (pending: %s). Back it up, then run %s and "+
		"start the server again, or set CODEATROPHY_DB_AUTO_MIGRATE=on to migrate at startup",
		t, at, e.Expected, strings.Join(e.Pending, ", "), migrateCommand)}
}

// migrationError is a message for the operator that matches the
// *store.MigrationNeededError it explains.
type migrationError struct {
	*store.MigrationNeededError
	msg string
}

func (e *migrationError) Error() string { return e.msg }
func (e *migrationError) Unwrap() error { return e.MigrationNeededError }

// Open opens the configured database. With PostgreSQL, when the database
// holds no library data (see dbcopy.IsEmpty), the import is enabled and a
// SQLite database exists at SQLitePath, its contents are copied in, the
// row counts checked, and the file (with its -wal and -shm files) renamed
// to <name>.migrated-<UTC timestamp>, so it stays as a backup and is never
// imported twice. If the import fails nothing is imported, the file stays
// where it is, and Open fails. If PostgreSQL already holds data, a SQLite
// file there is left alone.
//
// With ManualMigration, Open changes no schema: it fails (see
// manualMigrationError) unless the database is at this server's version,
// and instead of importing a SQLite database into an empty PostgreSQL one,
// which would migrate the SQLite file, it fails with how to copy it by
// hand.
func Open(ctx context.Context, cfg Config) (DB, error) {
	log := cfg.Logger
	if log == nil {
		log = slog.New(slog.DiscardHandler)
	}
	t := Target{SQLitePath: cfg.SQLitePath}
	if cfg.DatabaseURL != "" {
		t = Target{PostgresURL: cfg.DatabaseURL}
	}
	db, err := openTarget(ctx, t, log, !cfg.ManualMigration)
	var mn *store.MigrationNeededError
	if errors.As(err, &mn) {
		return nil, manualMigrationError(t, mn)
	}
	if err != nil {
		return nil, err
	}
	if t.PostgresURL != "" && cfg.SQLiteImport && cfg.SQLitePath != "" {
		if err := importSQLite(ctx, db, cfg.SQLitePath, cfg.ManualMigration, log); err != nil {
			db.Close()
			return nil, err
		}
	}
	return db, nil
}

func importSQLite(ctx context.Context, dst DB, path string, manual bool, log *slog.Logger) error {
	info, err := os.Stat(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("SQLite database to import: %w", err)
	}
	if info.IsDir() {
		return fmt.Errorf("SQLite database to import: %s is a directory", path)
	}
	empty, err := dbcopy.Empty(ctx, dst)
	if err != nil {
		return err
	}
	ignored := func() {
		log.Info("PostgreSQL already holds a library, so the SQLite database there was ignored; "+
			"use codeatrophy db copy to copy it over explicitly", "sqlite", path)
	}
	if !empty {
		ignored()
		return nil
	}
	if manual {
		copyCmd := "codeatrophy db copy --from " + path + " --to configured"
		return fmt.Errorf("automatic migration is off (CODEATROPHY_DB_AUTO_MIGRATE=off), so the SQLite database %s "+
			"is not imported into the empty PostgreSQL database at startup. Copy it with %s (with Compose: "+
			"docker compose run --rm app db %s), which migrates the SQLite file first and writes a backup next to "+
			"it; or set CODEATROPHY_DB_AUTO_MIGRATE=on for one start to import it automatically; or set "+
			"CODEATROPHY_SQLITE_IMPORT=off to start with an empty library", path, copyCmd,
			strings.TrimPrefix(copyCmd, "codeatrophy db "))
	}
	fail := func(err error) error {
		return fmt.Errorf("importing the SQLite database %s into PostgreSQL failed and nothing was imported; "+
			"the SQLite file stays where it is. Fix the cause and restart, set CODEATROPHY_SQLITE_IMPORT=off to "+
			"start with an empty PostgreSQL database, or unset CODEATROPHY_DATABASE_URL to keep using SQLite: %w",
			path, err)
	}
	log.Info("PostgreSQL holds no library yet; importing the SQLite database", "sqlite", path)
	src, err := sqlite.OpenWith(ctx, path, sqlite.Options{Logger: log})
	if err != nil {
		return fail(err)
	}
	counts, err := dbcopy.Copy(ctx, src, dst, dbcopy.Options{})
	// Closing checkpoints the write-ahead log into the database file.
	if cerr := src.Close(); err == nil && cerr != nil {
		log.Warn("closing the imported SQLite database", "error", cerr.Error())
	}
	if errors.Is(err, dbcopy.ErrNotEmpty) {
		ignored() // another process imported first
		return nil
	}
	if err != nil {
		return fail(err)
	}
	log.Info("imported the SQLite database into PostgreSQL: "+dbcopy.Summary(counts), "sqlite", path)
	renamed, err := renameImported(path, time.Now())
	if err != nil {
		// The import is committed: PostgreSQL now holds data, so the file
		// is not imported again anyway.
		log.Warn("could not rename the imported SQLite database; it stays where it is and is ignored from now on",
			"sqlite", path, "error", err.Error())
		return nil
	}
	log.Info("renamed the imported SQLite database, which is kept as a backup and not imported again",
		"from", path, "to", renamed)
	return nil
}

// MigratedSuffix starts the suffix of an imported SQLite file's new name.
const MigratedSuffix = ".migrated-"

// renameImported renames the database file and its -wal and -shm files
// with a .migrated-<UTC timestamp> suffix, and returns the database file's
// new path.
func renameImported(path string, now time.Time) (string, error) {
	suffix := MigratedSuffix + now.UTC().Format("20060102T150405Z")
	newPath := path + suffix
	if err := os.Rename(path, newPath); err != nil {
		return "", err
	}
	for _, ext := range []string{"-wal", "-shm"} {
		if _, err := os.Stat(path + ext); err == nil {
			if err := os.Rename(path+ext, path+ext+suffix); err != nil {
				return newPath, err
			}
		}
	}
	return newPath, nil
}
