package postgres

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"slices"
	"strings"
	"sync"
	"testing"
	"testing/fstest"
	"time"

	"codeatrophy/internal/store"
	"codeatrophy/internal/store/internal/sqlrow"
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
		cols, err := sqlrow.Strings(rows)
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
	t.Run("Behind", func(t *testing.T) {
		addMigration(t, laterMigration, `CREATE TABLE later (x integer);`)
		_, err := Open(ctx, url, Options{NoMigrate: true})
		if !errors.As(err, &mn) || mn.Version != store.SchemaVersion || mn.Expected != store.SchemaVersion+1 ||
			len(mn.Pending) != 1 {
			t.Fatalf("a database one version behind: %v", err)
		}
		var later bool
		if err := db.pool.QueryRow(`SELECT to_regclass('later') IS NOT NULL`).Scan(&later); err != nil || later {
			t.Errorf("the later migration ran: %v %v", later, err)
		}
		if v, _ := db.SchemaVersion(ctx); v != store.SchemaVersion {
			t.Errorf("the version moved to %d", v)
		}
	})
	if _, err := db.pool.Exec(`INSERT INTO schema_migrations (version, name, applied_at) VALUES (999, 'future', 0)`); err != nil {
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

// A database from before 1.0.0, at a version between 5 (the first
// PostgreSQL had) and 21, is refused, migrating or not, and left as it
// was: nothing is applied.
func TestOlderSchemaIsRefused(t *testing.T) {
	ctx := context.Background()
	url := pgtest.URL(t)
	db := open(t, url, nil)
	if err := db.Write(ctx, func(tx store.Tx) error { return tx.SetSetting("k", "v") }); err != nil {
		t.Fatal(err)
	}
	snapshot := func() string {
		var s string
		if err := db.pool.QueryRow(`SELECT (SELECT string_agg(version || ' ' || name, ', ' ORDER BY version) FROM schema_migrations)
			|| ' / ' || (SELECT string_agg(relname, ',' ORDER BY relname) FROM pg_class WHERE relnamespace = current_schema()::regnamespace)
			|| ' / ' || (SELECT string_agg(key || '=' || value, ',') FROM settings)`).Scan(&s); err != nil {
			t.Fatal(err)
		}
		return s
	}
	for _, v := range []int{5, 10, store.BaselineVersion - 1} {
		if _, err := db.pool.Exec(`DELETE FROM schema_migrations`); err != nil {
			t.Fatal(err)
		}
		if _, err := db.pool.Exec(`INSERT INTO schema_migrations (version, name, applied_at)
			SELECT i, lpad(i::text, 4, '0') || '_old.sql', 0 FROM generate_series(5, $1::integer) AS i`, v); err != nil {
			t.Fatal(err)
		}
		before := snapshot()
		for _, noMigrate := range []bool{false, true} {
			_, err := Open(ctx, url, Options{NoMigrate: noMigrate})
			if !errors.Is(err, store.ErrOlderSchema) || errors.Is(err, store.ErrMigrationNeeded) ||
				!strings.Contains(err.Error(), fmt.Sprintf("schema version %d is older", v)) ||
				!strings.Contains(err.Error(), "upgrade it with Codeatrophy 1.0.0 first") {
				t.Errorf("version %d, NoMigrate %v: %v", v, noMigrate, err)
			}
		}
		if after := snapshot(); after != before {
			t.Errorf("version %d: the database was changed:\n  %s\nwas\n  %s", v, after, before)
		}
		st, err := Inspect(ctx, url, Options{})
		if err != nil || st.Version != v || len(st.Pending) != 0 {
			t.Errorf("version %d: inspect %+v %v", v, st, err)
		}
	}
}

// A database the migrations before the baseline brought to the schema of
// 1.0.0 records their versions, 5 to 22. It opens with nothing applied and
// its record unchanged, migrating or not, as one the baseline built does.
func TestDatabaseUpgradedTo100OpensUnchanged(t *testing.T) {
	ctx := context.Background()
	url := pgtest.URL(t)
	db := open(t, url, nil)
	if _, err := db.pool.Exec(`DELETE FROM schema_migrations`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.pool.Exec(`INSERT INTO schema_migrations (version, name, applied_at)
		SELECT i, lpad(i::text, 4, '0') || '_old.sql', 0 FROM generate_series(5, $1::integer) AS i`, store.BaselineVersion); err != nil {
		t.Fatal(err)
	}
	for _, noMigrate := range []bool{false, true} {
		var logs bytes.Buffer
		cur, err := Open(ctx, url, Options{NoMigrate: noMigrate, Logger: slog.New(slog.NewTextHandler(&logs, nil))})
		if err != nil {
			t.Fatalf("NoMigrate %v: %v", noMigrate, err)
		}
		cur.Close()
		var n, first, last int
		if err := db.pool.QueryRow(`SELECT COUNT(*), MIN(version), MAX(version) FROM schema_migrations`).Scan(&n, &first, &last); err != nil {
			t.Fatal(err)
		}
		if n != store.BaselineVersion-4 || first != 5 || last != store.BaselineVersion || logs.Len() != 0 {
			t.Errorf("NoMigrate %v: %d migrations recorded, %d to %d; logged: %s", noMigrate, n, first, last, logs.String())
		}
	}
}

// appendSetting adds s to the comma-separated setting "order": a
// read-modify-write that loses entries unless writers run one at a time.
func appendSetting(tx store.Tx, s string) error {
	v, _, err := tx.GetSetting("order")
	if err != nil {
		return err
	}
	if v != "" {
		v += ","
	}
	return tx.SetSetting("order", v+s)
}

// Writers queued behind a long one wait without holding connections, so
// reads still get one from a small pool; then all of them commit, one at a
// time.
func TestQueuedWritesLeaveConnectionsForReads(t *testing.T) {
	db, err := Open(context.Background(), pgtest.URL(t), Options{MaxConns: 2})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	const queued = 5
	started, release := make(chan struct{}), make(chan struct{})
	errs := make(chan error, queued+1)
	go func() {
		errs <- db.Write(context.Background(), func(tx store.Tx) error {
			if err := appendSetting(tx, "w0"); err != nil {
				return err
			}
			close(started)
			<-release
			return nil
		})
	}()
	<-started
	for i := range queued {
		go func() {
			errs <- db.Write(context.Background(), func(tx store.Tx) error { return appendSetting(tx, fmt.Sprintf("w%d", i+1)) })
		}()
	}
	time.Sleep(300 * time.Millisecond) // let the writers queue

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	err = db.Read(ctx, func(tx store.Tx) error { _, _, err := tx.GetSetting("order"); return err })
	cancel()
	if err != nil {
		t.Errorf("a read while writers queue: %v", err)
	}
	if n := len(errs); n != 0 {
		t.Errorf("%d writes finished before the first one", n)
	}

	close(release)
	for range queued + 1 {
		select {
		case err := <-errs:
			if err != nil {
				t.Error(err)
			}
		case <-time.After(30 * time.Second):
			t.Fatal("the queued writes did not finish")
		}
	}
	var order string
	if err := db.Read(context.Background(), func(tx store.Tx) (err error) {
		order, _, err = tx.GetSetting("order")
		return err
	}); err != nil {
		t.Fatal(err)
	}
	got := strings.Split(order, ",")
	slices.Sort(got)
	want := []string{"w0", "w1", "w2", "w3", "w4", "w5"}
	if !slices.Equal(got, want) || !strings.HasPrefix(order, "w0,") {
		t.Errorf("order = %q: want each of %v once, w0 first", order, want)
	}
}

// A writer waiting for its turn gives up when its context ends.
func TestQueuedWriteHonoursContext(t *testing.T) {
	db := open(t, pgtest.URL(t), nil)
	started, release := make(chan struct{}), make(chan struct{})
	first := make(chan error, 1)
	go func() {
		first <- db.Write(context.Background(), func(tx store.Tx) error {
			close(started)
			<-release
			return tx.SetSetting("k", "first")
		})
	}()
	<-started
	ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancel()
	ran := false
	start := time.Now()
	err := db.Write(ctx, func(tx store.Tx) error { ran = true; return tx.SetSetting("k", "second") })
	if !errors.Is(err, context.DeadlineExceeded) || ran {
		t.Errorf("a queued write whose context ended: %v (ran: %v)", err, ran)
	}
	if d := time.Since(start); d > 5*time.Second {
		t.Errorf("it returned after %v", d)
	}
	close(release)
	if err := <-first; err != nil {
		t.Fatal(err)
	}
	v := storetest.Read(t, db, func(tx store.Tx) (string, error) { v, _, err := tx.GetSetting("k"); return v, err })
	if v != "first" {
		t.Errorf("k = %q", v)
	}
}
