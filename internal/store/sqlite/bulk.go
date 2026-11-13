package sqlite

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"codeatrophy/internal/store"
)

// Export implements store.Bulk.
func (db *DB) Export(ctx context.Context, fn func(store.Dump) error) error {
	return db.run(ctx, db.reader, true, func(t *tx) error { return fn(&dump{t}) })
}

// Import implements store.Bulk. Foreign keys are checked by Finish rather
// than row by row.
func (db *DB) Import(ctx context.Context, fn func(store.Load) error) error {
	return db.run(ctx, db.writer, false, func(t *tx) error {
		if _, err := t.exec(`PRAGMA defer_foreign_keys = ON`); err != nil {
			return err
		}
		l := &load{dump: dump{t}, stmts: map[string]*sql.Stmt{}}
		defer l.close()
		return fn(l)
	})
}

type dump struct{ t *tx }

func (d *dump) Rows(t store.Table, fn func([]any) error) error {
	rows, err := d.t.query(`SELECT ` + strings.Join(t.Columns, ", ") + ` FROM ` + t.Name +
		` ORDER BY ` + strings.Join(t.Key, ", "))
	if err != nil {
		return err
	}
	defer rows.Close()
	vals := make([]any, len(t.Columns))
	ptrs := make([]any, len(t.Columns))
	for i := range vals {
		ptrs[i] = &vals[i]
	}
	for rows.Next() {
		if err := rows.Scan(ptrs...); err != nil {
			return err
		}
		for i, v := range vals {
			switch v := v.(type) {
			case []byte:
				vals[i] = string(v)
			case nil, int64, string:
			default:
				return fmt.Errorf("%s.%s: unexpected value of type %T", t.Name, t.Columns[i], v)
			}
		}
		if err := fn(vals); err != nil {
			return err
		}
	}
	return rows.Err()
}

func (d *dump) Count(t store.Table) (int64, error) {
	var n int64
	err := d.t.queryRow(`SELECT COUNT(*) FROM ` + t.Name).Scan(&n)
	return n, err
}

type load struct {
	dump
	stmts map[string]*sql.Stmt
	blobs map[string][]bool // table -> which columns are declared BLOB
}

func (l *load) close() {
	for _, s := range l.stmts {
		s.Close()
	}
}

func (l *load) Clear() error {
	if _, err := l.t.exec(`DELETE FROM items_fts`); err != nil {
		return err
	}
	for i := len(store.Tables) - 1; i >= 0; i-- {
		if _, err := l.t.exec(`DELETE FROM ` + store.Tables[i].Name); err != nil {
			return err
		}
	}
	return nil
}

func (l *load) Insert(t store.Table, row []any) error {
	if len(row) != len(t.Columns) {
		return fmt.Errorf("%s: %d values for %d columns", t.Name, len(row), len(t.Columns))
	}
	st := l.stmts[t.Name]
	if st == nil {
		var err error
		st, err = l.t.tx.PrepareContext(l.t.ctx, `INSERT INTO `+t.Name+` (`+strings.Join(t.Columns, ", ")+
			`) VALUES (`+placeholders(len(t.Columns))+`)`)
		if err != nil {
			return err
		}
		l.stmts[t.Name] = st
	}
	// Values are backend-neutral strings; a BLOB column gets bytes, so that
	// it keeps the BLOB storage class it is written with.
	blobs, err := l.blobColumns(t)
	if err != nil {
		return err
	}
	vals := row
	for i, isBlob := range blobs {
		if v, ok := row[i].(string); ok && isBlob {
			if &vals[0] == &row[0] {
				vals = append([]any(nil), row...)
			}
			vals[i] = []byte(v)
		}
	}
	_, err = st.ExecContext(l.t.ctx, vals...)
	return err
}

func (l *load) blobColumns(t store.Table) ([]bool, error) {
	if b, ok := l.blobs[t.Name]; ok {
		return b, nil
	}
	types := map[string]string{}
	if err := l.t.eachRow(`SELECT name, type FROM pragma_table_info(?)`, []any{t.Name}, func(r *sql.Rows) error {
		var name, typ string
		if err := r.Scan(&name, &typ); err != nil {
			return err
		}
		types[name] = strings.ToUpper(typ)
		return nil
	}); err != nil {
		return nil, err
	}
	b := make([]bool, len(t.Columns))
	for i, c := range t.Columns {
		b[i] = types[c] == "BLOB"
	}
	if l.blobs == nil {
		l.blobs = map[string][]bool{}
	}
	l.blobs[t.Name] = b
	return b, nil
}

// Finish rebuilds the search index from the items and their tags, and
// reports the first foreign key violation, if any.
func (l *load) Finish() error {
	if _, err := l.t.exec(`DELETE FROM items_fts`); err != nil {
		return err
	}
	if _, err := l.t.exec(`INSERT INTO items_fts (rowid, title, summary, body, tags)
		SELECT i.seq, i.title, i.summary, i.body,
		       COALESCE((SELECT group_concat(tag, ' ') FROM (SELECT tag FROM item_tags t WHERE t.item_id = i.id ORDER BY tag)), '')
		FROM items i`); err != nil {
		return err
	}
	var table, parent string
	var rowid sql.NullInt64
	var fkid int
	err := l.t.queryRow(`PRAGMA foreign_key_check`).Scan(&table, &rowid, &parent, &fkid)
	if errors.Is(err, sql.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	return fmt.Errorf("a row of %s refers to a missing row of %s", table, parent)
}

// Inspect describes the database file at path without changing it.
func Inspect(ctx context.Context, path string) (store.Status, error) {
	migs, err := loadMigrations()
	if err != nil {
		return store.Status{}, err
	}
	abs, err := filepath.Abs(path)
	if err != nil {
		return store.Status{}, err
	}
	st := store.Status{Backend: "SQLite", Location: abs, Latest: migs[len(migs)-1].version}
	if _, err := os.Stat(abs); errors.Is(err, os.ErrNotExist) {
		for _, m := range migs {
			st.Pending = append(st.Pending, m.name)
		}
		return st, nil
	} else if err != nil {
		return st, err
	}
	st.Exists = true
	conn, err := sql.Open("sqlite", "file:"+abs+"?_pragma=busy_timeout(10000)&_pragma=query_only(1)")
	if err != nil {
		return st, err
	}
	defer conn.Close()
	conn.SetMaxOpenConns(1)
	exists := func(table string) (bool, error) {
		var n int
		err := conn.QueryRowContext(ctx, `SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?`, table).Scan(&n)
		return n > 0, err
	}
	ok, err := exists("schema_migrations")
	if err != nil {
		return st, fmt.Errorf("%s: %w", abs, err)
	}
	if ok {
		if err := conn.QueryRowContext(ctx, `SELECT COALESCE(MAX(version), 0) FROM schema_migrations`).Scan(&st.Version); err != nil {
			return st, err
		}
	}
	for _, m := range migs {
		if m.version > st.Version {
			st.Pending = append(st.Pending, m.name)
		}
	}
	for _, t := range store.Tables {
		ok, err := exists(t.Name)
		if err != nil {
			return st, err
		}
		if !ok {
			continue
		}
		var n int64
		if err := conn.QueryRowContext(ctx, `SELECT COUNT(*) FROM `+t.Name).Scan(&n); err != nil {
			return st, err
		}
		st.Counts = append(st.Counts, store.TableCount{Table: t.Name, Rows: n})
	}
	return st, nil
}
