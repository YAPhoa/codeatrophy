package postgres

import (
	"context"
	"database/sql"
	"fmt"
	"strings"

	"codeatrophy/internal/store"
)

// Export implements store.Bulk.
func (db *DB) Export(ctx context.Context, fn func(store.Dump) error) error {
	return db.run(ctx, true, func(t *tx) error { return fn(&dump{t}) })
}

// Import implements store.Bulk. It holds the write lock, and foreign keys
// are checked by Finish rather than row by row.
func (db *DB) Import(ctx context.Context, fn func(store.Load) error) error {
	return db.run(ctx, false, func(t *tx) error {
		if _, err := t.exec(`SET CONSTRAINTS ALL DEFERRED`); err != nil {
			return err
		}
		types := map[string]string{}
		if err := t.eachRow(`SELECT table_name, column_name, data_type FROM information_schema.columns
			WHERE table_schema = current_schema()`, nil, func(r *sql.Rows) error {
			var table, column, typ string
			if err := r.Scan(&table, &column, &typ); err != nil {
				return err
			}
			types[table+"."+column] = typ
			return nil
		}); err != nil {
			return err
		}
		return fn(&load{dump: dump{t}, types: types})
	})
}

type dump struct{ t *tx }

func (d *dump) Rows(t store.Table, fn func([]any) error) error {
	// Rows are read in pages: the connection cannot run another statement
	// (such as an insert by fn) while a result is open.
	const page = 200
	vals := make([]any, len(t.Columns))
	ptrs := make([]any, len(t.Columns))
	for i := range vals {
		ptrs[i] = &vals[i]
	}
	keyIdx := make([]int, len(t.Key))
	for i, k := range t.Key {
		keyIdx[i] = indexOf(t.Columns, k)
	}
	var after []any // key of the last row read
	for {
		var p params
		q := `SELECT ` + strings.Join(t.Columns, ", ") + ` FROM ` + t.Name
		if after != nil {
			ph := make([]string, len(after))
			for i, v := range after {
				ph[i] = p.add(v)
			}
			q += ` WHERE (` + strings.Join(t.Key, ", ") + `) > (` + strings.Join(ph, ", ") + `)`
		}
		q += ` ORDER BY ` + strings.Join(t.Key, ", ") + ` LIMIT ` + p.add(page)
		var batch [][]any
		if err := d.t.eachRow(q, p.args, func(r *sql.Rows) error {
			if err := r.Scan(ptrs...); err != nil {
				return err
			}
			row := make([]any, len(vals))
			for i, v := range vals {
				switch v := v.(type) {
				case []byte:
					row[i] = string(v)
				case bool:
					row[i] = int64(0)
					if v {
						row[i] = int64(1)
					}
				case nil, int64, string:
					row[i] = v
				default:
					return fmt.Errorf("%s.%s: unexpected value of type %T", t.Name, t.Columns[i], v)
				}
			}
			batch = append(batch, row)
			return nil
		}); err != nil {
			return err
		}
		for _, row := range batch {
			if err := fn(row); err != nil {
				return err
			}
		}
		if len(batch) < page {
			return nil
		}
		last := batch[len(batch)-1]
		after = make([]any, len(keyIdx))
		for i, k := range keyIdx {
			after[i] = last[k]
		}
	}
}

func indexOf(ss []string, s string) int {
	for i, v := range ss {
		if v == s {
			return i
		}
	}
	panic("no column " + s)
}

func (d *dump) Count(t store.Table) (int64, error) {
	var n int64
	err := d.t.queryRow(`SELECT COUNT(*) FROM ` + t.Name).Scan(&n)
	return n, err
}

// load buffers inserted rows and writes them as multi-row inserts.
type load struct {
	dump
	types   map[string]string // "table.column" -> data type
	table   store.Table
	pending [][]any
	bytes   int
}

// Limits of one multi-row insert.
const (
	maxBatchRows  = 200
	maxBatchBytes = 4 << 20
	maxParams     = 65535
)

func (l *load) Rows(t store.Table, fn func([]any) error) error {
	if err := l.flush(); err != nil {
		return err
	}
	return l.dump.Rows(t, fn)
}

func (l *load) Count(t store.Table) (int64, error) {
	if err := l.flush(); err != nil {
		return 0, err
	}
	return l.dump.Count(t)
}

