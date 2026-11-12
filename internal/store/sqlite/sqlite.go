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
	"net/url"
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
var migrationFS embed.FS

// DB is a SQLite-backed store.Store.
type DB struct {
	writer *sql.DB
	reader *sql.DB
}

var _ store.Store = (*DB)(nil)

// Open opens (creating if needed) the database file at path and applies
// pending migrations.
func Open(ctx context.Context, path string) (*DB, error) {
	abs, err := filepath.Abs(path)
	if err != nil {
		return nil, err
	}
	dsn := func(txlock string, readOnly bool) string {
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
	writer, err := sql.Open("sqlite", dsn("immediate", false))
	if err != nil {
		return nil, err
	}
	writer.SetMaxOpenConns(1)
	writer.SetConnMaxIdleTime(0)
	if err := writer.PingContext(ctx); err != nil {
		writer.Close()
		return nil, fmt.Errorf("open database: %w", err)
	}
	db := &DB{writer: writer}
	if err := db.migrate(ctx); err != nil {
		writer.Close()
		return nil, err
	}
	reader, err := sql.Open("sqlite", dsn("deferred", true))
	if err != nil {
		writer.Close()
		return nil, err
	}
	reader.SetMaxOpenConns(max(4, runtime.NumCPU()))
	db.reader = reader
	return db, nil
}

// Close closes the database.
func (db *DB) Close() error {
	return errors.Join(db.reader.Close(), db.writer.Close())
}

// Read implements store.Store.
func (db *DB) Read(ctx context.Context, fn func(store.Tx) error) error {
	return db.run(ctx, db.reader, true, fn)
}

// Write implements store.Store.
func (db *DB) Write(ctx context.Context, fn func(store.Tx) error) error {
	return db.run(ctx, db.writer, false, fn)
}

func (db *DB) run(ctx context.Context, conn *sql.DB, readOnly bool, fn func(store.Tx) error) (err error) {
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
}

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
		b, err := migrationFS.ReadFile("migrations/" + name)
		if err != nil {
			return nil, err
		}
		out = append(out, migration{version: v, name: name, sql: string(b)})
	}
	slices.SortFunc(out, func(a, b migration) int { return a.version - b.version })
	return out, nil
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
	var current int
	if err := db.writer.QueryRowContext(ctx, `SELECT COALESCE(MAX(version), 0) FROM schema_migrations`).Scan(&current); err != nil {
		return err
	}
	if latest := migs[len(migs)-1].version; current > latest {
		return fmt.Errorf("database schema version %d is newer than this server supports (%d)", current, latest)
	}
	for _, m := range migs {
		if m.version <= current {
			continue
		}
		tx, err := db.writer.BeginTx(ctx, nil)
		if err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, m.sql); err != nil {
			tx.Rollback()
			return fmt.Errorf("migration %s: %w", m.name, err)
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)`,
			m.version, m.name, time.Now().Unix()); err != nil {
			tx.Rollback()
			return err
		}
		if err := tx.Commit(); err != nil {
			return fmt.Errorf("migration %s: %w", m.name, err)
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
