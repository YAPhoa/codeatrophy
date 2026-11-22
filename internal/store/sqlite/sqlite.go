// Package sqlite implements store.Store on SQLite using the pure-Go
// modernc.org/sqlite driver, in WAL mode with FTS5 search.
package sqlite

import (
	"context"
	"database/sql"
	"embed"
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strconv"
	"strings"
	"time"

	_ "modernc.org/sqlite" // driver

	"codeatrophy/internal/store"
)

//go:embed migrations/*.sql
var embeddedMigrations embed.FS

// migrationFS holds the migrations in its directory "migrations"; tests
// replace it to add one after the latest.
var migrationFS fs.FS = embeddedMigrations

// DB is a SQLite-backed store.Store.
type DB struct {
	path   string
	log    *slog.Logger
	writer *sql.DB
	reader *sql.DB
	backed string // pre-migration backup written by Open, if any
}

var (
	_ store.Store = (*DB)(nil)
	_ store.Bulk  = (*DB)(nil)
)

// Options configure Open.
type Options struct {
	// Logger receives one line per migration applied and per backup
	// written. Nil discards them.
	Logger *slog.Logger
	// NoMigrate opens the database only if it is at this server's schema
	// version, and otherwise fails with a *store.MigrationNeededError
	// without changing anything (a missing file is not created).
	NoMigrate bool
}

// Open opens (creating if needed) the database file at path and applies
// pending migrations.
func Open(ctx context.Context, path string) (*DB, error) { return OpenWith(ctx, path, Options{}) }

// OpenWith is Open with options.
func OpenWith(ctx context.Context, path string, opts Options) (*DB, error) {
	abs, err := filepath.Abs(path)
	if err != nil {
		return nil, err
	}
	log := opts.Logger
	if log == nil {
		log = slog.New(slog.DiscardHandler)
	}
	if opts.NoMigrate {
		if _, err := os.Stat(abs); errors.Is(err, os.ErrNotExist) {
			return nil, migrationNeeded(0)
		}
	}
	writer, err := sql.Open("sqlite", dsn(abs, "immediate", false))
	if err != nil {
		return nil, err
	}
	writer.SetMaxOpenConns(1)
	writer.SetConnMaxIdleTime(0)
	if err := writer.PingContext(ctx); err != nil {
		writer.Close()
		return nil, fmt.Errorf("open database: %w", err)
	}
	db := &DB{path: abs, log: log, writer: writer}
	check := db.migrate
	if opts.NoMigrate {
		check = db.checkVersion
	}
	if err := check(ctx); err != nil {
		writer.Close()
		return nil, err
	}
	reader, err := sql.Open("sqlite", dsn(abs, "deferred", true))
	if err != nil {
		writer.Close()
		return nil, err
	}
	reader.SetMaxOpenConns(max(4, runtime.NumCPU()))
	db.reader = reader
	return db, nil
}

func dsn(abs, txlock string, readOnly bool) string {
	q := url.Values{}
	q.Add("_pragma", "busy_timeout(10000)")
	q.Add("_pragma", "foreign_keys(1)")
	q.Add("_pragma", "journal_mode(WAL)")
	q.Add("_pragma", "synchronous(NORMAL)")
	if readOnly {
		q.Add("_pragma", "query_only(1)")
	}
	q.Set("_txlock", txlock)
	return "file:" + abs + "?" + q.Encode()
}

// Path is the absolute path of the database file.
func (db *DB) Path() string { return db.path }

// Backup is the path of the backup Open wrote before migrating, or "".
func (db *DB) Backup() string { return db.backed }

// Close closes the database.
func (db *DB) Close() error {
	return errors.Join(db.reader.Close(), db.writer.Close())
}

// Read implements store.Store.
func (db *DB) Read(ctx context.Context, fn func(store.Tx) error) error {
	return db.run(ctx, db.reader, true, func(t *tx) error { return fn(t) })
}

// Write implements store.Store.
func (db *DB) Write(ctx context.Context, fn func(store.Tx) error) error {
	return db.run(ctx, db.writer, false, func(t *tx) error { return fn(t) })
}

