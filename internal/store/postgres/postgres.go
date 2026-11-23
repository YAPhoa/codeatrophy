// Package postgres implements store.Store on PostgreSQL using the pure-Go
// pgx driver. It behaves like the SQLite store as seen through the store
// interface: same ids, timestamps (Unix seconds), ordering, limits and
// search rules. Write transactions are serialised, as SQLite serialises its
// writers: within the process a writer waits for its turn before it takes a
// pooled connection, and then takes an advisory lock that serialises it with
// writers of other processes.
package postgres

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"embed"
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"net/url"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/stdlib"

	"codeatrophy/internal/store"
	"codeatrophy/internal/store/internal/sqlrow"
)

//go:embed migrations/*.sql
var embeddedMigrations embed.FS

// migrationFS holds the migrations in its directory "migrations"; tests
// replace it to add one after the latest.
var migrationFS fs.FS = embeddedMigrations

// Advisory lock keys. Every write transaction holds writeLock until it ends;
// a migrating process holds migrateLock for the whole migrate step.
const (
	writeLock   int64 = 0x636f64656174_0001 // "codeat" 1
	migrateLock int64 = 0x636f64656174_0002
)

// Defaults for Options.
const (
	DefaultWait     = time.Minute
	DefaultMaxConns = 10
)

// DB is a PostgreSQL-backed store.Store.
type DB struct {
	location string // URL without the password
	log      *slog.Logger
	pool     *sql.DB
	// writeGate holds one token while a write transaction of this process
	// runs. Writers queue on it rather than on the advisory lock, so a
	// queue of writers holds no pooled connections and reads still get one.
	writeGate chan struct{}
}

var (
	_ store.Store = (*DB)(nil)
	_ store.Bulk  = (*DB)(nil)
)

// Options configure Open.
type Options struct {
	// Logger receives one line per migration applied and a note while
	// waiting for the server. Nil discards them.
	Logger *slog.Logger
	// Wait bounds how long Open waits for the server to accept
	// connections: DefaultWait when zero.
	Wait time.Duration
	// MaxConns is the connection pool size: DefaultMaxConns when zero.
	MaxConns int
	// NoMigrate opens the database only if it is at this server's schema
	// version, and otherwise fails with a *store.MigrationNeededError
	// without changing anything.
	NoMigrate bool
}

// IsURL reports whether s is a PostgreSQL connection URL.
func IsURL(s string) bool {
	u, err := url.Parse(s)
	return err == nil && (u.Scheme == "postgres" || u.Scheme == "postgresql")
}

// Redact returns the URL with its password replaced, for logs and messages.
func Redact(rawURL string) string {
	u, err := url.Parse(rawURL)
	if err != nil {
		return "(unparsable URL)"
	}
	return u.Redacted()
}

// Open connects to the database at the postgres:// URL, waiting a bounded
// time for the server to accept connections, and applies pending
// migrations (see Options.NoMigrate).
func Open(ctx context.Context, rawURL string, opts Options) (*DB, error) {
	db, err := connect(ctx, rawURL, opts)
	if err != nil {
		return nil, err
	}
	check := db.migrate
	if opts.NoMigrate {
		check = db.checkVersion
	}
	if err := check(ctx); err != nil {
		db.pool.Close()
		return nil, err
	}
	return db, nil
}

func connect(ctx context.Context, rawURL string, opts Options) (*DB, error) {
	if !IsURL(rawURL) {
		return nil, errors.New("not a postgres:// or postgresql:// URL")
	}
	location := Redact(rawURL)
	cfg, err := pgx.ParseConfig(rawURL)
	if err != nil {
		// pgx leaves the password out of its parse errors.
		return nil, fmt.Errorf("PostgreSQL URL %s: %w", location, err)
	}
	if _, ok := cfg.RuntimeParams["application_name"]; !ok {
		cfg.RuntimeParams["application_name"] = "codeatrophy"
	}
	log := opts.Logger
	if log == nil {
		log = slog.New(slog.DiscardHandler)
	}
	wait := opts.Wait
	if wait <= 0 {
		wait = DefaultWait
	}
	conns := opts.MaxConns
	if conns <= 0 {
		conns = DefaultMaxConns
	}
	pool := stdlib.OpenDB(*cfg)
	pool.SetMaxOpenConns(conns)
	pool.SetMaxIdleConns(conns)
	pool.SetConnMaxIdleTime(5 * time.Minute)
	pool.SetConnMaxLifetime(time.Hour)
	db := &DB{location: location, log: log, pool: pool, writeGate: make(chan struct{}, 1)}
	if err := db.waitReady(ctx, wait); err != nil {
		pool.Close()
		return nil, err
	}
	return db, nil
}