func (l *load) Clear() error {
	l.pending = nil
	if _, err := l.t.exec(`DELETE FROM items_search`); err != nil {
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
	if l.table.Name != t.Name {
		if err := l.flush(); err != nil {
			return err
		}
		l.table = t
	}
	vals := make([]any, len(row))
	for i, v := range row {
		col := t.Name + "." + t.Columns[i]
		switch typ := l.types[col]; {
		case typ == "":
			return fmt.Errorf("the database has no column %s", col)
		case v == nil:
		case typ == "bytea":
			s, ok := v.(string)
			if !ok {
				return fmt.Errorf("%s: want text, got %T", col, v)
			}
			vals[i] = text(s)
			l.bytes += len(s)
			continue
		case typ == "boolean":
			n, ok := v.(int64)
			if !ok {
				return fmt.Errorf("%s: want an integer flag, got %T", col, v)
			}
			vals[i] = n != 0
			continue
		}
		if s, ok := v.(string); ok {
			l.bytes += len(s)
		}
		vals[i] = v
	}
	l.pending = append(l.pending, vals)
	if len(l.pending) >= maxBatchRows || l.bytes >= maxBatchBytes || (len(l.pending)+1)*len(row) > maxParams {
		return l.flush()
	}
	return nil
}

func (l *load) flush() error {
	if len(l.pending) == 0 {
		return nil
	}
	var p params
	tuples := make([]string, len(l.pending))
	for i, row := range l.pending {
		ph := make([]string, len(row))
		for j, v := range row {
			ph[j] = p.add(v)
		}
		tuples[i] = `(` + strings.Join(ph, ", ") + `)`
	}
	l.pending, l.bytes = nil, 0
	_, err := l.t.exec(`INSERT INTO `+l.table.Name+` (`+strings.Join(l.table.Columns, ", ")+`) VALUES `+
		strings.Join(tuples, ", "), p.args...)
	if err != nil {
		return fmt.Errorf("%s: %w", l.table.Name, err)
	}
	return nil
}

// Finish writes pending rows, rebuilds the search index, moves the
// insertion sequences past the copied rows and checks the foreign keys.
func (l *load) Finish() error {
	if err := l.flush(); err != nil {
		return err
	}
	if _, err := l.t.exec(`DELETE FROM items_search`); err != nil {
		return err
	}
	var last int64
	for {
		type doc struct {
			seq                       int64
			title, summary, body, tag string
		}
		var docs []doc
		if err := l.t.eachRow(`SELECT i.seq, i.title, i.summary, i.body,
			COALESCE((SELECT string_agg(t.tag, ' ' ORDER BY t.tag) FROM item_tags t WHERE t.item_id = i.id), '')
			FROM items i WHERE i.seq > $1 ORDER BY i.seq LIMIT 100`, []any{last}, func(r *sql.Rows) error {
			var d doc
			if err := r.Scan(&d.seq, &d.title, &d.summary, &d.body, &d.tag); err != nil {
				return err
			}
			docs = append(docs, d)
			return nil
		}); err != nil {
			return err
		}
		var texts []string
		for _, d := range docs {
			texts = append(texts, d.title, d.summary, d.body, d.tag)
		}
		cols, err := searchTexts(texts...)
		if err != nil {
			return err
		}
		for i, d := range docs {
			c := cols[4*i : 4*i+4]
			if _, err := l.t.exec(`INSERT INTO items_search (seq, title, summary, body, tags) VALUES ($1, $2, $3, $4, $5)`,
				d.seq, c[0], c[1], c[2], c[3]); err != nil {
				return err
			}
		}
		if len(docs) < 100 {
			break
		}
		last = docs[len(docs)-1].seq
	}
	for _, t := range store.Tables {
		if t.Key[0] != "seq" {
			continue
		}
		if _, err := l.t.exec(`SELECT setval(pg_get_serial_sequence('` + t.Name + `', 'seq'),
			COALESCE((SELECT MAX(seq) FROM ` + t.Name + `), 0) + 1, false)`); err != nil {
			return err
		}
	}
	if _, err := l.t.exec(`SET CONSTRAINTS ALL IMMEDIATE`); err != nil {
		return fmt.Errorf("foreign keys: %w", err)
	}
	return nil
}

// Inspect describes the database at the URL without changing it.
func Inspect(ctx context.Context, rawURL string, opts Options) (store.Status, error) {
	migs, err := loadMigrations()
	if err != nil {
		return store.Status{}, err
	}
	st := store.Status{Backend: "PostgreSQL", Location: Redact(rawURL), Latest: migs[len(migs)-1].version}
	db, err := connect(ctx, rawURL, opts)
	if err != nil {
		return st, err
	}
	defer db.Close()
	st.Exists = true
	err = db.run(ctx, true, func(t *tx) error {
		exists := func(table string) (bool, error) {
			var ok bool
			err := t.queryRow(`SELECT to_regclass($1) IS NOT NULL`, table).Scan(&ok)
			return ok, err
		}
		ok, err := exists("schema_migrations")
		if err != nil {
			return err
		}
		if ok {
			if err := t.queryRow(`SELECT COALESCE(MAX(version), 0) FROM schema_migrations`).Scan(&st.Version); err != nil {
				return err
			}
		}
		for _, m := range migs {
			if m.version > st.Version {
				st.Pending = append(st.Pending, m.name)
			}
		}
		for _, tb := range store.Tables {
			ok, err := exists(tb.Name)
			if err != nil {
				return err
			}
			if !ok {
				continue
			}
			n, err := (&dump{t}).Count(tb)
			if err != nil {
				return err
			}
			st.Counts = append(st.Counts, store.TableCount{Table: tb.Name, Rows: n})
		}
		return nil
	})
	return st, err
}