func (db *DB) run(ctx context.Context, conn *sql.DB, readOnly bool, fn func(*tx) error) (err error) {
	sqlTx, err := conn.BeginTx(ctx, &sql.TxOptions{ReadOnly: readOnly})
	if err != nil {
		return fmt.Errorf("begin transaction: %w", err)
	}
	defer func() {
		if p := recover(); p != nil {
			_ = sqlTx.Rollback()
			panic(p)
		}
		if err != nil {
			_ = sqlTx.Rollback()
			return
		}
		if cerr := sqlTx.Commit(); cerr != nil {
			if ctx.Err() != nil {
				// database/sql rolls the transaction back when its context
				// ends; report that rather than the failed commit.
				err = ctx.Err()
				return
			}
			err = fmt.Errorf("commit: %w", cerr)
		}
	}()
	return fn(&tx{ctx: ctx, tx: sqlTx})
}

type migration struct {
	version int
	name    string
	sql     string
	// noForeignKeys is set for a migration whose first line is
	// "-- foreign_keys=off": one that rebuilds a table other tables refer
	// to. It runs with foreign key enforcement off, as SQLite's procedure
	// for such changes asks, so that dropping the old table deletes nothing
	// and changes no reference, and it commits only if PRAGMA
	// foreign_key_check then finds every reference intact.
	noForeignKeys bool
}

// noForeignKeysLine marks a migration that runs with foreign key
// enforcement off.
const noForeignKeysLine = "-- foreign_keys=off"

func loadMigrations() ([]migration, error) {
	entries, err := fs.ReadDir(migrationFS, "migrations")
	if err != nil {
		return nil, err
	}
	var out []migration
	for _, e := range entries {
		name := e.Name()
		num, _, ok := strings.Cut(name, "_")
		if !ok {
			return nil, fmt.Errorf("bad migration name %q", name)
		}
		v, err := strconv.Atoi(num)
		if err != nil {
			return nil, fmt.Errorf("bad migration name %q", name)
		}
		b, err := fs.ReadFile(migrationFS, "migrations/"+name)
		if err != nil {
			return nil, err
		}
		first, _, _ := strings.Cut(string(b), "\n")
		out = append(out, migration{version: v, name: name, sql: string(b),
			noForeignKeys: strings.TrimSpace(first) == noForeignKeysLine})
	}
	slices.SortFunc(out, func(a, b migration) int { return a.version - b.version })
	return out, nil
}

// MigrationVersions are the versions of the embedded migrations, in order.
func MigrationVersions() []int {
	migs, err := loadMigrations()
	if err != nil {
		panic(err)
	}
	out := make([]int, len(migs))
	for i, m := range migs {
		out[i] = m.version
	}
	return out
}

// newerError is the error for a database written by a newer server.
func newerError(current, latest int) error {
	return fmt.Errorf("database schema version %d is newer than this server supports (%d): %w", current, latest,
		store.ErrNewerSchema)
}

// migrationNeeded describes a database at version current.
func migrationNeeded(current int) error {
	migs, err := loadMigrations()
	if err != nil {
		return err
	}
	e := &store.MigrationNeededError{Version: current, Expected: migs[len(migs)-1].version}
	for _, m := range migs {
		if m.version > current {
			e.Pending = append(e.Pending, m.name)
		}
	}
	return e
}

// checkVersion fails unless the database is at the latest version. It
// writes nothing.
func (db *DB) checkVersion(ctx context.Context) error {
	var n, current int
	if err := db.writer.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'`).Scan(&n); err != nil {
		return err
	}
	if n > 0 {
		var err error
		if current, err = db.version(ctx, db.writer); err != nil {
			return err
		}
	}
	latest := MigrationVersions()
	switch last := latest[len(latest)-1]; {
	case current > last:
		return newerError(current, last)
	case store.TooOld(current):
		return store.OlderSchemaError(current)
	case current < last:
		return migrationNeeded(current)
	}
	return nil
}