// waitReady pings the server until it answers, the wait is over or ctx
// ends. Errors that waiting cannot fix (bad password, missing database) end
// it at once.
func (db *DB) waitReady(ctx context.Context, wait time.Duration) error {
	deadline := time.Now().Add(wait)
	logged := false
	for {
		pctx, cancel := context.WithTimeout(ctx, 5*time.Second)
		err := db.pool.PingContext(pctx)
		cancel()
		if err == nil {
			return nil
		}
		if ctx.Err() != nil {
			return ctx.Err()
		}
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && (strings.HasPrefix(pgErr.Code, "28") || pgErr.Code == "3D000") {
			// 28xxx: invalid authorisation; 3D000: no such database.
			return fmt.Errorf("connect to PostgreSQL at %s: %w", db.location, err)
		}
		if time.Now().After(deadline) {
			return fmt.Errorf("PostgreSQL at %s did not accept connections within %s: %w", db.location, wait, err)
		}
		if !logged {
			db.log.Info("waiting for PostgreSQL to accept connections", "database", db.location, "error", err.Error())
			logged = true
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(time.Second):
		}
	}
}

// Location is the database URL without its password.
func (db *DB) Location() string { return db.location }

// Close closes the connection pool.
func (db *DB) Close() error { return db.pool.Close() }

// Read implements store.Store: a read-only transaction on one snapshot.
func (db *DB) Read(ctx context.Context, fn func(store.Tx) error) error {
	return db.run(ctx, true, func(t *tx) error { return fn(t) })
}

// Write implements store.Store. Writers run one at a time, as on SQLite,
// and each one sees everything committed before it started: a writer first
// waits for the other writers of this process, without holding a
// connection, and then takes the write lock, which other processes' writers
// hold too. fn must not start another Write.
func (db *DB) Write(ctx context.Context, fn func(store.Tx) error) error {
	return db.run(ctx, false, func(t *tx) error { return fn(t) })
}

// run runs fn in a transaction. A write waits on the write gate before it
// takes a connection, so queued writers cannot use up the pool, and keeps
// the gate until its transaction has ended; it then waits on the advisory
// write lock for writers of other processes.
func (db *DB) run(ctx context.Context, readOnly bool, fn func(*tx) error) error {
	opts := &sql.TxOptions{}
	if readOnly {
		opts = &sql.TxOptions{ReadOnly: true, Isolation: sql.LevelRepeatableRead}
	} else {
		select {
		case db.writeGate <- struct{}{}:
		case <-ctx.Done():
			return fmt.Errorf("write lock: %w", ctx.Err())
		}
		// Deferred first, so released after the commit or rollback below,
		// on a panic too.
		defer func() { <-db.writeGate }()
	}
	sqlTx, err := db.pool.BeginTx(ctx, opts)
	if err != nil {
		return fmt.Errorf("begin transaction: %w", err)
	}
	return sqlrow.InTx(ctx, sqlTx, func() error {
		t := &tx{ctx: ctx, tx: sqlTx}
		if !readOnly {
			if _, err := t.exec(`SELECT pg_advisory_xact_lock($1)`, writeLock); err != nil {
				return fmt.Errorf("write lock: %w", err)
			}
		}
		return fn(t)
	})
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
		b, err := fs.ReadFile(migrationFS, "migrations/"+name)
		if err != nil {
			return nil, err
		}
		out = append(out, migration{version: v, name: name, sql: string(b)})
	}
	slices.SortFunc(out, func(a, b migration) int { return a.version - b.version })
	return out, nil
}

// MigrationVersions are the versions of the embedded migrations, in order.
// The first one builds the whole schema up to its version.
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

func newerError(current, latest int) error {
	return fmt.Errorf("database schema version %d is newer than this server supports (%d): %w", current, latest,
		store.ErrNewerSchema)
}

