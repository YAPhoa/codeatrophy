// Package sqlrow holds the Go code that the SQLite and PostgreSQL stores
// share word for word, such as ending a transaction and walking rows.
// Neither store imports the other; both import this. The SQL itself stays
// in each store.
package sqlrow

import (
	"context"
	"database/sql"
	"fmt"
)

// InTx runs fn in the open transaction sqlTx and ends it: a commit when fn
// returns nil, a rollback when it fails or panics (the panic goes on).
func InTx(ctx context.Context, sqlTx *sql.Tx, fn func() error) (err error) {
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
	return fn()
}

// EachRow runs the query q in sqlTx and calls fn for each row.
func EachRow(ctx context.Context, sqlTx *sql.Tx, q string, args []any, fn func(*sql.Rows) error) error {
	rows, err := sqlTx.QueryContext(ctx, q, args...)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		if err := fn(rows); err != nil {
			return err
		}
	}
	return rows.Err()
}

// Strings reads rows of one text column, and closes them.
func Strings(rows *sql.Rows) ([]string, error) {
	defer rows.Close()
	out := []string{}
	for rows.Next() {
		var s string
		if err := rows.Scan(&s); err != nil {
			return nil, err
		}
		out = append(out, s)
	}
	return out, rows.Err()
}