func (db *DB) migrate(ctx context.Context) error {
	migs, err := loadMigrations()
	if err != nil {
		return err
	}
	if _, err := db.writer.ExecContext(ctx, `CREATE TABLE IF NOT EXISTS schema_migrations (
		version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)`); err != nil {
		return fmt.Errorf("migrations table: %w", err)
	}
	current, err := db.version(ctx, db.writer)
	if err != nil {
		return err
	}
	latest := migs[len(migs)-1].version
	if current > latest {
		return newerError(current, latest)
	}
	if store.TooOld(current) {
		return store.OlderSchemaError(current)
	}
	if current > 0 && current < latest {
		if err := db.backup(ctx, current); err != nil {
			return err
		}
	}
	for _, m := range migs {
		if m.version <= current {
			continue
		}
		applied, err := db.apply(ctx, m)
		if err != nil {
			return fmt.Errorf("migration %s: %w", m.name, err)
		}
		if applied {
			db.log.Info("applied database migration", "backend", "SQLite", "migration", m.name, "version", m.version)
		}
	}
	return nil
}

// apply runs one migration in its own transaction. It reports false when
// another process applied it first.
func (db *DB) apply(ctx context.Context, m migration) (applied bool, err error) {
	// The writer's only connection, held for the whole migration so that
	// the foreign key setting applies to the transaction.
	conn, err := db.writer.Conn(ctx)
	if err != nil {
		return false, err
	}
	defer conn.Close()
	if m.noForeignKeys {
		// The setting cannot change inside a transaction.
		if _, err := conn.ExecContext(ctx, `PRAGMA foreign_keys = OFF`); err != nil {
			return false, err
		}
		defer func() {
			if _, rerr := conn.ExecContext(context.WithoutCancel(ctx), `PRAGMA foreign_keys = ON`); rerr != nil && err == nil {
				err = rerr
			}
		}()
	}
	tx, err := conn.BeginTx(ctx, nil) // BEGIN IMMEDIATE: one migrating process at a time
	if err != nil {
		return false, err
	}
	defer tx.Rollback()
	var current int
	if err := tx.QueryRowContext(ctx, `SELECT COALESCE(MAX(version), 0) FROM schema_migrations`).Scan(&current); err != nil {
		return false, err
	}
	if current >= m.version {
		return false, nil
	}
	if _, err := tx.ExecContext(ctx, m.sql); err != nil {
		return false, err
	}
	if m.noForeignKeys {
		if err := checkForeignKeys(ctx, tx); err != nil {
			return false, err
		}
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)`,
		m.version, m.name, time.Now().Unix()); err != nil {
		return false, err
	}
	return true, tx.Commit()
}

// checkForeignKeys fails if any row refers to a row that does not exist.
func checkForeignKeys(ctx context.Context, tx *sql.Tx) error {
	rows, err := tx.QueryContext(ctx, `PRAGMA foreign_key_check`)
	if err != nil {
		return err
	}
	defer rows.Close()
	if rows.Next() {
		var table, parent string
		var rowid sql.NullInt64
		var fk int
		if err := rows.Scan(&table, &rowid, &parent, &fk); err != nil {
			return err
		}
		return fmt.Errorf("a row of %s refers to a missing row of %s", table, parent)
	}
	return rows.Err()
}

func (db *DB) version(ctx context.Context, conn interface {
	QueryRowContext(context.Context, string, ...any) *sql.Row
}) (int, error) {
	var v int
	err := conn.QueryRowContext(ctx, `SELECT COALESCE(MAX(version), 0) FROM schema_migrations`).Scan(&v)
	return v, err
}

// SchemaVersion implements store.Bulk.
func (db *DB) SchemaVersion(ctx context.Context) (int, error) { return db.version(ctx, db.writer) }

// Backend implements store.Bulk.
func (db *DB) Backend() string { return "SQLite" }

// keepBackups is how many pre-migration backups are kept per database.
const keepBackups = 3

// BackupPrefix is the start of the file name of a pre-migration backup of
// the database at path; the schema version and a UTC timestamp follow, as in
// codeatrophy.db.backup-v4-20260301T100000Z.
func BackupPrefix(path string) string { return filepath.Base(path) + ".backup-v" }

// backup writes a consistent copy of the database, at schema version
// current, next to it before migrations change it, and removes all but the
// most recent backups.
func (db *DB) backup(ctx context.Context, current int) error {
	ts := time.Now().UTC().Format("20060102T150405Z")
	dst := filepath.Join(filepath.Dir(db.path), fmt.Sprintf("%s%d-%s", BackupPrefix(db.path), current, ts))
	if _, err := os.Stat(dst); err == nil {
		return fmt.Errorf("backup before migrating: %s already exists", dst)
	}
	if _, err := db.writer.ExecContext(ctx, `VACUUM INTO ?`, dst); err != nil {
		return fmt.Errorf("backup before migrating: %w", err)
	}
	db.backed = dst
	db.log.Info("backed up the database before migrating it", "backend", "SQLite", "version", current, "backup", dst)
	return pruneBackups(db.path, keepBackups)
}

// pruneBackups removes all but the newest keep pre-migration backups of the
// database at path.
func pruneBackups(path string, keep int) error {
	prefix := BackupPrefix(path)
	entries, err := os.ReadDir(filepath.Dir(path))
	if err != nil {
		return err
	}
	type backup struct{ name, ts string }
	var found []backup
	for _, e := range entries {
		rest, ok := strings.CutPrefix(e.Name(), prefix)
		if !ok || e.IsDir() {
			continue
		}
		if _, ts, ok := strings.Cut(rest, "-"); ok {
			found = append(found, backup{e.Name(), ts})
		}
	}
	slices.SortFunc(found, func(a, b backup) int { return strings.Compare(b.ts, a.ts) })
	for _, b := range found[min(keep, len(found)):] {
		if err := os.Remove(filepath.Join(filepath.Dir(path), b.name)); err != nil {
			return err
		}
	}
	return nil
}

// tx implements store.Tx.
type tx struct {
	ctx context.Context
	tx  *sql.Tx
}

func (t *tx) exec(q string, args ...any) (sql.Result, error) {
	return t.tx.ExecContext(t.ctx, q, args...)
}

func (t *tx) query(q string, args ...any) (*sql.Rows, error) {
	return t.tx.QueryContext(t.ctx, q, args...)
}

func (t *tx) queryRow(q string, args ...any) *sql.Row {
	return t.tx.QueryRowContext(t.ctx, q, args...)
}

// Time helpers: timestamps are stored as Unix seconds.

func toUnix(t time.Time) int64 { return t.UTC().Unix() }

func fromUnix(s int64) time.Time { return time.Unix(s, 0).UTC() }

func nullUnix(p *time.Time) any {
	if p == nil {
		return nil
	}
	return toUnix(*p)
}

func nullStr(p *string) any {
	if p == nil {
		return nil
	}
	return *p
}

func nullInt(p *int) any {
	if p == nil {
		return nil
	}
	return *p
}

func strPtr(ns sql.NullString) *string {
	if !ns.Valid {
		return nil
	}
	s := ns.String
	return &s
}

func intPtr(ni sql.NullInt64) *int {
	if !ni.Valid {
		return nil
	}
	v := int(ni.Int64)
	return &v
}

func boolInt(b bool) int {
	if b {
		return 1
	}
	return 0
}

// placeholders returns "?, ?, ..." for n parameters.
func placeholders(n int) string {
	if n <= 0 {
		return ""
	}
	return strings.Repeat("?, ", n-1) + "?"
}

func anyArgs(ss []string) []any {
	out := make([]any, len(ss))
	for i, s := range ss {
		out[i] = s
	}
	return out
}

// chunks splits ids into slices of at most n.
func chunks(ids []string, n int) [][]string {
	var out [][]string
	for len(ids) > n {
		out = append(out, ids[:n])
		ids = ids[n:]
	}
	if len(ids) > 0 {
		out = append(out, ids)
	}
	return out
}