// checkVersion fails unless the database is at the latest version. It
// writes nothing.
func (db *DB) checkVersion(ctx context.Context) error {
	migs, err := loadMigrations()
	if err != nil {
		return err
	}
	var (
		current int
		exists  bool
	)
	if err := db.pool.QueryRowContext(ctx, `SELECT to_regclass('schema_migrations') IS NOT NULL`).Scan(&exists); err != nil {
		return err
	}
	if exists {
		if current, err = db.SchemaVersion(ctx); err != nil {
			return err
		}
	}
	latest := migs[len(migs)-1].version
	switch {
	case current > latest:
		return newerError(current, latest)
	case store.TooOld(current):
		return store.OlderSchemaError(current)
	case current < latest:
		e := &store.MigrationNeededError{Version: current, Expected: latest}
		for _, m := range migs {
			if m.version > current {
				e.Pending = append(e.Pending, m.name)
			}
		}
		return e
	}
	return nil
}

// migrate applies pending migrations, each in its own transaction, while
// holding the migration lock so that two processes cannot both migrate.
func (db *DB) migrate(ctx context.Context) error {
	migs, err := loadMigrations()
	if err != nil {
		return err
	}
	conn, err := db.pool.Conn(ctx)
	if err != nil {
		return err
	}
	defer conn.Close()
	if _, err := conn.ExecContext(ctx, `SELECT pg_advisory_lock($1)`, migrateLock); err != nil {
		return fmt.Errorf("migration lock: %w", err)
	}
	defer func() {
		// Unlock even when ctx has ended; closing the connection would
		// release the lock too, but the pool keeps it open.
		uctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if _, err := conn.ExecContext(uctx, `SELECT pg_advisory_unlock($1)`, migrateLock); err != nil {
			_ = conn.Raw(func(any) error { return driver.ErrBadConn })
		}
	}()
	if _, err := conn.ExecContext(ctx, `CREATE TABLE IF NOT EXISTS schema_migrations (
		version integer PRIMARY KEY, name text NOT NULL, applied_at bigint NOT NULL)`); err != nil {
		return fmt.Errorf("migrations table: %w", err)
	}
	var current int
	if err := conn.QueryRowContext(ctx, `SELECT COALESCE(MAX(version), 0) FROM schema_migrations`).Scan(&current); err != nil {
		return err
	}
	latest := migs[len(migs)-1].version
	if current > latest {
		return newerError(current, latest)
	}
	if store.TooOld(current) {
		return store.OlderSchemaError(current)
	}
	for _, m := range migs {
		if m.version <= current {
			continue
		}
		if err := applyMigration(ctx, conn, m); err != nil {
			return fmt.Errorf("migration %s: %w", m.name, err)
		}
		db.log.Info("applied database migration", "backend", "PostgreSQL", "migration", m.name, "version", m.version)
	}
	return nil
}

func applyMigration(ctx context.Context, conn *sql.Conn, m migration) error {
	tx, err := conn.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	// Running writers of another process finish first.
	if _, err := tx.ExecContext(ctx, `SELECT pg_advisory_xact_lock($1)`, writeLock); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, m.sql); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO schema_migrations (version, name, applied_at)
		VALUES ($1, $2, extract(epoch FROM now())::bigint)`, m.version, m.name); err != nil {
		return err
	}
	return tx.Commit()
}

// SchemaVersion implements store.Bulk.
func (db *DB) SchemaVersion(ctx context.Context) (int, error) {
	var v int
	err := db.pool.QueryRowContext(ctx, `SELECT COALESCE(MAX(version), 0) FROM schema_migrations`).Scan(&v)
	return v, err
}

// Backend implements store.Bulk.
func (db *DB) Backend() string { return "PostgreSQL" }

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

// params collects the arguments of a query built piece by piece; add
// returns the placeholder of the value.
type params struct{ args []any }

func (p *params) add(v any) string {
	p.args = append(p.args, v)
	return "$" + strconv.Itoa(len(p.args))
}

// Value helpers. Timestamps are stored as Unix seconds; free text is bytea.

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

// text returns s for a bytea column; never nil, which would be NULL.
func text(s string) []byte {
	if s == "" {
		return []byte{}
	}
	return []byte(s)
}

// nullText returns *p for a nullable bytea column.
func nullText(p *string) any {
	if p == nil {
		return nil
	}
	return text(*p)
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
